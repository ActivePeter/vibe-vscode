/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as net from 'net';
import { Sequencer } from '../../base/common/async.js';
import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter, Event } from '../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { FileAccess } from '../../base/common/network.js';
import { delimiter, join } from '../../base/common/path.js';
import { IProcessEnvironment, isWindows } from '../../base/common/platform.js';
import { removeDangerousEnvVariables } from '../../base/common/processes.js';
import { createRandomIPCHandle, NodeSocket, WebSocketNodeSocket } from '../../base/parts/ipc/node/ipc.net.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IRemoteExtensionHostStartParams } from '../../platform/remote/common/remoteAgentConnection.js';
import { getResolvedShellEnv } from '../../platform/shell/node/shellEnv.js';
import { IExtensionHostStatusService } from './extensionHostStatusService.js';
import { getNLSConfiguration } from './remoteLanguagePacks.js';
import { IServerEnvironmentService } from './serverEnvironmentService.js';
import { IPCExtHostConnection, SocketExtHostConnection, writeExtHostConnection } from '../../workbench/services/extensions/common/extensionHostEnv.js';
import { IExtHostReadyMessage, IExtHostReduceGraceTimeMessage, IExtHostSocketMessage } from '../../workbench/services/extensions/common/extensionHostProtocol.js';

export async function buildUserEnvironment(startParamsEnv: { [key: string]: string | null } = {}, withUserShellEnvironment: boolean, language: string, environmentService: IServerEnvironmentService, logService: ILogService, configurationService: IConfigurationService): Promise<IProcessEnvironment> {
	const nlsConfig = await getNLSConfiguration(language, environmentService.userDataPath);

	let userShellEnv: typeof process.env = {};
	if (withUserShellEnvironment) {
		try {
			userShellEnv = await getResolvedShellEnv(configurationService, logService, environmentService.args, process.env);
		} catch (error) {
			logService.error('ExtensionHostConnection#buildUserEnvironment resolving shell environment failed', error);
		}
	}

	const processEnv = process.env;

	const env: IProcessEnvironment = {
		...processEnv,
		...userShellEnv,
		...startParamsEnv,
		VSCODE_ESM_ENTRYPOINT: 'vs/workbench/api/node/extensionHostProcess',
		VSCODE_HANDLES_UNCAUGHT_ERRORS: 'true',
		VSCODE_NLS_CONFIG: JSON.stringify(nlsConfig)
	};

	const binFolder = environmentService.isBuilt ? join(environmentService.appRoot, 'bin') : join(environmentService.appRoot, 'resources', 'server', 'bin-dev');
	const remoteCliBinFolder = join(binFolder, 'remote-cli'); // contains the `code` command that can talk to the remote server

	let PATH = readCaseInsensitive(env, 'PATH');
	if (PATH) {
		PATH = remoteCliBinFolder + delimiter + PATH;
	} else {
		PATH = remoteCliBinFolder;
	}
	setCaseInsensitive(env, 'PATH', PATH);

	if (!environmentService.args['without-browser-env-var']) {
		env.BROWSER = join(binFolder, 'helpers', isWindows ? 'browser.cmd' : 'browser.sh'); // a command that opens a browser on the local machine
	}

	env.VSCODE_RECONNECTION_GRACE_TIME = String(environmentService.reconnectionGraceTime);
	logService.trace(`[reconnection-grace-time] Setting VSCODE_RECONNECTION_GRACE_TIME env var for extension host: ${environmentService.reconnectionGraceTime}ms (${Math.floor(environmentService.reconnectionGraceTime / 1000)}s)`);

	removeNulls(env);
	return env;
}

class SocketBridgeDataBuffer extends Disposable {

	private readonly bufferedData: VSBuffer[] = [];
	private readonly sourceSocket: net.Socket;
	private target: net.Socket | undefined;

