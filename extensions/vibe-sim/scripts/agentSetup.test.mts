/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import type * as vscode from 'vscode';
import type { AgentKind } from '../src/protocol.ts';
import { agentProfile } from '../src/agentProfile.ts';
import { bundle, waitFor } from './testUtils.mts';

const require = createRequire(import.meta.url);
const compiled = bundle('agentSetup');

async function create(t: TestContext) {
	const root = await fs.mkdtemp(path.join(tmpdir(), 'vibe-sim-agent-setup-'));
	const configuration: Record<string, { globalValue?: string | boolean; workspaceValue?: string | boolean; workspaceFolderValue?: string | boolean }> = {};
	const options: vscode.TerminalOptions[] = [];
	const shown: string[] = [];
	let disposed = 0;
	let profileReads = 0;
	let kind: AgentKind = 'codex';
	let gate = Promise.resolve();
	const workspace = { isTrusted: true, getConfiguration: () => ({ inspect: (key: string) => configuration[key] }), openTextDocument: async (uri: { fsPath: string }) => uri };
	const api = {
		workspace, Uri: { file: (fsPath: string) => ({ fsPath }) }, l10n: { t: (value: string) => value },
		window: {
			showQuickPick: async () => ({ agent: kind }),
			onDidCloseTerminal: () => ({ dispose() { } }),
			createTerminal: (value: vscode.TerminalOptions) => { options.push(value); return { show() { }, dispose: () => { disposed++; } }; },
			showTextDocument: async (document: { fsPath: string }) => { shown.push(document.fsPath); },
		},
	};
	const exports = runInNewContext(`${compiled}\nmodule.exports;`, {
		module: { exports: {} }, require: (name: string) => name === 'vscode' ? api : require(name),
		process: { env: { PATH: '/fixture/bin', HOME: '/old-home', CODEX_HOME: '/old-codex', CLAUDE_CONFIG_DIR: '/old-claude', OPENAI_API_KEY: 'must-not-inherit', DATABASE_URL: 'must-not-inherit', NODE_OPTIONS: '--inspect' } },
	}) as typeof import('../src/agentSetup.ts');
	const runtime = { getAgentProfile: async (agent: AgentKind) => {
		profileReads++; await gate;
		const profile = agentProfile(root, agent, { codex: '/machine/bin/codex', claude: '/machine/bin/claude' });
		await fs.mkdir(profile.home, { recursive: true });
		await fs.mkdir(profile.environment.HOME, { recursive: true });
		return profile;
	} };
	const setup = new exports.AgentSetup(runtime, '/extension');
	t.after(async () => { setup.dispose(); await fs.rm(root, { recursive: true, force: true }); });
	return {
		root, setup, workspace, configuration, options, shown, readExecutables: exports.readAgentExecutables, readPolicy: exports.readAgentPolicy,
		get disposedTerminals() { return disposed; }, get profileReads() { return profileReads; },
		select: (value: AgentKind) => { kind = value; }, waitOn: (value: Promise<void>) => { gate = value; },
	};
}

describe('instance-owned Agent setup', () => {
	it('keeps permissions restricted by default and ignores workspace attempts to raise the ceiling', async t => {
		const fixture = await create(t);
		fixture.configuration.codexSandbox = { workspaceValue: 'workspace-write' };
		fixture.configuration.allowUnrestricted = { workspaceValue: true, workspaceFolderValue: true };
		assert.deepStrictEqual(structuredClone(fixture.readPolicy()), { codexSandbox: 'read-only', allowUnrestricted: false });
		fixture.configuration.codexSandbox.globalValue = 'workspace-write';
		fixture.configuration.allowUnrestricted.globalValue = true;
		assert.deepStrictEqual(structuredClone(fixture.readPolicy()), { codexSandbox: 'workspace-write', allowUnrestricted: true });
		fixture.configuration.codexSandbox.globalValue = 'danger-full-access';
		assert.throws(fixture.readPolicy, /valid Agent permission policy/);
	});

	it('accepts only user/machine executable settings, ignoring workspace overrides', async t => {
		const fixture = await create(t);
		fixture.configuration.codexExecutable = { workspaceValue: '/workspace/untrusted', workspaceFolderValue: '/workspace/also-untrusted' };
		fixture.configuration.claudeExecutable = { globalValue: '/machine/claude', workspaceValue: '/workspace/untrusted' };
		assert.deepStrictEqual(structuredClone(fixture.readExecutables()), { codex: 'codex', claude: '/machine/claude' });
		fixture.configuration.codexExecutable.globalValue = 'bad\ncommand';
		assert.throws(fixture.readExecutables, /valid Agent executable/);
	});

	it('coalesces explicit sign-in and isolates its CLI home without inheriting credentials', async t => {
		const fixture = await create(t);
		const gate = Promise.withResolvers<void>(); fixture.waitOn(gate.promise);
		const first = fixture.setup.signIn(); const second = fixture.setup.signIn();
		await waitFor(() => fixture.profileReads === 1, 'one sign-in profile acquisition');
		assert.equal(fixture.options.length, 0);
		gate.resolve(); await Promise.all([first, second]);
		await fixture.setup.signIn();
		fixture.select('claude'); await fixture.setup.signIn();
		fixture.setup.dispose();
		assert.deepStrictEqual({
			terminals: fixture.options.map(value => ({ executable: value.shellPath, args: Array.from(value.shellArgs as string[]), strictEnv: value.strictEnv, transient: value.isTransient, env: { ...value.env } })),
			disposed: fixture.disposedTerminals,
		}, {
			terminals: [
				{ executable: '/machine/bin/codex', args: ['login', '--device-auth', '-c', 'cli_auth_credentials_store="file"'], strictEnv: true, transient: true, env: { NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: '1', PATH: '/extension/runtime/bin:/fixture/bin', HOME: path.join(fixture.root, 'home'), CODEX_HOME: path.join(fixture.root, 'agents/codex') } },
				{ executable: '/machine/bin/claude', args: ['auth', 'login'], strictEnv: true, transient: true, env: { NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: '1', PATH: '/extension/runtime/bin:/fixture/bin', HOME: path.join(fixture.root, 'home'), CLAUDE_CONFIG_DIR: path.join(fixture.root, 'agents/claude') } },
			], disposed: 2,
		});
	});

	it('does not create a login terminal after disposal during profile acquisition', async t => {
		const fixture = await create(t);
		const gate = Promise.withResolvers<void>(); fixture.waitOn(gate.promise);
		const pending = fixture.setup.signIn();
		await waitFor(() => fixture.profileReads === 1, 'pending profile');
		fixture.setup.dispose(); gate.resolve(); await pending;
		assert.equal(fixture.options.length, 0);
	});

	it('preserves existing private configuration and refuses setup in an untrusted workspace', async t => {
		const fixture = await create(t);
		await fixture.setup.openConfiguration();
		const file = path.join(fixture.root, 'agents/codex/config.toml');
		await fs.writeFile(file, 'model = "fixture-model"\n');
		await fixture.setup.openConfiguration();
		fixture.workspace.isTrusted = false;
		await assert.rejects(fixture.setup.signIn(), /Trust this workspace/);
		assert.deepStrictEqual({ text: await fs.readFile(file, 'utf8'), mode: (await fs.stat(file)).mode & 0o777, opened: fixture.shown, terminals: fixture.options.length }, {
			text: 'model = "fixture-model"\n', mode: 0o600, opened: [file, file], terminals: 0,
		});
	});
});
