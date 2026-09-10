/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'node:child_process';
import * as path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { SimRuntimeError } from '../protocol';

/** Every native service has an OS-level owner which also survives a killed Node parent. */
export class NativeProcess {
	private readonly child: ChildProcess;
	private readonly completion = Promise.withResolvers<number | null>();
	private stopPromise: Promise<void> | undefined;
	private exited = false;
	private stdout = '';
	readonly closed = this.completion.promise.then(() => { });

	constructor(
		packageDirectory: string,
		executable: string,
		args: readonly string[],
		cwd: string,
		environment: NodeJS.ProcessEnv,
		onMessage?: (message: unknown) => void,
	) {
		this.child = spawn(path.join(packageDirectory, 'bin/process-supervisor'), [executable, ...args], {
			cwd, env: environment, detached: true, stdio: onMessage ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
		});
		this.child.once('close', code => {
			this.exited = true;
			this.completion.resolve(code);
		});
		this.child.once('error', () => {
			// A failed spawn also emits close. Observe its outcome without exposing arguments or env.
		});
		this.child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
			this.stdout = (this.stdout + chunk).slice(-64 * 1024);
		});
		// Native diagnostics can contain database URLs. They never become protocol messages or UI output.
		this.child.stderr?.resume();
		if (onMessage) {
			this.child.on('message', onMessage);
		}
	}

	get isClosed(): boolean {
		return this.exited;
	}

	/** A command's output is consumed only by its owner, never forwarded to the browser. */
	async result(signal: AbortSignal): Promise<string> {
		const abort = () => { void this.stop().catch(() => { }); };
		signal.addEventListener('abort', abort, { once: true });
		if (signal.aborted) {
			abort();
		}
		try {
			const code = await this.completion.promise;
			if (signal.aborted) {
				throw new SimRuntimeError('cancelled');
			}
			if (code !== 0) {
				throw new SimRuntimeError('startFailed');
			}
			return this.stdout;
		} finally {
			signal.removeEventListener('abort', abort);
		}
	}

	send(message: object): void {
		if (!this.child.connected || this.exited) {
			throw new SimRuntimeError('runtimeExited');
		}
		this.child.send(message, () => { });
	}

	stop(): Promise<void> {
		return this.stopPromise ??= this.doStop();
	}

	private async doStop(): Promise<void> {
		if (this.exited) {
			return;
		}
		this.child.kill('SIGTERM');
		if (!await this.waitForExit(4500)) {
			// The supervisor escalates its children itself and retains ownership until they exit.
			// Killing it here could release the writer lease while a descendant is still alive.
			if (!await this.waitForExit(1500)) {
				throw new SimRuntimeError('stopTimedOut');
			}
		}
	}

	private async waitForExit(timeout: number): Promise<boolean> {
		const cancel = new AbortController();
		try {
			return await Promise.race([
				this.closed.then(() => true),
				setTimeout(timeout, false, { signal: cancel.signal }),
			]);
		} finally {
			cancel.abort();
		}
	}
}

/** Readiness is a successful service probe, not a spawn event or an assigned port. */
export async function waitForNativeService(process: NativeProcess, probe: () => Promise<boolean>, signal: AbortSignal): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (!signal.aborted && !process.isClosed && Date.now() < deadline) {
		if (await probe()) {
			if (process.isClosed || signal.aborted) {
				break;
			}
			return;
		}
		await setTimeout(50, undefined, { signal }).catch(() => { });
	}
	throw new SimRuntimeError(signal.aborted ? 'cancelled' : 'startFailed');
}