	constructor(socket: NodeSocket | WebSocketNodeSocket) {
		super();
		this.sourceSocket = socket instanceof NodeSocket ? socket.socket : socket.socket.socket;
		// Preserve transport backpressure while the transferable bridge socket is being created.
		// The listener below only covers data that was already decoded in the current turn.
		this.sourceSocket.pause();
		this._register(socket.onData(data => {
			if (this.target) {
				this.target.write(data.buffer);
			} else {
				this.bufferedData.push(data);
			}
		}));
	}

	pipeTo(target: net.Socket): void {
		this.target = target;
		for (const data of this.bufferedData) {
			target.write(data.buffer);
		}
		this.bufferedData.length = 0;
		this.sourceSocket.resume();
	}

	override dispose(): void {
		this.bufferedData.length = 0;
		this.target = undefined;
		super.dispose();
	}
}

class ConnectionData {
	private socketBridgeDataBuffer: SocketBridgeDataBuffer | undefined;

	constructor(
		public readonly socket: NodeSocket | WebSocketNodeSocket,
		public readonly initialDataChunk: VSBuffer
	) { }

	startSocketBridgeBuffering(): void {
		this.socketBridgeDataBuffer ??= new SocketBridgeDataBuffer(this.socket);
	}

	pipeSocketBridgeDataTo(target: net.Socket, disposables: DisposableStore): void {
		if (!this.socketBridgeDataBuffer) {
			throw new Error('Socket bridge buffering was not started');
		}
		disposables.add(this.socketBridgeDataBuffer);
		this.socketBridgeDataBuffer.pipeTo(target);
	}

	disposeSocketBridgeBuffer(): void {
		this.socketBridgeDataBuffer?.dispose();
		this.socketBridgeDataBuffer = undefined;
	}

	public socketDrain(): Promise<void> {
		return this.socket.drain();
	}

	public toIExtHostSocketMessage(useDecodedSocket = false): IExtHostSocketMessage {

		let skipWebSocketFrames: boolean;
		let permessageDeflate: boolean;
		let inflateBytes: VSBuffer;

		if (useDecodedSocket || this.socket instanceof NodeSocket) {
			skipWebSocketFrames = true;
			permessageDeflate = false;
			inflateBytes = VSBuffer.alloc(0);
		} else {
			skipWebSocketFrames = false;
			permessageDeflate = this.socket.permessageDeflate;
			inflateBytes = this.socket.recordedInflateBytes;
			this.socket.setRecordInflateBytes(false);
		}

		return {
			type: 'VSCODE_EXTHOST_IPC_SOCKET',
			initialDataChunk: (<Buffer>this.initialDataChunk.buffer).toString('base64'),
			skipWebSocketFrames: skipWebSocketFrames,
			permessageDeflate: permessageDeflate,
			inflateBytes: (<Buffer>inflateBytes.buffer).toString('base64'),
		};
	}
}

export class ExtensionHostConnection extends Disposable {

	private _onClose = this._register(new Emitter<void>());
	readonly onClose: Event<void> = this._onClose.event;

	private readonly _canSendSocket: boolean;
	private readonly _useSocketBridge: boolean;
	private readonly _useSocketTransferProtocol: boolean;
	private readonly _connectionSequencer = new Sequencer();
	private readonly _activeSocketBridge = this._register(new MutableDisposable<DisposableStore>());
	private _disposed: boolean;
	private _remoteAddress: string;
	private _extensionHostProcess: cp.ChildProcess | null;
	private _socketTransferReady: boolean;
	private _connectionData: ConnectionData | null;

