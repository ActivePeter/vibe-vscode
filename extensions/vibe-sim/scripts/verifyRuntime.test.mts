/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import { bundle, createFixture } from './testUtils.mts';

const require = createRequire(import.meta.url);
const { verifyNativeRuntime } = runInNewContext(`${bundle('verifyRuntime')}\nmodule.exports;`, {
	module: { exports: {} }, require, process,
}) as typeof import('../src/verifyRuntime.ts');

async function completeFixture(t: TestContext) {
	const fixture = await createFixture(t);
	for (const file of [
		'complete', 'application.mjs', 'realtime.mjs', 'application/apps/sim/server.js',
		'application/apps/sim/.next/BUILD_ID', 'application/apps/sim/.next/required-server-files.json',
		'application/node_modules/next/package.json', 'db/migrate.mjs', 'db/migrations/meta/_journal.json',
		'postgres/bin/postgres', 'postgres/bin/initdb', 'postgres/bin/psql', 'postgres/bin/createdb', 'bin/redis-server', 'bin/redis-cli', 'licenses/sim',
		'bin/process-supervisor', 'bin/node',
	]) {
		const target = path.join(fixture.runtimeDirectory, file);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, file === 'bin/node' ? '#!/bin/sh\nprintf "v24.0.0\\n"\n' : 'fixture-only', { mode: 0o755 });
	}
	await fs.writeFile(path.join(fixture.runtimeDirectory, 'sim-runtime.json'), JSON.stringify({
		protocolVersion: 1, version: '0.0.1-test', entrypoint: './adapter.mjs', supervisor: './bin/process-supervisor', node: './bin/node',
	}));
	return fixture;
}

describe('native package release gate', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, () => {
	it('rejects lifecycle-only fixtures as production packages', async t => {
		const fixture = await createFixture(t);
		await assert.rejects(verifyNativeRuntime(fixture.extensionDirectory), /full native Sim runtime/);
	});

	it('verifies a relocated complete package without opening user storage', async t => {
		const fixture = await completeFixture(t);
		const before = await fs.readdir(fixture.root);
		await verifyNativeRuntime(fixture.extensionDirectory);
		assert.deepStrictEqual(await fs.readdir(fixture.root), before);
	});

	for (const file of ['complete', 'application/apps/sim/.next/BUILD_ID', 'application/node_modules/next/package.json', 'db/migrations/meta/_journal.json', 'postgres/bin/initdb']) {
		it(`rejects a package missing ${file}`, async t => {
			const fixture = await completeFixture(t);
			await fs.rm(path.join(fixture.runtimeDirectory, file));
			await assert.rejects(verifyNativeRuntime(fixture.extensionDirectory));
		});
	}

	it('rejects a resource symlink outside the immutable package', async t => {
		const fixture = await completeFixture(t);
		const file = path.join(fixture.runtimeDirectory, 'licenses/sim');
		const outside = path.join(fixture.root, 'outside-license');
		await fs.rename(file, outside); await fs.symlink(outside, file);
		await assert.rejects(verifyNativeRuntime(fixture.extensionDirectory), /Invalid native Sim package resource/);
	});

	it('rejects non-executable database binaries and an incompatible packaged Node', async t => {
		const fixture = await completeFixture(t);
		const postgres = path.join(fixture.runtimeDirectory, 'postgres/bin/postgres');
		await fs.chmod(postgres, 0o644);
		await assert.rejects(verifyNativeRuntime(fixture.extensionDirectory), /Invalid native Sim package resource/);
		await fs.chmod(postgres, 0o755);
		await fs.writeFile(path.join(fixture.runtimeDirectory, 'bin/node'), '#!/bin/sh\nprintf "v20.0.0\\n"\n');
		await assert.rejects(verifyNativeRuntime(fixture.extensionDirectory), /Node.js 24/);
	});
});
