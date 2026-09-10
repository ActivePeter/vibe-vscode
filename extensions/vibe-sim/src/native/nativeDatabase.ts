/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createConnection, createServer, Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createRuntimeEnvironment } from '../managedRuntime';
import { isRecord, SimRuntimeError } from '../protocol';
import { NativeProcess, waitForNativeService } from './nativeProcess';

interface NativeSecrets {
	readonly database: string;
	readonly redis: string;
	readonly authentication: string;
	readonly encryption: string;
	readonly internal: string;
	readonly gateway: string;
}

/** Persistent credentials are created inside the storage lease; malformed data is never replaced. */
async function readSecrets(directory: string): Promise<NativeSecrets> {
	const file = path.join(directory, 'secrets.json');
	const names = ['database', 'redis', 'authentication', 'encryption', 'internal', 'gateway'] as const;
	let metadata;
	try {
		metadata = await fs.lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}
	if (metadata) {
		if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
			throw new SimRuntimeError('storageUnavailable');
		}
		const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
		if (!isRecord(value) || names.some(name => typeof value[name] !== 'string' || !/^[a-f0-9]{64}$/.test(value[name]))) {
			throw new SimRuntimeError('storageUnavailable');
		}
		return {
			database: value.database as string, redis: value.redis as string,
			authentication: value.authentication as string, encryption: value.encryption as string,
			internal: value.internal as string, gateway: value.gateway as string,
		};
	}
	const value: NativeSecrets = {
		database: randomBytes(32).toString('hex'), redis: randomBytes(32).toString('hex'),
		authentication: randomBytes(32).toString('hex'), encryption: randomBytes(32).toString('hex'),
		internal: randomBytes(32).toString('hex'), gateway: randomBytes(32).toString('hex'),
	};
	const handle = await fs.open(file, 'wx', 0o600);
	try {
		await handle.writeFile(JSON.stringify(value));
		await handle.sync();
	} finally {
		await handle.close();
	}
	return value;
}

