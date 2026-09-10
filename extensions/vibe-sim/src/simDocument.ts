/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { NativeClient } from './native/nativeClient';
import { readResponse } from './nativeResources';
import { CreateChatRequest, editorKey, HostContext, isSimMessage, SimMessage, SimSurface, simWorkspaceId, surfacePath } from './simSurface';
import { WebviewTransport } from './webviewTransport';

export interface DocumentConnection {
	readonly client: NativeClient;
	readonly resourceRoot: vscode.Uri;
	readonly context: HostContext;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/** Next's own SSR output is hosted unchanged except for the Webview's CSP, base and transport boot. */
export function nativeDocument(html: string, resourceOrigin: string, script: string, cspSource: string, token: string, route: string): string {
	const nonce = randomBytes(24).toString('hex');
	const csp = `default-src 'none'; base-uri ${cspSource}; script-src ${cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} https: data: blob:; font-src ${cspSource} data:; connect-src ${cspSource} https: wss:; worker-src ${cspSource} blob:; media-src ${cspSource} https: data: blob:; frame-src https:; form-action 'none';`;
	const configuration = JSON.stringify({ token, path: route, resourceOrigin }).replace(/</g, '\\u003c');
	const bootstrap = `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><base href="${escapeHtml(resourceOrigin)}"><script nonce="${nonce}" src="${escapeHtml(script)}"></script><script nonce="${nonce}">simNative.install(${configuration});</script>`;
	return html.replace(/<script\b([^>]*)>/gi, (_tag, attributes: string) => `<script nonce="${nonce}"${attributes.replace(/\snonce=(?:"[^"]*"|'[^']*')/gi, '')}>`).replace(/<head\b[^>]*>/i, head => `${head}${bootstrap}`);
}

/** A view generation owns only browser state and I/O. Its parent owns the native runtime. */
export class SimDocument implements vscode.Disposable {
	private readonly messages: vscode.Disposable;
	private token = randomUUID();
	private generation = 0;
	private lifetime = new AbortController();
	private transport: WebviewTransport | undefined;
	private ready = Promise.withResolvers<void>();
	private connected = false;
	private initiated = false;
	private disposed = false;
	private loading: Promise<void> | undefined;
	private readyTimer: ReturnType<typeof setTimeout> | undefined;
	private context: HostContext | undefined;
	private projectionTarget: string | undefined;
	private readonly creations = new Map<string, { request: CreateChatRequest; readonly result: PromiseWithResolvers<string>; readonly prepared: (request: CreateChatRequest) => void; sent: boolean }>();

	constructor(
		readonly webview: vscode.Webview, readonly surface: SimSurface, private route: string,
		private readonly connect: () => Promise<DocumentConnection>,
		private readonly onMessage: (message: SimMessage) => void,
		private readonly describeError: (error: Error) => string,
	) {
		void this.ready.promise.catch(() => { });
		this.messages = webview.onDidReceiveMessage((message: unknown) => {
			if (this.disposed || typeof message !== 'object' || !message || !('token' in message) || message.token !== this.token) { return; }
			if ('source' in message && message.source === 'sim-retry') { void this.load(); return; }
			if (!isSimMessage(message)) { return; }
			if (message.type === 'ready') {
				this.connected = true; clearTimeout(this.readyTimer); this.ready.resolve();
				if (this.context) { this.send('context', this.context); }
				if (this.projectionTarget) { this.send('navigate', { path: this.route }); }
				this.sendCreations();
			} else if (message.type === 'chatCreated' && message.payload?.requestId) {
				const creation = this.creations.get(message.payload.requestId);
				if (message.payload.error) { creation?.result.reject(new Error(message.payload.error)); }
				else if (message.payload.path) { creation?.result.resolve(message.payload.path); }
			} else if (message.type === 'routeChanged' && message.payload?.path) {
				// Host tab selection remains authoritative until a new user navigation. In particular,
				// late hydration and A → B → A completions cannot reselect an obsolete resource.
				if (message.payload.userInitiated) { this.projectionTarget = undefined; }
				else if (this.projectionTarget && editorKey(message.payload.path) !== editorKey(this.projectionTarget)) { return; }
				this.route = message.payload.path; this.sendCreations();
			}
			this.onMessage(message);
		});
	}

	load(): Promise<void> {
		if (this.disposed) { return Promise.resolve(); }
		if (this.loading) { return this.loading; }
		this.loading = this.loadNative().finally(() => { this.loading = undefined; });
		return this.loading;
	}

