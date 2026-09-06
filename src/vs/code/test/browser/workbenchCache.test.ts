/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { isWebClientCacheManifest, type IWebClientCacheChunk, type IWebClientCacheManifest } from '../../../platform/remote/common/webClientCache.js';
import { prepareWorkbenchCache, type IWebClientCacheEnvironment, type IWebClientCacheProgress, type IWebClientCacheStorage } from '../../browser/workbench/workbenchCache.js';

suite('Workbench resource cache', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const manifestUrl = 'https://example.test/release/cache/manifest.json';
	const hash = async (data: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('');
	const fixture = async (styleText = '.workbench { color: red; }') => {
		const payloads = new Map<string, Uint8Array<ArrayBuffer>>();
		const chunk = async (text: string): Promise<IWebClientCacheChunk> => {
			const original = new TextEncoder().encode(text);
			const compressed = new Uint8Array(await new Response(new Blob([original]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
			const result = { hash: await hash(compressed), size: compressed.byteLength, originalSize: original.byteLength };
			payloads.set(result.hash, compressed);
			return result;
		};
		const scriptText = ['// first part\n', '// second part\n', 'globalThis.ready = "你好";'];
		const scriptChunks = await Promise.all(scriptText.map(chunk));
		const styleChunk = await chunk(styleText);
		const manifest: IWebClientCacheManifest = {
			version: 1,
			hash: await hash(new TextEncoder().encode(scriptText.join('') + styleText)),
			script: { size: scriptChunks.reduce((sum, chunk) => sum + chunk.originalSize, 0), chunks: scriptChunks },
			style: { size: styleChunk.originalSize, chunks: [styleChunk] },
		};
		return { manifest, payloads, scriptText: scriptText.join(''), styleText };
	};
	const memoryStorage = (onWrite?: () => Promise<void>) => {
		const entries = new Map<string, Map<string, Response>>();
		const storage: IWebClientCacheStorage = {
			open: async name => {
				const cache = entries.get(name) ?? new Map<string, Response>();
				entries.set(name, cache);
				return {
					match: async request => cache.get(typeof request === 'string' ? request : request instanceof URL ? request.href : request.url)?.clone(),
					put: async (request, response) => {
						await onWrite?.();
						cache.set(typeof request === 'string' ? request : request instanceof URL ? request.href : request.url, response.clone());
					},
				};
			},
			match: async (request, options) => entries.get(options.cacheName)?.get(request)?.clone(),
			keys: async () => [...entries.keys()],
			delete: async name => entries.delete(name),
		};
		return { storage, entries };
	};
	const environment = (data: Awaited<ReturnType<typeof fixture>>, storage: IWebClientCacheStorage | undefined) => {
		const requests: string[] = [];
		const value: IWebClientCacheEnvironment = {
			storage,
			fetch: async url => {
				if (url.endsWith('/manifest.json')) {
					return Response.json(data.manifest);
				}
				const id = new URL(url).pathname.split('/').pop()!.slice(0, -4);
				requests.push(id);
				return new Response(data.payloads.get(id));
			},
		};
		return { value, requests };
	};

	test('cold load persists chunks, then a fresh loader reads them without resource requests', async () => {
		const data = await fixture();
		const { storage } = memoryStorage();
		const cold = environment(data, storage);
		const snapshots: IWebClientCacheProgress[] = [];
		const first = await prepareWorkbenchCache(manifestUrl, progress => snapshots.push(progress), cold.value);
		const warm = environment(data, storage);
		const second = await prepareWorkbenchCache(manifestUrl, progress => snapshots.push(progress), warm.value);
		assert.deepStrictEqual({
			coldRequests: cold.requests.length, warmRequests: warm.requests,
			script: await second.script.text(), style: await first.style.text(),
			final: snapshots.at(-1),
			inFlightProgress: snapshots.some(progress => progress.transferredBytes > 0 && progress.completedChunks < progress.totalChunks),
		}, {
			coldRequests: 4, warmRequests: [], script: data.scriptText, style: data.styleText,
			final: { totalBytes: data.manifest.script.size + data.manifest.style.size, completedBytes: data.manifest.script.size + data.manifest.style.size, cachedBytes: data.manifest.script.size + data.manifest.style.size, transferredBytes: 0, completedChunks: 4, totalChunks: 4, storage: 'available' },
			inFlightProgress: true,
		});
	});

	test('an interrupted load retains completed chunks and downloads only the missing chunk on retry', async () => {
		const data = await fixture();
		let completedWrites = 0;
		let releaseFailure!: () => void;
		const barrier = new Promise<void>(resolve => releaseFailure = resolve);
		const { storage } = memoryStorage(async () => { if (++completedWrites === 3) { releaseFailure(); } });
		const first = environment(data, storage);
		const failedChunk = data.manifest.style.chunks[0];
		await assert.rejects(prepareWorkbenchCache(manifestUrl, () => { }, {
			...first.value,
			fetch: async (url, options) => {
				if (url.endsWith(`${failedChunk.hash}.bin`)) {
					await barrier;
					return new Response('', { status: 503 });
				}
				return first.value.fetch(url, options);
			},
		}), /Unable to read/);
		const retry = environment(data, storage);
		let progress: IWebClientCacheProgress | undefined;
		const result = await prepareWorkbenchCache(manifestUrl, value => progress = value, retry.value);
		assert.deepStrictEqual({ requests: retry.requests, cachedBytes: progress?.cachedBytes, transferred: progress?.transferredBytes, script: await result.script.text() }, {
			requests: [failedChunk.hash], cachedBytes: data.manifest.script.size, transferred: failedChunk.size, script: data.scriptText,
		});
	});

	test('repairs a corrupt cached chunk without discarding valid chunks', async () => {
		const data = await fixture();
		const { storage, entries } = memoryStorage();
		await prepareWorkbenchCache(manifestUrl, () => { }, environment(data, storage).value);
		const corrupted = data.manifest.script.chunks[1];
		entries.values().next().value!.set(new URL(`/vscode-workbench-cache/${corrupted.hash}`, manifestUrl).href, new Response(new Uint8Array(corrupted.size)));
		const repair = environment(data, storage);
		const result = await prepareWorkbenchCache(manifestUrl, () => { }, repair.value);
		assert.deepStrictEqual({ requested: repair.requests, script: await result.script.text() }, { requested: [corrupted.hash], script: data.scriptText });
	});

	test('rejects network corruption without storing it or reporting a completed chunk', async () => {
		const data = await fixture();
		const { storage, entries } = memoryStorage();
		const base = environment(data, storage);
		const broken = data.manifest.script.chunks[0];
		const brokenUrl = new URL(`/vscode-workbench-cache/${broken.hash}`, manifestUrl).href;
		await assert.rejects(prepareWorkbenchCache(manifestUrl, () => { }, {
			...base.value,
			fetch: async (url, options) => url.endsWith(`${broken.hash}.bin`) ? new Response(new Uint8Array(broken.size)) : base.value.fetch(url, options),
		}), /integrity/);
		assert.strictEqual([...entries.values()].some(cache => cache.has(brokenUrl)), false);
	});

	test('storage denial and quota errors allow startup but never claim persistent storage', async () => {
		const data = await fixture();
		const quota = memoryStorage(async () => { throw new Error('Quota exceeded'); });
		const results = [];
		for (const storage of [undefined, quota.storage]) {
			let final: IWebClientCacheProgress | undefined;
			const result = await prepareWorkbenchCache(manifestUrl, value => final = value, environment(data, storage).value);
			results.push({ storage: final?.storage, cached: final?.cachedBytes, script: await result.script.text() });
		}
		assert.deepStrictEqual(results, [0, 1].map(() => ({ storage: 'unavailable', cached: 0, script: data.scriptText })));
	});

	test('a new release reuses unchanged content and only retires its own old caches after commit', async () => {
		const { storage, entries } = memoryStorage();
		entries.set('another-component', new Map());
		const requests: number[] = [];
		let beforeCommit = 0;
		for (let index = 0; index < 3; index++) {
			const data = await fixture(`.workbench { opacity: ${index}; }`);
			const load = environment(data, storage);
			const result = await prepareWorkbenchCache(manifestUrl.replace('/release/', `/release-${index}/`), () => { }, load.value);
			requests.push(load.requests.length);
			beforeCommit = entries.size;
			await result.commit();
		}
		assert.deepStrictEqual({ requests, beforeCommit, afterCommit: entries.size, otherPreserved: entries.has('another-component') }, { requests: [4, 1, 1], beforeCommit: 4, afterCommit: 3, otherPreserved: true });
	});

	test('rejects malformed manifests and inconsistent identities', async () => {
		const { manifest } = await fixture();
		const duplicate = { ...manifest.script.chunks[0], originalSize: 1 };
		assert.deepStrictEqual([
			isWebClientCacheManifest(manifest),
			isWebClientCacheManifest({ ...manifest, version: 2 }),
			isWebClientCacheManifest({ ...manifest, script: { ...manifest.script, size: 1 } }),
			isWebClientCacheManifest({ ...manifest, style: { size: 1, chunks: [duplicate] } }),
			isWebClientCacheManifest({ ...manifest, style: { size: 1, chunks: [{ ...duplicate, hash: '../outside' }] } }),
		], [true, false, false, false, false]);
	});
});