	constructor(
		private readonly _reconnectionToken: string,
		remoteAddress: string,
		socket: NodeSocket | WebSocketNodeSocket,
		initialDataChunk: VSBuffer,
		private readonly _extensionHostProcessFactory: typeof cp.fork | undefined,
		@IServerEnvironmentService private readonly _environmentService: IServerEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IExtensionHostStatusService private readonly _extensionHostStatusService: IExtensionHostStatusService,
		@IConfigurationService private readonly _configurationService: IConfigurationService
	) {
		super();
		// A TLSSocket cannot be transferred through child-process IPC. Keep TLS/WebSocket
		// processing here and give the extension host a fresh plain-socket bridge for each
		// initial connection and reconnection.
		this._useSocketBridge = Boolean(this._environmentService.args['tls-key-path']);
		this._canSendSocket = !this._useSocketBridge && (!isWindows || !this._environmentService.args['socket-path']);
		this._useSocketTransferProtocol = this._canSendSocket || this._useSocketBridge;
		this._disposed = false;
		this._remoteAddress = remoteAddress;
		this._extensionHostProcess = null;
		this._socketTransferReady = false;
		this._connectionData = new ConnectionData(socket, initialDataChunk);
		if (this._useSocketBridge) {
			this._connectionData.startSocketBridgeBuffering();
		}
		if (!this._canSendSocket && socket instanceof WebSocketNodeSocket) {
			socket.setRecordInflateBytes(false);
		}

		this._log(`New connection established.`);
	}

	override dispose(): void {
		this._cleanResources();
		super.dispose();
	}

	private get _logPrefix(): string {
		return `[${this._remoteAddress}][${this._reconnectionToken.substr(0, 8)}][ExtensionHostConnection] `;
	}

	private _log(_str: string): void {
		this._logService.info(`${this._logPrefix}${_str}`);
	}

	private _logError(_str: string): void {
		this._logService.error(`${this._logPrefix}${_str}`);
	}

	private _pipeSockets(extHostSocket: net.Socket, connectionData: ConnectionData, forwardInitialDataChunk = true, useBufferedBridgeData = false): void {

		const disposables = new DisposableStore();
		this._activeSocketBridge.value = disposables;
		disposables.add(connectionData.socket);
		disposables.add(toDisposable(() => {
			if (!extHostSocket.destroyed && !extHostSocket.writableEnded) {
				extHostSocket.end();
			}
		}));

		const stopAndCleanup = () => {
			if (this._activeSocketBridge.value === disposables) {
				this._activeSocketBridge.clear();
			} else {
				disposables.dispose();
			}
		};

		disposables.add(connectionData.socket.onEnd(stopAndCleanup));
		disposables.add(connectionData.socket.onClose(stopAndCleanup));

		disposables.add(Event.fromNodeEventEmitter<void>(extHostSocket, 'end')(stopAndCleanup));
		disposables.add(Event.fromNodeEventEmitter<void>(extHostSocket, 'close')(stopAndCleanup));
		disposables.add(Event.fromNodeEventEmitter<void>(extHostSocket, 'error')(stopAndCleanup));

		if (useBufferedBridgeData) {
			connectionData.pipeSocketBridgeDataTo(extHostSocket, disposables);
		} else {
			disposables.add(connectionData.socket.onData((e) => extHostSocket.write(e.buffer)));
		}
		disposables.add(Event.fromNodeEventEmitter<Buffer>(extHostSocket, 'data')((e) => {
			connectionData.socket.write(VSBuffer.wrap(e));
		}));

		if (forwardInitialDataChunk && connectionData.initialDataChunk.byteLength > 0) {
			extHostSocket.write(connectionData.initialDataChunk.buffer);
		}
		extHostSocket.resume();
	}

	private async _sendSocketToExtensionHost(extensionHostProcess: cp.ChildProcess, connectionData: ConnectionData): Promise<void> {
		// Make sure all outstanding writes have been drained before sending the socket
		await connectionData.socketDrain();
		const msg = connectionData.toIExtHostSocketMessage();
		let socket: net.Socket;
		if (connectionData.socket instanceof NodeSocket) {
			socket = connectionData.socket.socket;
		} else {
			socket = connectionData.socket.socket.socket;
		}
		await this._sendSocketHandleToExtensionHost(extensionHostProcess, msg, socket);
	}

