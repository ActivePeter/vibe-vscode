/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SimSidebarViewProvider } from './simSidebar';
import {
	isSafeSimPath,
	isSimWebviewMessage,
	renderSimWebview,
	type SimWebviewMessage,
	SimWebviewMessageType,
	SimWebviewSurface,
} from './simWebview';
import { getVibeSubPlugins, type VibeSubPlugin, type VibeSubPluginHostContext } from './subplugins';

const OPEN_SIM_COMMAND = 'vibe-vscode.openSim';
const OPEN_SIM_FULLSCREEN_COMMAND = 'vibe-vscode.openSimFullscreen';
const OPEN_FULLSCREEN_PANEL_COMMAND = 'vibe-vscode.openFullscreenPanel';
const CLOSE_FULLSCREEN_PANEL_COMMAND = 'vibe-vscode.closeFullscreenPanel';
const SIM_EDITOR_VIEW_TYPE = 'vibe-vscode.sim.editor';
const SIM_SIDEBAR_VIEW_TYPE = 'vibe-vscode.sim.sidebar';
const FULLSCREEN_PANEL_VIEW_TYPE = 'vibe-vscode.projectSwitcher.fullscreen';
const SIM_BASE_URL_CONFIGURATION = 'sim.baseUrl';

let simEditorPanel: vscode.WebviewPanel | undefined;
let simFullscreenPanel: vscode.WebviewPanel | undefined;
let currentSimPath = '/workspace';
let lastActiveTextEditor: vscode.TextEditor | undefined;

export function activate(context: vscode.ExtensionContext): void {
	lastActiveTextEditor = vscode.window.activeTextEditor;
	const simPlugin = getSimPlugin();
	const simSidebarViewProvider = new SimSidebarViewProvider({
		handleMessage: message => handleSimResourceMessage(message),
		observeRoute: path => {
			if (!simEditorPanel) {
				currentSimPath = path;
			}
		},
		openEditor: path => openSimEditor(context, path, simSidebarViewProvider),
	}, getConfiguredSimBaseUrl(), createHostContext(simPlugin));
	context.subscriptions.push(
		vscode.commands.registerCommand(OPEN_SIM_COMMAND, () => openSimEditor(context, undefined, simSidebarViewProvider)),
		vscode.commands.registerCommand(OPEN_SIM_FULLSCREEN_COMMAND, () => openSimFullscreen(context, simSidebarViewProvider)),
		vscode.commands.registerCommand(OPEN_FULLSCREEN_PANEL_COMMAND, () => openSimFullscreen(context, simSidebarViewProvider)),
		vscode.commands.registerCommand(CLOSE_FULLSCREEN_PANEL_COMMAND, () => simFullscreenPanel?.dispose()),
		vscode.window.registerWebviewViewProvider(SIM_SIDEBAR_VIEW_TYPE, simSidebarViewProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		simSidebarViewProvider,
		vscode.window.registerWebviewPanelSerializer(SIM_EDITOR_VIEW_TYPE, {
			deserializeWebviewPanel: async (panel, state) => {
				if (isPersistedPanelState(state)) {
					currentSimPath = state.path;
				}
				simEditorPanel = panel;
				initializeSimPanel(panel, context, SimWebviewSurface.Editor, getSimPlugin(), simSidebarViewProvider);
			},
		}),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(`vibe-vscode.${SIM_BASE_URL_CONFIGURATION}`)) {
				reloadOpenPanels(simSidebarViewProvider);
			}
		}),
		new vscode.Disposable(() => {
			simFullscreenPanel?.dispose();
			simEditorPanel?.dispose();
		}),
	);
	registerSubPluginContextSubscriptions(context, simSidebarViewProvider);
}

function registerSubPluginContextSubscriptions(context: vscode.ExtensionContext, simSidebarViewProvider: SimSidebarViewProvider): void {
	const subscriptions = getVibeSubPlugins().map(plugin => plugin.contextSubscriptions);
	const needsWorkspaceContext = subscriptions.some(subscription => subscription.physicalWorkspace || subscription.logicalWorkspace || subscription.project);
	const needsActiveFile = subscriptions.some(subscription => subscription.activeFile || subscription.selection);
	const needsSelection = subscriptions.some(subscription => subscription.selection);

	if (needsWorkspaceContext) {
		context.subscriptions.push(vscode.workspace.onDidChangeVibeWorkspaceContext(workspaceContext => {
			broadcastHostContext(simSidebarViewProvider, createHostContext(getSimPlugin(), workspaceContext));
		}));
	}
	if (needsActiveFile) {
		context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor) {
				lastActiveTextEditor = editor;
			}
			broadcastHostContext(simSidebarViewProvider);
		}));
	}
	if (needsSelection) {
		context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
			if (event.textEditor === lastActiveTextEditor) {
				broadcastHostContext(simSidebarViewProvider);
			}
		}));
	}
}

