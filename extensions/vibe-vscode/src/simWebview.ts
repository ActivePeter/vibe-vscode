/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { VibeSubPluginHostContext } from './subplugins';
import { createNonce, escapeHtml, safeJson } from './webviewUtils';

export const enum SimWebviewSurface {
	Editor = 'editor',
	Fullscreen = 'fullscreen',
	Sidebar = 'sidebar',
}

export enum SimWebviewMessageType {
	OpenDiff = 'openDiff',
	OpenEditor = 'openEditor',
	OpenExternal = 'openExternal',
	OpenFile = 'openFile',
	OpenTerminal = 'openTerminal',
	RouteChanged = 'routeChanged',
}

export interface SimWebviewMessage {
	readonly type: SimWebviewMessageType;
	readonly uri?: string;
	readonly originalUri?: string;
	readonly modifiedUri?: string;
	readonly title?: string;
	readonly path?: string;
	readonly line?: number;
	readonly character?: number;
	readonly userInitiated?: boolean;
}

interface RenderSimWebviewOptions {
	readonly configuredBaseUrl: string;
	readonly hostContext: VibeSubPluginHostContext;
	readonly initialPath: string;
	readonly surface: SimWebviewSurface;
}

export function isSafeSimPath(value: string | undefined): value is string {
	return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
}

export function isSimWebviewMessage(value: unknown): value is SimWebviewMessage {
	if (typeof value !== 'object' || value === null || !('type' in value)) {
		return false;
	}
	return Object.values(SimWebviewMessageType).includes(value.type as SimWebviewMessageType);
}

