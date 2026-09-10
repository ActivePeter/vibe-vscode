/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, fork, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { VibeProjectContext } from 'vibe-vscode';
import { agentProfile } from './agentProfile';
import { AgentExecutables, AgentKind, AgentPolicy, InitializeMessage, isAgentExecutables, isAgentPolicy, isInstanceId, isNativeConnectionInfo, isRecord, isRuntimeErrorCode, NativeConnectionInfo, protocolVersion, RuntimeErrorCode, ShutdownMessage, SimRuntimeError } from './protocol';
import { loadRuntimePackage } from './runtimePackage';

export interface RuntimeInfo {
	readonly protocolVersion: typeof protocolVersion;
	readonly runId: string;
	readonly instanceId: string;
	readonly version: string;
}

export interface RuntimeStatus {
	readonly phase: 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed';
	readonly runId?: string;
	readonly instanceId?: string;
	readonly error?: RuntimeErrorCode;
}

interface RuntimeOptions {
	readonly startupTimeoutMs?: number;
	readonly shutdownTimeoutMs?: number;
	readonly terminateTimeoutMs?: number;
	readonly killTimeoutMs?: number;
	readonly projectContextTimeoutMs?: number;
	readonly onDidChangeStatus?: (status: RuntimeStatus) => void;
	readonly getAgentExecutables?: () => AgentExecutables;
	readonly getAgentPolicy?: () => AgentPolicy;
}

interface RuntimeRun {
	readonly runId: string;
	readonly ready: PromiseWithResolvers<RuntimeInfo>;
	readonly closed: PromiseWithResolvers<void>;
	child?: ChildProcess;
	supervised?: boolean;
	connection?: NativeConnectionInfo;
	agentExecutables?: AgentExecutables;
	agentPolicy?: AgentPolicy;
	startupTimer?: NodeJS.Timeout;
	stopRequested: boolean;
	didClose: boolean;
	stopPromise?: Promise<void>;
	failure?: RuntimeErrorCode;
	readonly contextRequests: Map<string, PromiseWithResolvers<void>>;
}

/** Do not inherit shared databases, Sim credentials, NODE_OPTIONS or other injection/configuration channels. */
export function createRuntimeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = { NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: '1' };
	for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']) {
		if (environment[name] !== undefined) {
			result[name] = environment[name];
		}
	}
	return result;
}

/** Owns one child generation. UI lifetime and active project selection never control this resource. */
export class ManagedSimRuntime {
	private active: RuntimeRun | undefined;
	private disposed = false;
	private currentStatus: RuntimeStatus = Object.freeze({ phase: 'stopped' });

	constructor(
		private readonly extensionDirectory: string,
		private readonly stateDirectory: string,
		private readonly options: RuntimeOptions = {},
	) { }

	get status(): RuntimeStatus {
		return this.currentStatus;
	}

	/** Only extension-owned adapters use this metadata; public status never includes addresses or credentials. */
	async getConnection(): Promise<{ readonly info: NativeConnectionInfo; readonly runId: string }> {
		const ready = await this.start();
		const run = this.active;
		if (!run || run.runId !== ready.runId || run.stopRequested || !run.connection) {
			throw new SimRuntimeError('runtimeExited');
		}
		return { info: run.connection, runId: run.runId };
	}

	/** Explicit login/configuration commands must first acquire the same storage owner as execution. */
	async getAgentProfile(agent: AgentKind) {
		const { runId } = await this.start();
		const run = this.active;
		if (!run || run.runId !== runId || run.stopRequested) { throw new SimRuntimeError('runtimeExited'); }
		return agentProfile(this.stateDirectory, agent, run.agentExecutables);
	}

	/** The storage-lease owner atomically applies the catalog before the UI may publish it. */
	async updateProjectContext(context: VibeProjectContext, runId: string): Promise<void> {
		const run = this.active;
		if (!run || run.runId !== runId || run.stopRequested || this.status.phase !== 'ready' || !run.child?.connected) { throw new SimRuntimeError('runtimeExited'); }
		const requestId = randomUUID();
		const applied = Promise.withResolvers<void>();
		run.contextRequests.set(requestId, applied);
		const timer = setTimeout(() => this.fail(run, 'storageUnavailable'), this.options.projectContextTimeoutMs ?? 10000);
		run.child.send({ type: 'projectContext', protocolVersion, runId, requestId, context }, error => { if (error) { this.fail(run, 'runtimeExited'); } });
		try { await applied.promise; } finally { clearTimeout(timer); run.contextRequests.delete(requestId); }
	}