/** Owns both the ephemeral socket and every accepted proxy connection. */
async function forwardUnixSocket(socketPath: string): Promise<{ port: number; close(): Promise<void> }> {
	const connections = new Set<Socket>();
	const server: Server = createServer(client => {
		connections.add(client);
		const upstream = createConnection(socketPath);
		connections.add(upstream);
		client.once('close', () => { connections.delete(client); upstream.destroy(); });
		upstream.once('close', () => { connections.delete(upstream); client.destroy(); });
		client.on('error', () => upstream.destroy());
		upstream.on('error', () => client.destroy());
		client.pipe(upstream).pipe(client);
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		server.close();
		throw new SimRuntimeError('startFailed');
	}
	return {
		port: address.port,
		close: async () => {
			for (const connection of connections) {
				connection.destroy();
			}
			await new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
}

/** The package owns binaries; this instance exclusively owns the native database and queue. */
export async function startNativeDatabase(packageDirectory: string, stateDirectory: string, signal: AbortSignal) {
	const environment: NodeJS.ProcessEnv = {
		...createRuntimeEnvironment(process.env), HOME: stateDirectory,
		LD_LIBRARY_PATH: path.join(packageDirectory, 'postgres/lib'),
	};
	const secrets = await readSecrets(stateDirectory);
	const temporary = await fs.mkdtemp(path.join(tmpdir(), 'vibe-sim-sockets-'));
	await fs.chmod(temporary, 0o700);
	const pgSocketDirectory = path.join(temporary, 'pg');
	const redisSocket = path.join(temporary, 'redis.sock');
	await fs.mkdir(pgSocketDirectory, { mode: 0o700 });
	const pgData = path.join(stateDirectory, 'postgres');
	const pgBinary = (name: string) => path.join(packageDirectory, 'postgres/bin', name);
	const children = new Set<NativeProcess>();
	const proxies: Awaited<ReturnType<typeof forwardUnixSocket>>[] = [];
	let stopPromise: Promise<void> | undefined;
	const stop = () => stopPromise ??= (async () => {
		await Promise.all(proxies.map(proxy => proxy.close()));
		await Promise.all([...children].map(child => child.stop()));
		await fs.rm(temporary, { recursive: true, force: true });
	})();
	const start = (executable: string, args: string[], cwd = stateDirectory, env = environment) => {
		if (signal.aborted) {
			throw new SimRuntimeError('cancelled');
		}
		const child = new NativeProcess(packageDirectory, executable, args, cwd, env);
		children.add(child);
		void child.closed.then(() => children.delete(child));
		return child;
	};
	const pgEnvironment = { ...environment, PGHOST: pgSocketDirectory, PGPORT: '5432', PGUSER: 'sim', PGPASSWORD: secrets.database };
	try {
		let databaseExists = false;
		try {
			const entry = await fs.lstat(pgData);
			if (!entry.isDirectory() || entry.isSymbolicLink() || (await fs.readFile(path.join(pgData, 'PG_VERSION'), 'utf8')).trim() !== '17') {
				throw new SimRuntimeError('storageUnavailable');
			}
			databaseExists = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
			// An existing but incomplete database is not a fresh installation.
			if (await fs.lstat(pgData).then(() => true, error => {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
				return false;
			})) {
				throw new SimRuntimeError('storageUnavailable');
			}
		}
		if (!databaseExists) {
			const staging = path.join(stateDirectory, `postgres.initializing-${randomUUID()}`);
			const passwordFile = path.join(temporary, 'pg-password');
			let initialized = false;
			try {
				await fs.writeFile(passwordFile, secrets.database, { flag: 'wx', mode: 0o600 });
				await start(pgBinary('initdb'), ['-D', staging, '--username=sim', '--pwfile', passwordFile, '--auth-local=scram-sha-256', '--auth-host=scram-sha-256', '--encoding=UTF8', '--locale=C']).result(signal);
				await fs.rename(staging, pgData);
				initialized = true;
			} finally {
				await fs.rm(passwordFile, { force: true });
				if (!initialized && ![...children].some(child => !child.isClosed)) {
					await fs.rm(staging, { recursive: true, force: true });
				}
			}
		}
		const postgres = start(pgBinary('postgres'), ['-D', pgData, '-h', '', '-k', pgSocketDirectory, '-p', '5432', '-c', 'unix_socket_permissions=0600', '-c', 'max_connections=60', '-c', 'shared_buffers=32MB']);
		await waitForNativeService(postgres, async () => {
			try {
				await start(pgBinary('psql'), ['-d', 'postgres', '-Atc', 'SELECT 1'], stateDirectory, pgEnvironment).result(signal);
				return true;
			} catch {
				return false;
			}
		}, signal);
		const present = await start(pgBinary('psql'), ['-d', 'postgres', '-Atc', `SELECT 1 FROM pg_database WHERE datname = 'sim'`], stateDirectory, pgEnvironment).result(signal);
		if (present.trim() !== '1') {
			await start(pgBinary('createdb'), ['sim'], stateDirectory, pgEnvironment).result(signal);
		}
		const redisConfig = path.join(temporary, 'redis.conf');
		const redisData = path.join(stateDirectory, 'redis');
		await fs.mkdir(redisData, { recursive: true, mode: 0o700 });
		await fs.writeFile(redisConfig, `port 0\nunixsocket ${JSON.stringify(redisSocket)}\nunixsocketperm 600\nsave ""\nappendonly yes\nappendfsync everysec\nrequirepass ${secrets.redis}\nprotected-mode yes\ndir ${JSON.stringify(redisData)}\n`, { flag: 'wx', mode: 0o600 });
		const redis = start(path.join(packageDirectory, 'bin/redis-server'), [redisConfig]);
		await waitForNativeService(redis, async () => {
			try {
				const output = await start(path.join(packageDirectory, 'bin/redis-cli'), ['-s', redisSocket, 'PING'], stateDirectory, { ...environment, REDISCLI_AUTH: secrets.redis }).result(signal);
				return output.trim() === 'PONG';
			} catch {
				return false;
			}
		}, signal);
		const databaseProxy = await forwardUnixSocket(path.join(pgSocketDirectory, '.s.PGSQL.5432'));
		proxies.push(databaseProxy);
		const redisProxy = await forwardUnixSocket(redisSocket);
		proxies.push(redisProxy);
		return {
			environment: {
				DATABASE_URL: `postgres://sim:${secrets.database}@127.0.0.1:${databaseProxy.port}/sim`,
				REDIS_URL: `redis://:${secrets.redis}@127.0.0.1:${redisProxy.port}`,
				BETTER_AUTH_SECRET: secrets.authentication, ENCRYPTION_KEY: secrets.encryption,
				INTERNAL_API_SECRET: secrets.internal, VIBE_VSCODE_AGENT_GATEWAY_SECRET: secrets.gateway,
			},
			closed: Promise.race([postgres.closed, redis.closed]),
			stop,
		};
	} catch (error) {
		await stop();
		throw error;
	}
}