function openSimEditor(context: vscode.ExtensionContext, path: string | undefined, simSidebarViewProvider: SimSidebarViewProvider): void {
	if (simEditorPanel) {
		simEditorPanel.reveal(vscode.ViewColumn.Active, false);
		if (isSafeSimPath(path)) {
			navigateSimPanels(path, simSidebarViewProvider);
		}
		return;
	}

	if (isSafeSimPath(path)) {
		currentSimPath = path;
	}
	simEditorPanel = createSimPanel(context, SimWebviewSurface.Editor, simSidebarViewProvider);
	if (isSafeSimPath(path)) {
		simSidebarViewProvider.navigate(path);
	}
}

async function openSimFullscreen(context: vscode.ExtensionContext, simSidebarViewProvider: SimSidebarViewProvider): Promise<void> {
	if (simFullscreenPanel) {
		simFullscreenPanel.reveal(vscode.ViewColumn.Active, false);
		return;
	}

	try {
		simFullscreenPanel = createSimPanel(context, SimWebviewSurface.Fullscreen, simSidebarViewProvider);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await vscode.window.showErrorMessage(vscode.l10n.t('Unable to open Sim fullscreen: {0}', message));
	}
}

function createSimPanel(context: vscode.ExtensionContext, surface: SimWebviewSurface, simSidebarViewProvider: SimSidebarViewProvider): vscode.WebviewPanel {
	const fullscreen = surface === SimWebviewSurface.Fullscreen;
	const plugin = getSimPlugin();
	const panel = vscode.window.createWebviewPanel(
		fullscreen ? FULLSCREEN_PANEL_VIEW_TYPE : SIM_EDITOR_VIEW_TYPE,
		vscode.l10n.t('Sim Development Orchestration'),
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			vibeVscodeFullscreen: fullscreen,
		},
	);
	initializeSimPanel(panel, context, surface, plugin, simSidebarViewProvider);
	return panel;
}

function initializeSimPanel(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, surface: SimWebviewSurface, plugin: VibeSubPlugin, simSidebarViewProvider: SimSidebarViewProvider): void {
	panel.webview.options = { enableScripts: true };
	panel.webview.html = renderSimWebview({
		configuredBaseUrl: getConfiguredSimBaseUrl(),
		hostContext: createHostContext(plugin),
		initialPath: currentSimPath || plugin.defaultPath,
		surface,
	});

	const messageListener = panel.webview.onDidReceiveMessage(message => {
		if (isSimWebviewMessage(message)) {
			void handleSimPanelMessage(message, panel, context, simSidebarViewProvider);
		}
	});
	const disposeListener = panel.onDidDispose(() => {
		messageListener.dispose();
		disposeListener.dispose();
		if (simEditorPanel === panel) {
			simEditorPanel = undefined;
		}
		if (simFullscreenPanel === panel) {
			simFullscreenPanel = undefined;
		}
	});
}

async function handleSimPanelMessage(message: SimWebviewMessage, panel: vscode.WebviewPanel, context: vscode.ExtensionContext, simSidebarViewProvider: SimSidebarViewProvider): Promise<void> {
	switch (message.type) {
		case SimWebviewMessageType.OpenEditor:
			if (isSafeSimPath(message.path)) {
				openSimEditor(context, message.path, simSidebarViewProvider);
			}
			return;
		case SimWebviewMessageType.RouteChanged:
			if (isSafeSimPath(message.path)) {
				navigateSimPanels(message.path, simSidebarViewProvider, panel);
			}
			return;
		default:
			await handleSimResourceMessage(message);
	}
}

function navigateSimPanels(path: string, simSidebarViewProvider: SimSidebarViewProvider, source?: vscode.WebviewPanel): void {
	if (currentSimPath === path) {
		simSidebarViewProvider.navigate(path);
		return;
	}
	currentSimPath = path;
	for (const panel of [simEditorPanel, simFullscreenPanel]) {
		if (panel && panel !== source) {
			void panel.webview.postMessage({ source: 'vibe-extension', type: 'navigate', path });
		}
	}
	simSidebarViewProvider.navigate(path);
}

async function handleSimResourceMessage(message: SimWebviewMessage): Promise<void> {
	switch (message.type) {
		case SimWebviewMessageType.OpenExternal:
			await openExternalUri(message.uri);
			return;
		case SimWebviewMessageType.OpenFile:
			await openFile(message);
			return;
		case SimWebviewMessageType.OpenDiff:
			await openDiff(message);
			return;
		case SimWebviewMessageType.OpenTerminal:
			openTerminal(message.uri);
			return;
	}
}

function broadcastHostContext(simSidebarViewProvider: SimSidebarViewProvider, hostContext = createHostContext(getSimPlugin())): void {
	for (const panel of [simEditorPanel, simFullscreenPanel]) {
		if (panel) {
			void panel.webview.postMessage({ source: 'vibe-extension', type: 'context', context: hostContext });
		}
	}
	simSidebarViewProvider.updateHostContext(hostContext);
}

