/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

let lastActiveTextEditor: vscode.TextEditor | undefined;

/** The Workbench owns presentation. This adapter only supplies standard extension API capabilities. */
export function activate(context: vscode.ExtensionContext): void {
	lastActiveTextEditor = vscode.window.activeTextEditor;
	context.subscriptions.push(
		vscode.commands.registerCommand('_vibe-vscode.sim.getContext', () => createHostContext()),
		vscode.commands.registerCommand('_vibe-vscode.sim.resource', (message: unknown) => handleResource(message)),
		vscode.window.registerWebviewPanelSerializer('vibe-vscode.sim.editor', {
			deserializeWebviewPanel: async (panel, state: unknown) => {
				// One-way migration of a saved legacy route, never another Webview UI or Session store.
				const path = isRecord(state) ? state.path : undefined;
				await vscode.commands.executeCommand('vibe-vscode.openSim', path);
				panel.dispose();
			},
		}),
		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor) {
				lastActiveTextEditor = editor;
			}
			broadcastContext();
		}),
		vscode.window.onDidChangeTextEditorSelection(event => {
			if (event.textEditor === lastActiveTextEditor) {
				broadcastContext();
			}
		}),
	);
	broadcastContext();
}

function createHostContext() {
	const editor = vscode.window.activeTextEditor ?? lastActiveTextEditor;
	return {
		language: vscode.env.language,
		...(editor ? {
			activeFile: {
				uri: editor.document.uri.toString(),
				selection: {
					startLine: editor.selection.start.line,
					startCharacter: editor.selection.start.character,
					endLine: editor.selection.end.line,
					endCharacter: editor.selection.end.character,
				},
			},
		} : undefined),
	};
}

function broadcastContext(): void {
	void vscode.commands.executeCommand('_vibe-vscode.sim.updateContext', createHostContext()).then(undefined, () => {
		// The hosted Workbench may not be available in other products using this extension.
	});
}

async function handleResource(message: unknown): Promise<void> {
	if (!isRecord(message)) {
		return;
	}
	switch (message.type) {
		case 'openExternal': {
			const uri = parseUri(message.uri, ['http', 'https']);
			if (uri) {
				await vscode.env.openExternal(uri);
			}
			return;
		}
		case 'openFile': {
			const uri = parseUri(message.uri, ['file', 'vscode-remote']);
			if (!uri) {
				return;
			}
			const line = toNonNegativeInteger(message.line);
			const character = toNonNegativeInteger(message.character);
			const document = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(document, {
				preview: true,
				selection: line === undefined ? undefined : new vscode.Range(line, character ?? 0, line, character ?? 0),
			});
			return;
		}
		case 'openDiff': {
			const original = parseUri(message.originalUri, ['file', 'vscode-remote', 'git']);
			const modified = parseUri(message.modifiedUri, ['file', 'vscode-remote', 'git']);
			if (original && modified) {
				const title = typeof message.title === 'string' ? message.title : vscode.l10n.t('Sim Changes');
				await vscode.commands.executeCommand('vscode.diff', original, modified, title);
			}
			return;
		}
		case 'openTerminal': {
			const cwd = parseUri(message.uri, ['file', 'vscode-remote']);
			const terminal = vscode.window.createTerminal({ name: vscode.l10n.t('Sim Task'), cwd });
			terminal.show();
			return;
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUri(value: unknown, allowedSchemes: readonly string[]): vscode.Uri | undefined {
	if (typeof value !== 'string' || !value) {
		return undefined;
	}
	try {
		const uri = vscode.Uri.parse(value, true);
		return allowedSchemes.includes(uri.scheme) ? uri : undefined;
	} catch {
		return undefined;
	}
}

function toNonNegativeInteger(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