	/** Resolves only after the adapter is ready. Concurrent callers share the same readiness barrier. */
	start(): Promise<RuntimeInfo> {
		if (this.disposed) {
			return Promise.reject(new SimRuntimeError('disposed'));
		}
		if (this.active) {
			return this.active.stopRequested ? Promise.reject(new SimRuntimeError('stopping')) : this.active.ready.promise;
		}
		const run: RuntimeRun = {
			runId: randomUUID(), ready: Promise.withResolvers<RuntimeInfo>(), closed: Promise.withResolvers<void>(),
			stopRequested: false, didClose: false, contextRequests: new Map(),
		};
		this.active = run;
		run.startupTimer = setTimeout(() => this.fail(run, 'startTimedOut'), this.options.startupTimeoutMs ?? 15000);
		this.setStatus({ phase: 'starting', runId: run.runId });
		void this.launch(run);
		return run.ready.promise;
	}

	stop(): Promise<void> {
		return this.active ? this.stopRun(this.active) : Promise.resolve();
	}

	/** deactivate can await this; IPC disconnect is the independent crash-cleanup path. */
	dispose(): Promise<void> {
		this.disposed = true;
		return this.stop();
	}

	private setStatus(status: RuntimeStatus): void {
		this.currentStatus = Object.freeze(status);
		try {
			this.options.onDidChangeStatus?.(this.currentStatus);
		} catch {
			// Notifications are projections. A disposed UI/logger must never interrupt child cleanup.
		}
	}

	private async launch(run: RuntimeRun): Promise<void> {
		try {
			run.agentExecutables = this.options.getAgentExecutables?.();
			if (run.agentExecutables && !isAgentExecutables(run.agentExecutables)) { throw new SimRuntimeError('invalidProtocol'); }
			run.agentPolicy = this.options.getAgentPolicy?.();
			if (run.agentPolicy !== undefined && !isAgentPolicy(run.agentPolicy)) { throw new SimRuntimeError('invalidProtocol'); }
			const runtimePackage = await loadRuntimePackage(this.extensionDirectory);
			if (runtimePackage.supervisor && !run.stopRequested && this.active === run) {
				clearTimeout(run.startupTimer);
				run.startupTimer = setTimeout(() => this.fail(run, 'startTimedOut'), this.options.startupTimeoutMs ?? 180000);
				await fs.mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
			}
			// A stop may already have completed while the package was being read. Never revive that run.
			if (this.active !== run || run.stopRequested) {
				return;
			}
			const options = {
				cwd: path.dirname(runtimePackage.entrypoint),
				env: createRuntimeEnvironment(process.env),
				stdio: ['ignore', 'ignore', 'ignore', 'ipc'] as ['ignore', 'ignore', 'ignore', 'ipc'],
			};
			const directory = runtimePackage.supervisor ? await fs.realpath(this.stateDirectory) : this.stateDirectory;
			if (this.active !== run || run.stopRequested) { return; }
			const child = runtimePackage.supervisor
				? spawn(runtimePackage.supervisor, ['--lease-directory', directory, runtimePackage.nodeExecutable!, path.join(__dirname, 'runtimeHost.js')], options)
				: fork(path.join(__dirname, 'runtimeHost.js'), [], { ...options, execArgv: [] });
			run.supervised = !!runtimePackage.supervisor;
			run.child = child;
			child.once('close', code => {
				if (run.supervised && !run.stopRequested && (code === 123 || code === 124)) {
					run.failure = code === 124 ? 'storageBusy' : 'storageUnavailable';
				}
				this.finish(run);
			});
			child.on('error', () => this.fail(run, 'startFailed'));
			child.on('message', (message: unknown) => {
				if (this.active !== run) {
					return;
				}
				if (!isRecord(message)) {
					this.fail(run, 'invalidProtocol');
					return;
				}
				if (message.runId !== run.runId) {
					return;
				}
				if (message.protocolVersion !== protocolVersion) {
					this.fail(run, 'invalidProtocol');
				} else if (message.type === 'projectContextApplied' && typeof message.requestId === 'string') {
					run.contextRequests.get(message.requestId)?.resolve();
				} else if (message.type === 'failed' && isRuntimeErrorCode(message.code)) {
					this.fail(run, message.code);
				} else if (message.type === 'ready' && isInstanceId(message.instanceId)) {
					if (message.connection !== undefined && !isNativeConnectionInfo(message.connection)) {
						this.fail(run, 'invalidProtocol');
						return;
					}
					if (!run.stopRequested && this.status.phase === 'starting') {
						run.connection = message.connection as NativeConnectionInfo | undefined;
						clearTimeout(run.startupTimer);
						this.setStatus({ phase: 'ready', runId: run.runId, instanceId: message.instanceId });
						run.ready.resolve(Object.freeze({ protocolVersion, runId: run.runId, instanceId: message.instanceId, version: runtimePackage.version }));
					}
				} else {
					this.fail(run, 'invalidProtocol');
				}
			});
			const initialize: InitializeMessage = { type: 'initialize', protocolVersion, runId: run.runId, stateDirectory: this.stateDirectory, runtimePackage, agentExecutables: run.agentExecutables, agentPolicy: run.agentPolicy };
			child.send(initialize, error => {
				// A native lease refusal closes IPC before initialize. Its authoritative exit code wins.
				if (error && !run.supervised) { this.fail(run, 'startFailed'); }
			});
		} catch (error) {
			this.fail(run, error instanceof SimRuntimeError ? error.code : 'startFailed');
		}
	}

