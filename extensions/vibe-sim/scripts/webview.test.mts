/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import type * as vscode from 'vscode';
import type { DocumentConnection } from '../src/simDocument.ts';
import type { SimMessage } from '../src/simSurface.ts';
import type { TransportReply, TransportRequest } from '../src/transportProtocol.ts';
import { bundle, waitFor } from './testUtils.mts';

const require = createRequire(import.meta.url);
const mockVscode = {
	l10n: { t: (value: string) => value },
	Uri: { joinPath: (_base: object, relative: string) => ({ toString: () => `https://resources.vscode.invalid/${relative}` }) },
};

function load<T>(entry: string): T {
	return runInNewContext(`${bundle(entry)}\nmodule.exports;`, {
		module: { exports: {} }, require: (name: string) => name === 'vscode' ? mockVscode : require(name),
		process, Buffer, URL, Headers, Response, ReadableStream, Uint8Array, ArrayBuffer, TextDecoder, TextEncoder,
		AbortController, AbortSignal, Promise, setTimeout, clearTimeout, fetch,
	}) as T;
}

const { SimDocument, nativeDocument } = load<typeof import('../src/simDocument.ts')>('simDocument');
const { NativeClient, publicResponseHeaders } = load<typeof import('../src/native/nativeClient.ts')>('native/nativeClient');
const { WebviewTransport } = load<typeof import('../src/webviewTransport.ts')>('webviewTransport');
const { isSafeSimPath, editorKey } = load<typeof import('../src/simSurface.ts')>('simSurface');

function createDocumentConnection(): DocumentConnection {
	const client = new class extends NativeClient {
		override async request(path: string) {
			return { response: new Response('<html><head></head><body>Native Sim</body></html>'), path, redirected: false, headers: [] };
		}
		override openSocket(): never { throw new Error('Unexpected socket in the document fixture'); }
	}('document-test', { applicationPort: 1, realtimePort: 2, gateway: 'fixture' }, () => true);
	const resourceRoot: vscode.Uri = {
		scheme: 'https', authority: 'resources.vscode.invalid', path: '/', query: '', fragment: '', fsPath: '/',
		with: () => resourceRoot, toJSON: () => ({}), toString: () => 'https://resources.vscode.invalid/',
	};
	return { client, resourceRoot, context: {
		version: 1, generation: 1, language: 'en',
		physicalWorkspace: { id: 'fixture', name: 'Fixture', remoteAuthority: '', folders: [] }, logicalWorkspaces: [],
	} };
}

function createWebview() {
	const listeners = new Set<(message: unknown) => void>();
	const posted: object[] = [];
	let onPost = (_message: object) => { };
	let html = '';
	let htmlWrites = 0;
	const view = {
		get html() { return html; },
		set html(value: string) { html = value; htmlWrites++; },
		options: {}, cspSource: 'https://*.vscode.invalid',
		asWebviewUri: (uri: vscode.Uri) => uri,
		onDidReceiveMessage: (listener: (message: unknown) => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
		postMessage: async (message: object) => { posted.push(message); onPost(message); return true; },
	};
	return {
		view: view as vscode.Webview, posted,
		get htmlWrites() { return htmlWrites; },
		receive: (message: unknown) => { for (const listener of [...listeners]) { listener(message); } },
		onPost: (listener: typeof onPost) => { onPost = listener; },
		get token(): string { return JSON.parse(/simNative\.install\((\{.*?\})\)/.exec(html)![1]).token; },
	};
}

describe('native Sim Webview document projection', () => {
	it('keeps tab selection authoritative through late hydration and A to B to A completions without reloading HTML', async t => {
		const webview = createWebview();
		const gate = Promise.withResolvers<DocumentConnection>();
		const messages: SimMessage[] = [];
		const a = '/workspace/one/chat/a'; const b = '/workspace/one/chat/b';
		const document = new SimDocument(webview.view, 'sidebar', a, () => gate.promise, message => messages.push(message), error => error.message);
		t.after(() => document.dispose());
		const loading = document.load();
		document.navigate(b);
		gate.resolve(createDocumentConnection());
		await loading;
		const token = webview.token;
		const send = (type: SimMessage['type'], path: string, userInitiated = false) => webview.receive({ source: 'sim', token, type, payload: { path, userInitiated } });
		send('ready', a);
		send('routeChanged', a);
		send('routeChanged', b);
		document.navigate(a);
		send('routeChanged', a);
		send('routeChanged', b);
		send('routeChanged', '/workspace/one/chat/user', true);
		assert.deepStrictEqual({
			writes: webview.htmlWrites,
			paths: messages.filter(message => message.type === 'routeChanged').map(message => message.payload?.path),
			navigations: webview.posted.filter(message => 'type' in message && message.type === 'navigate').length,
		}, { writes: 2, paths: [b, a, '/workspace/one/chat/user'], navigations: 2 });
	});

	it('preserves native startup redirects when no host tab selection superseded them', async t => {
		const webview = createWebview();
		const paths: string[] = [];
		const document = new SimDocument(webview.view, 'sidebar', '/workspace', async () => createDocumentConnection(), message => { if (message.type === 'routeChanged') { paths.push(message.payload!.path!); } }, error => error.message);
		t.after(() => document.dispose());
		await document.load();
		for (const type of ['ready', 'routeChanged']) { webview.receive({ source: 'sim', token: webview.token, type, payload: { path: '/workspace/created' } }); }
		assert.deepStrictEqual({ paths, navigations: webview.posted.filter(message => 'type' in message && message.type === 'navigate').length }, { paths: ['/workspace/created'], navigations: 0 });
	});

	it('keys workflow, DAG and chat tabs by resource and keeps the monitor singleton', () => {
		assert.deepStrictEqual(['/workspace/w/w/one', '/workspace/w/d/one', '/workspace/w/chat/one', '/workspace/w/chat/one?tab=files', '/agents', '/workspace/w/agents'].map(editorKey), [
			'editor:/workspace/w/w/one', 'editor:/workspace/w/d/one', 'editor:/workspace/w/chat/one', 'editor:/workspace/w/chat/one', 'monitor', 'monitor',
		]);
	});

	it('rejects URL injection and grants native scripts only the Webview nonce and resource boundary', () => {
		for (const value of ['//other.invalid', '/%2fother.invalid', '/a/../api', '/a/%2e%2e/api', '/a\\b', '/bad\nheader', 'http://other.invalid', '/%zz']) { assert.equal(isSafeSimPath(value), false, value); }
		const result = nativeDocument('<html><head><script nonce="old">boot()</script></head></html>', 'https://resources.vscode.invalid/', 'https://resources.vscode.invalid/transport.js', 'https://*.vscode.invalid', 'view-token', '/workspace');
		assert.deepStrictEqual({ scripts: [...result.matchAll(/<script nonce="([^"]+)"/g)].length, nonces: new Set([...result.matchAll(/<script nonce="([^"]+)"/g)].map(match => match[1])).size, oldNonce: result.includes('nonce="old"'), gateway: result.includes('gateway') }, {
			scripts: 3, nonces: 1, oldNonce: false, gateway: false,
		});
	});
});