/** Renders the common trusted iframe host used by both Sim projections. */
export function renderSimWebview(options: RenderSimWebviewOptions): string {
	const nonce = createNonce();
	const bridgeTokenSeed = createNonce();
	const title = escapeHtml(vscode.l10n.t('Sim Development Orchestration'));
	const loading = escapeHtml(vscode.l10n.t('Connecting'));
	const failureUi = {
		allowAndOpen: vscode.l10n.t('Allow and open Sim'),
		localNetworkBlocked: vscode.l10n.t('Chrome has blocked this permission. Open the site controls for this page, set Local network access to Allow, then return and retry.'),
		localNetworkDescription: vscode.l10n.t('Sim is opened through the current IP address. This browser must allow local network access before the embedded view can connect.'),
		localNetworkPrompt: vscode.l10n.t('Continue, then approve the browser permission request.'),
		localNetworkTitle: vscode.l10n.t('Local network access is required'),
		refresh: vscode.l10n.t('Refresh'),
		serviceDescription: vscode.l10n.t('The Sim gateway did not respond. Confirm that the Sim latest service is running, then retry.'),
		serviceHelp: vscode.l10n.t('If automatic routing is unavailable, configure vibe-vscode.sim.baseUrl with an HTTPS Sim address.'),
		serviceTitle: vscode.l10n.t('Unable to load Sim'),
	};
	const language = escapeHtml(vscode.env.language);
	const serializedBaseUrl = safeJson(options.configuredBaseUrl);
	const serializedFailureUi = safeJson(failureUi);
	const serializedHostContext = safeJson(options.hostContext);
	const serializedInitialPath = safeJson(options.initialPath);
	const serializedSurface = safeJson(options.surface === SimWebviewSurface.Fullscreen ? '' : options.surface);
	const serializedTokenSeed = safeJson(bridgeTokenSeed);

	return `<!DOCTYPE html>
<html lang="${language}">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src https: http:; connect-src https: http:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<title>${title}</title>
	<style nonce="${nonce}">
		:root { color-scheme: light dark; }
		* { box-sizing: border-box; }
		html, body, main { width: 100%; height: 100%; margin: 0; overflow: hidden; }
		body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
		main { position: relative; }
		iframe { display: block; width: 100%; height: 100%; border: 0; background: #0c0c0c; }
		.overlay {
			position: absolute;
			inset: 0;
			display: grid;
			place-items: center;
			padding: 20px;
			background: var(--vscode-editor-background);
		}
		.overlay.hidden { display: none; }
		.loading { color: var(--vscode-descriptionForeground); font-size: 12px; }
		.failure { display: none; width: min(560px, 100%); padding: 18px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
		.overlay.failed .loading { display: none; }
		.overlay.failed .failure { display: block; }
		.failure h1 { margin: 0 0 8px; font-size: 17px; font-weight: 600; }
		.failure p { margin: 5px 0; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.55; }
		.failure p.hidden { display: none; }
		button {
			min-height: 28px;
			margin-top: 8px;
			padding: 0 10px;
			border: 1px solid var(--vscode-button-border, transparent);
			border-radius: 3px;
			color: var(--vscode-button-foreground);
			background: var(--vscode-button-background);
			font: inherit;
			cursor: pointer;
		}
		button:hover { background: var(--vscode-button-hoverBackground); }
		button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
	</style>
</head>
<body>
	<main>
		<iframe id="sim" title="${title}" allow="clipboard-read; clipboard-write; fullscreen; local-network-access"></iframe>
		<section id="overlay" class="overlay" aria-live="polite">
			<div class="loading">${loading}</div>
			<div class="failure">
				<h1 id="failure-title"></h1>
				<p id="failure-description"></p>
				<p id="failure-help"></p>
				<button id="retry" type="button"></button>
			</div>
		</section>
	</main>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const configuredBaseUrl = ${serializedBaseUrl};
		const failureUi = ${serializedFailureUi};
		const bridgeTokenSeed = ${serializedTokenSeed};
		const surface = ${serializedSurface};
		let hostContext = ${serializedHostContext};
		let currentPath = ${serializedInitialPath};
		let currentFrameToken = '';
		let navigationGeneration = 0;
		let simOrigin = '';
		let loadTimer;
		const frame = document.getElementById('sim');
		const overlay = document.getElementById('overlay');
		const failureTitle = document.getElementById('failure-title');
		const failureDescription = document.getElementById('failure-description');
		const failureHelp = document.getElementById('failure-help');
		const retryButton = document.getElementById('retry');

		function workbenchOrigin() {
			const ancestors = window.location.ancestorOrigins ? Array.from(window.location.ancestorOrigins) : [];
			for (let index = ancestors.length - 1; index >= 0; index--) {
				try {
					const candidate = new URL(ancestors[index]);
					if (candidate.protocol === 'https:' && !candidate.hostname.endsWith('.vscode-cdn.net')) return candidate.origin;
				} catch {}
			}
			try {
				const referrer = new URL(document.referrer);
				return referrer.protocol === 'https:' ? referrer.origin : '';
			} catch {
				return '';
			}
		}

		function baseUrl() {
			return configuredBaseUrl || workbenchOrigin();
		}

		function routeUrl(path, token) {
			const base = baseUrl();
			if (!base) return '';
			const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
			const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
			const url = new URL(normalizedBase + '/' + normalizedPath);
			if (surface) url.searchParams.set('_vscodeSurface', surface);
			url.hash = '_vscodeEmbed=' + encodeURIComponent(token);
			return url.toString();
		}

		function showServiceFailure() {
			overlay.dataset.failure = 'service';
			failureTitle.textContent = failureUi.serviceTitle;
			failureDescription.textContent = failureUi.serviceDescription;
			failureHelp.textContent = failureUi.serviceHelp;
			failureHelp.className = '';
			retryButton.textContent = failureUi.refresh;
			overlay.className = 'overlay failed';
		}

		function showLocalNetworkFailure(blocked) {
			overlay.dataset.failure = 'local-network';
			failureTitle.textContent = failureUi.localNetworkTitle;
			failureDescription.textContent = failureUi.localNetworkDescription;
			failureHelp.textContent = blocked ? failureUi.localNetworkBlocked : failureUi.localNetworkPrompt;
			failureHelp.className = '';
			retryButton.textContent = blocked ? failureUi.refresh : failureUi.allowAndOpen;
			overlay.className = 'overlay failed';
		}

		async function localNetworkPermissionState() {
			if (configuredBaseUrl || !navigator.permissions || typeof navigator.permissions.query !== 'function') return 'unsupported';
			try {
				return (await navigator.permissions.query({ name: 'local-network-access' })).state;
			} catch {
				return 'unsupported';
			}
		}

		function sendToSim(type, payload) {
			if (!frame.contentWindow || !simOrigin || !currentFrameToken) return;
			frame.contentWindow.postMessage({ source: 'vibe-vscode', token: currentFrameToken, type, payload }, simOrigin);
		}

		async function connect(generation, url, requestLocalNetworkAccess) {
			if (!configuredBaseUrl && !requestLocalNetworkAccess) {
				const permissionState = await localNetworkPermissionState();
				if (generation !== navigationGeneration) return;
				if (permissionState === 'prompt') {
					showLocalNetworkFailure(false);
					return;
				}
				if (permissionState === 'denied') {
					showLocalNetworkFailure(true);
					return;
				}
			}

			if (generation !== navigationGeneration) return;
			simOrigin = new URL(url).origin;
			frame.src = url;
			loadTimer = setTimeout(() => {
				if (generation !== navigationGeneration) return;
				void localNetworkPermissionState().then(permissionState => {
					if (generation !== navigationGeneration) return;
					if (permissionState === 'denied' || permissionState === 'prompt') {
						frame.src = 'about:blank';
						showLocalNetworkFailure(permissionState === 'denied');
					} else {
						showServiceFailure();
					}
				});
			}, 12000);
		}

		function load(path = currentPath, requestLocalNetworkAccess = false) {
			if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return;
			const generation = ++navigationGeneration;
			const token = bridgeTokenSeed + ':' + generation;
			const url = routeUrl(path, token);
			currentPath = path;
			currentFrameToken = token;
			overlay.className = 'overlay';
			overlay.dataset.failure = '';
			clearTimeout(loadTimer);
			if (!url) {
				showServiceFailure();
				return;
			}
			void connect(generation, url, requestLocalNetworkAccess);
		}

		frame.addEventListener('load', () => {
			sendToSim('context', hostContext);
			sendToSim('ping');
		});

		window.addEventListener('message', event => {
			const message = event.data;
			if (message && message.source === 'vibe-extension') {
				if (message.type === 'context') {
					hostContext = message.context;
					sendToSim('context', hostContext);
				} else if (message.type === 'navigate' && typeof message.path === 'string') {
					load(message.path);
				}
				return;
			}
			if (event.source !== frame.contentWindow || event.origin !== simOrigin || !message || message.source !== 'sim' || message.token !== currentFrameToken) return;
			if (message.type === 'ready') {
				clearTimeout(loadTimer);
				overlay.className = 'overlay hidden';
				sendToSim('context', hostContext);
				return;
			}
			if (message.type === 'routeChanged' && message.payload && typeof message.payload.path === 'string') {
				currentPath = message.payload.path;
				vscode.setState({ path: currentPath });
				vscode.postMessage({
					type: '${SimWebviewMessageType.RouteChanged}',
					path: currentPath,
					userInitiated: message.payload.userInitiated === true,
				});
				return;
			}
			if (message.type === 'openEditor' || message.type === 'openFile' || message.type === 'openDiff' || message.type === 'openTerminal' || message.type === 'openExternal') {
				vscode.postMessage({ type: message.type, ...(message.payload || {}) });
			}
		});

		retryButton.addEventListener('click', () => load(currentPath, overlay.dataset.failure === 'local-network'));
		const persistedState = vscode.getState();
		if (persistedState && typeof persistedState.path === 'string' && persistedState.path.startsWith('/') && !persistedState.path.startsWith('//')) currentPath = persistedState.path;
		load();
	</script>
</body>
</html>`;
}
