/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { InitializeMessage, isInstanceId, isRecord, isRuntimeErrorCode, protocolVersion, RuntimeErrorCode, ShutdownMessage, SimRuntimeError } from './protocol';
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
	readonly onDidChangeStatus?: (status: RuntimeStatus) => void;
}

interface RuntimeRun {
	readonly runId: string;
	readonly ready: PromiseWithResolvers<RuntimeInfo>;
	readonly closed: PromiseWithResolvers<void>;
	child?: ChildProcess;
	startupTimer?: NodeJS.Timeout;
	stopRequested: boolean;
	didClose: boolean;
	stopPromise?: Promise<void>;
	failure?: RuntimeErrorCode;
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
			stopRequested: false, didClose: false,
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
			const runtimePackage = await loadRuntimePackage(this.extensionDirectory);
			// A stop may already have completed while the package was being read. Never revive that run.
			if (this.active !== run || run.stopRequested) {
				return;
			}
			const child = fork(path.join(__dirname, 'runtimeHost.js'), [], {
				cwd: path.dirname(runtimePackage.entrypoint),
				env: createRuntimeEnvironment(process.env),
				execArgv: [],
				stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
			});
			run.child = child;
			child.once('close', () => this.finish(run));
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
				} else if (message.type === 'failed' && isRuntimeErrorCode(message.code)) {
					this.fail(run, message.code);
				} else if (message.type === 'ready' && isInstanceId(message.instanceId)) {
					if (!run.stopRequested && this.status.phase === 'starting') {
						clearTimeout(run.startupTimer);
						this.setStatus({ phase: 'ready', runId: run.runId, instanceId: message.instanceId });
						run.ready.resolve(Object.freeze({ protocolVersion, runId: run.runId, instanceId: message.instanceId, version: runtimePackage.version }));
					}
				} else {
					this.fail(run, 'invalidProtocol');
				}
			});
			const initialize: InitializeMessage = { type: 'initialize', protocolVersion, runId: run.runId, stateDirectory: this.stateDirectory, runtimePackage };
			child.send(initialize, error => { if (error) { this.fail(run, 'startFailed'); } });
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
		if (await this.waitForClose(run, this.options.shutdownTimeoutMs ?? 1500)) {
			return;
		}
		// Never look up a port/PID or signal another process. These handles came from our own fork.
		try { child.kill('SIGTERM'); } catch { /* Confirm exit even when signalling fails. */ }
		if (await this.waitForClose(run, this.options.terminateTimeoutMs ?? 500)) {
			return;
		}
		try { child.kill('SIGKILL'); } catch { /* A live child must remain owned after a timeout. */ }
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
			run.failure = 'runtimeExited';
		}
		run.ready.reject(new SimRuntimeError(run.failure ?? 'cancelled'));
		this.active = undefined;
		this.setStatus(run.failure ? { phase: 'failed', runId: run.runId, error: run.failure } : { phase: 'stopped' });
	}
}