	private _sendSocketHandleToExtensionHost(extensionHostProcess: cp.ChildProcess, message: IExtHostSocketMessage, socket: net.Socket): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			try {
				extensionHostProcess.send(message, socket, { keepOpen: false }, error => error ? reject(error) : resolve());
			} catch (error) {
				reject(error);
			}
		});
	}

	private async _sendSocketBridgeToExtensionHost(extensionHostProcess: cp.ChildProcess, connectionData: ConnectionData): Promise<void> {
		// TLS and WebSocket framing stay in the server process. The child receives a plain
		// socket so its existing PersistentProtocol reconnection state machine remains intact.
		await connectionData.socketDrain();
		const bridge = await this._createSocketBridge();
		if (this._disposed || this._extensionHostProcess !== extensionHostProcess) {
			bridge.parentSocket.destroy();
			bridge.extensionHostSocket.destroy();
			connectionData.disposeSocketBridgeBuffer();
			connectionData.socket.end();
			return;
		}

		try {
			await this._sendSocketHandleToExtensionHost(extensionHostProcess, connectionData.toIExtHostSocketMessage(true), bridge.extensionHostSocket);
			if (this._disposed || this._extensionHostProcess !== extensionHostProcess) {
				bridge.parentSocket.destroy();
				connectionData.disposeSocketBridgeBuffer();
				connectionData.socket.end();
				return;
			}
			// The initial chunk travels in IExtHostSocketMessage, matching direct socket transfer.
			this._pipeSockets(bridge.parentSocket, connectionData, false, true);
		} catch (error) {
			connectionData.disposeSocketBridgeBuffer();
			bridge.parentSocket.destroy();
			bridge.extensionHostSocket.destroy();
			throw error;
		}
	}

	private _queueSocketToExtensionHost(extensionHostProcess: cp.ChildProcess, connectionData: ConnectionData): void {
		void this._connectionSequencer.queue(async () => {
			if (this._disposed || this._extensionHostProcess !== extensionHostProcess) {
				connectionData.disposeSocketBridgeBuffer();
				connectionData.socket.end();
				return;
			}
			if (this._useSocketBridge) {
				await this._sendSocketBridgeToExtensionHost(extensionHostProcess, connectionData);
			} else {
				await this._sendSocketToExtensionHost(extensionHostProcess, connectionData);
			}
		}).catch(error => {
			connectionData.disposeSocketBridgeBuffer();
			connectionData.socket.end();
			if (!this._disposed) {
				this._logError('Failed to connect socket to Extension Host Process');
				this._logService.error(error);
			}
		});
	}

	private async _createSocketBridge(): Promise<{ parentSocket: net.Socket; extensionHostSocket: net.Socket }> {
		if (!isWindows) {
			const { namedPipeServer, pipeName } = await this._listenOnPipe();
			return this._connectSocketBridge(namedPipeServer, () => net.createConnection(pipeName));
		}

		const loopbackServer = net.createServer({ pauseOnConnect: true });
		const port = await new Promise<number>((resolve, reject) => {
			const onError = (error: Error) => reject(error);
			loopbackServer.once('error', onError);
			loopbackServer.listen(0, '127.0.0.1', () => {
				loopbackServer.removeListener('error', onError);
				const address = loopbackServer.address();
				if (!address || typeof address === 'string') {
					reject(new Error('Could not create Extension Host loopback bridge'));
					return;
				}
				resolve(address.port);
			});
		});
		return this._connectSocketBridge(loopbackServer, () => net.createConnection({ host: '127.0.0.1', port }));
	}

	private _connectSocketBridge(server: net.Server, createConnection: () => net.Socket): Promise<{ parentSocket: net.Socket; extensionHostSocket: net.Socket }> {
		return new Promise((resolve, reject) => {
			let parentSocket: net.Socket | undefined;
			let extensionHostSocket: net.Socket | undefined;
			let extensionHostConnected = false;
			let settled = false;

			const cleanupListeners = () => {
				server.removeListener('error', fail);
				server.removeListener('connection', acceptConnection);
				extensionHostSocket?.removeListener('error', fail);
				extensionHostSocket?.removeListener('connect', didConnect);
			};
			const fail = (error: Error) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanupListeners();
				server.close();
				parentSocket?.destroy();
				extensionHostSocket?.destroy();
				reject(error);
			};
			const tryResolve = () => {
				if (settled || !parentSocket || !extensionHostSocket || !extensionHostConnected) {
					return;
				}
				settled = true;
				cleanupListeners();
				server.close();
				parentSocket.setNoDelay(true);
				extensionHostSocket.setNoDelay(true);
				resolve({ parentSocket, extensionHostSocket });
			};
			const acceptConnection = (socket: net.Socket) => {
				parentSocket = socket;
				tryResolve();
			};
			const didConnect = () => {
				extensionHostConnected = true;
				tryResolve();
			};

			server.once('error', fail);
			server.once('connection', acceptConnection);
			try {
				extensionHostSocket = createConnection();
				extensionHostSocket.once('error', fail);
				extensionHostSocket.once('connect', didConnect);
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	public shortenReconnectionGraceTimeIfNecessary(): void {
		if (!this._extensionHostProcess) {
			return;
		}
		const msg: IExtHostReduceGraceTimeMessage = {
			type: 'VSCODE_EXTHOST_IPC_REDUCE_GRACE_TIME'
		};
		this._extensionHostProcess.send(msg);
	}

	public acceptReconnection(remoteAddress: string, _socket: NodeSocket | WebSocketNodeSocket, initialDataChunk: VSBuffer): void {
		this._remoteAddress = remoteAddress;
		this._log(`The client has reconnected.`);
		if (!this._canSendSocket && _socket instanceof WebSocketNodeSocket) {
			_socket.setRecordInflateBytes(false);
		}
		const connectionData = new ConnectionData(_socket, initialDataChunk);
		if (this._useSocketBridge) {
			connectionData.startSocketBridgeBuffering();
		}

		if (!this._extensionHostProcess || (this._useSocketTransferProtocol && !this._socketTransferReady)) {
			// The extension host either has not started or has not installed its socket listener yet.
			this._connectionData?.disposeSocketBridgeBuffer();
			this._connectionData?.socket.end();
			this._connectionData = connectionData;
			return;
		}

		this._queueSocketToExtensionHost(this._extensionHostProcess, connectionData);
	}

	private _cleanResources(): void {
		if (this._disposed) {
			// already called
			return;
		}
		this._disposed = true;
		if (this._connectionData) {
			this._connectionData.disposeSocketBridgeBuffer();
			this._connectionData.socket.end();
			this._connectionData = null;
		}
		if (this._extensionHostProcess) {
			this._extensionHostProcess.kill();
			this._extensionHostProcess = null;
		}
		this._socketTransferReady = false;
		this._onClose.fire(undefined);
	}

	public async start(startParams: IRemoteExtensionHostStartParams): Promise<void> {
		try {
			let execArgv: string[] = process.execArgv ? process.execArgv.filter(a => !/^--inspect(-brk)?=/.test(a)) : [];
			// eslint-disable-next-line local/code-no-any-casts, @typescript-eslint/no-explicit-any
			if (startParams.port && !(<any>process).pkg) {
				execArgv = [
					`--inspect${startParams.break ? '-brk' : ''}=${startParams.port}`,
					'--experimental-network-inspection'
				];
			}

			this._log(`Starting extension host process...`);

			const env = await buildUserEnvironment(startParams.env, true, startParams.language, this._environmentService, this._logService, this._configurationService);
			removeDangerousEnvVariables(env);

			let extHostNamedPipeServer: net.Server | null;

			if (this._useSocketTransferProtocol) {
				writeExtHostConnection(new SocketExtHostConnection(), env);
				extHostNamedPipeServer = null;
			} else {
				const { namedPipeServer, pipeName } = await this._listenOnPipe();
				writeExtHostConnection(new IPCExtHostConnection(pipeName), env);
				extHostNamedPipeServer = namedPipeServer;
			}

			const opts = {
				env,
				execArgv,
				silent: true
			};

			// Refs https://github.com/microsoft/vscode/issues/189805
			opts.execArgv.unshift('--dns-result-order=ipv4first');

			// Run Extension Host as fork of current process
			const args = ['--type=extensionHost', `--transformURIs`];
			const useHostProxy = this._environmentService.args['use-host-proxy'];
			args.push(`--useHostProxy=${useHostProxy ? 'true' : 'false'}`);
			if (this._configurationService.getValue<boolean>('extensions.supportNodeGlobalNavigator')) {
				args.push('--supportGlobalNavigator');
			}
			const extensionHostProcessFactory = this._extensionHostProcessFactory ?? cp.fork;
			this._extensionHostProcess = extensionHostProcessFactory(FileAccess.asFileUri('bootstrap-fork').fsPath, args, opts);
			const pid = this._extensionHostProcess.pid;
			this._log(`<${pid}> Launched Extension Host Process.`);

			// Catch all output coming from the extension host process
			this._extensionHostProcess.stdout!.setEncoding('utf8');
			this._extensionHostProcess.stderr!.setEncoding('utf8');
			const onStdout = Event.fromNodeEventEmitter<string>(this._extensionHostProcess.stdout!, 'data');
			const onStderr = Event.fromNodeEventEmitter<string>(this._extensionHostProcess.stderr!, 'data');
			this._register(onStdout((e) => this._log(`<${pid}> ${e}`)));
			this._register(onStderr((e) => this._log(`<${pid}><stderr> ${e}`)));

			// Lifecycle
			this._extensionHostProcess.on('error', (err) => {
				this._logError(`<${pid}> Extension Host Process had an error`);
				this._logService.error(err);
				this._cleanResources();
			});

			this._extensionHostProcess.on('exit', (code: number, signal: string) => {
				this._extensionHostStatusService.setExitInfo(this._reconnectionToken, { code, signal });
				this._log(`<${pid}> Extension Host Process exited with code: ${code}, signal: ${signal}.`);
				this._cleanResources();
			});

			if (extHostNamedPipeServer) {
				extHostNamedPipeServer.on('connection', (socket) => {
					extHostNamedPipeServer.close();
					this._pipeSockets(socket, this._connectionData!);
				});
			} else {
				const messageListener = (msg: IExtHostReadyMessage) => {
					if (msg.type === 'VSCODE_EXTHOST_IPC_READY') {
						this._extensionHostProcess!.removeListener('message', messageListener);
						this._socketTransferReady = true;
						const connectionData = this._connectionData;
						this._connectionData = null;
						if (connectionData) {
							this._queueSocketToExtensionHost(this._extensionHostProcess!, connectionData);
						}
					}
				};
				this._extensionHostProcess.on('message', messageListener);
			}

		} catch (error) {
			this._logError(`Failed to start extension host process`);
			this._logService.error(error);
			this._cleanResources();
		}
	}

	private _listenOnPipe(): Promise<{ pipeName: string; namedPipeServer: net.Server }> {
		return new Promise<{ pipeName: string; namedPipeServer: net.Server }>((resolve, reject) => {
			const pipeName = createRandomIPCHandle();

			const namedPipeServer = net.createServer({ pauseOnConnect: true });
			namedPipeServer.on('error', reject);
			namedPipeServer.listen(pipeName, () => {
				namedPipeServer?.removeListener('error', reject);
				resolve({ pipeName, namedPipeServer });
			});
		});
	}
}

function readCaseInsensitive(env: { [key: string]: string | undefined }, key: string): string | undefined {
	const pathKeys = Object.keys(env).filter(k => k.toLowerCase() === key.toLowerCase());
	const pathKey = pathKeys.length > 0 ? pathKeys[0] : key;
	return env[pathKey];
}

function setCaseInsensitive(env: { [key: string]: unknown }, key: string, value: string): void {
	const pathKeys = Object.keys(env).filter(k => k.toLowerCase() === key.toLowerCase());
	const pathKey = pathKeys.length > 0 ? pathKeys[0] : key;
	env[pathKey] = value;
}

function removeNulls(env: { [key: string]: unknown | null }): void {
	// Don't delete while iterating the object itself
	for (const key of Object.keys(env)) {
		if (env[key] === null) {
			delete env[key];
		}
	}
}