	private fail(run: RuntimeRun, code: RuntimeErrorCode): void {
		if (this.active !== run) {
			return;
		}
		// Cancellation wins over late startup errors; a stop failure must still be visible.
		if (run.stopRequested && code !== 'stopFailed') {
			return;
		}
		run.failure ??= code;
		run.ready.reject(new SimRuntimeError(run.failure));
		void this.stopRun(run).catch(() => { /* stopRun retains the owned child and publishes stopTimedOut. */ });
	}

	private stopRun(run: RuntimeRun): Promise<void> {
		if (run.stopPromise) {
			return run.stopPromise;
		}
		const stopped = Promise.withResolvers<void>();
		run.stopPromise = stopped.promise;
		run.stopRequested = true;
		for (const pending of run.contextRequests.values()) { pending.reject(new SimRuntimeError(run.failure ?? 'cancelled')); }
		run.contextRequests.clear();
		clearTimeout(run.startupTimer);
		run.ready.reject(new SimRuntimeError(run.failure ?? 'cancelled'));
		this.setStatus({ phase: 'stopping', runId: run.runId, error: run.failure });
		void this.terminate(run).then(stopped.resolve, stopped.reject);
		return run.stopPromise;
	}

	private async terminate(run: RuntimeRun): Promise<void> {
		const child = run.child;
		if (!child) {
			this.finish(run);
			return;
		}
		if (child.connected) {
			const message: ShutdownMessage = { type: 'shutdown', protocolVersion, runId: run.runId };
			child.send(message, () => { /* A closing IPC channel is covered by the exit barrier below. */ });
		}
		if (await this.waitForClose(run, this.options.shutdownTimeoutMs ?? (run.supervised ? 20000 : 1500))) {
			return;
		}
		// Never look up a port/PID or signal another process. These handles came from our own fork.
		try { child.kill('SIGTERM'); } catch { /* Confirm exit even when signalling fails. */ }
		if (await this.waitForClose(run, this.options.terminateTimeoutMs ?? (run.supervised ? 5000 : 500))) {
			return;
		}
		if (!run.supervised) {
			try { child.kill('SIGKILL'); } catch { /* A live child must remain owned after a timeout. */ }
		}
		if (!await this.waitForClose(run, this.options.killTimeoutMs ?? 1000)) {
			run.failure = 'stopTimedOut';
			this.setStatus({ phase: 'failed', runId: run.runId, error: run.failure });
			// Keep active: a timeout is not proof of exit and must not permit a second writer.
			throw new SimRuntimeError(run.failure);
		}
	}

	private async waitForClose(run: RuntimeRun, timeoutMs: number): Promise<boolean> {
		if (run.didClose) {
			return true;
		}
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				run.closed.promise.then(() => true),
				new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	private finish(run: RuntimeRun): void {
		run.didClose = true;
		run.closed.resolve();
		clearTimeout(run.startupTimer);
		if (this.active !== run) {
			return;
		}
		if (!run.stopRequested) {
			run.failure ??= 'runtimeExited';
		}
		run.ready.reject(new SimRuntimeError(run.failure ?? 'cancelled'));
		this.active = undefined;
		for (const pending of run.contextRequests.values()) { pending.reject(new SimRuntimeError(run.failure ?? 'runtimeExited')); }
		run.contextRequests.clear();
		this.setStatus(run.failure ? { phase: 'failed', runId: run.runId, error: run.failure } : { phase: 'stopped' });
	}
}
