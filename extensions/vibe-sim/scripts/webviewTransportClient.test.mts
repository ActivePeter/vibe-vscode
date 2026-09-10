/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { TransportReplyPayload, TransportRequest } from '../src/transportProtocol.ts';
import { bundle, waitFor } from './testUtils.mts';

const source = bundle('webviewTransportClient');

function harness() {
	const messages: TransportRequest[] = [];
	let externalFetches = 0;
	let externalBeacons = 0;
	const navigator = { sendBeacon: () => { externalBeacons++; return false; } };
	const window = Object.assign(new EventTarget(), {
		location: new URL('https://webview.invalid/index.html'), history: { replaceState: (_state: unknown, _unused: string, _url?: string | URL | null) => { }, pushState: () => { } },
		fetch: async () => { externalFetches++; return new Response('external'); },
		WebSocket: class { }, EventSource: class { },
	});
	window.history.replaceState = (_state, _unused, url) => { if (url) { window.location = new URL(url); } };
	let state: object | undefined;
	const { install } = runInNewContext(`${source}\nmodule.exports;`, {
		module: { exports: {} }, window, navigator, document: { baseURI: 'https://resources.vscode.invalid/' },
		acquireVsCodeApi: () => ({ postMessage: (message: TransportRequest) => messages.push(message), getState: () => state, setState: (value: object) => { state = value; } }),
		URL, URLSearchParams, Headers, Request, Response, Blob, FormData, ReadableStream, TextDecoderStream, Uint8Array, ArrayBuffer,
		TextEncoder, EventTarget, Event, MessageEvent, CloseEvent, AbortSignal, AbortController, DOMException, setTimeout, clearTimeout,
	}) as typeof import('../src/webviewTransportClient.ts');
	install({ token: 'test-view', path: '/workspace/one', resourceOrigin: 'https://resources.vscode.invalid/' });
	return {
		window: window as unknown as Window, navigator, messages,
		get externalFetches() { return externalFetches; }, get externalBeacons() { return externalBeacons; },
		reply: (message: TransportReplyPayload) => window.dispatchEvent(new MessageEvent('message', { data: { ...message, source: 'sim-native-transport', token: 'test-view' } })),
	};
}