describe('private native Webview transport', () => {
	it('owns the virtual same-origin authority even when Node fetch supplies a loopback Host', async t => {
		const server = createServer((request, response) => {
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({
				origin: request.headers.origin, host: request.headers['x-forwarded-host'],
				protocol: request.headers['x-forwarded-proto'], originalHost: request.headers['x-original-host'] ?? null,
				contentType: request.headers['content-type'], gateway: request.headers['x-vibe-agent-gateway'],
			}));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as { port: number }).port;
		const client = new NativeClient('test-run', { applicationPort: port, realtimePort: port, gateway: 'test-only-private-gateway' }, () => true);
		t.after(async () => { client.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
		const { response } = await client.request('/api/vscode/projects/sync', {
			method: 'POST', body: new TextEncoder().encode('{}'), headers: [
				['content-type', 'application/json'], ['host', 'forged.invalid'], ['origin', 'https://forged.invalid'],
				['x-original-host', 'forged.invalid'], ['x-forwarded-host', 'forged.invalid'], ['x-forwarded-proto', 'http'],
				['x-vibe-agent-gateway', 'forged'],
			],
		});
		assert.deepStrictEqual(await response.json(), {
			origin: 'https://sim.vscode.invalid', host: 'sim.vscode.invalid', protocol: 'https', originalHost: null,
			contentType: 'application/json', gateway: 'test-only-private-gateway',
		});
	});

	it('preserves streamed bytes and next-pull backpressure, while closing one tab leaves the other usable', async t => {
		const server = createServer((_request, response) => { response.setHeader('content-type', 'application/octet-stream'); response.end(Buffer.alloc(170000, 42)); });
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as { port: number }).port;
		const client = new NativeClient('test-run', { applicationPort: port, realtimePort: port, gateway: 'test-only-private-gateway' }, () => true);
		const a = createWebview(); const b = createWebview();
		const ta = new WebviewTransport(a.view, client, 'a'); const tb = new WebviewTransport(b.view, client, 'b');
		t.after(async () => { ta.dispose(); tb.dispose(); client.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
		const bytes: number[] = [];
		const done = Promise.withResolvers<void>();
		b.onPost(value => {
			const message = value as TransportReply;
			if (message.type === 'chunk') { bytes.push(...message.data); assert.ok(message.data.byteLength <= 65536); assert.equal(message.data.buffer.byteLength, message.data.byteLength); }
			if (message.type === 'response' || message.type === 'chunk') { b.receive({ source: 'sim-native-transport', token: 'b', id: message.id, type: 'pull' }); }
			if (message.type === 'end') { done.resolve(); }
		});
		ta.dispose();
		b.receive({ source: 'sim-native-transport', token: 'b', id: 1, type: 'fetch', path: '/api/test', method: 'GET', headers: [], redirect: 'follow' } satisfies TransportRequest);
		await done.promise;
		assert.deepStrictEqual({ length: bytes.length, valid: bytes.every(value => value === 42), otherTabReplies: a.posted.length }, { length: 170000, valid: true, otherTabReplies: 0 });
	});

	it('cancels a pending response without accepting its late completion', async t => {
		const webview = createWebview();
		const gate = Promise.withResolvers<Awaited<ReturnType<InstanceType<typeof NativeClient>['request']>>>();
		let signal: AbortSignal | undefined;
		let cancelled = false;
		const client = new class extends NativeClient {
			override request(_path: string, options: Parameters<InstanceType<typeof NativeClient>['request']>[1] = {}) {
				signal = options.signal;
				return gate.promise;
			}
			override openSocket(): never { throw new Error('Unexpected socket in the cancellation fixture'); }
		}('cancellation-test', { applicationPort: 1, realtimePort: 2, gateway: 'fixture' }, () => true);
		const transport = new WebviewTransport(webview.view, client, 'test');
		t.after(() => transport.dispose());
		webview.receive({ source: 'sim-native-transport', token: 'wrong', id: 1, type: 'fetch', path: '/api/test', method: 'GET', headers: [], redirect: 'follow' });
		assert.equal(signal, undefined);
		webview.receive({ source: 'sim-native-transport', token: 'test', id: 1, type: 'fetch', path: '/api/test', method: 'GET', headers: [], redirect: 'follow' });
		transport.dispose();
		gate.resolve({ response: new Response(new ReadableStream({ cancel: () => { cancelled = true; } })), path: '/api/test', redirected: false, headers: [] });
		await waitFor(() => cancelled, 'late response cancellation');
		assert.deepStrictEqual({ aborted: signal?.aborted, replies: webview.posted.length }, { aborted: true, replies: 0 });
	});

	it('never exposes cookies, gateway headers or transport encoding metadata', () => {
		assert.deepStrictEqual(structuredClone(publicResponseHeaders(new Headers({ 'set-cookie': 'private=value', 'authorization': 'private', 'x-vibe-agent-gateway': 'private', 'content-encoding': 'gzip', 'content-type': 'text/event-stream', 'x-request-id': 'public-id' }), new URL('https://sim.vscode.invalid/api/test'), 'http://127.0.0.1:12345')), [
			['content-type', 'text/event-stream'], ['x-request-id', 'public-id'],
		]);
	});

	it('projects private URL headers into routes while retaining Next action metadata', () => {
		const headers = new Headers({
			location: 'http://127.0.0.1:12345/workspace/one?tab=files#selected',
			'content-location': 'https://outside.invalid/private',
			'x-action-redirect': 'https://sim.vscode.invalid/workspace/one;push',
			'x-action-revalidated': '[[],1,0]', 'x-nextjs-stale-time': '300',
			'x-middleware-rewrite': 'http://127.0.0.1:12345/internal',
			link: '<http://127.0.0.1:12345/chunk.js>; rel=preload',
			refresh: '0;url=http://127.0.0.1:12345/internal',
		});
		assert.deepStrictEqual(structuredClone(publicResponseHeaders(headers, new URL('https://sim.vscode.invalid/api/test'), 'http://127.0.0.1:12345')), [
			['location', '/workspace/one?tab=files#selected'], ['x-action-redirect', '/workspace/one;push'],
			['x-action-revalidated', '[[],1,0]'], ['x-nextjs-stale-time', '300'],
		]);
	});

	it('normalizes manual redirects and never follows or exposes an external redirect', async t => {
		let targetRequests = 0;
		const server = createServer((request, response) => {
			if (request.url === '/target') { targetRequests++; response.end('done'); return; }
			response.writeHead(303, { location: request.url === '/external' ? 'https://outside.invalid/private' : `http://127.0.0.1:${port}/target` });
			response.end();
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as { port: number }).port;
		const client = new NativeClient('test-run', { applicationPort: port, realtimePort: port, gateway: 'test-only-private-gateway' }, () => true);
		t.after(async () => { client.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
		const manual = await client.request('/manual', { redirect: 'manual' });
		assert.equal(new Headers(manual.headers).get('location'), '/target');
		await manual.response.body?.cancel();
		assert.equal(targetRequests, 0);
		const followed = await client.request('/follow');
		assert.equal(await followed.response.text(), 'done');
		assert.equal(followed.path, '/target');
		assert.equal(followed.redirected, true);
		for (const redirect of ['manual', 'follow', 'error'] as const) {
			await assert.rejects(client.request('/external', { redirect }), /outside this instance/);
		}
		await assert.rejects(client.request('/manual', { redirect: 'error' }), /not permitted/);
		assert.equal(targetRequests, 1);
	});
});
