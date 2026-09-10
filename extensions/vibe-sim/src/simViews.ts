/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { VibeProjectContext } from 'vibe-vscode';
import type { ManagedSimRuntime, RuntimeStatus } from './managedRuntime';
import { NativeClient } from './native/nativeClient';
import { NativeResources, resourceScheme } from './nativeResources';
import { ProjectContext } from './projectContext';
import { SimRuntimeError } from './protocol';
import { DocumentConnection, SimDocument } from './simDocument';
import { CreateChatRequest, defaultPath, editorKey, editorViewType, isMonitorPath, isSafeSimPath, resourcePath, selectionMaxLength, sidebarViewId, SimMessage, simWorkspaceId, SourceSelection } from './simSurface';

interface Editor {
	readonly panel: vscode.WebviewPanel;
	readonly document: SimDocument;
	readonly subscriptions: vscode.Disposable[];
	path: string;
}

/** Editor identity is a UI projection of a Sim resource, never a second agent-session catalog. */
export class SimViews implements vscode.WebviewViewProvider, vscode.WebviewPanelSerializer, vscode.Disposable {
	private readonly resources: NativeResources;
	private readonly projects: ProjectContext;
	private readonly subscriptions: vscode.Disposable[];
	private readonly editors = new Map<string, Editor>();
	private readonly creations = new Map<string, CreateChatRequest>();
	private sidebar: SimDocument | undefined;
	private sidebarReady = Promise.withResolvers<SimDocument>();
	private sidebarPath: string;
	private client: NativeClient | undefined;
	private connection: Promise<DocumentConnection> | undefined;
	private disposed = false;

	constructor(private readonly extension: vscode.ExtensionContext, private readonly runtime: ManagedSimRuntime, private readonly reportError: (error: Error) => void, private readonly describeError: (error: Error) => string) {
		const stored = extension.workspaceState.get<string>('sidebarRoute');
		this.sidebarPath = isSafeSimPath(stored) ? stored : defaultPath;
		this.resources = new NativeResources(extension.extensionUri.fsPath);
		this.projects = new ProjectContext(runtime, reportError);
		this.subscriptions = [this.resources, this.projects,
		vscode.workspace.registerFileSystemProvider(resourceScheme, this.resources, { isReadonly: true, isCaseSensitive: true }),
		vscode.window.registerWebviewViewProvider(sidebarViewId, this, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.window.registerWebviewPanelSerializer(editorViewType, this),
		this.projects.onDidChange(context => { this.sidebar?.setContext(context); for (const editor of this.editors.values()) { editor.document.setContext(context); } }),
		];
	}

	private connect(): Promise<DocumentConnection> {
		if (this.disposed) { return Promise.reject(new SimRuntimeError('disposed')); }
		if (!vscode.workspace.isTrusted) { return Promise.reject(new Error(vscode.l10n.t("Trust this workspace before starting the Sim runtime."))); }
		return this.connection ??= (async () => {
			const { info, runId } = await this.runtime.getConnection();
			const current = () => !this.disposed && this.runtime.status.phase === 'ready' && this.runtime.status.runId === runId;
			if (!current()) { throw new SimRuntimeError('runtimeExited'); }
			this.client?.dispose();
			const client = this.client = new NativeClient(runId, info, current);
			const resourceRoot = this.resources.attach(client);
			const context = await this.projects.attach(runId);
			if (!current()) { throw new SimRuntimeError('runtimeExited'); }
			return { client, resourceRoot, context };
		})().catch(error => { this.connection = undefined; throw error; });
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.sidebar?.dispose();
		const document = new SimDocument(view.webview, 'sidebar', this.sidebarPath, () => this.connect(), message => { void this.handleMessage(document, undefined, message).catch(this.reportError); }, this.describeError);
		this.sidebar = document;
		this.sidebarReady.resolve(document);
		const closed = view.onDidDispose(() => {
			closed.dispose(); document.dispose();
			if (this.sidebar === document) { this.sidebar = undefined; this.sidebarReady = Promise.withResolvers<SimDocument>(); }
		});
		void document.load();
	}

	async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: { path?: string; title?: string } | undefined): Promise<void> {
		const route = isSafeSimPath(state?.path) ? state.path : defaultPath;
		const existing = this.editors.get(editorKey(route));
		if (existing) { panel.dispose(); return; }
		this.adopt(panel, route, typeof state?.title === 'string' ? state.title : undefined);
	}

