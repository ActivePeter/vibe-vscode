/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { agentProfile } from '../agentProfile';
import { createRuntimeEnvironment } from '../managedRuntime';
import { defaultAgentPolicy, isRecord, SimRuntimeAdapter, SimRuntimeError } from '../protocol';
import { startNativeDatabase } from './nativeDatabase';
import { NativeProcess, waitForNativeService } from './nativeProcess';

/** No migration, worker, service or native queue outlives the plugin's process-tree owner. */
export async function start({ stateDirectory, signal, agentExecutables, agentPolicy = defaultAgentPolicy }: Parameters<SimRuntimeAdapter['start']>[0]): ReturnType<SimRuntimeAdapter['start']> {
	const directory = __dirname;
	const children: NativeProcess[] = [];
	let database: Awaited<ReturnType<typeof startNativeDatabase>> | undefined;
	let stopped: Promise<void> | undefined;
	const stop = () => stopped ??= (async () => {
		// App requests and collaborative document flushes complete before their database disappears.
		for (const child of [...children].reverse()) { await child.stop(); }
		await database?.stop();
	})();
	try {
		database = await startNativeDatabase(directory, stateDirectory, signal);
		for (const child of ['home', 'uploads', 'agents/codex', 'agents/claude']) {
			await fs.mkdir(path.join(stateDirectory, child), { recursive: true, mode: 0o700 });
		}
		const codex = agentProfile(stateDirectory, 'codex', agentExecutables);
		const claude = agentProfile(stateDirectory, 'claude', agentExecutables);
		const environment: NodeJS.ProcessEnv = {
			...createRuntimeEnvironment(process.env), ...database.environment,
			PATH: `${path.join(directory, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
			HOME: path.join(stateDirectory, 'home'),
			NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_APP_URL: 'https://sim.vscode.invalid',
			BETTER_AUTH_URL: 'https://sim.vscode.invalid', NEXT_PUBLIC_SOCKET_URL: 'https://sim.vscode.invalid',
			DISABLE_AUTH: 'true', SIM_VSCODE_PLUGIN: 'true',
			SIM_UPLOADS_DIR: path.join(stateDirectory, 'uploads'),
			SIM_VSCODE_PROJECT_CONTEXT_FILE: path.join(stateDirectory, 'project-context.json'),
			SIM_VSCODE_PROCESS_SUPERVISOR: path.join(directory, 'bin/process-supervisor'),
			SIM_VSCODE_CODEX_HOME: codex.home, SIM_VSCODE_CODEX_BINARY: codex.executable,
			SIM_VSCODE_CLAUDE_HOME: claude.home, SIM_VSCODE_CLAUDE_BINARY: claude.executable,
			SIM_VSCODE_CODEX_SANDBOX: agentPolicy.codexSandbox,
			SIM_VSCODE_ALLOW_UNRESTRICTED: String(agentPolicy.allowUnrestricted),
		};
		const launch = (entry: string, cwd: string, variables = environment, onMessage?: (message: unknown) => void) => {
			if (signal.aborted) { throw new SimRuntimeError('cancelled'); }
			const child = new NativeProcess(directory, process.execPath, [path.join(directory, entry)], cwd, variables, onMessage);
			children.push(child);
			return child;
		};
		await launch('db/migrate.mjs', path.join(directory, 'db')).result(signal);
		const applicationListening = Promise.withResolvers<number>();
		const configured = Promise.withResolvers<void>();
		const realtimeListening = Promise.withResolvers<number>();
		const receivePort = (message: unknown, ready: PromiseWithResolvers<number>) => {
			if (isRecord(message) && message.type === 'listening' && Number.isInteger(message.port) && Number(message.port) > 0 && Number(message.port) <= 65535) {
				ready.resolve(Number(message.port));
			}
		};
		const application = launch('application.mjs', path.join(directory, 'application/apps/sim'), environment, message => {
			receivePort(message, applicationListening);
			if (isRecord(message) && message.type === 'configured') { configured.resolve(); }
		});
		const wait = async <T>(child: NativeProcess, ready: Promise<T>): Promise<T> => {
			const cancelled = Promise.withResolvers<never>();
			const abort = () => cancelled.reject(new SimRuntimeError('cancelled'));
			if (signal.aborted) { abort(); } else { signal.addEventListener('abort', abort, { once: true }); }
			try {
				return await Promise.race([ready, child.closed.then(() => { throw new SimRuntimeError('startFailed'); }), cancelled.promise]);
			} finally {
				signal.removeEventListener('abort', abort);
			}
		};
		const applicationPort = await wait(application, applicationListening.promise);
		const realtime = launch('realtime.mjs', stateDirectory, {
			...environment, PORT: '0', SIM_DB_ROLE: 'realtime', DB_APP_NAME: 'sim-realtime',
			INTERNAL_API_BASE_URL: `http://127.0.0.1:${applicationPort}`,
		}, message => receivePort(message, realtimeListening));
		const realtimePort = await wait(realtime, realtimeListening.promise);
		application.send({ realtimePort });
		await wait(application, configured.promise);
		const gateway = database.environment.VIBE_VSCODE_AGENT_GATEWAY_SECRET;
		await waitForNativeService(application, async () => {
			const response = await fetch(`http://127.0.0.1:${applicationPort}/api/auth/get-session`, {
				headers: { host: 'sim.vscode.invalid', 'x-vibe-agent-gateway': gateway, 'x-forwarded-proto': 'https' },
				signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), redirect: 'error',
			});
			const result: unknown = response.ok ? await response.json() : undefined;
			return isRecord(result) && isRecord(result.user) && typeof result.user.id === 'string';
		}, signal);
		return {
			connection: { applicationPort, realtimePort, gateway },
			closed: Promise.race([application.closed, realtime.closed, database.closed]),
			stop,
		};
	} catch (error) {
		await stop();
		throw error;
	}
}
