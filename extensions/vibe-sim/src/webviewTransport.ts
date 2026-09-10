/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ReadableStreamDefaultReader } from 'node:stream/web';
import type { Disposable, Webview } from 'vscode';
import WebSocket from 'ws';
import { NativeClient } from './native/nativeClient';
import { isTransportRequest, maxBodyBytes, maxChunkBytes, TransportReplyPayload, TransportRequest, transportSource } from './transportProtocol';

interface FetchOperation {
	readonly abort: AbortController;
	reader?: ReadableStreamDefaultReader<Uint8Array>;
	remaining?: Uint8Array;
	reading: boolean;
}

interface SocketOperation {
	readonly socket: WebSocket;
	readonly pending: (string | Uint8Array)[];
	bytes: number;
	sending: boolean;
}

/** One Webview owns its requests. Closing a tab cancels its I/O, never another tab or the runtime. */
export class WebviewTransport implements Disposable {
	private readonly subscription: Disposable;
	private readonly requests = new Map<number, FetchOperation>();
	private readonly sockets = new Map<number, SocketOperation>();
	private disposed = false;

	constructor(private readonly webview: Pick<Webview, 'onDidReceiveMessage' | 'postMessage'>, private readonly client: NativeClient, private readonly token: string) {
		this.subscription = webview.onDidReceiveMessage((message: unknown) => {
			if (isTransportRequest(message) && message.token === token && !this.disposed) {
				void this.receive(message).catch(() => this.fail(message.id));
			}
		});
	}

	private async post(reply: TransportReplyPayload): Promise<boolean> {
		try { return !this.disposed && await this.webview.postMessage({ ...reply, source: transportSource, token: this.token }); }
		catch { return false; }
	}

	private cancel(id: number): void {
		const request = this.requests.get(id);
		this.requests.delete(id);
		request?.abort.abort();
		void request?.reader?.cancel().catch(() => { });
	}

	private async fail(id: number): Promise<void> {
		this.cancel(id);
		this.sockets.get(id)?.socket.terminate();
		await this.post({ type: 'error', id });
	}

	private async receive(message: TransportRequest): Promise<void> {
		const { id } = message;
		switch (message.type) {
			case 'fetch': {
				if (this.requests.has(id) || this.sockets.has(id) || this.requests.size >= 128) { await this.fail(id); return; }
				const operation: FetchOperation = { abort: new AbortController(), reading: false };
				this.requests.set(id, operation);
				const result = await this.client.request(message.path, { ...message, signal: operation.abort.signal });
				if (this.disposed || operation.abort.signal.aborted || this.requests.get(id) !== operation) {
					await result.response.body?.cancel();
					return;
				}
				operation.reader = result.response.body?.getReader();
				if (!await this.post({
					type: 'response', id, status: result.response.status, statusText: result.response.statusText,
					headers: result.headers, path: result.path, redirected: result.redirected, body: !!operation.reader,
				})) { this.cancel(id); }
				if (!operation.reader) { this.requests.delete(id); }
				return;
			}
			case 'pull': {
				const operation = this.requests.get(id);
				if (!operation?.reader || operation.reading) { return; }
				operation.reading = true;
				let result: ReadableStreamReadResult<Uint8Array>;
				try { result = operation.remaining ? { done: false, value: operation.remaining } : await operation.reader.read(); }
				finally { operation.reading = false; }
				if (this.requests.get(id) !== operation || operation.abort.signal.aborted) { return; }
				if (result.done) {
					this.requests.delete(id);
					await this.post({ type: 'end', id });
				} else {
					const chunk = result.value!;
					operation.remaining = chunk.byteLength > maxChunkBytes ? chunk.subarray(maxChunkBytes) : undefined;
					// Copy a bounded view: VS Code serializes the entire underlying ArrayBuffer.
					if (!await this.post({ type: 'chunk', id, data: new Uint8Array(chunk.subarray(0, maxChunkBytes)) })) { this.cancel(id); }
				}
				return;
			}
			case 'cancel': this.cancel(id); return;
			case 'socketOpen': {
				if (this.requests.has(id) || this.sockets.has(id) || this.sockets.size >= 8) { await this.fail(id); return; }
				const socket = this.client.openSocket(message.path, message.protocols);
				const operation: SocketOperation = { socket, pending: [], bytes: 0, sending: false };
				this.sockets.set(id, operation);
				socket.on('error', () => { void this.post({ type: 'socketError', id }); });
				socket.once('open', () => {
					void this.post({ type: 'socketOpened', id, protocol: socket.protocol, extensions: socket.extensions });
				});
				socket.on('message', (data, binary) => {
					const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
					operation.bytes += bytes.byteLength;
					if (operation.bytes > maxBodyBytes) { socket.terminate(); return; }
					operation.pending.push(binary ? new Uint8Array(bytes) : bytes.toString('utf8'));
					socket.pause();
					this.sendSocketData(id, operation);
				});
				socket.once('close', (code, reason) => {
					this.sockets.delete(id);
					void this.post({ type: 'socketClosed', id, code, reason: reason.toString('utf8'), clean: code === 1000 });
				});
				return;
			}
			case 'socketSend': {
				const operation = this.sockets.get(id);
				if (!operation || operation.socket.readyState !== WebSocket.OPEN || operation.socket.bufferedAmount > maxBodyBytes) { throw new Error('Sim socket is unavailable'); }
				const bytes = typeof message.data === 'string' ? Buffer.byteLength(message.data) : message.data.byteLength;
				await new Promise<void>((resolve, reject) => operation.socket.send(message.data, error => error ? reject(error) : resolve()));
				await this.post({ type: 'socketSent', id, bytes });
				return;
			}
			case 'socketAck': {
				const operation = this.sockets.get(id);
				if (operation) { operation.sending = false; this.sendSocketData(id, operation); }
				return;
			}
			case 'socketClose': this.sockets.get(id)?.socket.close(message.code, message.reason); return;
		}
	}

	private sendSocketData(id: number, operation: SocketOperation): void {
		if (operation.sending || this.disposed) { return; }
		const data = operation.pending.shift();
		if (data === undefined) { operation.socket.resume(); return; }
		operation.bytes -= typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
		operation.sending = true;
		void this.post({ type: 'socketData', id, data }).then(sent => { if (!sent) { operation.socket.terminate(); } });
	}

	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		this.subscription.dispose();
		for (const id of this.requests.keys()) { this.cancel(id); }
		for (const operation of this.sockets.values()) { operation.socket.terminate(); }
		this.sockets.clear();
	}
}
