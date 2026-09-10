/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FailedMessage, InitializeMessage, isInstanceId, isRecord, protocolVersion, ReadyMessage, RuntimeErrorCode, SimRuntimeAdapter, SimRuntimeError } from './protocol';
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

	const send = (message: ReadyMessage | FailedMessage) => {
		if (process.connected) {
			process.send!(message, () => { /* disconnect independently invokes stop. */ });
		}
	};
	const stop = () => {
		if (controller.signal.aborted) {
			return;
		}
		// This deadline also works when the parent has disappeared and can no longer kill its child.
		deadline = setTimeout(() => process.exit(1), 3000);
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
		} else if (message.type === 'initialize' && !request && !controller.signal.aborted
			&& typeof message.stateDirectory === 'string' && path.isAbsolute(message.stateDirectory)
			&& isRecord(message.runtimePackage) && typeof message.runtimePackage.entrypoint === 'string'
			&& path.isAbsolute(message.runtimePackage.entrypoint) && typeof message.runtimePackage.version === 'string') {
			request = {
				type: 'initialize', protocolVersion, runId: message.runId, stateDirectory: message.stateDirectory,
				runtimePackage: { entrypoint: message.runtimePackage.entrypoint, version: message.runtimePackage.version },
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
					const started = await adapter.start({ protocolVersion, instanceId: storage.instanceId, stateDirectory: storage.directory, signal: controller.signal });
					if (!started || typeof started.stop !== 'function') {
						throw new SimRuntimeError('invalidPackage');
					}
					instance = started;
					if (!controller.signal.aborted) {
						send({ type: 'ready', protocolVersion, runId: configuration.runId, instanceId: storage.instanceId });
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
