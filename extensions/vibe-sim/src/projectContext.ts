/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { VibeProjectContext } from 'vibe-vscode';
import type { ManagedSimRuntime } from './managedRuntime';
import { isProjectContext } from './protocol';
import type { HostContext } from './simSurface';

/** Consumes Vibe's public command/event contract across hosts. It owns only a rebuildable projection. */
export class ProjectContext implements vscode.Disposable {
	private readonly subscriptionId = randomUUID();
	private readonly changed = new vscode.EventEmitter<HostContext>();
	readonly onDidChange = this.changed.event;
	private readonly disposables: vscode.Disposable[];
	private lastEditor = vscode.window.activeTextEditor;
	private latest: VibeProjectContext | undefined;
	private subscribed: Promise<void> | undefined;
	private runId: string | undefined;
	private appliedGeneration = -1;
	private dirty = false;
	private publishing: Promise<void> | undefined;
	private disposed = false;

	constructor(private readonly runtime: Pick<ManagedSimRuntime, 'updateProjectContext'>, private readonly reportError: (error: Error) => void) {
		this.disposables = [this.changed,
		vscode.commands.registerCommand('_vibe-vscode.sim.projectContextChanged', (snapshot: unknown) => { if (isProjectContext(snapshot)) { this.accept(snapshot); } }),
		vscode.window.onDidChangeActiveTextEditor(editor => { if (editor) { this.lastEditor = editor; } this.schedule(); }),
		vscode.window.onDidChangeTextEditorSelection(event => { if (event.textEditor === this.lastEditor) { this.schedule(); } }),
		];
	}

	private subscribe(): Promise<void> {
		if (this.disposed) { return Promise.reject(new Error(vscode.l10n.t("Vibe project context is unavailable."))); }
		return this.subscribed ??= (async () => {
			const snapshot = await vscode.commands.executeCommand('vibe-vscode.projectContext.subscribe', { id: this.subscriptionId, command: '_vibe-vscode.sim.projectContextChanged' });
			if (this.disposed) {
				await vscode.commands.executeCommand('vibe-vscode.projectContext.unsubscribe', this.subscriptionId);
				throw new Error(vscode.l10n.t("Vibe project context is unavailable."));
			}
			if (!isProjectContext(snapshot)) { throw new Error(vscode.l10n.t("Vibe project context is unavailable.")); }
			this.accept(snapshot);
		})().catch(error => { this.subscribed = undefined; throw error; });
	}

	/** Resolve implicit context at Vibe readiness; return the initiating read, not a later UI selection. */
	async read(): Promise<VibeProjectContext> {
		const [snapshot] = await Promise.all([vscode.commands.executeCommand('vibe-vscode.getProjectContext'), this.subscribe()]);
		if (this.disposed || !isProjectContext(snapshot)) { throw new Error(vscode.l10n.t("Vibe project context is unavailable.")); }
		this.accept(snapshot);
		return snapshot;
	}

	private accept(snapshot: VibeProjectContext): void {
		if (!this.disposed && snapshot.generation > (this.latest?.generation ?? -1)) { this.latest = snapshot; this.schedule(); }
	}

	async attach(runId: string): Promise<HostContext> {
		if (this.runId !== runId) { this.runId = runId; this.appliedGeneration = -1; }
		await this.read();
		this.schedule();
		await this.publishing;
		if (this.disposed || this.runId !== runId || !this.latest || this.appliedGeneration < this.latest.generation) { throw new Error(vscode.l10n.t("Vibe project context is unavailable.")); }
		return this.context(this.latest);
	}

	detach(): void { this.runId = undefined; this.appliedGeneration = -1; }

	private context(snapshot: VibeProjectContext): HostContext {
		const editor = vscode.window.activeTextEditor ?? this.lastEditor;
		return {
			...snapshot, language: vscode.env.language, ...(editor ? {
				activeFile: {
					uri: editor.document.uri.toString(), selection: {
						startLine: editor.selection.start.line, startCharacter: editor.selection.start.character,
						endLine: editor.selection.end.line, endCharacter: editor.selection.end.character,
					},
				}
			} : {})
		};
	}

	private schedule(): void {
		if (this.disposed) { return; }
		this.dirty = true;
		if (!this.publishing) {
			this.publishing = this.publish().catch(error => this.reportError(error)).finally(() => { this.publishing = undefined; if (this.dirty && !this.disposed) { this.schedule(); } });
		}
	}

	private async publish(): Promise<void> {
		while (this.dirty && !this.disposed) {
			this.dirty = false;
			const snapshot = this.latest; const runId = this.runId;
			if (!snapshot || !runId) { continue; }
			if (snapshot.generation > this.appliedGeneration) { await this.runtime.updateProjectContext(snapshot, runId); }
			if (this.disposed || runId !== this.runId) { continue; }
			this.appliedGeneration = snapshot.generation;
			if (snapshot !== this.latest) { this.dirty = true; continue; }
			this.changed.fire(this.context(snapshot));
		}
	}

	dispose(): void {
		this.disposed = true; this.detach();
		for (const disposable of this.disposables) { disposable.dispose(); }
		void vscode.commands.executeCommand('vibe-vscode.projectContext.unsubscribe', this.subscriptionId).then(undefined, () => { });
	}
}
