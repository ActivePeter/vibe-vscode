/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { VibeProjectContext } from 'vibe-vscode';
import type { HostContext } from '../src/simSurface.ts';
import { bundle, waitFor } from './testUtils.mts';

const compiled = bundle('projectContext');
const require = createRequire(import.meta.url);
const snapshot = (generation: number): VibeProjectContext => ({
	version: 1, generation,
	physicalWorkspace: { id: 'physical', name: 'Projects', remoteAuthority: '', folders: [{ name: 'Project', uri: 'file:///project', index: 0 }] },
	logicalWorkspaces: [{ id: `logical-${generation}`, name: 'Work' }],
	logicalWorkspace: { id: `logical-${generation}`, name: 'Work' }, project: { uri: 'file:///project', name: 'Project' },
});

function create() {
	const commandHandlers = new Map<string, (snapshot: VibeProjectContext) => void>();
	const commands: string[] = [];
	const events: HostContext[] = [];
	const writes: { generation: number; runId: string }[] = [];
	const errors: Error[] = [];
	let read = async () => snapshot(1);
	let subscribe = async () => snapshot(1);
	let apply = async (_snapshot: VibeProjectContext, _runId: string) => { };
	const editor = { document: { uri: { toString: () => 'file:///project/file.ts' }, getText: () => { throw new Error('Automatic context must not read source text'); } }, selection: { start: { line: 1, character: 2 }, end: { line: 3, character: 4 } } };
	let activeChanged: ((value: typeof editor | undefined) => void) | undefined;
	const vscode = {
		EventEmitter: class<T> {
			private readonly listeners = new Set<(value: T) => void>();
			readonly event = (listener: (value: T) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
			fire(value: T) { for (const listener of this.listeners) { listener(value); } }
			dispose() { this.listeners.clear(); }
		},
		l10n: { t: (value: string) => value }, env: { language: 'zh-cn' },
		commands: {
			registerCommand: (id: string, handler: (value: VibeProjectContext) => void) => { commandHandlers.set(id, handler); return { dispose: () => commandHandlers.delete(id) }; },
			executeCommand: async (id: string) => { commands.push(id); return id === 'vibe-vscode.getProjectContext' ? read() : id === 'vibe-vscode.projectContext.subscribe' ? subscribe() : undefined; },
		},
		window: {
			activeTextEditor: editor as typeof editor | undefined,
			onDidChangeActiveTextEditor: (listener: typeof activeChanged) => { activeChanged = listener; return { dispose() { } }; },
			onDidChangeTextEditorSelection: () => ({ dispose() { } }),
		},
	};
	const { ProjectContext } = runInNewContext(`${compiled}\nmodule.exports;`, {
		module: { exports: {} }, require: (name: string) => name === 'vscode' ? vscode : require(name), Promise,
	}) as typeof import('../src/projectContext.ts');
	const project = new ProjectContext({ updateProjectContext: async (value, runId) => { writes.push({ generation: value.generation, runId }); await apply(value, runId); } }, error => errors.push(error));
	project.onDidChange(value => events.push(structuredClone(value)));
	return {
		project, commands, writes, errors, events,
		setRead: (value: typeof read) => { read = value; }, setSubscribe: (value: typeof subscribe) => { subscribe = value; }, setApply: (value: typeof apply) => { apply = value; },
		change: (value: VibeProjectContext) => commandHandlers.get('_vibe-vscode.sim.projectContextChanged')!(value),
		focusWebview: () => { vscode.window.activeTextEditor = undefined; activeChanged!(undefined); },
	};
}

describe('Sim project context projection', () => {
	it('resolves at authority readiness and retains the initiating read across subscription waits', async t => {
		const fixture = create(); t.after(() => fixture.project.dispose());
		const read = Promise.withResolvers<VibeProjectContext>(); const subscribed = Promise.withResolvers<VibeProjectContext>();
		fixture.setRead(() => read.promise); fixture.setSubscribe(() => subscribed.promise);
		const pending = fixture.project.read();
		assert.deepStrictEqual({ commands: fixture.commands, writes: fixture.writes }, { commands: ['vibe-vscode.getProjectContext', 'vibe-vscode.projectContext.subscribe'], writes: [] });
		read.resolve(snapshot(2));
		fixture.change(snapshot(3));
		subscribed.resolve(snapshot(3));
		assert.equal((await pending).logicalWorkspace?.id, 'logical-2');
	});

	it('publishes only after the lease owner applied the latest same-target generation', async t => {
		const fixture = create(); t.after(() => fixture.project.dispose());
		const first = Promise.withResolvers<void>(); const next = Promise.withResolvers<void>();
		fixture.setApply(value => value.generation === 1 ? first.promise : next.promise);
		const attaching = fixture.project.attach('run-a');
		await waitFor(() => fixture.writes.length === 1, 'first projection');
		fixture.change(snapshot(2)); first.resolve();
		await waitFor(() => fixture.writes.length === 2, 'latest projection');
		assert.deepStrictEqual(fixture.events, []);
		next.resolve();
		const context = await attaching;
		fixture.change(snapshot(1)); fixture.focusWebview();
		await waitFor(() => fixture.events.length === 2, 'selection projection');
		assert.deepStrictEqual({ generation: context.generation, writes: fixture.writes, events: fixture.events.map(value => [value.generation, value.activeFile?.uri, 'text' in (value.activeFile ?? {})]), errors: fixture.errors.length }, {
			generation: 2, writes: [{ generation: 1, runId: 'run-a' }, { generation: 2, runId: 'run-a' }], events: [[2, 'file:///project/file.ts', false], [2, 'file:///project/file.ts', false]], errors: 0,
		});
	});

	it('rejects an old runtime attachment and converges to the replacement owner', async t => {
		const fixture = create(); t.after(() => fixture.project.dispose());
		const first = Promise.withResolvers<void>();
		fixture.setApply((_value, runId) => runId === 'run-a' ? first.promise : Promise.resolve());
		const a = assert.rejects(fixture.project.attach('run-a'), /unavailable/);
		await waitFor(() => fixture.writes.length === 1, 'old owner projection');
		fixture.project.detach();
		fixture.change(snapshot(2));
		const b = fixture.project.attach('run-b');
		await waitFor(() => fixture.commands.filter(command => command === 'vibe-vscode.getProjectContext').length === 2, 'new owner read');
		first.resolve(); await a; await b;
		assert.deepStrictEqual({ writes: fixture.writes, generations: [...new Set(fixture.events.map(value => value.generation))] }, {
			writes: [{ generation: 1, runId: 'run-a' }, { generation: 2, runId: 'run-b' }], generations: [2],
		});
	});

	it('removes a subscription that completed after disposal', async () => {
		const fixture = create();
		const gate = Promise.withResolvers<VibeProjectContext>();
		fixture.setSubscribe(() => gate.promise);
		const reading = assert.rejects(fixture.project.read(), /unavailable/);
		fixture.project.dispose(); gate.resolve(snapshot(1)); await reading;
		assert.deepStrictEqual({ events: fixture.events, writes: fixture.writes, unsubscribes: fixture.commands.filter(command => command === 'vibe-vscode.projectContext.unsubscribe').length }, { events: [], writes: [], unsubscribes: 2 });
	});
});