	async openEditor(requested?: unknown, preserveFocus = false): Promise<void> {
		if (requested !== undefined && !isSafeSimPath(requested)) { throw new Error(vscode.l10n.t("Invalid Sim resource path.")); }
		const route = typeof requested === 'string' ? requested : this.sidebarPath;
		const key = editorKey(route);
		const existing = this.editors.get(key);
		if (existing) {
			if (route !== resourcePath(existing.path)) { existing.path = route; existing.document.navigate(route); }
			existing.panel.reveal(undefined, preserveFocus);
		} else {
			const panel = vscode.window.createWebviewPanel(editorViewType, this.title(route), { viewColumn: vscode.ViewColumn.Active, preserveFocus }, { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true });
			this.adopt(panel, route);
		}
		if (!preserveFocus) { this.selectSidebar(route); }
	}

	private adopt(panel: vscode.WebviewPanel, route: string, title?: string): Editor {
		panel.title = title?.trim().slice(0, 256) || this.title(route);
		panel.iconPath = vscode.Uri.joinPath(this.extension.extensionUri, 'media/sim.svg');
		const document = new SimDocument(panel.webview, isMonitorPath(route) ? 'monitor' : 'editor', route, () => this.connect(), message => { void this.handleMessage(document, editor, message).catch(this.reportError); }, this.describeError);
		const editor: Editor = { panel, document, path: route, subscriptions: [document] };
		this.editors.set(editorKey(route), editor);
		editor.subscriptions.push(panel.onDidChangeViewState(() => { if (panel.active) { this.selectSidebar(editor.path); } }));
		editor.subscriptions.push(panel.onDidDispose(() => {
			for (const [key, value] of this.editors) { if (value === editor) { this.editors.delete(key); } }
			for (const subscription of editor.subscriptions) { subscription.dispose(); }
		}));
		void document.load();
		return editor;
	}

	private title(route: string): string {
		if (isMonitorPath(route)) { return vscode.l10n.t("Sim Agent Monitor"); }
		const parts = resourcePath(route).split('/'); const id = parts.at(-1) || 'Sim';
		switch (parts[3]) {
			case 'w': return vscode.l10n.t("Workflow: {0}", id);
			case 'd': return vscode.l10n.t("DAG: {0}", id);
			case 'chat': return vscode.l10n.t("Agent: {0}", id);
			default: return 'Sim';
		}
	}

	private selectSidebar(route: string, source?: SimDocument): void {
		this.sidebarPath = route;
		void this.extension.workspaceState.update('sidebarRoute', route);
		if (this.sidebar !== source) { this.sidebar?.navigate(route); }
	}

	private async handleMessage(document: SimDocument, editor: Editor | undefined, message: SimMessage): Promise<void> {
		if (this.disposed) { return; }
		const payload = message.payload; const route = payload?.path;
		if (message.type === 'openMonitor') { await this.openEditor('/agents'); }
		else if (message.type === 'openEditor' && isSafeSimPath(route)) { await this.openEditor(route); }
		else if (message.type === 'titleChanged' && editor && isSafeSimPath(route) && editorKey(editor.path) === editorKey(route) && payload?.title?.trim()) { editor.panel.title = payload.title.trim().slice(0, 256); }
		else if (message.type === 'routeChanged' && isSafeSimPath(route)) {
			if (!editor) {
				this.selectSidebar(route, document);
				if (payload?.userInitiated) { await this.openEditor(route); }
			} else if (editorKey(editor.path) !== editorKey(route) && payload?.userInitiated) {
				document.navigate(editor.path);
				await this.openEditor(route);
			} else {
				const oldKey = editorKey(editor.path); const key = editorKey(route);
				if (oldKey !== key) { this.editors.delete(oldKey); this.editors.set(key, editor); }
				editor.path = route;
				if (editor.panel.active) { this.selectSidebar(route); }
			}
		} else if (message.type === 'openFile' || message.type === 'openDiff' || message.type === 'openTerminal' || message.type === 'openExternal') {
			await this.openResource(message);
		}
	}

