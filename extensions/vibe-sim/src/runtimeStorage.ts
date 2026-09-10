/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { isInstanceId, isRecord, SimRuntimeError } from './protocol';

async function readOrCreateIdentity(directory: string): Promise<string> {
	const identityPath = path.join(directory, 'instance.json');
	try {
		const file = await fs.open(identityPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const metadata = await file.stat();
			if (!metadata.isFile() || metadata.size > 1024) {
				throw new SimRuntimeError('invalidIdentity');
			}
			const value: unknown = JSON.parse(await file.readFile('utf8'));
			if (!isRecord(value) || value.version !== 1 || !isInstanceId(value.instanceId)) {
				throw new SimRuntimeError('invalidIdentity');
			}
			return value.instanceId;
		} finally {
			await file.close();
		}
	} catch (error) {
		if (error?.code !== 'ENOENT') {
			throw new SimRuntimeError('invalidIdentity');
		}
	}
	const instanceId = randomUUID();
	const file = await fs.open(identityPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		await file.writeFile(JSON.stringify({ version: 1, instanceId }) + '\n');
		await file.sync();
	} finally {
		await file.close();
	}
	return instanceId;
}

export interface RuntimeStorage {
	readonly directory: string;
	readonly instanceId: string;
	close(): Promise<void>;
}

/** The runtime alone owns identity creation and the writer lease, held until adapter cleanup completes. */
export async function acquireRuntimeStorage(stateDirectory: string): Promise<RuntimeStorage> {
	// Linux abstract sockets are kernel-owned leases: no stale PID file or unsafe stale-lock deletion.
	// Other platforms need an equivalent crash-safe lease before enabling the native adapter there.
	if (process.platform !== 'linux') {
		throw new SimRuntimeError('unsupportedPlatform');
	}
	let lease: net.Server | undefined;
	try {
		await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
		const directory = await fs.realpath(stateDirectory);
		const metadata = await fs.stat(directory, { bigint: true });
		const key = createHash('sha256').update(`${metadata.dev}:${metadata.ino}`).digest('hex');
		lease = net.createServer(socket => socket.destroy());
		const server = lease;
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen({ path: `\0vibe-sim-${key}` }, () => {
				server.removeListener('error', reject);
				resolve();
			});
		});
		const instanceId = await readOrCreateIdentity(directory);
		return { directory, instanceId, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
	} catch (error) {
		lease?.close();
		if (error instanceof SimRuntimeError) {
			throw error;
		}
		throw new SimRuntimeError(error?.code === 'EADDRINUSE' ? 'storageBusy' : 'storageUnavailable');
	}
}
