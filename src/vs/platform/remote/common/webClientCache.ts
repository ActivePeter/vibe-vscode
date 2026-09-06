/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The prepared cache belongs to an immutable web runtime, never to workspace files. */
export const webClientCacheDirectory = 'vs/code/browser/workbench/cache';

export interface IWebClientCacheChunk {
	/** SHA-256 of the gzip payload, also used as its file name and local cache key. */
	readonly hash: string;
	readonly size: number;
	readonly originalSize: number;
}

export interface IWebClientCacheFile {
	readonly size: number;
	readonly chunks: readonly IWebClientCacheChunk[];
}

export interface IWebClientCacheManifest {
	readonly version: 1;
	readonly hash: string;
	readonly script: IWebClientCacheFile;
	readonly style: IWebClientCacheFile;
}

/** Rejects unsupported, truncated or unbounded manifests before downloading or executing code. */
export function isWebClientCacheManifest(value: unknown): value is IWebClientCacheManifest {
	const isHash = (hash: unknown): hash is string => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash);
	const isSize = (size: unknown, maximum: number): size is number => typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 && size <= maximum;
	const chunks = new Map<string, IWebClientCacheChunk>();
	const isChunk = (value: unknown): value is IWebClientCacheChunk => {
		if (!value || typeof value !== 'object') {
			return false;
		}
		const chunk = value as IWebClientCacheChunk;
		if (!isHash(chunk.hash) || !isSize(chunk.size, 2 * 1024 * 1024) || chunk.size === 0 || !isSize(chunk.originalSize, 1024 * 1024)) {
			return false;
		}
		const previous = chunks.get(chunk.hash);
		if (previous && (previous.size !== chunk.size || previous.originalSize !== chunk.originalSize)) {
			return false;
		}
		chunks.set(chunk.hash, chunk);
		return true;
	};
	const isFile = (value: unknown): value is IWebClientCacheFile => {
		if (!value || typeof value !== 'object') {
			return false;
		}
		const file = value as IWebClientCacheFile;
		return isSize(file.size, 256 * 1024 * 1024)
			&& Array.isArray(file.chunks) && file.chunks.length > 0 && file.chunks.length <= 2048
			&& file.chunks.every(isChunk)
			&& file.chunks.reduce((total, chunk) => total + chunk.originalSize, 0) === file.size;
	};
	if (!value || typeof value !== 'object') {
		return false;
	}
	const manifest = value as IWebClientCacheManifest;
	return manifest.version === 1 && isHash(manifest.hash) && isFile(manifest.script) && isFile(manifest.style);
}
