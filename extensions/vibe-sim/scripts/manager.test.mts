/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, it, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { VibeProjectContext } from 'vibe-vscode';
import type { InitializeMessage, ShutdownMessage } from '../src/protocol.ts';
import { bundle, createFixture, waitFor } from './testUtils.mts';

const compiled = bundle('managedRuntime');
const require = createRequire(import.meta.url);

class FakeChild extends EventEmitter {
	connected = true;
	readonly messages: (InitializeMessage | ShutdownMessage | { type: 'projectContext'; runId: string; requestId: string })[] = [];
	readonly signals: string[] = [];
	closeOnShutdown = true;

	send(message: (typeof this.messages)[number], callback: (error: Error | null) => void): boolean {
		this.messages.push(message);
		callback(null);
		if (message.type === 'shutdown' && this.closeOnShutdown) {
			queueMicrotask(() => this.close());
		}
		return true;
	}

	kill(signal: string): boolean {
		this.signals.push(signal);
		return false;
	}

	close(): void {
		this.connected = false;
		this.emit('close', 0, null);
	}
}

async function create(t: TestContext) {
	const fixture = await createFixture(t);
	const child = new FakeChild();
	const exports = runInNewContext(`${compiled}\nmodule.exports;`, {
		module: { exports: {} }, __dirname: fixture.distDirectory, process, setTimeout, clearTimeout,
		require: (name: string) => name === 'node:child_process' ? { fork: () => child } : require(name),
	}) as typeof import('../src/managedRuntime.ts');
	const runtime = new exports.ManagedSimRuntime(fixture.extensionDirectory, fixture.root, {
		shutdownTimeoutMs: 5, terminateTimeoutMs: 5, killTimeoutMs: 5, projectContextTimeoutMs: 30,
	});
	fixture.beforeCleanup(async () => { child.close(); await runtime.dispose(); });
	return {
		runtime, child,
		async initialized() {
			await waitFor(() => child.messages.length > 0, 'fake child initialized');
			return child.messages[0] as InitializeMessage;
		},
	};
}

describe('Sim parent lifecycle boundary failures', () => {
	it('does not publish a project write before its matching acknowledgement and fails closed on timeout', async t => {
		const { runtime, child, initialized } = await create(t);
		const started = runtime.start(); const { runId } = await initialized();
		child.emit('message', { type: 'ready', protocolVersion: 1, runId, instanceId: randomUUID() });
		await started;
		const snapshot: VibeProjectContext = { version: 1, generation: 1, physicalWorkspace: { id: 'physical', name: 'Project', remoteAuthority: '', folders: [] }, logicalWorkspaces: [] };
		let applied = false;
		const update = runtime.updateProjectContext(snapshot, runId).then(() => { applied = true; });
		const request = child.messages.find(message => message.type === 'projectContext')!;
		child.emit('message', { type: 'projectContextApplied', protocolVersion: 1, runId: randomUUID(), requestId: 'requestId' in request ? request.requestId : '' });
		await Promise.resolve(); assert.equal(applied, false);
		child.emit('message', { ...request, type: 'projectContextApplied', protocolVersion: 1 });
		await update;
		await assert.rejects(runtime.updateProjectContext({ ...snapshot, generation: 2 }, runId), { code: 'storageUnavailable' });
		await runtime.stop();
		assert.deepStrictEqual({ applied, phase: runtime.status.phase, error: runtime.status.error }, { applied: true, phase: 'failed', error: 'storageUnavailable' });
	});

	it('handles a child error event and joins its exit instead of leaking a pending start', async t => {
		const { runtime, child, initialized } = await create(t);
		const rejected = assert.rejects(runtime.start(), { code: 'startFailed' });
		await initialized();
		child.emit('error', new Error('private spawn error'));
		await rejected;
		await runtime.stop();
		assert.deepStrictEqual({ phase: runtime.status.phase, error: runtime.status.error, messages: child.messages.map(message => message.type) }, {
			phase: 'failed', error: 'startFailed', messages: ['initialize', 'shutdown'],
		});
	});

	it('keeps ownership after an unconfirmed exit and refuses a second writer', async t => {
		const { runtime, child, initialized } = await create(t);
		child.closeOnShutdown = false;
		const pending = runtime.start();
		const { runId } = await initialized();
		child.emit('message', { type: 'ready', protocolVersion: 1, runId, instanceId: randomUUID() });
		await pending;
		await assert.rejects(runtime.stop(), { code: 'stopTimedOut' });
		await assert.rejects(runtime.start(), { code: 'stopping' });
		assert.deepStrictEqual({ phase: runtime.status.phase, error: runtime.status.error, signals: child.signals, initializations: child.messages.filter(message => message.type === 'initialize').length }, {
			phase: 'failed', error: 'stopTimedOut', signals: ['SIGTERM', 'SIGKILL'], initializations: 1,
		});
		child.close();
		assert.equal(runtime.status.error, 'stopTimedOut');
	});

	it('ignores another generation and duplicate ready without changing authoritative identity', async t => {
		const { runtime, child, initialized } = await create(t);
		const pending = runtime.start();
		const { runId } = await initialized();
		child.emit('message', { type: 'ready', protocolVersion: 1, runId: randomUUID(), instanceId: randomUUID() });
		assert.equal(runtime.status.phase, 'starting');
		const instanceId = randomUUID();
		child.emit('message', { type: 'ready', protocolVersion: 1, runId, instanceId });
		const info = await pending;
		child.emit('message', { type: 'ready', protocolVersion: 1, runId, instanceId: randomUUID() });
		assert.deepStrictEqual({ info: info.instanceId, status: runtime.status.instanceId }, { info: instanceId, status: instanceId });
	});

	it('fails closed on an incompatible reply for the current generation', async t => {
		const { runtime, child, initialized } = await create(t);
		const rejected = assert.rejects(runtime.start(), { code: 'invalidProtocol' });
		const { runId } = await initialized();
		child.emit('message', { type: 'ready', protocolVersion: 2, runId, instanceId: randomUUID() });
		await rejected;
		await runtime.stop();
		assert.equal(runtime.status.error, 'invalidProtocol');
	});
});