describe('native browser transport compatibility', () => {
	it('preserves fragmented SSE events and resumes with the last event ID without replaying a mutation', async t => {
		const view = harness();
		const stream = new view.window.EventSource('/api/events');
		t.after(() => stream.close());
		const events: { data: string; id: string }[] = [];
		stream.addEventListener('progress', event => { const message = event as MessageEvent; events.push({ data: message.data, id: message.lastEventId }); });
		await waitFor(() => view.messages.length === 1, 'event stream request');
		view.reply({ type: 'response', id: 1, status: 200, statusText: 'OK', headers: [['content-type', 'text/event-stream']], path: '/api/events', redirected: false, body: true });
		const chunks = ['retry: 100\nid: turn-7\nevent: progress\ndata: fir', 'st\r', '\ndata: second\r\n\r\n'];
		for (let index = 0; index < chunks.length; index++) {
			await waitFor(() => view.messages.filter(message => message.type === 'pull').length > index, 'event stream backpressure');
			view.reply({ type: 'chunk', id: 1, data: new TextEncoder().encode(chunks[index]) });
		}
		await waitFor(() => events.length === 1, 'fragmented event dispatch');
		view.reply({ type: 'end', id: 1 });
		await waitFor(() => view.messages.filter(message => message.type === 'fetch').length === 2, 'read-only event reconnect');
		const resumed = view.messages.filter(message => message.type === 'fetch')[1];
		stream.close();
		assert.deepStrictEqual({
			events, method: resumed.method, path: resumed.path, lastId: new Headers(resumed.headers).get('last-event-id'),
			closed: stream.readyState, cancelled: view.messages.some(message => message.type === 'cancel' && message.id === resumed.id),
		}, { events: [{ data: 'first\nsecond', id: 'turn-7' }], method: 'GET', path: '/api/events', lastId: 'turn-7', closed: 2, cancelled: true });
	});

	it('preserves WebSocket binary frames, acknowledgements and ordered writes before close', async t => {
		const view = harness();
		const socket = new view.window.WebSocket('wss://sim.vscode.invalid/socket.io/?EIO=4&transport=websocket');
		t.after(() => socket.close());
		const frames: number[][] = [];
		const closures: { code: number; reason: string; clean: boolean }[] = [];
		socket.binaryType = 'arraybuffer';
		socket.onmessage = event => frames.push([...new Uint8Array(event.data)]);
		socket.onclose = event => closures.push({ code: event.code, reason: event.reason, clean: event.wasClean });
		assert.throws(() => socket.send('too early'), { name: 'InvalidStateError' });
		view.reply({ type: 'socketOpened', id: 1, protocol: '', extensions: '' });
		socket.send(new Blob([new Uint8Array([7, 8])]));
		socket.send('next');
		view.reply({ type: 'socketData', id: 1, data: new Uint8Array([1, 2, 3]) });
		socket.close(1000, 'finished');
		await waitFor(() => view.messages.some(message => message.type === 'socketClose'), 'ordered socket close');
		view.reply({ type: 'socketSent', id: 1, bytes: 6 });
		view.reply({ type: 'socketClosed', id: 1, code: 1000, reason: 'finished', clean: true });
		assert.deepStrictEqual({
			frames, closures, ready: socket.readyState, buffered: socket.bufferedAmount,
			writes: view.messages.filter(message => message.type === 'socketSend' || message.type === 'socketClose').map(message => message.type),
			acknowledged: view.messages.filter(message => message.type === 'socketAck').length,
		}, { frames: [[1, 2, 3]], closures: [{ code: 1000, reason: 'finished', clean: true }], ready: 3, buffered: 0, writes: ['socketSend', 'socketSend', 'socketClose'], acknowledged: 1 });
	});

	it('ignores forged and malformed replies without completing another pending request', async () => {
		const view = harness();
		let completed = false;
		const pending = view.window.fetch('/api/test').then(response => { completed = true; return response; });
		await waitFor(() => view.messages.length === 1, 'fetch start');
		const reply = { source: 'sim-native-transport', token: 'test-view', type: 'response', id: 1, status: 200, statusText: 'OK', headers: [], path: '/api/test', redirected: false, body: false };
		for (const data of [
			null, { ...reply, token: 'another-view' }, { ...reply, source: 'another-source' },
			{ ...reply, id: '1' }, { ...reply, status: undefined }, { ...reply, headers: [null] },
			{ ...reply, path: '//outside.invalid' }, { ...reply, type: 'chunk', data: 'not-binary' },
		]) { view.window.dispatchEvent(new MessageEvent('message', { data })); }
		await Promise.resolve();
		assert.equal(completed, false);
		view.reply({ type: 'response', id: 1, status: 204, statusText: 'No Content', headers: [], path: '/api/test', redirected: false, body: false });
		assert.equal((await pending).status, 204);
	});

	it('allows Sim whole-file uploads through 50 MiB and rejects bodies above the bounded request limit', async () => {
		const view = harness();
		const pending = view.window.fetch('https://sim.vscode.invalid/api/upload', { method: 'PUT', body: new Uint8Array(50 * 1024 * 1024) });
		await waitFor(() => view.messages.length === 1, 'upload body serialization');
		const request = view.messages[0];
		assert.equal(request.type, 'fetch');
		if (request.type !== 'fetch') { throw new Error('Expected a fetch'); }
		assert.equal(request.body?.byteLength, 50 * 1024 * 1024);
		view.reply({ type: 'response', id: request.id, status: 204, statusText: 'No Content', headers: [], path: '/api/upload', redirected: false, body: false });
		assert.equal((await pending).status, 204);
		await assert.rejects(view.window.fetch('/api/upload', { method: 'PUT', body: new Uint8Array(64 * 1024 * 1024 + 1) }), /transport limit/);
		assert.equal(view.messages.length, 1);
	});

	it('routes tool cleanup beacons through private fetch and releases their response without reading it', async () => {
		const view = harness();
		const body = new Blob(['{"action":"stop"}'], { type: 'application/json' });
		assert.equal(view.navigator.sendBeacon('/api/tools/cleanup', body), true);
		await waitFor(() => view.messages.length === 1, 'beacon serialization');
		const request = view.messages[0];
		assert.equal(request.type, 'fetch');
		if (request.type !== 'fetch') { throw new Error('Expected a fetch'); }
		assert.equal(request.path, '/api/tools/cleanup');
		assert.equal(request.method, 'POST');
		assert.equal(new Headers(request.headers).get('content-type'), 'application/json');
		assert.equal(new TextDecoder().decode(request.body), '{"action":"stop"}');
		view.reply({ type: 'response', id: request.id, status: 200, statusText: 'OK', headers: [], path: request.path, redirected: false, body: true });
		await waitFor(() => view.messages.some(message => message.type === 'cancel'), 'beacon response release');
		assert.equal(view.externalFetches, 0);
		assert.equal(view.externalBeacons, 0);
	});

	it('preserves external transports and bounds pending best-effort beacon requests', async () => {
		const view = harness();
		assert.equal(view.navigator.sendBeacon('https://external.invalid/api', 'event'), false);
		assert.equal(await (await view.window.fetch('https://external.invalid/api')).text(), 'external');
		assert.equal(view.externalBeacons, 1);
		assert.equal(view.externalFetches, 1);
		for (let index = 0; index < 16; index++) { assert.equal(view.navigator.sendBeacon('/api/cleanup'), true); }
		assert.equal(view.navigator.sendBeacon('/api/cleanup'), false);
		await waitFor(() => view.messages.length === 16, 'bounded beacons');
		for (const request of [...view.messages]) { view.reply({ type: 'error', id: request.id }); }
	});

	it('cancels fetch on the originating signal without accepting late responses', async () => {
		const view = harness();
		const controller = new AbortController();
		const pending = view.window.fetch('/api/stream', { signal: controller.signal });
		await waitFor(() => view.messages.length === 1, 'fetch start');
		controller.abort();
		await assert.rejects(pending, { name: 'AbortError' });
		assert.equal(view.messages[1].type, 'cancel');
		view.reply({ type: 'response', id: 1, status: 200, statusText: 'OK', headers: [], path: '/api/stream', redirected: false, body: false });
		assert.equal(view.messages.length, 2);
	});
});