function reloadOpenPanels(simSidebarViewProvider: SimSidebarViewProvider): void {
	const baseUrl = getConfiguredSimBaseUrl();
	const plugin = getSimPlugin();
	const hostContext = createHostContext(plugin);
	if (simEditorPanel) {
		simEditorPanel.webview.html = renderSimWebview({ configuredBaseUrl: baseUrl, hostContext, initialPath: currentSimPath, surface: SimWebviewSurface.Editor });
	}
	if (simFullscreenPanel) {
		simFullscreenPanel.webview.html = renderSimWebview({ configuredBaseUrl: baseUrl, hostContext, initialPath: currentSimPath, surface: SimWebviewSurface.Fullscreen });
	}
	simSidebarViewProvider.updateBaseUrl(baseUrl);
}

function getSimPlugin(): VibeSubPlugin {
	const plugin = getVibeSubPlugins().find(candidate => candidate.id === 'sim');
	if (!plugin) {
		throw new Error('Sim subplugin is not registered.');
	}
	return plugin;
}

function createHostContext(plugin: VibeSubPlugin, workspaceContext = vscode.workspace.vibeWorkspaceContext): VibeSubPluginHostContext {
	const subscriptions = plugin.contextSubscriptions;
	const activeEditor = vscode.window.activeTextEditor ?? lastActiveTextEditor;
	return {
		language: vscode.env.language,
		...(subscriptions.physicalWorkspace && workspaceContext ? {
			physicalWorkspace: {
				id: workspaceContext.physicalWorkspace.id,
				name: workspaceContext.physicalWorkspace.name,
				folders: workspaceContext.physicalWorkspace.folders.map(folder => ({
					name: folder.name,
					uri: folder.uri.toString(),
					index: folder.index,
				})),
			},
		} : undefined),
		...(subscriptions.logicalWorkspace && workspaceContext ? {
			logicalWorkspace: {
				id: workspaceContext.logicalWorkspace.id,
				name: workspaceContext.logicalWorkspace.name,
			},
		} : undefined),
		...(subscriptions.project && workspaceContext?.project ? {
			project: {
				name: workspaceContext.project.name,
				uri: workspaceContext.project.uri.toString(),
			},
		} : undefined),
		...((subscriptions.activeFile || subscriptions.selection) && activeEditor ? { activeFile: {
			uri: activeEditor.document.uri.toString(),
			...(subscriptions.selection ? { selection: {
				startLine: activeEditor.selection.start.line,
				startCharacter: activeEditor.selection.start.character,
				endLine: activeEditor.selection.end.line,
				endCharacter: activeEditor.selection.end.character,
			} } : undefined),
		} } : undefined),
	};
}

function getConfiguredSimBaseUrl(): string {
	const configured = vscode.workspace.getConfiguration('vibe-vscode').get<string>(SIM_BASE_URL_CONFIGURATION, '').trim();
	if (!configured) {
		return '';
	}
	try {
		const uri = vscode.Uri.parse(configured, true);
		if (uri.scheme !== 'https' && uri.scheme !== 'http') {
			return '';
		}
		return uri.toString(true).replace(/\/$/, '');
	} catch {
		return '';
	}
}

async function openExternalUri(value: string | undefined): Promise<void> {
	const uri = parseUri(value, new Set(['http', 'https']));
	if (uri) {
		await vscode.env.openExternal(uri);
	}
}

async function openFile(message: SimWebviewMessage): Promise<void> {
	const uri = parseUri(message.uri, new Set(['file', 'vscode-remote']));
	if (!uri) {
		return;
	}
	const document = await vscode.workspace.openTextDocument(uri);
	const line = toNonNegativeInteger(message.line);
	const character = toNonNegativeInteger(message.character);
	await vscode.window.showTextDocument(document, {
		preview: true,
		selection: line === undefined ? undefined : new vscode.Range(line, character ?? 0, line, character ?? 0),
	});
}

async function openDiff(message: SimWebviewMessage): Promise<void> {
	const original = parseUri(message.originalUri, new Set(['file', 'vscode-remote', 'git']));
	const modified = parseUri(message.modifiedUri, new Set(['file', 'vscode-remote', 'git']));
	if (!original || !modified) {
		return;
	}
	await vscode.commands.executeCommand('vscode.diff', original, modified, message.title ?? vscode.l10n.t('Sim Changes'));
}

function openTerminal(value: string | undefined): void {
	const cwd = parseUri(value, new Set(['file', 'vscode-remote']));
	const terminal = vscode.window.createTerminal({ name: vscode.l10n.t('Sim Task'), cwd });
	terminal.show();
}

function parseUri(value: string | undefined, allowedSchemes: ReadonlySet<string>): vscode.Uri | undefined {
	if (!value) {
		return undefined;
	}
	try {
		const uri = vscode.Uri.parse(value, true);
		return allowedSchemes.has(uri.scheme) ? uri : undefined;
	} catch {
		return undefined;
	}
}

function toNonNegativeInteger(value: number | undefined): number | undefined {
	return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isPersistedPanelState(value: unknown): value is { readonly path: string } {
	return typeof value === 'object' && value !== null && 'path' in value && isSafeSimPath(typeof value.path === 'string' ? value.path : undefined);
}
