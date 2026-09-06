/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isWebClientCacheManifest, type IWebClientCacheChunk, type IWebClientCacheFile } from '../../../platform/remote/common/webClientCache.js';

const cachePrefix = 'vscode-workbench-core-v1:';

export interface IWebClientCacheProgress {
	readonly totalBytes: number;
	readonly completedBytes: number;
	readonly cachedBytes: number;
	readonly transferredBytes: number;
	readonly completedChunks: number;
	readonly totalChunks: number;
	readonly storage: 'checking' | 'available' | 'unavailable';
}

/** The subset of CacheStorage used by startup; injectable without replacing browser globals. */
export interface IWebClientCacheStorage {
	open(name: string): Promise<Pick<Cache, 'match' | 'put'>>;
	match(request: string, options: { cacheName: string }): Promise<Response | undefined>;
	keys(): Promise<string[]>;
	delete(name: string): Promise<boolean>;
}

export interface IWebClientCacheEnvironment {
	readonly fetch: (url: string, options?: RequestInit) => Promise<Response>;
	readonly storage: IWebClientCacheStorage | undefined;
}

export interface IPreparedWorkbenchCache {
	readonly script: Blob;
	readonly style: Blob;
	/** Retire older cache generations only after the workbench actually starts successfully. */
	commit(): Promise<void>;
}

export type WorkbenchCacheUnsupportedReason = 'insecureContext' | 'unsupportedBrowser';

export class WorkbenchCacheUnsupportedError extends Error {
	constructor(readonly reason: WorkbenchCacheUnsupportedReason) {
		super(reason === 'insecureContext'
			? 'Workbench chunk loading requires a secure context. Use HTTPS or localhost.'
			: 'Workbench chunk loading requires DecompressionStream and crypto.subtle. Use a browser that supports these APIs.');
		this.name = 'WorkbenchCacheUnsupportedError';
	}
}

/** Chunk loading is required when enabled; unavailable cache storage does not affect these requirements. */
export function assertWorkbenchCacheSupported(capabilities = {
	secureContext: globalThis.isSecureContext,
	decompression: typeof globalThis.DecompressionStream === 'function',
	digest: typeof globalThis.crypto?.subtle?.digest === 'function',
}): void {
	if (!capabilities.secureContext) {
		throw new WorkbenchCacheUnsupportedError('insecureContext');
	}
	if (!capabilities.decompression || !capabilities.digest) {
		throw new WorkbenchCacheUnsupportedError('unsupportedBrowser');
	}
}

function getEnvironment(): IWebClientCacheEnvironment {
	let storage: CacheStorage | undefined;
	try {
		storage = globalThis.caches;
	} catch {
		// Storage restrictions must not prevent startup from downloading the prepared resources.
	}
	return { fetch: (url, options) => globalThis.fetch(url, options), storage };
}

/** Reads a bounded payload. Network progress includes in-flight bytes, not only completed requests. */
async function readBytes(response: Response, size: number, onBytes?: (bytes: number) => void): Promise<Uint8Array<ArrayBuffer>> {
	if (!response.ok || !response.body) {
		throw new Error(`Unable to read a workbench resource (${response.status}).`);
	}
	const reader = response.body.getReader();
	const bytes = new Uint8Array(size);
	let offset = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			onBytes?.(value.byteLength);
			if (offset + value.byteLength > size) {
				await reader.cancel();
				throw new Error('A workbench resource exceeds its declared size.');
			}
			bytes.set(value, offset);
			offset += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	if (offset !== size) {
		throw new Error('A workbench resource is incomplete.');
	}
	return bytes;
}

async function matchesHash(bytes: Uint8Array<ArrayBuffer>, expected: string): Promise<boolean> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') === expected;
}

/**
 * Loads and verifies real cached payloads before reporting reuse. Each verified gzip chunk is
 * committed independently, so an interrupted load never loses already completed downloads.
 * Only this loader owns the cache; the startup view projects its verified progress.
 */
