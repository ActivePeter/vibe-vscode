/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from 'zlib';
import { join } from '../../../base/common/path.js';
import { FileAccess } from '../../../base/common/network.js';
import { upcastPartial } from '../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { ICSSDevelopmentService } from '../../../platform/cssDev/node/cssDevService.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { IRequestService } from '../../../platform/request/common/request.js';
import { webClientCacheDirectory } from '../../../platform/remote/common/webClientCache.js';
import { IWebClientStartupConfiguration } from '../../../platform/remote/common/webClientStartup.js';
import { NoneServerConnectionToken } from '../../node/serverConnectionToken.js';
import { IServerEnvironmentService } from '../../node/serverEnvironmentService.js';
import { CacheControl, getBuiltinExtensionPackageNLSCandidates, getWebClientPreferredEncodings, getWebClientResourceScheme, getWebClientStartupConfiguration, getWebClientStaticAssetCacheControl, getWebClientStaticAssetRoute, parseWebClientStartupTemplate, serveFile, WebClientServer } from '../../node/webClientServer.js';

suite('WebClientServer', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

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

	test('reads matching startup translations and safely falls back to English', async () => {
		const [english, simplified, traditional] = await Promise.all(['en', 'zh-hans', 'zh-hant'].map(async locale => {
			const file = FileAccess.asFileUri(`vs/platform/remote/common/workbench-startup.nls.${locale}.json`).fsPath;
			const messages: IWebClientStartupConfiguration['messages'] = JSON.parse(await fs.readFile(file, 'utf8'));
			return { title: messages.firstTitle, cache: undefined };
		}));
		const configurations = await Promise.all(['zh-CN;q=0.9', 'zh-Hant-HK', 'zh-TW', 'fr-FR', '../../product'].map(locale => getWebClientStartupConfiguration(locale)));
		assert.deepStrictEqual(configurations.map(value => ({ title: value.messages.firstTitle, cache: value.resourceCache })), [simplified, traditional, traditional, english, english]);
	});

	test('all startup translations preserve the English message keys, types and placeholders', async () => {
		const configurations = await Promise.all(['en', 'zh-hans', 'zh-hant'].map(locale => getWebClientStartupConfiguration(locale)));
		const contract = (configuration: IWebClientStartupConfiguration) => Object.entries(configuration.messages).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => ({
			key, type: Array.isArray(value) ? 'array' : typeof value,
			arrayTypes: Array.isArray(value) ? value.map(item => typeof item) : undefined,
			placeholders: typeof value === 'string' ? (value.match(/\{\d+\}/g) ?? []).sort() : [],
		}));
		assert.deepStrictEqual(configurations.slice(1).map(contract), [contract(configurations[0]), contract(configurations[0])]);
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

	test('builds the manifest URL under the public prefix only when the server enables the cache', async () => {
		const staticRoot = '/forwarded/oss-dev/static/release';
		const enabled = await getWebClientStartupConfiguration('en', staticRoot);
		const disabled = await getWebClientStartupConfiguration('en');
		assert.deepStrictEqual({
			enabled: enabled.resourceCache, disabled: disabled.resourceCache,
			fields: Object.keys(enabled).sort(),
		}, {
			enabled: `${staticRoot}/out/vs/code/browser/workbench/cache/manifest.json`,
			disabled: undefined, fields: ['messages', 'resourceCache'],
		});
	});

	for (const isBuilt of [true, false]) {
		for (const manifest of ['file', 'missing', 'directory']) {
			for (const versioned of [true, false]) {
				test(`validates the startup path: built=${isBuilt}, manifest=${manifest}, versioned=${versioned}`, async () => {
					const http = await import('http');
					const directory = await fs.mkdtemp(join(os.tmpdir(), 'web-client-startup-'));
					let server: import('http').Server | undefined;
					try {
						const cacheDirectory = join(directory, 'out', webClientCacheDirectory);
						await fs.mkdir(cacheDirectory, { recursive: true });
						const manifestPath = join(cacheDirectory, 'manifest.json');
						if (manifest === 'file') {
							await fs.writeFile(manifestPath, '{}');
						} else if (manifest === 'directory') {
							await fs.mkdir(manifestPath);
						}
						const logService = store.add(new NullLogService());
						const createWebClient = () => new WebClientServer(
							new NoneServerConnectionToken(), '/base', '/oss-release', false,
							upcastPartial<IServerEnvironmentService>({ appRoot: directory, isBuilt, args: upcastPartial<IServerEnvironmentService['args']>({ _: [], 'web-client-cache-version': versioned ? 'release' : undefined }) }),
							logService,
							upcastPartial<IRequestService>({}),
							upcastPartial<IProductService>({}),
							upcastPartial<ICSSDevelopmentService>({ isEnabled: false })
						);
						if (versioned && manifest !== 'file') {
							assert.throws(createWebClient, /Missing workbench cache manifest file: .*\.json\. Build the chunk cache before using --web-client-cache-version\./);
							return;
						}
						const webClient = createWebClient();
						server = http.createServer((req, res) => {
							void webClient.handle(req, res, new URL(req.url!, 'http://example.test'), '/');
						});
						await new Promise<void>((resolve, reject) => {
							server!.once('error', reject);
							server!.listen(0, '127.0.0.1', resolve);
						});
						const address = server.address();
						if (!address || typeof address === 'string') {
							throw new Error('Expected a TCP listener.');
						}
						const response = await fetch(`http://127.0.0.1:${address.port}/`);
						const html = await response.text();
						const settings = /id="vscode-workbench-startup" data-settings="(?<settings>[^"]*)"/.exec(html)?.groups?.settings;
						assert.ok(settings, html);
						const configuration: IWebClientStartupConfiguration = JSON.parse(settings.replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
						const staticRoot = `/base/oss-release${getWebClientStaticAssetRoute(versioned ? 'release' : undefined)}`;
						assert.deepStrictEqual({
							status: response.status,
							cache: configuration.resourceCache,
							startupScripts: [...html.matchAll(/<script id="vscode-workbench-startup-script" type="module" src="(?<src>[^"]*)"/g)].map(match => match.groups?.src),
							startupBeforeMain: html.indexOf('id="vscode-workbench-startup-script"') < html.indexOf('id="vscode-workbench-main"'),
							mainScripts: [...html.matchAll(/<script id="vscode-workbench-main" type="(?<type>[^"]*)"/g)].map(match => match.groups?.type),
						}, {
							status: 200,
							cache: versioned ? `${staticRoot}/out/vs/code/browser/workbench/cache/manifest.json` : undefined,
							startupScripts: [`${staticRoot}/out/vs/code/browser/workbench/workbenchStartup.js`],
							startupBeforeMain: true,
							mainScripts: [versioned ? 'application/json' : 'module'],
						});
					} finally {
						if (server) {
							await new Promise<void>(resolve => server!.close(() => resolve()));
						}
						await fs.rm(directory, { recursive: true, force: true });
					}
				});
			}
		}
	}
});