	private async loadNative(): Promise<void> {
		this.reset();
		this.initiated = true;
		const generation = this.generation;
		this.ready = Promise.withResolvers<void>(); void this.ready.promise.catch(() => { });
		this.status(vscode.l10n.t("Starting the native Sim plugin…"), false);
		try {
			const connection = await this.connect();
			if (this.disposed || generation !== this.generation) { return; }
			const requestedRoute = this.route;
			const result = await connection.client.request(surfacePath(requestedRoute, this.surface), { signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30000)]) });
			const html = new TextDecoder().decode(await readResponse(result.response));
			if (!result.response.ok || !html.includes('<head')) { throw new Error(vscode.l10n.t("The native Sim page could not be loaded.")); }
			if (this.disposed || generation !== this.generation) { return; }
			this.context = connection.context;
			this.webview.options = { enableScripts: true, enableForms: false, enableCommandUris: false, localResourceRoots: [connection.resourceRoot] };
			const root = this.webview.asWebviewUri(connection.resourceRoot).toString();
			const script = this.webview.asWebviewUri(vscode.Uri.joinPath(connection.resourceRoot, '__vscode/transport.js')).toString();
			this.transport = new WebviewTransport(this.webview, connection.client, this.token);
			this.readyTimer = setTimeout(() => this.unavailable(vscode.l10n.t("The native Sim interface did not become ready. Retry to reconnect.")), 60000);
			this.webview.html = nativeDocument(html, root, script, this.webview.cspSource, this.token, result.path);
		} catch (error) {
			if (!this.disposed && generation === this.generation) { this.unavailable(this.describeError(error)); }
		}
	}

	private send(type: string, payload?: object): void {
		if (this.connected) { void this.webview.postMessage({ source: 'vibe-vscode', token: this.token, type, payload }); }
	}

	setContext(context: HostContext): void { this.context = context; this.send('context', context); }
	navigate(route: string): void {
		this.projectionTarget = route;
		if (route !== this.route) { this.route = route; this.send('navigate', { path: route }); }
	}

	async createChat(request: CreateChatRequest, prepared: (request: CreateChatRequest) => void): Promise<string> {
		await this.loadIfNeeded();
		await this.ready.promise;
		const creation = { request, result: Promise.withResolvers<string>(), prepared, sent: false };
		this.creations.set(request.requestId, creation);
		const timer = setTimeout(() => creation.result.reject(new Error(vscode.l10n.t("Sim did not confirm chat creation. Retry to recover the same chat."))), 30000);
		this.sendCreations();
		try { return await creation.result.promise; } finally { clearTimeout(timer); this.creations.delete(request.requestId); }
	}

	private loadIfNeeded(): Promise<void> { return this.initiated ? this.loading ?? Promise.resolve() : this.load(); }

	private sendCreations(): void {
		if (!this.connected) { return; }
		for (const creation of this.creations.values()) {
			const workspaceId = creation.request.workspaceId ?? simWorkspaceId(this.route);
			if (creation.sent || !workspaceId) { continue; }
			creation.request = { ...creation.request, workspaceId };
			creation.prepared(creation.request);
			creation.sent = true;
			this.send('createChat', creation.request);
		}
	}

	unavailable(message: string): void { this.reset(); if (!this.disposed) { this.status(message, true); } }

	private status(message: string, retry: boolean): void {
		const nonce = randomBytes(16).toString('hex');
		this.webview.options = { enableScripts: true, localResourceRoots: [] };
		this.webview.html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:16px;line-height:1.5}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:6px 12px;cursor:pointer}button:focus-visible{outline:1px solid var(--vscode-focusBorder)}</style></head><body><p role="status">${escapeHtml(message)}</p>${retry ? `<button id="retry">${escapeHtml(vscode.l10n.t("Retry"))}</button><script nonce="${nonce}">const vscode=acquireVsCodeApi();document.getElementById('retry').onclick=()=>vscode.postMessage({source:'sim-retry',token:${JSON.stringify(this.token)}});</script>` : ''}</body></html>`;
	}

	private reset(): void {
		this.generation++; this.connected = false; this.initiated = false; this.token = randomUUID();
		clearTimeout(this.readyTimer); this.lifetime.abort(); this.lifetime = new AbortController();
		this.transport?.dispose(); this.transport = undefined;
		const error = new Error(vscode.l10n.t("The Sim view was disconnected. Existing chats have been preserved."));
		this.ready.reject(error);
		for (const creation of this.creations.values()) { creation.result.reject(error); }
		this.creations.clear();
	}

	dispose(): void { if (!this.disposed) { this.disposed = true; this.reset(); this.messages.dispose(); } }
}
