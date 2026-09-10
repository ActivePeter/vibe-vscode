/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { FailedMessage, InitializeMessage, isAgentExecutables, isAgentPolicy, isInstanceId, isNativeConnectionInfo, isProjectContext, isRecord, ProjectContextAppliedMessage, protocolVersion, ReadyMessage, RuntimeErrorCode, SimRuntimeAdapter, SimRuntimeError } from './protocol';
import { acquireRuntimeStorage, RuntimeStorage } from './runtimeStorage';

/** The private process entry point. It never listens on a public HTTP port or inherits an upstream URL. */
async function runHost(): Promise<never> {
	if (!process.send || !process.connected) {
		process.exit(1);
	}
	const controller = new AbortController();
	const initialize = Promise.withResolvers<InitializeMessage | undefined>();
	const stopped = Promise.withResolvers<void>();
	let request: InitializeMessage | undefined;
	let storage: RuntimeStorage | undefined;
	let instance: Awaited<ReturnType<SimRuntimeAdapter['start']>> | undefined;
	let deadline: NodeJS.Timeout | undefined;
	let failure: RuntimeErrorCode | undefined;
	let projection = Promise.resolve();
	let projectGeneration = -1;

	const send = (message: ReadyMessage | FailedMessage | ProjectContextAppliedMessage) => {
		if (process.connected) {
			process.send!(message, () => { /* disconnect independently invokes stop. */ });
		}
	};
	const stop = () => {
		if (controller.signal.aborted) {
			return;
		}
		// This deadline also works when the parent has disappeared and can no longer kill its child.
		deadline = setTimeout(() => process.exit(1), request?.runtimePackage.supervisor ? 15000 : 3000);
		controller.abort();
		initialize.resolve(undefined);
		stopped.resolve();
	};
	const fail = (code: RuntimeErrorCode) => {
		failure ??= code;
		if (request) {
			send({ type: 'failed', protocolVersion, runId: request.runId, code });
		}
		stop();
	};
	process.once('disconnect', stop);
	process.on('SIGTERM', stop);
	process.on('SIGINT', stop);
	process.on('message', (message: unknown) => {
		if (!isRecord(message) || message.protocolVersion !== protocolVersion || !isInstanceId(message.runId)) {
			fail('invalidProtocol');
			return;
		}
		if (message.type === 'shutdown' && message.runId === request?.runId) {
			stop();
		} else if (message.type === 'projectContext' && message.runId === request?.runId && isInstanceId(message.requestId) && isProjectContext(message.context) && storage && instance) {
			const { requestId, runId, context } = message;
			projection = projection.then(async () => {
				if (controller.signal.aborted || !storage) { return; }
				if (context.generation > projectGeneration) {
					const temporary = path.join(storage.directory, `project-context.${requestId}.tmp`);
					try {
						await fs.writeFile(temporary, JSON.stringify(context), { flag: 'wx', mode: 0o600 });
						if (controller.signal.aborted) { return; }
						await fs.rename(temporary, path.join(storage.directory, 'project-context.json'));
						projectGeneration = context.generation;
					} finally { await fs.rm(temporary, { force: true }); }
				}
				if (!controller.signal.aborted) { send({ type: 'projectContextApplied', protocolVersion, runId, requestId }); }
			}).catch(() => fail('storageUnavailable'));
		} else if (message.type === 'initialize' && !request && !controller.signal.aborted
			&& typeof message.stateDirectory === 'string' && path.isAbsolute(message.stateDirectory)
			&& isRecord(message.runtimePackage) && typeof message.runtimePackage.entrypoint === 'string'
			&& path.isAbsolute(message.runtimePackage.entrypoint) && typeof message.runtimePackage.version === 'string'
			&& (message.agentExecutables === undefined || isAgentExecutables(message.agentExecutables))
			&& (message.agentPolicy === undefined || isAgentPolicy(message.agentPolicy))) {
			request = {
				type: 'initialize', protocolVersion, runId: message.runId, stateDirectory: message.stateDirectory,
				agentExecutables: message.agentExecutables,
				agentPolicy: message.agentPolicy,
				runtimePackage: {
					entrypoint: message.runtimePackage.entrypoint, version: message.runtimePackage.version,
					...(typeof message.runtimePackage.supervisor === 'string' ? { supervisor: message.runtimePackage.supervisor } : {}),
				},
			};
			initialize.resolve(request);
		} else {
			fail('invalidProtocol');
		}
	});
	const initializeDeadline = setTimeout(() => fail('invalidProtocol'), 10000);
	try {
		const configuration = await initialize.promise;
		clearTimeout(initializeDeadline);
		if (configuration && !controller.signal.aborted) {
			storage = await acquireRuntimeStorage(configuration.stateDirectory);
			if (!controller.signal.aborted) {
				// esbuild preserves native import(): .mjs adapters may use top-level await and package resources.
				// eslint-disable-next-line no-restricted-syntax -- The immutable adapter is selected by its package manifest, not linked into this host.
				const adapter: SimRuntimeAdapter = await import(pathToFileURL(configuration.runtimePackage.entrypoint).href);
				if (typeof adapter.start !== 'function') {
					throw new SimRuntimeError('invalidPackage');
				}
				if (!controller.signal.aborted) {
					const started = await adapter.start({ protocolVersion, instanceId: storage.instanceId, stateDirectory: storage.directory, signal: controller.signal, agentExecutables: configuration.agentExecutables, agentPolicy: configuration.agentPolicy });
					if (!started || typeof started.stop !== 'function') {
						throw new SimRuntimeError('invalidPackage');
					}
					instance = started;
					if (started.connection !== undefined && !isNativeConnectionInfo(started.connection)) {
						throw new SimRuntimeError('invalidPackage');
					}
					void started.closed?.then(() => {
						if (!controller.signal.aborted) { fail('runtimeExited'); }
					}, () => fail('runtimeExited'));
					if (!controller.signal.aborted) {
						send({ type: 'ready', protocolVersion, runId: configuration.runId, instanceId: storage.instanceId, ...(started.connection ? { connection: started.connection } : {}) });
						await stopped.promise;
					}
				}
			}
		}
	} catch (error) {
		if (!controller.signal.aborted) {
			fail(error instanceof SimRuntimeError ? error.code : 'startFailed');
		}
	} finally {
		clearTimeout(initializeDeadline);
		stop();
		try {
			await projection;
			await instance?.stop();
		} catch {
			fail('stopFailed');
		} finally {
			await storage?.close();
		}
	}
	clearTimeout(deadline);
	process.exit(failure ? 1 : 0);
}

void runHost().catch(() => process.exit(1));
