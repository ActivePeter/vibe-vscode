/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { NativeClient } from './native/nativeClient';
import { isSafeSimPath } from './simSurface';
import { maxBodyBytes } from './transportProtocol';

export const resourceScheme = 'vibe-sim-resource';

export async function readResponse(response: Response, maximum = maxBodyBytes): Promise<Uint8Array> {
	if (!response.body) { return new Uint8Array(); }
	const chunks: Uint8Array[] = []; let size = 0;
	const reader = response.body.getReader();
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) { return new Uint8Array(Buffer.concat(chunks, size)); }
			size += result.value.byteLength;
			if (size > maximum) { throw new Error('The Sim resource exceeds the transport limit'); }
			chunks.push(result.value);
		}
	} finally { await reader.cancel().catch(() => { }); }
}

/** VS Code's existing resource channel serves immutable assets; no public Sim listener is published. */
export class NativeResources implements vscode.FileSystemProvider, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.changed.event;
	private client: NativeClient | undefined;
	constructor(private readonly extensionDirectory: string) { }

	attach(client: NativeClient): vscode.Uri { this.client = client; return vscode.Uri.from({ scheme: resourceScheme, authority: client.runId, path: '/' }); }
	detach(): void { this.client = undefined; }
	watch(): vscode.Disposable { return { dispose() { } }; }
	readDirectory(): [string, vscode.FileType][] { return []; }
	createDirectory(): never { throw vscode.FileSystemError.NoPermissions(); }
	writeFile(): never { throw vscode.FileSystemError.NoPermissions(); }
	delete(): never { throw vscode.FileSystemError.NoPermissions(); }
	rename(): never { throw vscode.FileSystemError.NoPermissions(); }

	private admit(uri: vscode.Uri): NativeClient {
		if (uri.scheme !== resourceScheme || !this.client || uri.authority !== this.client.runId || !isSafeSimPath(uri.path)) { throw vscode.FileSystemError.FileNotFound(uri); }
		return this.client;
	}

	private async file(uri: vscode.Uri): Promise<string> {
		this.admit(uri);
		const staticPrefix = '/_next/static/';
		const transport = uri.path === '/__vscode/transport.js';
		const root = path.join(this.extensionDirectory, transport ? 'dist' : `runtime/application/apps/sim/${uri.path.startsWith(staticPrefix) ? '.next/static' : 'public'}`);
		const relative = transport ? 'webviewTransportClient.js' : uri.path.startsWith(staticPrefix) ? uri.path.slice(staticPrefix.length) : uri.path.slice(1);
		const file = await fs.realpath(path.join(root, relative)).catch(() => { throw vscode.FileSystemError.FileNotFound(uri); });
		const canonical = await fs.realpath(root);
		if (file !== canonical && !file.startsWith(`${canonical}${path.sep}`)) { throw vscode.FileSystemError.NoPermissions(uri); }
		return file;
	}

	private isDynamicFile(uri: vscode.Uri): boolean {
		return /^\/api\/(?:files\/(?:serve|download|public)(?:\/|$)|workspaces\/[^/]+\/files\/(?:inline|download)(?:\/|$))/.test(uri.path);
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		this.admit(uri);
		if (uri.path === '/') { return { type: vscode.FileType.Directory, size: 0, ctime: 0, mtime: 0 }; }
		if (this.isDynamicFile(uri)) { return { type: vscode.FileType.File, size: 0, ctime: 0, mtime: 0 }; }
		const metadata = await fs.stat(await this.file(uri));
		return { type: metadata.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File, size: metadata.size, ctime: metadata.ctimeMs, mtime: metadata.mtimeMs };
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const client = this.admit(uri);
		if (this.isDynamicFile(uri)) {
			const { response } = await client.request(`${uri.path}${uri.query ? `?${uri.query}` : ''}`, { signal: AbortSignal.timeout(30000) });
			if (!response.ok) { await response.body?.cancel(); throw vscode.FileSystemError.FileNotFound(uri); }
			return readResponse(response);
		}
		const file = await this.file(uri);
		if ((await fs.stat(file)).size > maxBodyBytes) { throw vscode.FileSystemError.Unavailable(uri); }
		return new Uint8Array(await fs.readFile(file));
	}

	dispose(): void { this.detach(); this.changed.dispose(); }
}
