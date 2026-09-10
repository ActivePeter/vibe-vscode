/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import type { VibeProjectContext } from 'vibe-vscode';

const compiled = buildSync({
	entryPoints: [fileURLToPath(new URL('../src/extension.ts', import.meta.url))],
	bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false,
}).outputFiles[0].text;

function create() {
	const commands = new Map<string, (message?: unknown) => unknown>();
	const calls: { command: string; args: unknown[] }[] = [];
	const snapshot: VibeProjectContext = {
		version: 1, generation: 1,
		physicalWorkspace: { id: 'physical', name: 'Example', remoteAuthority: '', folders: [{ name: 'Example', uri: 'file:///project', index: 0 }] },
		logicalWorkspaces: [{ id: 'logical', name: 'Work' }],
		logicalWorkspace: { id: 'logical', name: 'Work' },
		project: { name: 'Example', uri: 'file:///project' },
	};
	let read = async () => snapshot;
	const vscode = {
		EventEmitter: class<T> {
			private readonly listeners = new Set<(event: T) => void>();
			readonly event = (listener: (event: T) => void) => {
				this.listeners.add(listener);
				return { dispose: () => this.listeners.delete(listener) };
			};
			fire(value: T) { for (const listener of this.listeners) { listener(value); } }
			dispose() { this.listeners.clear(); }
		},
		l10n: { t: (value: string) => value },
		commands: {
			registerCommand: (id: string, handler: (message?: unknown) => unknown) => {
				commands.set(id, handler);
				return { dispose: () => commands.delete(id) };
			},
			executeCommand: async (command: string, ...args: unknown[]) => {
				calls.push({ command, args: structuredClone(args) });
				return command === 'vibe-vscode.getProjectContext' ? read() : undefined;
			},
		},
	};
	const extension = runInNewContext(`${compiled}\nmodule.exports;`, {
		module: { exports: {} }, require: (name: string) => { assert.strictEqual(name, 'vscode'); return vscode; },
	}) as typeof import('../src/extension.ts');
	const context: Pick<Parameters<typeof extension.activate>[0], 'subscriptions'> = { subscriptions: [] };
	const api = extension.activate(context as Parameters<typeof extension.activate>[0]);
	return {
		commands, calls, api, snapshot,
		setRead: (handler: typeof read) => { read = handler; },
		dispose: () => { for (const subscription of context.subscriptions) { subscription.dispose(); } },
	};
}

describe('Vibe public project context API', () => {
	it('owns only the public context contract, without any Sim UI or private capability adapter', () => {
		const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		assert.deepStrictEqual({ contributes: manifest.contributes, proposals: manifest.enabledApiProposals, commands: [...create().commands.keys()] }, {
			contributes: undefined, proposals: undefined,
			commands: ['_vibe-vscode.projectContext.changed', 'vibe-vscode.projectContext.subscribe', 'vibe-vscode.projectContext.unsubscribe'],
		});
	});

	it('returns an immutable ready snapshot to same-host exports and cross-host commands', async () => {
		const { api, commands, snapshot } = create();
		const direct = await api.getProjectContext();
		const remote = await commands.get('vibe-vscode.projectContext.subscribe')!({ id: 'consumer', command: 'consumer.changed' }) as VibeProjectContext;
		assert.deepStrictEqual({ direct: structuredClone(direct), remote: structuredClone(remote), frozen: [Object.isFrozen(direct), Object.isFrozen(remote.physicalWorkspace.folders[0]), Object.isFrozen(remote.logicalWorkspaces)] }, {
			direct: snapshot, remote: snapshot, frozen: [true, true, true],
		});
	});

	it('subscribes before readiness and preserves the initiating snapshot while newer events arrive', async () => {
		const { api, commands, calls, snapshot, setRead } = create();
		const gate = Promise.withResolvers<VibeProjectContext>();
		setRead(() => gate.promise);
		const received: number[] = [];
		api.onDidChangeProjectContext(value => received.push(value.generation));
		const pending = commands.get('vibe-vscode.projectContext.subscribe')!({ id: 'consumer', command: 'consumer.changed' });
		commands.get('_vibe-vscode.projectContext.changed')!({ ...snapshot, generation: 3 });
		gate.resolve(snapshot);
		const initial = await pending as VibeProjectContext;
		commands.get('_vibe-vscode.projectContext.changed')!({ ...snapshot, generation: 2 });
		commands.get('vibe-vscode.projectContext.unsubscribe')!('consumer');
		commands.get('_vibe-vscode.projectContext.changed')!({ ...snapshot, generation: 4 });
		assert.deepStrictEqual({ initial: initial.generation, received, remote: calls.filter(call => call.command === 'consumer.changed').map(call => (call.args[0] as VibeProjectContext).generation) }, {
			initial: 1, received: [3, 4], remote: [3],
		});
	});

	it('does not regress events behind an authoritative initial read', async () => {
		const { api, commands, snapshot, setRead } = create();
		const received: number[] = [];
		api.onDidChangeProjectContext(value => received.push(value.generation));
		setRead(async () => ({ ...snapshot, generation: 5 }));
		await api.getProjectContext();
		for (const generation of [4, 5, 6]) { commands.get('_vibe-vscode.projectContext.changed')!({ ...snapshot, generation }); }
		assert.deepStrictEqual(received, [6]);
	});

	it('rejects malformed subscriptions and removes failed initial subscriptions', async () => {
		const { commands, calls, snapshot, setRead } = create();
		const subscribe = commands.get('vibe-vscode.projectContext.subscribe')!;
		for (const input of [undefined, {}, { id: 'x', command: '' }, { id: '/path', command: 'consumer.changed' }]) {
			await assert.rejects(Promise.resolve(subscribe(input)), /Invalid project context subscription/);
		}
		setRead(async () => { throw new Error('authority unavailable'); });
		await assert.rejects(Promise.resolve(subscribe({ id: 'consumer', command: 'consumer.changed' })), /authority unavailable/);
		commands.get('_vibe-vscode.projectContext.changed')!({ ...snapshot, generation: 2 });
		assert.deepStrictEqual(calls.map(call => call.command), ['vibe-vscode.getProjectContext']);
	});

	it('disposes subscriptions without starting or stopping consumer services', async () => {
		const { commands, calls, dispose } = create();
		await commands.get('vibe-vscode.projectContext.subscribe')!({ id: 'consumer', command: 'consumer.changed' });
		dispose();
		assert.deepStrictEqual({ commands: commands.size, calls: calls.map(call => call.command) }, { commands: 0, calls: ['vibe-vscode.getProjectContext'] });
	});
});
