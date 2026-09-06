/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from 'zlib';
import { join } from '../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { CacheControl, getBuiltinExtensionPackageNLSCandidates, getWebClientCacheRecoveryToken, getWebClientPreferredEncodings, getWebClientResourceScheme, getWebClientStartupConfiguration, getWebClientStaticAssetCacheControl, getWebClientStaticAssetRecoveryRoute, getWebClientStaticAssetResourcePath, getWebClientStaticAssetRoute, parseWebClientStartupTemplate, serveFile } from '../../node/webClientServer.js';

suite('WebClientServer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('negotiates compressed modules by quality without overriding explicit refusals', () => {
		assert.deepStrictEqual([
			getWebClientPreferredEncodings(undefined),
			getWebClientPreferredEncodings('gzip, deflate, br, zstd'),
			getWebClientPreferredEncodings('br;q=0.5, gzip;q=0.9'),
			getWebClientPreferredEncodings('br;q=0, gzip;q=0, *;q=1'),
			getWebClientPreferredEncodings('BR; q=1, gzip;q=invalid'),
			getWebClientPreferredEncodings('identity'),
		], [[], ['br', 'gzip'], ['gzip', 'br'], [], ['br'], []]);
	});

	test('serves prepared representations with cache negotiation and leaves mutable development files alone', async () => {
		const http = await import('http');
		const directory = await fs.mkdtemp(join(os.tmpdir(), 'web-client-compression-'));
		const file = join(directory, 'module.js');
		const contents = Buffer.from('export const text = "cacheable module";\n'.repeat(100));
		const logService = new NullLogService();
		const server = http.createServer((req, res) => {
			void serveFile(file, CacheControl.NO_EXPIRY, logService, req, res, {}, req.url !== '/development');
		});
		try {
			await Promise.all([
				fs.writeFile(file, contents),
				fs.writeFile(`${file}.br`, brotliCompressSync(contents)),
				fs.writeFile(`${file}.gz`, gzipSync(contents)),
			]);
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(0, '127.0.0.1', resolve);
			});
			const address = server.address();
			if (!address || typeof address === 'string') {
				throw new Error('Expected a TCP listener.');
			}
			const request = (encoding: string, requestPath = '/') => new Promise<{ encoding: string | undefined; vary: string | undefined; cache: string | undefined; length: number; wireBytes: number; contents: Buffer }>((resolve, reject) => {
				http.get({ hostname: '127.0.0.1', port: address.port, path: requestPath, agent: false, headers: { 'Accept-Encoding': encoding } }, response => {
					const chunks: Buffer[] = [];
					response.on('data', chunk => chunks.push(chunk));
					response.on('error', reject);
					response.on('end', () => {
						const data = Buffer.concat(chunks);
						const contentEncoding = response.headers['content-encoding'];
						resolve({
							encoding: contentEncoding,
							vary: response.headers.vary,
							cache: response.headers['cache-control'],
							length: Number(response.headers['content-length']),
							wireBytes: data.length,
							contents: contentEncoding === 'br' ? brotliDecompressSync(data) : contentEncoding === 'gzip' ? gunzipSync(data) : data,
						});
					});
				}).on('error', reject);
			});
			const responses = await Promise.all([
				request('br, gzip'),
				request('br;q=0, gzip'),
				request('identity'),
				request('br, gzip', '/development'),
			]);
			await fs.unlink(`${file}.br`);
			responses.push(await request('br, gzip'));
			assert.deepStrictEqual(responses.map(response => ({
				encoding: response.encoding,
				vary: response.vary,
				cache: response.cache,
				lengthMatches: response.length === response.wireBytes,
				roundTrips: response.contents.equals(contents),
				smaller: response.wireBytes < contents.length,
			})), ['br', 'gzip', undefined, undefined, 'gzip'].map((encoding, index) => ({
				encoding,
				vary: index === 3 ? undefined : 'Accept-Encoding',
				cache: 'public, max-age=31536000, immutable',
				lengthMatches: index !== 3,
				roundTrips: true,
				smaller: !!encoding,
			})));
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
			logService.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('resolves locale bundles from most specific to default', () => {
		assert.deepStrictEqual(getBuiltinExtensionPackageNLSCandidates('zh-Hans-CN;q=0.9'), [
			'package.nls.zh-hans-cn.json',
			'package.nls.zh-hans.json',
			'package.nls.zh.json',
			'package.nls.json',
		]);
	});

	test('uses the default bundle for English and invalid locales', () => {
		assert.deepStrictEqual({
			english: getBuiltinExtensionPackageNLSCandidates('en-US'),
			invalid: getBuiltinExtensionPackageNLSCandidates('../zh-cn'),
		}, {
			english: ['package.nls.json'],
			invalid: ['package.nls.json'],
		});
	});

	test('uses only a valid public scheme from a reverse proxy', () => {
		assert.deepStrictEqual({
			directHttp: getWebClientResourceScheme(undefined),
			forwardedHttps: getWebClientResourceScheme('https'),
			forwardedChain: getWebClientResourceScheme(' HTTPS, http'),
			invalid: getWebClientResourceScheme('javascript'),
		}, {
			directHttp: 'http',
			forwardedHttps: 'https',
			forwardedChain: 'https',
			invalid: 'http',
		});
	});

	test('versions immutable static assets without changing local development caching', () => {
		const versionedRoute = getWebClientStaticAssetRoute('20260904T030000Z-123-456');
		assert.deepStrictEqual({
			unversionedRoute: getWebClientStaticAssetRoute(undefined),
			versionedRouteIsHashed: /^\/static\/[0-9a-f]{64}$/.test(versionedRoute),
			sameVersionIsStable: getWebClientStaticAssetRoute('20260904T030000Z-123-456') === versionedRoute,
			newVersionChangesRoute: getWebClientStaticAssetRoute('20260904T040000Z-789-012') !== versionedRoute,
			localDevelopmentCache: getWebClientStaticAssetCacheControl(false, undefined),
			versionedDevelopmentCache: getWebClientStaticAssetCacheControl(false, 'release'),
			builtCache: getWebClientStaticAssetCacheControl(true, undefined),
		}, {
			unversionedRoute: '/static',
			versionedRouteIsHashed: true,
			sameVersionIsStable: true,
			newVersionChangesRoute: true,
			localDevelopmentCache: CacheControl.ETAG,
			versionedDevelopmentCache: CacheControl.NO_EXPIRY,
			builtCache: CacheControl.NO_EXPIRY,
		});
	});

	test('isolates cache recovery in a fresh static module graph', () => {
		const recoveryToken = '0123456789abcdef0123456789abcdef';
		const cacheVersion = 'release';
		const staticRoute = getWebClientStaticAssetRoute(cacheVersion);
		const cacheKey = staticRoute.substring(staticRoute.lastIndexOf('/') + 1);
		const recoveryQueryValue = `${cacheKey}.${recoveryToken}`;
		const recoveryRoute = getWebClientStaticAssetRecoveryRoute(staticRoute, recoveryToken);
		const duplicateTokenUrl = new URL(`https://example.test/?vscode-cache-recovery=${recoveryQueryValue}&vscode-cache-recovery=${recoveryQueryValue}`);

		assert.deepStrictEqual({
			recoveryRoute,
			validToken: getWebClientCacheRecoveryToken(new URL(`https://example.test/?vscode-cache-recovery=${recoveryQueryValue}`), cacheVersion),
			staleVersionToken: getWebClientCacheRecoveryToken(new URL(`https://example.test/?vscode-cache-recovery=${'0'.repeat(64)}.${recoveryToken}`), cacheVersion),
			invalidToken: getWebClientCacheRecoveryToken(new URL('https://example.test/?vscode-cache-recovery=../out'), cacheVersion),
			duplicateToken: getWebClientCacheRecoveryToken(duplicateTokenUrl, cacheVersion),
			disabledToken: getWebClientCacheRecoveryToken(new URL(`https://example.test/?vscode-cache-recovery=${recoveryQueryValue}`), undefined),
			recoveryResource: getWebClientStaticAssetResourcePath(`/recovery-${recoveryToken}/out/vs/code/browser/workbench/workbench.js`, true),
			canonicalResource: getWebClientStaticAssetResourcePath('/out/vs/code/browser/workbench/workbench.js', true),
			disabledRecoveryResource: getWebClientStaticAssetResourcePath(`/recovery-${recoveryToken}/out/file.js`, false),
		}, {
			recoveryRoute: `${staticRoute}/recovery-${recoveryToken}`,
			validToken: recoveryToken,
			staleVersionToken: undefined,
			invalidToken: undefined,
			duplicateToken: undefined,
			disabledToken: undefined,
			recoveryResource: '/out/vs/code/browser/workbench/workbench.js',
			canonicalResource: '/out/vs/code/browser/workbench/workbench.js',
			disabledRecoveryResource: `/recovery-${recoveryToken}/out/file.js`,
		});
	});

	test('localizes the pre-workbench cache status without changing its version identity', () => {
		const staticRoot = getWebClientStaticAssetRoute('release-1');
		const simplifiedChinese = getWebClientStartupConfiguration('zh-CN;q=0.9', staticRoot, staticRoot);
		const traditionalChinese = getWebClientStartupConfiguration('zh-Hant-HK', staticRoot, staticRoot);
		const english = getWebClientStartupConfiguration('fr-FR', undefined, '/static');
		const recoveryToken = '0123456789abcdef0123456789abcdef';
		const recoveryRoot = getWebClientStaticAssetRecoveryRoute(staticRoot, recoveryToken);
		const recovery = getWebClientStartupConfiguration('en', staticRoot, recoveryRoot, recoveryToken);

		assert.deepStrictEqual({
			simplifiedChinese: {
				cacheVersion: simplifiedChinese.cacheVersion,
				first: simplifiedChinese.messages.firstTitle,
				reuse: simplifiedChinese.messages.reuseTitle,
				repair: simplifiedChinese.messages.repairTitle,
				slow: simplifiedChinese.messages.slowLoading,
				metrics: simplifiedChinese.messages.processedBytesWithTotal,
				ready: simplifiedChinese.messages.ready,
			},
			traditionalChinese: {
				first: traditionalChinese.messages.firstTitle,
				reuse: traditionalChinese.messages.reuseTitle,
			},
			english: {
				cacheVersion: english.cacheVersion,
				staticRoot: english.staticRoot,
				cacheRecoveryQuery: english.cacheRecoveryQuery,
				first: english.messages.firstTitle,
				reuse: english.messages.reuseTitle,
				slow: english.messages.slowLoading,
				metrics: english.messages.processedBytes,
			},
			recovery: {
				cacheVersion: recovery.cacheVersion,
				staticRoot: recovery.staticRoot,
				recoveryToken: recovery.recoveryToken,
				recovering: recovery.messages.recovering,
				retry: recovery.messages.retry,
			},
		}, {
			simplifiedChinese: {
				cacheVersion: staticRoot,
				first: '首次加载并缓存资源',
				reuse: '正在复用本地缓存',
				repair: '缓存不完整，正在补全',
				slow: '加载时间较长，仍在继续；网络较慢时可能需要更久',
				metrics: '已处理 {0} / {1} · 进度 {2}%',
				ready: '工作台已就绪',
			},
			traditionalChinese: {
				first: '首次載入並快取資源',
				reuse: '正在重用本機快取',
			},
			english: {
				cacheVersion: undefined,
				staticRoot: '/static',
				cacheRecoveryQuery: 'vscode-cache-recovery',
				first: 'Loading and caching resources for the first time',
				reuse: 'Reusing the local cache',
				slow: 'Loading is taking longer than usual and is still continuing. A slow network may need more time',
				metrics: 'Processed {0} · Progress {1}%',
			},
			recovery: {
				cacheVersion: staticRoot,
				staticRoot: recoveryRoot,
				recoveryToken,
				recovering: 'A cached resource failed to load. Retrying with a fresh copy',
				retry: 'Retry with a fresh cache',
			},
		});
	});

	test('splits the shared startup template and rejects missing sections', () => {
		const template = [
			'header',
			'<!-- WORKBENCH_STARTUP_STYLE -->',
			'<style>style</style>',
			'<!-- WORKBENCH_STARTUP_BODY -->',
			'<main>body</main>',
			'<!-- WORKBENCH_STARTUP_SCRIPT -->',
			'<script>script</script>',
		].join('\r\n');

		assert.deepStrictEqual(parseWebClientStartupTemplate(template), {
			style: '<style>style</style>',
			body: '<main>body</main>',
			script: '<script>script</script>',
		});
		assert.throws(() => parseWebClientStartupTemplate('<!-- WORKBENCH_STARTUP_STYLE -->'));
	});

	test('enables the prepared cache only for versioned resources and preserves forwarded and recovery prefixes', () => {
		const staticRoot = '/forwarded/oss-dev/static/release/recovery-token';
		const enabled = getWebClientStartupConfiguration('en', '/forwarded/oss-dev/static/release', staticRoot, undefined, true);
		assert.deepStrictEqual({
			enabled: enabled.resourceCache,
			mutable: getWebClientStartupConfiguration('en', undefined, '/static', undefined, true).resourceCache,
			missing: getWebClientStartupConfiguration('en', '/static/release', '/static/release').resourceCache,
			checking: enabled.messages.checkingTitle,
			retry: enabled.messages.chunkLoadError,
		}, {
			enabled: `${staticRoot}/out/vs/code/browser/workbench/cache/manifest.json`,
			mutable: undefined,
			missing: undefined,
			checking: 'Checking saved resources',
			retry: 'Resources could not be fully loaded. Saved chunks are kept; check the connection and retry',
		});
	});
});
