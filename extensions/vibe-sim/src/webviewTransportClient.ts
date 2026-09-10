/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { maxBodyBytes, maxRequestBodyBytes, TransportReply, TransportRequest, transportSource } from './transportProtocol';

interface WebviewApi {
	postMessage(message: object): void;
	getState(): { path?: string; title?: string } | undefined;
	setState(state: { path?: string; title?: string }): void;
}
declare function acquireVsCodeApi(): WebviewApi;

interface Configuration {
	readonly token: string;
	readonly path: string;
	readonly resourceOrigin: string;
}

interface FetchOperation {
	readonly resolve: (response: Response) => void;
	readonly reject: (error: Error) => void;
	readonly release: () => void;
	controller?: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
	pulled?: () => void;
}

type RequestPayload<T = TransportRequest> = T extends TransportRequest ? Omit<T, 'source' | 'token'> : never;

/** Installs only platform transport. Sim still owns routing, queries, messages and agent state. */
export function install(configuration: Configuration): void {
	const api = acquireVsCodeApi();
	const originalFetch = window.fetch.bind(window);
	const originalSocket = window.WebSocket;
	const originalEventSource = window.EventSource;
	const originalBeacon = navigator.sendBeacon.bind(navigator);
	const requests = new Map<number, FetchOperation>();
	const sockets = new Map<number, NativeSocket>();
	const listeners = new Set<(message: unknown) => void>();
	let sequence = 0;
	const post = (message: RequestPayload) => api.postMessage({ ...message, source: transportSource, token: configuration.token });
	const host = (type: string, payload?: object) => api.postMessage({ source: 'sim', token: configuration.token, type, payload });
	const applicationHosts = new Set([window.location.host, new URL(configuration.resourceOrigin).host, 'sim.vscode.invalid']);
	const nativePath = (value: string | URL) => {
		const url = new URL(value.toString(), document.baseURI);
		return applicationHosts.has(url.host) && ['https:', 'http:', 'ws:', 'wss:', window.location.protocol].includes(url.protocol) ? `${url.pathname}${url.search}` : undefined;
	};

	// A Webview's real origin is retained; only its route is initialized for the native Next router.
	const replace = window.history.replaceState.bind(window.history);
	const push = window.history.pushState.bind(window.history);
	const historyUrl = (value?: string | URL | null) => {
		if (value === undefined || value === null) { return value; }
		const path = nativePath(value);
		return path === undefined ? value : new URL(path, window.location.href).href;
	};
	// Relative History URLs resolve against <base>, unlike the document's own origin.
	replace({}, '', new URL(configuration.path, window.location.href).href);
	window.history.replaceState = (state, unused, url) => { replace(state, unused, historyUrl(url)); persistRoute(); };
	window.history.pushState = (state, unused, url) => { push(state, unused, historyUrl(url)); persistRoute(); };
	function persistRoute(): void {
		const url = new URL(window.location.href);
		url.searchParams.delete('_vscodeSurface');
		api.setState({ ...api.getState(), path: `${url.pathname}${url.search}${url.hash}` });
	}
	persistRoute();
	Object.defineProperty(window, 'vibeVscodeTransport', { value: Object.freeze({
		token: configuration.token,
		postMessage: (message: Record<string, unknown>) => {
			if (message.type === 'titleChanged' && typeof message.payload === 'object' && message.payload && 'title' in message.payload && typeof message.payload.title === 'string') {
				api.setState({ ...api.getState(), title: message.payload.title });
			}
			api.postMessage(message);
		},
		onMessage: (listener: (message: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
	}) });

	const finish = (id: number, error?: Error) => {
		const operation = requests.get(id);
		if (!operation) { return; }
		requests.delete(id);
		operation.release();
		if (error) { operation.reject(error); operation.controller?.error(error); }
		else { operation.controller?.close(); }
		operation.pulled?.();
	};

	window.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		const route = nativePath(url);
		if (route === undefined) { return originalFetch(input, init); }
		const request = new Request(input instanceof Request ? input : new URL(url, document.baseURI), init);
		request.signal.throwIfAborted();
		const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
		if (body && body.byteLength > maxRequestBodyBytes) { throw new RangeError('The Sim request body exceeds the transport limit'); }
		request.signal.throwIfAborted();
		const id = ++sequence;
		return new Promise<Response>((resolve, reject) => {
			const abort = () => { finish(id, new DOMException('The request was cancelled', 'AbortError')); post({ type: 'cancel', id }); };
			requests.set(id, { resolve, reject, release: () => request.signal.removeEventListener('abort', abort) });
			request.signal.addEventListener('abort', abort, { once: true });
			post({ type: 'fetch', id, path: route, method: request.method, headers: [...request.headers], body, redirect: request.redirect });
		});
	};

	// Native tool cleanup uses the same private fetch channel. This is best effort:
	// closing the Webview still cancels its I/O; a beacon is never a durability barrier.
	let pendingBeacons = 0;
	navigator.sendBeacon = (url, data) => {
		if (nativePath(url) === undefined) { return originalBeacon(url, data); }
		if (pendingBeacons >= 16) { return false; }
		try {
			const request = new Request(new URL(url, document.baseURI), { method: 'POST', body: data, keepalive: true });
			pendingBeacons++;
			void window.fetch(request).then(response => response.body?.cancel()).catch(() => { }).finally(() => { pendingBeacons--; });
			return true;
		} catch { return false; }
	};

	window.addEventListener('message', (event: MessageEvent<unknown>) => {
		if (typeof event.data !== 'object' || !event.data || !('token' in event.data) || event.data.token !== configuration.token) { return; }
		if (!('source' in event.data) || event.data.source !== transportSource) {
			for (const listener of listeners) { listener(event.data); }
			return;
		}
		const message = event.data as TransportReply;
		const operation = requests.get(message.id);
		if (message.type === 'response' && operation) {
			const body = message.body ? new ReadableStream<Uint8Array<ArrayBuffer>>({
				start: controller => { operation.controller = controller; },
				pull: () => new Promise<void>(resolve => { operation.pulled = resolve; post({ type: 'pull', id: message.id }); }),
				cancel: () => { requests.delete(message.id); operation.release(); operation.pulled?.(); post({ type: 'cancel', id: message.id }); },
			}, { highWaterMark: 0 }) : null;
			const response = new Response(body, { status: message.status, statusText: message.statusText, headers: message.headers.map(pair => [...pair]) });
			Object.defineProperties(response, { url: { value: new URL(message.path, window.location.href).href }, redirected: { value: message.redirected } });
			operation.resolve(response);
			if (!body) { finish(message.id); }
		} else if (message.type === 'chunk' && operation) {
			operation.controller?.enqueue(new Uint8Array(message.data));
			operation.pulled?.();
			operation.pulled = undefined;
		} else if (message.type === 'end') {
			finish(message.id);
		} else if (message.type === 'error') {
			finish(message.id, new TypeError('The native Sim request failed'));
			sockets.get(message.id)?.receive({ ...message, type: 'socketError' });
		} else {
			sockets.get(message.id)?.receive(message);
		}
	});

	class NativeSocket extends EventTarget {
		static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
		readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
		readonly id = ++sequence;
		readonly url: string;
		readyState = 0;
		bufferedAmount = 0;
		binaryType: BinaryType = 'blob';
		protocol = '';
		extensions = '';
		onopen: ((event: Event) => void) | null = null;
		onmessage: ((event: MessageEvent) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;
		onclose: ((event: CloseEvent) => void) | null = null;
		private writes = Promise.resolve();

		constructor(url: string | URL, path: string, protocols?: string | string[]) {
			super();
			this.url = url.toString();
			sockets.set(this.id, this);
			post({ type: 'socketOpen', id: this.id, path, protocols: typeof protocols === 'string' ? [protocols] : protocols ?? [] });
		}

		send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
			if (this.readyState === 0) { throw new DOMException('The socket is connecting', 'InvalidStateError'); }
			if (this.readyState !== 1) { return; }
			const bytes = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data instanceof Blob ? data.size : data.byteLength;
			if (this.bufferedAmount + bytes > maxBodyBytes) { this.close(1000, 'Transport buffer limit'); return; }
			this.bufferedAmount += bytes;
			this.writes = this.writes.then(async () => {
				const payload = typeof data === 'string' ? data : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : new Uint8Array(data).slice();
				post({ type: 'socketSend', id: this.id, data: payload });
			}).catch(() => this.close(1000, 'Transport write failed'));
		}

		close(code?: number, reason?: string): void {
			if (code !== undefined && code !== 1000 && (!Number.isInteger(code) || code < 3000 || code >= 5000)) { throw new DOMException('Invalid close code', 'InvalidAccessError'); }
			if (reason && new TextEncoder().encode(reason).byteLength > 123) { throw new SyntaxError('The close reason is too long'); }
			if (this.readyState >= 2) { return; }
			this.readyState = 2;
			void this.writes.then(() => post({ type: 'socketClose', id: this.id, code, reason }));
		}

		receive(message: TransportReply): void {
			switch (message.type) {
				case 'socketOpened': {
					if (this.readyState !== 0) { return; }
					this.readyState = 1; this.protocol = message.protocol; this.extensions = message.extensions;
					const event = new Event('open'); this.dispatchEvent(event); this.onopen?.(event); return;
				}
				case 'socketSent': this.bufferedAmount = Math.max(0, this.bufferedAmount - message.bytes); return;
				case 'socketData': {
					try {
						const data = typeof message.data === 'string' ? message.data : this.binaryType === 'arraybuffer' ? new Uint8Array(message.data).buffer : new Blob([new Uint8Array(message.data)]);
						const event = new MessageEvent('message', { data, origin: window.location.origin }); this.dispatchEvent(event); this.onmessage?.(event);
					} finally { post({ type: 'socketAck', id: this.id }); }
					return;
				}
				case 'socketError': { const event = new Event('error'); this.dispatchEvent(event); this.onerror?.(event); return; }
				case 'socketClosed': {
					this.readyState = 3; sockets.delete(this.id);
					const event = new CloseEvent('close', { code: message.code, reason: message.reason, wasClean: message.clean }); this.dispatchEvent(event); this.onclose?.(event); return;
				}
			}
		}
	}
	const Socket = function (url: string | URL, protocols?: string | string[]) {
		const path = nativePath(url);
		return path === undefined ? new originalSocket(url, protocols) : new NativeSocket(url, path, protocols);
	};
	Object.assign(Socket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
	Socket.prototype = NativeSocket.prototype;
	Object.defineProperty(window, 'WebSocket', { value: Socket });

	/** EventSource's standard reconnect is read-only. Last-Event-ID is preserved; mutations never retry. */
	class NativeEventSource extends EventTarget {
		static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSED = 2;
		readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSED = 2;
		readyState = 0;
		readonly url: string;
		readonly withCredentials: boolean;
		onopen: ((event: Event) => void) | null = null;
		onmessage: ((event: MessageEvent) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;
		private readonly lifetime = new AbortController();
		private retry = 3000;
		private lastId = '';
		private timer: ReturnType<typeof setTimeout> | undefined;

		constructor(url: string | URL, options?: EventSourceInit) {
			super(); this.url = url.toString(); this.withCredentials = options?.withCredentials ?? false;
			void this.connect();
		}
		close(): void { this.readyState = 2; clearTimeout(this.timer); this.lifetime.abort(); }
		private async connect(): Promise<void> {
			if (this.lifetime.signal.aborted) { return; }
			try {
				const response = await window.fetch(this.url, { headers: { accept: 'text/event-stream', ...(this.lastId ? { 'last-event-id': this.lastId } : {}) }, signal: this.lifetime.signal, cache: 'no-store' });
				if (response.status === 204) { this.close(); return; }
				if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) { await response.body?.cancel(); throw new Error('Event stream unavailable'); }
				this.readyState = 1;
				const opened = new Event('open'); this.dispatchEvent(opened); this.onopen?.(opened);
				const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
				let buffer = ''; let data: string[] = []; let dataLength = 0; let name = '';
				try {
					while (!this.lifetime.signal.aborted) {
						const chunk = await reader.read();
						if (chunk.done) { break; }
						buffer += chunk.value;
						if (buffer.length > maxBodyBytes) { throw new Error('Event line exceeds transport limit'); }
						let match: RegExpExecArray | null;
						while ((match = /\r\n|\n|\r(?!$)/.exec(buffer))) {
							const line = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
							if (!line) {
								if (data.length) {
									const event = new MessageEvent(name || 'message', { data: data.join('\n'), lastEventId: this.lastId, origin: window.location.origin }); this.dispatchEvent(event); if (!name || name === 'message') { this.onmessage?.(event); }
								}
								data = []; dataLength = 0; name = ''; continue;
							}
							const colon = line.indexOf(':'); const field = colon < 0 ? line : line.slice(0, colon); const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
							if (field === 'data') {
								dataLength += value.length + 1;
								if (dataLength > maxBodyBytes) { throw new Error('Event data exceeds transport limit'); }
								data.push(value);
							}
							else if (field === 'event') { name = value; }
							else if (field === 'id' && !value.includes('\0')) { this.lastId = value; }
							else if (field === 'retry' && /^\d+$/.test(value)) { this.retry = Math.min(30000, Math.max(100, Number(value))); }
						}
					}
				} finally { await reader.cancel().catch(() => { }); }
			} catch { /* The EventSource error contract deliberately contains no native diagnostics. */ }
			if (!this.lifetime.signal.aborted) {
				this.readyState = 0;
				const event = new Event('error'); this.dispatchEvent(event); this.onerror?.(event);
				this.timer = setTimeout(() => { void this.connect(); }, this.retry);
			}
		}
	}
	const EventSource = function (url: string | URL, options?: EventSourceInit) {
		return nativePath(url) === undefined ? new originalEventSource(url, options) : new NativeEventSource(url, options);
	};
	Object.assign(EventSource, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
	EventSource.prototype = NativeEventSource.prototype;
	Object.defineProperty(window, 'EventSource', { value: EventSource });

	window.addEventListener('click', event => {
		const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
		if (!(anchor instanceof HTMLAnchorElement) || nativePath(anchor.href) !== undefined || anchor.hasAttribute('download')) { return; }
		if (['http:', 'https:'].includes(new URL(anchor.href).protocol)) { event.preventDefault(); host('openExternal', { uri: anchor.href }); }
	}, true);
}
