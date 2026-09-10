/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { createFixture, exists, processExited, starts, waitFor } from './testUtils.mts';

describe('Sim runtime lifecycle with real private child processes', { skip: process.platform !== 'linux', timeout: 60000 }, () => {
	it('coalesces concurrent starts and does not advertise readiness before the adapter barrier', async t => {
		const fixture = await createFixture(t);
		const { runtime, stateDirectory } = await fixture.createRuntime('workspace-a', 'barrier');
		const first = runtime.start();
		const second = runtime.start();
		let resolved = false;
		void first.then(() => { resolved = true; }, () => { });
		await waitFor(() => exists(path.join(stateDirectory, 'starts.jsonl')), 'adapter entered start');
		assert.deepStrictEqual({ coalesced: first === second, phase: runtime.status.phase, resolved, count: (await starts(stateDirectory)).length }, {
			coalesced: true, phase: 'starting', resolved: false, count: 1,
		});
		await fs.writeFile(path.join(stateDirectory, 'release'), 'ready');
		const info = await first;
		assert.deepStrictEqual({ phase: runtime.status.phase, instanceId: (await starts(stateDirectory))[0].instanceId, frozen: Object.isFrozen(runtime.status) }, {
			phase: 'ready', instanceId: info.instanceId, frozen: true,
		});
	});

	it('isolates two storage roots and stopping one does not stop or write into the other', async t => {
		const fixture = await createFixture(t);
		const a = await fixture.createRuntime('instance-a/workspace');
		const b = await fixture.createRuntime('instance-b/workspace');
		const [one, two] = await Promise.all([a.runtime.start(), b.runtime.start()]);
		await a.runtime.stop();
		assert.deepStrictEqual({
			differentIdentity: one.instanceId !== two.instanceId,
			differentProcess: (await starts(a.stateDirectory))[0].pid !== (await starts(b.stateDirectory))[0].pid,
			a: a.runtime.status.phase, b: b.runtime.status.phase,
			aStopped: await exists(path.join(a.stateDirectory, 'stopped')), bStopped: await exists(path.join(b.stateDirectory, 'stopped')),
			bStarts: (await starts(b.stateDirectory)).length,
		}, { differentIdentity: true, differentProcess: true, a: 'stopped', b: 'ready', aStopped: true, bStopped: false, bStarts: 1 });
	});

	it('rejects another writer including a symlink alias without disturbing the owner', async t => {
		const fixture = await createFixture(t);
		const owner = await fixture.createRuntime();
		await owner.runtime.start();
		const alias = path.join(fixture.root, 'same-storage-alias');
		await fs.symlink(owner.stateDirectory, alias);
		const contender = new fixture.Manager(fixture.extensionDirectory, alias);
		fixture.track(contender);
		await assert.rejects(contender.start(), { code: 'storageBusy' });
		await contender.stop();
		assert.deepStrictEqual({ owner: owner.runtime.status.phase, contender: contender.status.error, writes: (await starts(owner.stateDirectory)).length }, {
			owner: 'ready', contender: 'storageBusy', writes: 1,
		});
		await owner.runtime.stop();
		await contender.start();
		assert.equal((await starts(owner.stateDirectory)).length, 2);
	});

	it('preserves the durable identity and existing data across a new child generation', async t => {
		const fixture = await createFixture(t);
		const { runtime, stateDirectory } = await fixture.createRuntime();
		const first = await runtime.start();
		await fs.writeFile(path.join(stateDirectory, 'conversation.txt'), 'existing conversation');
		await runtime.stop();
		const second = await runtime.start();
		const identity = JSON.parse(await fs.readFile(path.join(stateDirectory, 'instance.json'), 'utf8'));
		assert.deepStrictEqual({
			sameIdentity: first.instanceId === second.instanceId, newGeneration: first.runId !== second.runId,
			identity, data: await fs.readFile(path.join(stateDirectory, 'conversation.txt'), 'utf8'),
			mode: (await fs.stat(path.join(stateDirectory, 'instance.json'))).mode & 0o777,
		}, { sameIdentity: true, newGeneration: true, identity: { version: 1, instanceId: first.instanceId }, data: 'existing conversation', mode: 0o600 });
	});

	it('cancels during package loading and never revives the cancelled generation', async t => {
		const fixture = await createFixture(t);
		const { runtime, stateDirectory } = await fixture.createRuntime();
		const pending = runtime.start();
		const rejected = assert.rejects(pending, { code: 'cancelled' });
		await runtime.stop();
		await rejected;
		assert.deepStrictEqual({ phase: runtime.status.phase, identity: await exists(path.join(stateDirectory, 'instance.json')) }, { phase: 'stopped', identity: false });
		await runtime.start();
		assert.equal((await starts(stateDirectory)).length, 1);
	});

	it('cancels an adapter in start, stops its late result and waits for actual process exit', async t => {
		const fixture = await createFixture(t);
		const phases: string[] = [];
		const { runtime, stateDirectory } = await fixture.createRuntime('workspace-a', 'barrier', { onDidChangeStatus: status => phases.push(status.phase) });
		const pending = runtime.start();
		const rejected = assert.rejects(pending, { code: 'cancelled' });
		await waitFor(() => exists(path.join(stateDirectory, 'starts.jsonl')), 'adapter startup');
		const [{ pid }] = await starts(stateDirectory);
		const stopping = runtime.stop();
		await assert.rejects(runtime.start(), { code: 'stopping' });
		await waitFor(() => exists(path.join(stateDirectory, 'aborted')), 'startup cancellation delivery');
		await fs.writeFile(path.join(stateDirectory, 'release'), 'late result');
		await Promise.all([rejected, stopping]);
		assert.deepStrictEqual({ phases, stopped: await exists(path.join(stateDirectory, 'stopped')), exited: await processExited(pid) }, {
			phases: ['starting', 'stopping', 'stopped'], stopped: true, exited: true,
		});
	});

	it('ignores an actual ready IPC message sent after shutdown was requested', async t => {
		const fixture = await createFixture(t);
		await fs.writeFile(path.join(fixture.distDirectory, 'runtimeHost.js'), fixture.lateHostBundle);
		const phases: string[] = [];
		const { runtime, stateDirectory } = await fixture.createRuntime('workspace-a', 'ready', { onDidChangeStatus: status => phases.push(status.phase) });
		const rejected = assert.rejects(runtime.start(), { code: 'cancelled' });
		await waitFor(() => exists(path.join(stateDirectory, 'late-host-started')), 'misbehaving child started');
		await runtime.stop();
		await rejected;
		assert.deepStrictEqual(phases, ['starting', 'stopping', 'stopped']);
	});

	it('bounds a hung startup, reaps the owned child and permits an explicit retry', async t => {
		const fixture = await createFixture(t);
		const { runtime, stateDirectory } = await fixture.createRuntime('workspace-a', 'hang-start', {
			startupTimeoutMs: 700, shutdownTimeoutMs: 50, terminateTimeoutMs: 50,
		});
		await assert.rejects(runtime.start(), { code: 'startTimedOut' });
		await runtime.stop();
		const [{ pid }] = await starts(stateDirectory);
		assert.deepStrictEqual({ phase: runtime.status.phase, error: runtime.status.error, exited: await processExited(pid) }, {
			phase: 'failed', error: 'startTimedOut', exited: true,
		});
		await fs.writeFile(path.join(stateDirectory, 'control.json'), JSON.stringify({ mode: 'ready' }));
		await runtime.start();
		assert.equal((await starts(stateDirectory)).length, 2);
	});

	for (const mode of ['crash-start', 'fail-start']) {
		it(`reports ${mode} without publishing adapter details or replaying work`, async t => {
			const fixture = await createFixture(t);
			const { runtime, stateDirectory } = await fixture.createRuntime('workspace-a', mode);
			const expected = mode === 'crash-start' ? 'runtimeExited' : 'startFailed';
			await assert.rejects(runtime.start(), { code: expected, message: expected });
			await runtime.stop();
			assert.deepStrictEqual({ phase: runtime.status.phase, error: runtime.status.error, writes: (await starts(stateDirectory)).length }, { phase: 'failed', error: expected, writes: 1 });
		});
	}

	it('reports a crash after readiness and leaves persistent data untouched', async t => {
		const fixture = await createFixture(t);
		const { runtime, stateDirectory } = await fixture.createRuntime();
		const first = await runtime.start();
		await fs.writeFile(path.join(stateDirectory, 'crash'), 'crash');
		await waitFor(() => runtime.status.phase === 'failed', 'crash observation');
		assert.deepStrictEqual({ error: runtime.status.error, identity: JSON.parse(await fs.readFile(path.join(stateDirectory, 'instance.json'), 'utf8')), writes: (await starts(stateDirectory)).length }, {
			error: 'runtimeExited', identity: { version: 1, instanceId: first.instanceId }, writes: 1,
		});
	});

	it('bounds an uncooperative stop and never signals the other instance', async t => {
		const fixture = await createFixture(t);
		const a = await fixture.createRuntime('a', 'hang-stop', { shutdownTimeoutMs: 50, terminateTimeoutMs: 50 });
		const b = await fixture.createRuntime('b');
		await Promise.all([a.runtime.start(), b.runtime.start()]);
		const [{ pid }] = await starts(a.stateDirectory);
		await a.runtime.stop();
		assert.deepStrictEqual({ a: a.runtime.status.phase, aExited: await processExited(pid), b: b.runtime.status.phase, bStopped: await exists(path.join(b.stateDirectory, 'stopped')) }, {
			a: 'stopped', aExited: true, b: 'ready', bStopped: false,
		});
	});

	it('keeps a failed adapter stop visible after exit and releases its storage lease', async t => {
		const fixture = await createFixture(t);
		const { runtime, stateDirectory } = await fixture.createRuntime('workspace-a', 'fail-stop');
		await runtime.start();
		await runtime.stop();
		assert.deepStrictEqual({ phase: runtime.status.phase, error: runtime.status.error }, { phase: 'failed', error: 'stopFailed' });
		await fs.writeFile(path.join(stateDirectory, 'control.json'), JSON.stringify({ mode: 'ready' }));
		await runtime.start();
	});

	it('makes dispose idempotent and refuses all subsequent starts', async t => {
		const fixture = await createFixture(t);
		const { runtime, stateDirectory } = await fixture.createRuntime();
		await runtime.start();
		const first = runtime.dispose();
		const second = runtime.dispose();
		await Promise.all([first, second]);
		await assert.rejects(runtime.start(), { code: 'disposed' });
		assert.deepStrictEqual({ coalesced: first === second, writes: (await starts(stateDirectory)).length, stopped: runtime.status.phase }, { coalesced: true, writes: 1, stopped: 'stopped' });
	});

	it('keeps lifecycle and cleanup independent of a failing status observer', async t => {
		const fixture = await createFixture(t);
		const phases: string[] = [];
		const { runtime, stateDirectory } = await fixture.createRuntime('workspace-a', 'ready', {
			onDidChangeStatus: status => { phases.push(status.phase); throw new Error('disposed output channel'); },
		});
		await runtime.start();
		await runtime.dispose();
		assert.deepStrictEqual({ phases, stopped: await exists(path.join(stateDirectory, 'stopped')) }, {
			phases: ['starting', 'ready', 'stopping', 'stopped'], stopped: true,
		});
	});

	for (const mode of ['ready', 'hang-stop']) {
		it(`cleans up after Extension Host IPC disconnect (${mode}), without deactivate`, async t => {
			const fixture = await createFixture(t);
			const { runtime, stateDirectory } = await fixture.createRuntime('workspace-a', mode);
			const parent = fork(path.join(fixture.distDirectory, 'parent.mjs'), [path.join(fixture.distDirectory, 'manager.cjs'), fixture.extensionDirectory, stateDirectory], {
				execArgv: ['--conditions=fixture-parent'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
				env: { ...process.env, DATABASE_URL: 'shared-fixture', REDIS_URL: 'shared-fixture', SIM_TOKEN: 'shared-fixture', NODE_OPTIONS: '--conditions=fixture-parent' },
			});
			const closed = once(parent, 'close');
			fixture.beforeCleanup(async () => {
				if (parent.exitCode === null && parent.signalCode === null) {
					parent.kill('SIGKILL');
				}
				await closed;
				if (await exists(path.join(stateDirectory, 'starts.jsonl'))) {
					const [{ pid }] = await starts(stateDirectory);
					await waitFor(() => processExited(pid), 'orphan runtime exit');
				}
			});
			await Promise.race([once(parent, 'message'), closed.then(() => { throw new Error('Fixture parent exited before readiness'); })]);
			const [{ pid, ambientConfiguration, execArgv }] = await starts(stateDirectory);
			parent.send({ type: 'crash-parent' });
			await closed;
			await waitFor(() => processExited(pid), 'runtime observed parent disconnect');
			assert.deepStrictEqual({ ambientConfiguration, execArgv, aborted: await exists(path.join(stateDirectory, 'aborted')), graceful: await exists(path.join(stateDirectory, 'stopped')) }, {
				ambientConfiguration: [], execArgv: [], aborted: true, graceful: mode === 'ready',
			});
			await fs.writeFile(path.join(stateDirectory, 'control.json'), JSON.stringify({ mode: 'ready' }));
			await runtime.start(); // The kernel lease was released even on the forced orphan-exit path.
		});
	}
});
