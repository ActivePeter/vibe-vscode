/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { createFixture, exists } from './testUtils.mts';

describe('Sim immutable runtime package boundary', () => {
	it('resolves only extension-owned resources after relocating to a path with spaces and URL metacharacters', async t => {
		const fixture = await createFixture(t);
		assert.deepStrictEqual(await fixture.loadRuntimePackage(fixture.extensionDirectory), {
			entrypoint: path.join(fixture.runtimeDirectory, 'adapter.mjs'), version: '0.0.1-test',
		});
	});

	it('fails explicitly when the package is missing, with no storage writes or shared-service fallback', async t => {
		const fixture = await createFixture(t);
		await fs.rm(fixture.runtimeDirectory, { recursive: true });
		const stateDirectory = path.join(fixture.root, 'not-created');
		const runtime = new fixture.Manager(fixture.extensionDirectory, stateDirectory);
		fixture.track(runtime);
		await assert.rejects(runtime.start(), { code: 'runtimeNotPackaged' });
		await runtime.stop();
		assert.deepStrictEqual({ phase: runtime.status.phase, error: runtime.status.error, storageCreated: await exists(stateDirectory) }, {
			phase: 'failed', error: 'runtimeNotPackaged', storageCreated: false,
		});
	});

	for (const [name, manifest, code] of [
		['malformed JSON', '{', 'invalidPackage'],
		['unknown protocol', JSON.stringify({ protocolVersion: 2, version: '0.0.1', entrypoint: './adapter.mjs' }), 'incompatiblePackage'],
		['path traversal', JSON.stringify({ protocolVersion: 1, version: '0.0.1', entrypoint: '../outside.mjs' }), 'invalidPackage'],
		['absolute path', JSON.stringify({ protocolVersion: 1, version: '0.0.1', entrypoint: '/adapter.mjs' }), 'invalidPackage'],
		['Windows absolute path', JSON.stringify({ protocolVersion: 1, version: '0.0.1', entrypoint: 'C:\\adapter.mjs' }), 'invalidPackage'],
		['invalid version', JSON.stringify({ protocolVersion: 1, version: {}, entrypoint: './adapter.mjs' }), 'invalidPackage'],
		['unsupported module format', JSON.stringify({ protocolVersion: 1, version: '0.0.1', entrypoint: './adapter.cjs' }), 'invalidPackage'],
	] as const) {
		it(`rejects ${name}`, async t => {
			const fixture = await createFixture(t);
			await fs.writeFile(path.join(fixture.runtimeDirectory, 'sim-runtime.json'), manifest);
			await assert.rejects(fixture.loadRuntimePackage(fixture.extensionDirectory), { code });
		});
	}

	for (const target of ['runtime-directory', 'manifest', 'entrypoint']) {
		it(`rejects a symlink escaping the package via ${target}`, { skip: process.platform === 'win32' }, async t => {
			const fixture = await createFixture(t);
			if (target === 'runtime-directory') {
				const outside = path.join(fixture.root, 'outside');
				await fs.rename(fixture.runtimeDirectory, outside);
				await fs.symlink(outside, fixture.runtimeDirectory);
			} else {
				const name = target === 'manifest' ? 'sim-runtime.json' : 'adapter.mjs';
				const inside = path.join(fixture.runtimeDirectory, name);
				const outside = path.join(fixture.extensionDirectory, name);
				await fs.rename(inside, outside);
				await fs.symlink(outside, inside);
			}
			await assert.rejects(fixture.loadRuntimePackage(fixture.extensionDirectory), { code: 'invalidPackage' });
		});
	}

	it('does not inherit ambient database, authentication, upstream or Node injection settings', async t => {
		const fixture = await createFixture(t);
		assert.deepStrictEqual(fixture.createRuntimeEnvironment({
			PATH: '/test/bin', LANG: 'en_US.UTF-8', DATABASE_URL: 'database', REDIS_URL: 'redis',
			SIM_DATABASE_URL: 'sim-database', VIBE_VSCODE_SIM_UPSTREAM: 'shared', VIBE_VSCODE_SIM_AGENT_TOKEN: 'token',
			AUTH_SECRET: 'secret', BETTER_AUTH_URL: 'auth', NODE_OPTIONS: '--inspect', LD_PRELOAD: 'inject',
			HOME: '/test/home', XDG_CONFIG_HOME: '/test/config', NODE_ENV: 'development',
		}), { PATH: '/test/bin', LANG: 'en_US.UTF-8', NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: '1' });
	});
});

describe('Sim persistent storage and adapter failures', { skip: process.platform !== 'linux' }, () => {
	for (const identity of ['{', JSON.stringify({ version: 2, instanceId: 'bad' }), JSON.stringify({ version: 1, instanceId: 'bad' })]) {
		it(`preserves and rejects invalid identity ${identity}`, async t => {
			const fixture = await createFixture(t);
			const { runtime, stateDirectory } = await fixture.createRuntime();
			const file = path.join(stateDirectory, 'instance.json');
			await fs.writeFile(file, identity);
			await assert.rejects(runtime.start(), { code: 'invalidIdentity' });
			await runtime.stop();
			assert.deepStrictEqual({ identity: await fs.readFile(file, 'utf8'), adapterStarted: await exists(path.join(stateDirectory, 'starts.jsonl')) }, { identity, adapterStarted: false });
		});
	}

	it('never follows an identity symlink or replaces its target', async t => {
		const fixture = await createFixture(t);
		const { runtime, stateDirectory } = await fixture.createRuntime();
		const outside = path.join(fixture.root, 'other-instance.json');
		await fs.writeFile(outside, 'preserve-other-instance');
		await fs.symlink(outside, path.join(stateDirectory, 'instance.json'));
		await assert.rejects(runtime.start(), { code: 'invalidIdentity' });
		await runtime.stop();
		assert.equal(await fs.readFile(outside, 'utf8'), 'preserve-other-instance');
	});

	it('rejects an unavailable storage directory', async t => {
		const fixture = await createFixture(t);
		const stateDirectory = path.join(fixture.root, 'file-not-directory');
		await fs.writeFile(stateDirectory, 'preserve');
		const runtime = new fixture.Manager(fixture.extensionDirectory, stateDirectory);
		fixture.track(runtime);
		await assert.rejects(runtime.start(), { code: 'storageUnavailable' });
		await runtime.stop();
		assert.equal(await fs.readFile(stateDirectory, 'utf8'), 'preserve');
	});

	for (const adapter of ['export const wrong = true;', 'export async function start() { return {}; }']) {
		it(`rejects an invalid adapter contract: ${adapter}`, async t => {
			const fixture = await createFixture(t);
			await fs.writeFile(path.join(fixture.runtimeDirectory, 'adapter.mjs'), adapter);
			const { runtime } = await fixture.createRuntime();
			await assert.rejects(runtime.start(), { code: 'invalidPackage' });
			await runtime.stop();
			assert.equal(runtime.status.error, 'invalidPackage');
		});
	}
});