	/** Captures source immediately, captures owner at readiness, and keeps both across UI/agent awaits. */
	async createChatFromSelection(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.selection.isEmpty) { throw new Error(vscode.l10n.t("Select text in a project file to create a Sim chat.")); }
		const text = editor.document.getText(editor.selection);
		if (text.length > selectionMaxLength) { throw new Error(vscode.l10n.t("Select up to 32,000 characters to create a Sim chat.")); }
		const selection: SourceSelection = {
			uri: editor.document.uri.toString(), language: editor.document.languageId, text, range: {
				startLine: editor.selection.start.line, startCharacter: editor.selection.start.character, endLine: editor.selection.end.line, endCharacter: editor.selection.end.character,
			}
		};
		const initiatingTab = vscode.window.tabGroups.activeTabGroup.activeTab;
		const workspaceId = simWorkspaceId(this.sidebarPath);
		const context = await this.projects.read();
		const project = context.physicalWorkspace.folders.filter(folder => this.contains(folder.uri, selection.uri)).sort((a, b) => b.uri.length - a.uri.length)[0];
		if (!project) { throw new Error(vscode.l10n.t("The selected file must belong to an open VS Code project.")); }
		const identity = (scope: string | undefined) => JSON.stringify([scope, context.physicalWorkspace.id, context.physicalWorkspace.remoteAuthority, project.uri, context.logicalWorkspace?.id, selection]);
		let key = identity(workspaceId);
		let request = this.creations.get(key) ?? { requestId: randomUUID(), workspaceId, catalog: { physicalWorkspace: context.physicalWorkspace, logicalWorkspaces: context.logicalWorkspaces }, projectUri: project.uri, logicalWorkspaceId: context.logicalWorkspace?.id, selection };
		this.creations.set(key, request);
		await vscode.commands.executeCommand(`${sidebarViewId}.focus`);
		const sidebar = this.sidebar ?? await this.sidebarReady.promise;
		const route = await sidebar.createChat(request, prepared => { this.creations.delete(key); key = identity(prepared.workspaceId); request = prepared; this.creations.set(key, prepared); });
		this.creations.delete(key);
		const current = await this.projects.read().catch(() => undefined);
		const preserveFocus = initiatingTab !== vscode.window.tabGroups.activeTabGroup.activeTab || !current || !this.sameInitiator(context, current)
			|| request.workspaceId !== simWorkspaceId(this.sidebarPath);
		await this.openEditor(route, preserveFocus);
	}

	private sameInitiator(a: VibeProjectContext, b: VibeProjectContext): boolean {
		return a.physicalWorkspace.id === b.physicalWorkspace.id && a.physicalWorkspace.remoteAuthority === b.physicalWorkspace.remoteAuthority
			&& a.logicalWorkspace?.id === b.logicalWorkspace?.id && a.project?.uri === b.project?.uri;
	}

	private contains(parent: string, child: string): boolean {
		try {
			const base = vscode.Uri.parse(parent, true); const file = vscode.Uri.parse(child, true);
			return base.scheme === file.scheme && base.authority === file.authority && file.path.startsWith(`${base.path.replace(/\/$/, '')}/`);
		} catch { return false; }
	}

	private async openResource(message: SimMessage): Promise<void> {
		const payload = message.payload;
		const parse = (value: string | undefined, schemes: string[]) => {
			try { const uri = value ? vscode.Uri.parse(value, true) : undefined; return uri && schemes.includes(uri.scheme) ? uri : undefined; } catch { return undefined; }
		};
		if (message.type === 'openExternal') { const uri = parse(payload?.uri, ['https', 'http']); if (uri) { await vscode.env.openExternal(uri); } return; }
		if (!vscode.workspace.isTrusted) { throw new Error(vscode.l10n.t("Trust this workspace before starting the Sim runtime.")); }
		if (message.type === 'openFile') {
			const uri = parse(payload?.uri, ['file', 'vscode-remote']);
			if (uri) {
				const document = await vscode.workspace.openTextDocument(uri);
				await vscode.window.showTextDocument(document, { preview: true, selection: payload?.line === undefined ? undefined : new vscode.Range(payload.line, payload.character ?? 0, payload.line, payload.character ?? 0) });
			}
		} else if (message.type === 'openDiff') {
			const original = parse(payload?.originalUri, ['file', 'vscode-remote', 'git']); const modified = parse(payload?.modifiedUri, ['file', 'vscode-remote', 'git']);
			if (original && modified) { await vscode.commands.executeCommand('vscode.diff', original, modified, payload?.title ?? vscode.l10n.t("Sim Changes")); }
		} else if (message.type === 'openTerminal') {
			const cwd = parse(payload?.uri, ['file', 'vscode-remote']);
			if (payload?.uri && !cwd) { return; }
			vscode.window.createTerminal({ name: vscode.l10n.t("Sim Task"), cwd }).show();
		}
	}

	onRuntimeChanged(status: RuntimeStatus, message: string): void {
		if (status.phase === 'stopping' || status.phase === 'stopped' || status.phase === 'failed') {
			this.client?.dispose(); this.client = undefined; this.connection = undefined; this.resources.detach(); this.projects.detach();
			this.sidebar?.unavailable(message);
			for (const editor of this.editors.values()) { editor.document.unavailable(message); }
		}
	}

	reconnect(): void { void this.sidebar?.load(); for (const editor of this.editors.values()) { void editor.document.load(); } }

	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true; this.client?.dispose(); this.sidebar?.dispose();
		for (const editor of this.editors.values()) { for (const subscription of editor.subscriptions) { subscription.dispose(); } }
		this.editors.clear();
		for (const subscription of this.subscriptions) { subscription.dispose(); }
	}
}
