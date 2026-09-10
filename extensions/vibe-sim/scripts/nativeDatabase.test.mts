/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { buildSync } from 'esbuild';

const services = process.env.VIBE_SIM_NATIVE_TEST_SERVICES;
const require = createRequire(import.meta.url);
const exec = promisify(execFile);

test('native PostgreSQL and Redis have independent credentials, data, lifetimes and restart state', { skip: !services, timeout: 180_000 }, async t => {
	const root = await fs.mkdtemp(path.join(tmpdir(), 'vibe-sim-native-test-'));
	const packageDirectory = path.join(root, 'relocated package');
	const instances: { stop(): Promise<void> }[] = [];
	t.after(async () => {
		await Promise.all(instances.map(instance => instance.stop()));
		await fs.rm(root, { recursive: true, force: true });
	});
	await fs.mkdir(packageDirectory);
	await Promise.all([
		exec('cp', ['-a', path.join(services!, 'bin'), path.join(packageDirectory, 'bin')], { signal: t.signal }),
		exec('cp', ['-a', path.join(services!, 'sim-postgres'), path.join(packageDirectory, 'postgres')], { signal: t.signal }),
	]);
	t.diagnostic('Relocated the packaged PostgreSQL and Redis binaries');
	const code = buildSync({
		entryPoints: [new URL('../src/native/nativeDatabase.ts', import.meta.url).pathname],
		bundle: true, format: 'cjs', platform: 'node', write: false,
	}).outputFiles[0].text;
	const moduleFile = path.join(root, 'native.cjs');
	await fs.writeFile(moduleFile, code);
	const { startNativeDatabase } = require(moduleFile) as typeof import('../src/native/nativeDatabase.ts');
	const stateA = path.join(root, 'state-a');
	const stateB = path.join(root, 'state-b');
	await Promise.all([stateA, stateB].map(directory => fs.mkdir(directory, { mode: 0o700 })));
	const [a, b] = await Promise.all([stateA, stateB].map(async state => {
		const instance = await startNativeDatabase(packageDirectory, state, t.signal);
		instances.push(instance);
		return instance;
	}));
	t.diagnostic('Both isolated databases passed their readiness probes');
	type Database = Awaited<ReturnType<typeof startNativeDatabase>>;
	const query = async (instance: Database, sql: string, password?: string) => {
		const address = new URL(instance.environment.DATABASE_URL);
		const result = await exec(path.join(packageDirectory, 'postgres/bin/psql'), ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
			timeout: 5000,
			env: { LD_LIBRARY_PATH: path.join(packageDirectory, 'postgres/lib'), PGHOST: address.hostname, PGPORT: address.port, PGUSER: address.username, PGPASSWORD: password ?? address.password, PGDATABASE: 'sim' },
		});
		return result.stdout.trim();
	};
	const redis = async (instance: Database, ...args: string[]) => {
		const address = new URL(instance.environment.REDIS_URL);
		const result = await exec(path.join(packageDirectory, 'bin/redis-cli'), ['--raw', '-h', address.hostname, '-p', address.port, ...args], {
			timeout: 5000, env: { REDISCLI_AUTH: address.password },
		});
		return result.stdout.trim();
	};
	await Promise.all([
		query(a, `CREATE EXTENSION vector; CREATE EXTENSION btree_gin; CREATE TABLE isolation_probe (value text); INSERT INTO isolation_probe VALUES ('A')`),
		query(b, `CREATE EXTENSION vector; CREATE TABLE isolation_probe (value text); INSERT INTO isolation_probe VALUES ('B')`),
		redis(a, 'SET', 'native-turn', 'A'), redis(b, 'SET', 'native-turn', 'B'),
	]);
	const snapshot = {
		databaseA: await query(a, 'SELECT value FROM isolation_probe'),
		databaseB: await query(b, 'SELECT value FROM isolation_probe'),
		queueA: await redis(a, 'GET', 'native-turn'),
		queueB: await redis(b, 'GET', 'native-turn'),
		distinctCredentials: new URL(a.environment.DATABASE_URL).password !== new URL(b.environment.DATABASE_URL).password,
	};
	await assert.rejects(query(b, 'SELECT 1', new URL(a.environment.DATABASE_URL).password));
	await a.stop();
	const afterStop = await query(b, 'SELECT value FROM isolation_probe');
	const restarted = await startNativeDatabase(packageDirectory, stateA, t.signal);
	instances.push(restarted);
	assert.deepStrictEqual({ ...snapshot, afterStop, restarted: await query(restarted, 'SELECT value FROM isolation_probe'), restartedQueue: await redis(restarted, 'GET', 'native-turn') }, {
		databaseA: 'A', databaseB: 'B', queueA: 'A', queueB: 'B', distinctCredentials: true, afterStop: 'B', restarted: 'A', restartedQueue: 'A',
	});
});
