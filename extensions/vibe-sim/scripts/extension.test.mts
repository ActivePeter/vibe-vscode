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
import type { ExtensionContext } from 'vscode';
import type { RuntimeStatus } from '../src/managedRuntime.ts';
import { bundle, createFixture, exists } from './testUtils.mts';

const compiled = bundle('extension');
const require = createRequire(import.meta.url);

async function activate(t: TestContext, empty = false) {
	const fixture = await createFixture(t);
	const handlers = new Map<string, () => Promise<object | undefined> | object | undefined>();
	const errors: string[] = [];
	const output: string[] = [];
	const uri = (fsPath: string) => ({ scheme: 'file', fsPath });
	const subscriptions: { dispose(): void }[] = [];
	const workspace = { isTrusted: true };
	const vscode = {
		workspace,
		Uri: { joinPath: (base: { fsPath: string }, ...segments: string[]) => uri(path.join(base.fsPath, ...segments)) },
		l10n: { t: (message: string, ...args: string[]) => message.replace(/\{(?<index>\d+)\}/g, (_match, index) => args[Number(index)]) },
		commands: { registerCommand: (id: string, handler: () => Promise<object | undefined> | object | undefined) => {
			handlers.set(id, handler);
			return { dispose: () => handlers.delete(id) };
		} },
		window: {
			createOutputChannel: () => ({ info: (message: string) => output.push(message), error: (message: string) => output.push(message), show() { }, dispose() { } }),
			showErrorMessage: async (message: string) => { errors.push(message); },
			showInformationMessage: async (message: string) => { output.push(message); },
		},
	};
	const extension = runInNewContext(`${compiled}\nmodule.exports;`, {
		module: { exports: {} }, __dirname: fixture.distDirectory, process, setTimeout, clearTimeout,
		require: (name: string) => name === 'vscode' ? vscode : require(name),
	}) as typeof import('../src/extension.ts');
	const storageUri = empty ? undefined : uri(path.join(fixture.root, 'workspace'));
	const context = { extensionUri: uri(fixture.extensionDirectory), storageUri, globalStorageUri: uri(path.join(fixture.root, 'global')), subscriptions };
	extension.activate(context as ExtensionContext);
	fixture.beforeCleanup(async () => {
		await extension.deactivate();
		for (const subscription of subscriptions) {
			subscription.dispose();
		}
	});
	return { fixture, context, errors, output, workspace, handlers, extension };
}

describe('Sim workspace extension entry point', () => {
	it('uses a Node workspace host and contributes no competing Sim views or startup activation', async () => {
		const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
		assert.deepStrictEqual({
			main: manifest.main, browser: manifest.browser, extensionKind: manifest.extensionKind,
			activationEvents: manifest.activationEvents, capabilities: manifest.capabilities,
			contributionPoints: Object.keys(manifest.contributes), commands: manifest.contributes.commands.map((command: { command: string }) => command.command),
		}, {
			main: './dist/extension.js', browser: undefined, extensionKind: ['workspace'], activationEvents: undefined,
			capabilities: { virtualWorkspaces: false, untrustedWorkspaces: { supported: false } }, contributionPoints: ['commands'],
			commands: ['vibe-vscode.sim.startRuntime', 'vibe-vscode.sim.stopRuntime', 'vibe-vscode.sim.showRuntimeStatus'],
		});
	});

	it('activates and shows status without starting a process or creating storage', async t => {
		const { handlers, fixture } = await activate(t);
		const status = handlers.get('vibe-vscode.sim.showRuntimeStatus')!() as RuntimeStatus;
		assert.deepStrictEqual({ phase: status.phase, storage: await exists(path.join(fixture.root, 'workspace')), globalStorage: await exists(path.join(fixture.root, 'global')) }, {
			phase: 'stopped', storage: false, globalStorage: false,
		});
	});

	it('reports a missing native package without claiming the existing UI has been migrated', async t => {
		const { handlers, fixture, errors } = await activate(t);
		await fs.rm(fixture.runtimeDirectory, { recursive: true });
		const info = await handlers.get('vibe-vscode.sim.startRuntime')!();
		assert.deepStrictEqual({ info, errors, storage: await exists(path.join(fixture.root, 'workspace')) }, {
			info: undefined, errors: ['The native Sim runtime is not packaged in this build. The existing Sim interface has not been switched.'], storage: false,
		});
	});

	it('rechecks trust before execution, even if a command is invoked programmatically', async t => {
		const { handlers, workspace, fixture, errors } = await activate(t);
		workspace.isTrusted = false;
		await handlers.get('vibe-vscode.sim.startRuntime')!();
		assert.deepStrictEqual({ errors, storage: await exists(path.join(fixture.root, 'workspace')) }, {
			errors: ['Trust this workspace before starting the Sim runtime.'], storage: false,
		});
	});

	for (const empty of [false, true]) {
		it(`uses ${empty ? 'dedicated empty-workspace global storage' : 'workspace storage'} and awaits deactivate`, { skip: process.platform !== 'linux' }, async t => {
			const { handlers, fixture, extension, errors } = await activate(t, empty);
			const stateName = empty ? 'global/empty-workspace/runtime' : 'workspace/runtime';
			const { stateDirectory } = await fixture.createRuntime(stateName);
			await handlers.get('vibe-vscode.sim.startRuntime')!();
			const status = handlers.get('vibe-vscode.sim.showRuntimeStatus')!() as RuntimeStatus;
			await extension.deactivate();
			assert.deepStrictEqual({
				errors, phase: status.phase, identity: await exists(path.join(stateDirectory, 'instance.json')),
				stopped: await exists(path.join(stateDirectory, 'stopped')),
				otherStorage: await exists(path.join(fixture.root, empty ? 'workspace' : 'global')),
			}, { errors: [], phase: 'ready', identity: true, stopped: true, otherStorage: false });
		});
	}

	it('keeps all preview labels and runtime messages localized', async () => {
		const bundle = JSON.parse(await fs.readFile(new URL('../l10n/bundle.l10n.json', import.meta.url), 'utf8'));
		const chinese = JSON.parse(await fs.readFile(new URL('../l10n/bundle.l10n.zh-cn.json', import.meta.url), 'utf8'));
		const source = await fs.readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
		const messages = [...source.matchAll(/l10n\.t\("(?<message>[^"\n]+)"/g)].map(match => match.groups!.message);
		assert.deepStrictEqual({ missingEnglish: messages.filter(message => !bundle[message]), missingChinese: messages.filter(message => !chinese[message]) }, {
			missingEnglish: [], missingChinese: [],
		});
	});
});
