/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import * as net from 'net';
import { PassThrough } from 'stream';
import * as tls from 'tls';
import { VSBuffer } from '../../../base/common/buffer.js';
import { Event } from '../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { NodeSocket, WebSocketNodeSocket } from '../../../base/parts/ipc/node/ipc.net.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import product from '../../../platform/product/common/product.js';
import { generateSelfSignedCert, ISelfSignedCert } from '../../../platform/tunnel/node/selfSignedCert.js';
import { IExtHostReadyMessage, IExtHostSocketMessage } from '../../../workbench/services/extensions/common/extensionHostProtocol.js';
import { ExtensionHostConnection } from '../../node/extensionHostConnection.js';
import { ExtensionHostStatusService } from '../../node/extensionHostStatusService.js';
import { ServerEnvironmentService, ServerParsedArgs } from '../../node/serverEnvironmentService.js';

interface ISentSocket {
	readonly message: IExtHostSocketMessage;
	readonly socket: net.Socket;
}

class TestExtensionHostProcess extends EventEmitter {

	readonly pid = 1234;
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly sockets: net.Socket[] = [];

	nextSocket(): Promise<ISentSocket> {
		return new Promise(resolve => this.once('sentSocket', resolve));
	}

	send(message: IExtHostSocketMessage, socket: net.Socket | undefined, _options: { keepOpen?: boolean } | undefined, callback: ((error: Error | null) => void) | undefined): boolean {
		if (message.type === 'VSCODE_EXTHOST_IPC_SOCKET' && socket) {
			const sentSocket = { message, socket };
			this.sockets.push(socket);
			callback?.(null);
			queueMicrotask(() => this.emit('sentSocket', sentSocket));
			return true;
		}
		callback?.(null);
		return true;
	}

	emitReady(): void {
		this.emit('message', { type: 'VSCODE_EXTHOST_IPC_READY' } satisfies IExtHostReadyMessage);
	}

	kill(): boolean {
		for (const socket of this.sockets) {
			socket.destroy();
		}
		this.stdout.destroy();
		this.stderr.destroy();
		return true;
	}
}

class TestServerEnvironmentService extends ServerEnvironmentService {
	override get reconnectionGraceTime(): number { return 1000; }
}

suite('ExtensionHostConnection', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('bridges a TLS WebSocket through initial connection and reconnection', async () => {
		const certificate = await generateSelfSignedCert();
		const initial = await createTlsWebSocketPair(disposables, certificate);
		const childProcess = new TestExtensionHostProcess();
		disposables.add(toDisposable(() => childProcess.kill()));
		const args: ServerParsedArgs = {
			_: [],
			'accept-server-license-terms': true,
			compatibility: '',
			folder: '',
			help: false,
			version: false,
			workspace: '',
			'force-disable-user-env': true,
			'tls-key-path': 'test-key.pem',
			'without-browser-env-var': true,
			'user-data-dir': join(process.cwd(), '.tmp-extension-host-connection-test'),
		};
		const environmentService = new TestServerEnvironmentService(args, { ...product, _serviceBrand: undefined });
		const connection = disposables.add(new ExtensionHostConnection(
			'reconnection-token',
			'127.0.0.1',
			initial.server,
			VSBuffer.fromString('initial-chunk'),
			() => childProcess as unknown as cp.ChildProcess,
			environmentService,
			new NullLogService(),
			new ExtensionHostStatusService(),
			new TestConfigurationService(),
		));

		await connection.start({ language: 'en' });
		const initialSocketPromise = childProcess.nextSocket();
		childProcess.emitReady();
		const initialSocket = await initialSocketPromise;
		await assertBridge(initial, initialSocket, 'initial');

		const initialBridgeEnded = onceSocketEnd(initialSocket.socket);
		initial.client.end();
		await initialBridgeEnded;

		const reconnected = await createTlsWebSocketPair(disposables, certificate);
		const reconnectedSocketPromise = childProcess.nextSocket();
		connection.acceptReconnection('127.0.0.2', reconnected.server, VSBuffer.fromString('reconnected-chunk'));
		const reconnectedSocket = await reconnectedSocketPromise;
		await assertBridge(reconnected, reconnectedSocket, 'reconnected');

		assert.notStrictEqual(initialSocket.socket, reconnectedSocket.socket);
	});
});

async function assertBridge(pair: ITlsWebSocketPair, sent: ISentSocket, phase: string): Promise<void> {
	assert.deepStrictEqual({
		initialDataChunk: Buffer.from(sent.message.initialDataChunk, 'base64').toString(),
		skipWebSocketFrames: sent.message.skipWebSocketFrames,
		sentTlsSocket: sent.socket instanceof tls.TLSSocket,
		sourceTlsSocket: pair.server.socket.socket instanceof tls.TLSSocket,
	}, {
		initialDataChunk: `${phase}-chunk`,
		skipWebSocketFrames: true,
		sentTlsSocket: false,
		sourceTlsSocket: true,
	});

	const childReceived = onceSocketData(sent.socket);
	pair.client.write(VSBuffer.fromString(`${phase}-from-browser`));
	assert.strictEqual((await childReceived).toString(), `${phase}-from-browser`);

	const browserReceived = Event.toPromise<VSBuffer>(listener => pair.client.onData(listener));
	sent.socket.write(Buffer.from(`${phase}-from-extension-host`));
	assert.strictEqual((await browserReceived).toString(), `${phase}-from-extension-host`);
}

interface ITlsWebSocketPair {
	readonly server: WebSocketNodeSocket;
	readonly client: WebSocketNodeSocket;
}

async function createTlsWebSocketPair(disposables: Pick<DisposableStore, 'add'>, certificate: ISelfSignedCert): Promise<ITlsWebSocketPair> {
	let resolveServerSocket: (socket: tls.TLSSocket) => void;
	const serverSocketPromise = new Promise<tls.TLSSocket>(resolve => resolveServerSocket = resolve);
	const tlsServer = tls.createServer({ key: certificate.key, cert: certificate.cert }, socket => resolveServerSocket(socket));
	disposables.add(toDisposable(() => tlsServer.close()));
	const port = await new Promise<number>((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		tlsServer.once('error', onError);
		tlsServer.listen(0, '127.0.0.1', () => {
			tlsServer.removeListener('error', onError);
			const address = tlsServer.address();
			if (!address || typeof address === 'string') {
				reject(new Error('Could not create test TLS server'));
				return;
			}
			resolve(address.port);
		});
	});
	const clientTlsSocket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false });
	await new Promise<void>((resolve, reject) => {
		clientTlsSocket.once('secureConnect', resolve);
		clientTlsSocket.once('error', reject);
	});
	const serverTlsSocket = await serverSocketPromise;
	tlsServer.close();
	return {
		server: disposables.add(new WebSocketNodeSocket(new NodeSocket(serverTlsSocket, 'test-tls-server'), false, null, false)),
		client: disposables.add(new WebSocketNodeSocket(new NodeSocket(clientTlsSocket, 'test-tls-client'), false, null, false)),
	};
}

function onceSocketData(socket: net.Socket): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			socket.removeListener('data', onData);
			socket.removeListener('error', onError);
		};
		const onData = (data: Buffer) => {
			cleanup();
			resolve(data);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		socket.once('data', onData);
		socket.once('error', onError);
	});
}

function onceSocketEnd(socket: net.Socket): Promise<void> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			socket.removeListener('end', onEnd);
			socket.removeListener('error', onError);
		};
		const onEnd = () => {
			cleanup();
			resolve();
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		socket.once('end', onEnd);
		socket.once('error', onError);
	});
}