export async function prepareWorkbenchCache(
	manifestUrl: string,
	onProgress: (progress: IWebClientCacheProgress) => void,
	environment: IWebClientCacheEnvironment = getEnvironment(),
): Promise<IPreparedWorkbenchCache> {
	const response = await environment.fetch(manifestUrl, { cache: 'no-store' });
	if (!response.ok) {
		throw new Error(`Unable to load the workbench cache manifest (${response.status}).`);
	}
	const manifest: unknown = await response.json();
	if (!isWebClientCacheManifest(manifest)) {
		throw new Error('Invalid workbench cache manifest.');
	}
	const chunks = [...manifest.script.chunks, ...manifest.style.chunks];
	let completedBytes = 0;
	let cachedBytes = 0;
	let transferredBytes = 0;
	let completedChunks = 0;
	let storageState: IWebClientCacheProgress['storage'] = 'checking';
	let failed = false;
	const report = () => {
		if (!failed) {
			onProgress({ totalBytes: manifest.script.size + manifest.style.size, completedBytes, cachedBytes, transferredBytes, completedChunks, totalChunks: chunks.length, storage: storageState });
		}
	};
	report();
	const cacheName = `${cachePrefix}${manifest.hash}`;
	const storage = environment.storage;
	let cache: Pick<Cache, 'match' | 'put'> | undefined;
	let previousCaches: string[] = [];
	try {
		previousCaches = (await storage?.keys() ?? []).filter(name => name.startsWith(cachePrefix) && name !== cacheName).slice(-2).reverse();
		cache = await storage?.open(cacheName);
	} catch {
		// Private browsing, quota or policy can deny storage while allowing normal downloads.
	}
	storageState = cache ? 'available' : 'unavailable';
	report();
	const save = async (key: string, bytes: Uint8Array<ArrayBuffer>) => {
		if (cache && storageState === 'available') {
			try {
				// Store only the verified body: network Vary/Content-Encoding headers do not
				// describe this explicit local representation and would make cache lookups miss.
				await cache.put(key, new Response(bytes));
			} catch {
				storageState = 'unavailable';
			}
		}
	};
	const readCached = async (key: string, chunk: IWebClientCacheChunk) => {
		for (const name of [cacheName, ...previousCaches]) {
			try {
				const response = name === cacheName ? await cache?.match(key) : await storage?.match(key, { cacheName: name });
				if (!response) {
					continue;
				}
				const bytes = await readBytes(response, chunk.size);
				if (await matchesHash(bytes, chunk.hash)) {
					if (name !== cacheName) {
						await save(key, bytes);
					}
					return bytes;
				}
			} catch {
				// A missing, corrupt or evicted entry is a cache miss, not a failed module graph.
			}
		}
		return undefined;
	};
	const controller = new AbortController();
	const loadedChunks = new Array<Uint8Array<ArrayBuffer>>(chunks.length);
	let nextIndex = 0;
	let failure: Error | undefined;
	const worker = async () => {
		while (!failed && nextIndex < chunks.length) {
			const index = nextIndex++;
			const chunk = chunks[index];
			try {
				// The local key depends on content and origin, never the release URL.
				const key = new URL(`/vscode-workbench-cache/${chunk.hash}`, manifestUrl).href;
				let bytes = await readCached(key, chunk);
				const reused = !!bytes;
				if (!bytes) {
					const chunkUrl = new URL(`${chunk.hash}.bin`, manifestUrl).href;
					const response = await environment.fetch(chunkUrl, { cache: 'no-store', signal: controller.signal });
					bytes = await readBytes(response, chunk.size, size => {
						transferredBytes += size;
						report();
					});
					if (!await matchesHash(bytes, chunk.hash)) {
						throw new Error('Workbench resource integrity check failed.');
					}
				}
				const decoded = await readBytes(new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))), chunk.originalSize);
				if (!reused) {
					await save(key, bytes);
				}
				loadedChunks[index] = decoded;
				completedBytes += chunk.originalSize;
				cachedBytes += reused ? chunk.originalSize : 0;
				completedChunks++;
				report();
			} catch (error) {
				failure ??= error instanceof Error ? error : new Error(String(error));
				failed = true;
				controller.abort();
			}
		}
	};
	// Drain every worker before returning/rejecting: no progress or write is left running afterward.
	await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker));
	if (failure) {
		throw failure;
	}
	const fileBlob = (file: IWebClientCacheFile, offset: number, type: string) => new Blob(loadedChunks.slice(offset, offset + file.chunks.length), { type });
	return {
		script: fileBlob(manifest.script, 0, 'text/javascript'),
		style: fileBlob(manifest.style, manifest.script.chunks.length, 'text/css'),
		commit: async () => {
			if (!storage || storageState !== 'available') {
				return;
			}
			try {
				const names = (await storage.keys()).filter(name => name.startsWith(cachePrefix));
				// Keep this successful generation and the two newest caches, including a concurrent
				// tab's in-progress generation. Never enumerate/delete another component's cache.
				const retained = new Set([cacheName, ...names.slice(-2)]);
				await Promise.all(names.filter(name => !retained.has(name)).map(name => storage.delete(name)));
			} catch {
				// Retention is best effort and cannot invalidate a successful startup.
			}
		},
	};
}
