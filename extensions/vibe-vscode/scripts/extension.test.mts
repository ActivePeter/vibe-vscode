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

const compiled = buildSync({
	entryPoints: [fileURLToPath(new URL('../src/extension.ts', import.meta.url))],
	bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false,
}).outputFiles[0].text;

function create() {
	const commands = new Map<string, (message?: unknown) => Promise<void>>();
	const calls: { command: string; args: unknown[] }[] = [];
	let restore: ((panel: { dispose(): void }, state: unknown) => Promise<void>) | undefined;
	let activeChanged: ((editor?: typeof editor) => void) | undefined;
	const editor = {
		document: { uri: { toString: () => 'file:///example.ts' } },
		selection: { start: { line: 2, character: 3 }, end: { line: 4, character: 5 } },
	};
	const disposable = { dispose() { } };
	const vscode = {
		env: { language: 'en', openExternal: async (uri: object) => { calls.push({ command: 'external', args: [uri] }); } },
		l10n: { t: (value: string) => value },
		Uri: { parse: (value: string) => ({ scheme: value.split(':')[0], value }) },
		commands: {
			registerCommand: (id: string, handler: (message?: unknown) => Promise<void>) => { commands.set(id, handler); return disposable; },
			executeCommand: async (command: string, ...args: unknown[]) => { calls.push({ command, args: JSON.parse(JSON.stringify(args)) }); },
		},
		window: {
			activeTextEditor: editor as typeof editor | undefined,
			registerWebviewPanelSerializer: (_id: string, serializer: { deserializeWebviewPanel: typeof restore }) => { restore = serializer.deserializeWebviewPanel; return disposable; },
			onDidChangeActiveTextEditor: (callback: typeof activeChanged) => { activeChanged = callback; return disposable; },
			onDidChangeTextEditorSelection: () => disposable,
		},
	};
	const extension = runInNewContext(`${compiled}\nmodule.exports;`, {
		module: { exports: {} }, require: (name: string) => { assert.strictEqual(name, 'vscode'); return vscode; },
	}) as typeof import('../src/extension.ts');
	const context: Pick<Parameters<typeof extension.activate>[0], 'subscriptions'> = { subscriptions: [] };
	extension.activate(context as Parameters<typeof extension.activate>[0]);
	return { commands, calls, restore: restore!, vscode, activeChanged: activeChanged! };
}

describe('Sim extension capability adapter', () => {
	it('does not contribute a competing Webview surface or public commands', () => {
		const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		assert.deepStrictEqual({ contributes: manifest.contributes, proposals: manifest.enabledApiProposals, commands: [...create().commands.keys()] }, {
			contributes: undefined, proposals: undefined, commands: ['_vibe-vscode.sim.getContext', '_vibe-vscode.sim.resource'],
		});
	});

	it('migrates the saved route to the native editor before closing the legacy panel', async () => {
		const { restore, calls } = create();
		await restore({ dispose: () => calls.push({ command: 'dispose', args: [] }) }, { path: '/workspace/existing/chat' });
		assert.deepStrictEqual(calls.slice(-2), [
			{ command: 'vibe-vscode.openSim', args: ['/workspace/existing/chat'] },
			{ command: 'dispose', args: [] },
		]);
	});

	it('keeps the last text selection when Sim takes focus', () => {
		const { vscode, activeChanged, calls } = create();
		vscode.window.activeTextEditor = undefined;
		activeChanged(undefined);
		assert.deepStrictEqual(calls.at(-1), {
			command: '_vibe-vscode.sim.updateContext', args: [{
				language: 'en', activeFile: { uri: 'file:///example.ts', selection: { startLine: 2, startCharacter: 3, endLine: 4, endCharacter: 5 } },
			}],
		});
	});

	it('rejects arbitrary commands and non-HTTP external URLs', async () => {
		const { commands, calls } = create();
		const resource = commands.get('_vibe-vscode.sim.resource')!;
		await resource({ type: 'executeCommand', command: 'workbench.action.terminal.new' });
		await resource({ type: 'openExternal', uri: 'command:unsafe' });
		await resource({ type: 'openExternal', uri: {} });
		await resource({ type: 'openExternal', uri: 'https://example.invalid' });
		assert.deepStrictEqual(calls.filter(call => call.command !== '_vibe-vscode.sim.updateContext').map(call => call.command), ['external']);
	});
});
