/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFixture, processExited, starts, waitFor } from './testUtils.mts';

test('the native root directory lease rejects a competing writer before IPC initialization and releases after exit', { skip: process.platform !== 'linux', timeout: 15_000 }, async t => {
	const fixture = await createFixture(t);
	const bin = path.join(fixture.runtimeDirectory, 'bin');
	await fs.mkdir(bin);
	await fs.copyFile(process.execPath, path.join(bin, 'node'));
	execFileSync('cc', ['-Wall', '-Wextra', '-Werror', '-O2', fileURLToPath(new URL('../native/process-supervisor.c', import.meta.url)), '-o', path.join(bin, 'process-supervisor')]);
	await fs.writeFile(path.join(fixture.runtimeDirectory, 'sim-runtime.json'), JSON.stringify({ protocolVersion: 1, version: '0.0.1-test', entrypoint: './adapter.mjs', supervisor: './bin/process-supervisor', node: './bin/node' }));
	const owner = await fixture.createRuntime();
	await owner.runtime.start();
	const alias = path.join(fixture.root, 'same-storage-alias'); await fs.symlink(owner.stateDirectory, alias);
	const contender = new fixture.Manager(fixture.extensionDirectory, alias); fixture.track(contender);
	await assert.rejects(contender.start(), { code: 'storageBusy' });
	await contender.stop();
	const before = { owner: owner.runtime.status.phase, contender: contender.status.error, starts: (await starts(owner.stateDirectory)).length };
	await owner.runtime.stop(); await contender.start();
	assert.deepStrictEqual({ before, after: contender.status.phase, starts: (await starts(owner.stateDirectory)).length }, { before: { owner: 'ready', contender: 'storageBusy', starts: 1 }, after: 'ready', starts: 2 });
});

for (const action of ['exit', 'stop', 'kill-owner'] as const) {
	test(`native supervisor releases its complete process group after ${action}`, { skip: process.platform !== 'linux', timeout: 15_000 }, async t => {
		const root = await fs.mkdtemp(path.join(tmpdir(), 'vibe-sim-supervisor-'));
		const supervisor = path.join(root, 'supervisor');
		const source = fileURLToPath(new URL('../native/process-supervisor.c', import.meta.url));
		execFileSync('cc', ['-Wall', '-Wextra', '-Werror', '-O2', source, '-o', supervisor]);
		const parent = fork(fileURLToPath(new URL('./fixtures/supervisorParent.mts', import.meta.url)), [
			supervisor, fileURLToPath(new URL('./fixtures/supervisedService.mts', import.meta.url)),
		], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
		const pids = Promise.withResolvers<{ supervisorPid: number; servicePid: number; descendantPid: number }>();
		parent.once('message', message => pids.resolve(message as Awaited<typeof pids.promise>));
		parent.once('error', pids.reject);
		parent.once('exit', () => pids.reject(new Error('Parent exited before its service was ready')));
		t.after(async () => {
			parent.kill('SIGKILL');
			await fs.rm(root, { recursive: true, force: true });
		});
		const tree = await pids.promise;
		if (action === 'kill-owner') {
			parent.kill('SIGKILL');
		} else {
			parent.send(action);
		}
		const allPids = [parent.pid!, tree.supervisorPid, tree.servicePid, tree.descendantPid];
		await waitFor(async () => (await Promise.all(allPids.map(processExited))).every(Boolean), 'supervised process tree exits', 10_000);
		assert.deepStrictEqual(await Promise.all(allPids.map(processExited)), [true, true, true, true]);
	});
}
