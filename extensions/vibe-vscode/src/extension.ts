/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const OPEN_FULLSCREEN_PANEL_COMMAND = 'vibe-vscode.openFullscreenPanel';
const CLOSE_FULLSCREEN_PANEL_COMMAND = 'vibe-vscode.closeFullscreenPanel';
const FULLSCREEN_PANEL_VIEW_TYPE = 'vibe-vscode.projectSwitcher.fullscreen';

const enum FullscreenPanelIntent {
	Open,
	Close,
}

const enum FullscreenPanelMessageType {
	Close = 'close',
}

interface FullscreenPanelMessage {
	readonly type: FullscreenPanelMessageType;
}

let fullscreenPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(OPEN_FULLSCREEN_PANEL_COMMAND, () => dispatchFullscreenPanelIntent(FullscreenPanelIntent.Open, context)),
		vscode.commands.registerCommand(CLOSE_FULLSCREEN_PANEL_COMMAND, () => dispatchFullscreenPanelIntent(FullscreenPanelIntent.Close, context)),
		new vscode.Disposable(() => fullscreenPanel?.dispose()),
	);
}

function dispatchFullscreenPanelIntent(intent: FullscreenPanelIntent, context: vscode.ExtensionContext): void {
	switch (intent) {
		case FullscreenPanelIntent.Open:
			openFullscreenPanel(context);
			return;
		case FullscreenPanelIntent.Close:
			fullscreenPanel?.dispose();
			return;
	}
}

function openFullscreenPanel(context: vscode.ExtensionContext): void {
	if (fullscreenPanel) {
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		FULLSCREEN_PANEL_VIEW_TYPE,
		vscode.l10n.t('vibe vscode'),
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			vibeVscodeFullscreen: true,
		},
	);
	fullscreenPanel = panel;
	panel.webview.html = renderFullscreenPanel();

	const messageListener = panel.webview.onDidReceiveMessage((message: unknown) => {
		if (isFullscreenPanelMessage(message) && message.type === FullscreenPanelMessageType.Close) {
			void dispatchFullscreenPanelIntent(FullscreenPanelIntent.Close, context);
		}
	});
	const disposeListener = panel.onDidDispose(() => {
		messageListener.dispose();
		disposeListener.dispose();
		if (fullscreenPanel === panel) {
			fullscreenPanel = undefined;
		}
	});
}

function isFullscreenPanelMessage(value: unknown): value is FullscreenPanelMessage {
	return typeof value === 'object' && value !== null && 'type' in value && value.type === FullscreenPanelMessageType.Close;
}

function renderFullscreenPanel(): string {
	const nonce = createNonce();
	const title = escapeHtml(vscode.l10n.t('vibe vscode fullscreen panel'));
	const description = escapeHtml(vscode.l10n.t('The privileged fullscreen host is active. vibe vscode interfaces can now be mounted in this surface.'));
	const close = escapeHtml(vscode.l10n.t('Close'));
	const language = escapeHtml(vscode.env.language);

	return `<!DOCTYPE html>
<html lang="${language}">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<title>${title}</title>
	<style nonce="${nonce}">
		:root { color-scheme: light dark; }
		* { box-sizing: border-box; }
		html, body { width: 100%; height: 100%; margin: 0; }
		body {
			display: grid;
			grid-template-rows: auto 1fr;
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
			font-family: var(--vscode-font-family);
		}
		header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 16px;
			min-height: 52px;
			padding: 0 20px;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		.brand { font-size: 13px; font-weight: 600; letter-spacing: 0.04em; }
		button {
			min-height: 30px;
			padding: 0 12px;
			border: 1px solid var(--vscode-button-border, transparent);
			border-radius: 4px;
			color: var(--vscode-button-foreground);
			background: var(--vscode-button-background);
			font: inherit;
			cursor: pointer;
		}
		button:hover { background: var(--vscode-button-hoverBackground); }
		button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
		main {
			display: grid;
			place-items: center;
			min-width: 0;
			min-height: 0;
			padding: 32px;
		}
		.intro { width: min(680px, 100%); }
		h1 { margin: 0 0 12px; font-size: 26px; line-height: 1; font-weight: 600; }
		p { max-width: 58ch; margin: 0; color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1.7; }
	</style>
</head>
<body>
	<header>
		<div class="brand">VIBE VSCODE</div>
		<button id="close" type="button" aria-label="${close}">${close}</button>
	</header>
	<main>
		<section class="intro" aria-labelledby="title">
			<h1 id="title">${title}</h1>
			<p>${description}</p>
		</section>
	</main>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.getElementById('close').addEventListener('click', () => vscode.postMessage({ type: '${FullscreenPanelMessageType.Close}' }));
	</script>
</body>
</html>`;
}

function createNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let value = '';
	for (let index = 0; index < 32; index++) {
		value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return value;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll('\'', '&#039;');
}
