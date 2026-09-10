/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createRuntimeEnvironment, ManagedSimRuntime } from './managedRuntime';
import { AgentExecutables, AgentKind, AgentPolicy, defaultAgentPolicy, isAgentExecutables, isAgentPolicy } from './protocol';

/** Machine/user settings may select an executable, but may not replace the instance's private home. */
export function readAgentExecutables(): AgentExecutables {
	const configuration = vscode.workspace.getConfiguration('sim.agent');
	const read = (agent: AgentKind) => configuration.inspect<string>(`${agent}Executable`)?.globalValue ?? agent;
	const result = { codex: read('codex'), claude: read('claude') };
	if (!isAgentExecutables(result)) { throw new Error(vscode.l10n.t("Choose a valid Agent executable in user or remote machine settings.")); }
	return result;
}

export function readAgentPolicy(): AgentPolicy {
	const configuration = vscode.workspace.getConfiguration('sim.agent');
	const result = {
		codexSandbox: configuration.inspect<AgentPolicy['codexSandbox']>('codexSandbox')?.globalValue ?? defaultAgentPolicy.codexSandbox,
		allowUnrestricted: configuration.inspect<boolean>('allowUnrestricted')?.globalValue ?? defaultAgentPolicy.allowUnrestricted,
	};
	if (!isAgentPolicy(result)) { throw new Error(vscode.l10n.t("Choose a valid Agent permission policy in user or remote machine settings.")); }
	return Object.freeze(result);
}

/** Explicit setup uses VS Code's terminal/editor APIs; it never imports another instance's sessions or credentials. */
export class AgentSetup implements vscode.Disposable {
	private readonly terminals = new Map<AgentKind, vscode.Terminal>();
	private readonly pendingSignIns = new Map<AgentKind, Promise<void>>();
	private readonly closed: vscode.Disposable;
	private disposed = false;

	constructor(private readonly runtime: Pick<ManagedSimRuntime, 'getAgentProfile'>, private readonly extensionDirectory: string) {
		this.closed = vscode.window.onDidCloseTerminal(terminal => {
			for (const [kind, value] of this.terminals) { if (value === terminal) { this.terminals.delete(kind); } }
		});
	}

	private async select(): Promise<AgentKind | undefined> {
		if (!vscode.workspace.isTrusted) { throw new Error(vscode.l10n.t("Trust this workspace before starting the Sim runtime.")); }
		const selected = await vscode.window.showQuickPick([
			{ label: 'Codex', agent: 'codex' as const }, { label: 'Claude Code', agent: 'claude' as const },
		], { title: vscode.l10n.t("Sim Agent Setup"), placeHolder: vscode.l10n.t("Settings and sign-in apply only to this Sim instance.") });
		return this.disposed ? undefined : selected?.agent;
	}

	async signIn(): Promise<void> {
		const kind = await this.select();
		if (!kind) { return; }
		let pending = this.pendingSignIns.get(kind);
		if (!pending) { pending = this.startSignIn(kind); this.pendingSignIns.set(kind, pending); }
		try { await pending; } finally { if (this.pendingSignIns.get(kind) === pending) { this.pendingSignIns.delete(kind); } }
	}

	private async startSignIn(kind: AgentKind): Promise<void> {
		if (!vscode.workspace.isTrusted) { throw new Error(vscode.l10n.t("Trust this workspace before starting the Sim runtime.")); }
		const existing = this.terminals.get(kind);
		if (existing && existing.exitStatus === undefined) { existing.show(); return; }
		existing?.dispose();
		const profile = await this.runtime.getAgentProfile(kind);
		if (this.disposed || !vscode.workspace.isTrusted) { return; }
		const terminal = vscode.window.createTerminal({
			name: vscode.l10n.t("Sim: Sign In to {0}", kind === 'codex' ? 'Codex' : 'Claude Code'),
			shellPath: profile.executable,
			shellArgs: kind === 'codex' ? ['login', '--device-auth', '-c', 'cli_auth_credentials_store="file"'] : ['auth', 'login'],
			cwd: profile.environment.HOME,
			env: { ...createRuntimeEnvironment(process.env), ...profile.environment, PATH: `${path.join(this.extensionDirectory, 'runtime/bin')}${path.delimiter}${process.env.PATH ?? ''}` },
			strictEnv: true, isTransient: true,
		});
		this.terminals.set(kind, terminal);
		terminal.show();
	}

	async openConfiguration(): Promise<void> {
		const kind = await this.select();
		if (!kind) { return; }
		if (!vscode.workspace.isTrusted) { throw new Error(vscode.l10n.t("Trust this workspace before starting the Sim runtime.")); }
		const profile = await this.runtime.getAgentProfile(kind);
		if (this.disposed || !vscode.workspace.isTrusted) { return; }
		try {
			await fs.writeFile(profile.configFile, kind === 'codex' ? 'cli_auth_credentials_store = "file"\n' : '{}\n', { flag: 'wx', mode: 0o600 });
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(profile.configFile));
		if (!this.disposed) { await vscode.window.showTextDocument(document, { preview: false }); }
	}

	dispose(): void {
		this.disposed = true; this.closed.dispose();
		for (const terminal of this.terminals.values()) { terminal.dispose(); }
		this.terminals.clear();
	}
}
