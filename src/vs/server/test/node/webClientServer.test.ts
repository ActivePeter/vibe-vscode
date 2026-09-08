/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from 'zlib';
import { DeferredPromise } from '../../../base/common/async.js';
import { join } from '../../../base/common/path.js';
import { FileAccess } from '../../../base/common/network.js';
import { upcastPartial } from '../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { ICSSDevelopmentService } from '../../../platform/cssDev/node/cssDevService.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { IRequestService } from '../../../platform/request/common/request.js';
import { webClientCacheDirectory } from '../../../platform/remote/common/webClientCache.js';
import { IWebClientStartupConfiguration, IWebClientStartupMessages } from '../../../platform/remote/common/webClientStartup.js';
import { NoneServerConnectionToken } from '../../node/serverConnectionToken.js';
import { IServerEnvironmentService } from '../../node/serverEnvironmentService.js';
import { CacheControl, getBuiltinExtensionPackageNLSCandidates, getWebClientPreferredEncodings, getWebClientProductConfiguration, getWebClientRemoteAuthority, getWebClientResourceScheme, getWebClientStartupLocaleCandidates, getWebClientStaticAssetCacheControl, getWebClientStaticAssetRoute, parseWebClientStartupTemplate, serveFile, WebClientServer, WebClientStartupMessages } from '../../node/webClientServer.js';

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

	test('forwards product configuration required by the web client', () => {
		assert.deepStrictEqual(getWebClientProductConfiguration({
			remoteConnectionSigning: false,
			voiceWsUrl: 'wss://example.com/voice',
			nativeAgentSessionsUIEnabled: false,
		}), {
			embedderIdentifier: 'server-distro',
			remoteConnectionSigning: false,
			voiceWsUrl: 'wss://example.com/voice',
			nativeAgentSessionsUIEnabled: false,
		});
	});

	test('uses configured authority before proxy headers and retains the token-server fallback', () => {
		assert.deepStrictEqual({
			preserved: getWebClientRemoteAuthority(['https://public.example', 'https://100.64.0.7:8443'], 'attacker.invalid', '127.0.0.1:18080'),
			secondEntry: getWebClientRemoteAuthority(['https://public.example', 'https://100.64.0.7:8443'], '100.64.0.7:8443, proxy.invalid', '127.0.0.1:18080'),
			directEntry: getWebClientRemoteAuthority(['https://public.example', 'https://[::1]:8443'], undefined, '[::1]:8443'),
			forgedFirst: getWebClientRemoteAuthority(['https://public.example'], 'attacker.invalid, public.example', 'public.example'),
			forwarded: getWebClientRemoteAuthority(undefined, 'public.example, internal-proxy.invalid', '127.0.0.1:18080'),
			direct: getWebClientRemoteAuthority(undefined, undefined, 'localhost:18080'),
			missing: getWebClientRemoteAuthority(undefined, undefined, undefined),
		}, {
			preserved: 'public.example',
			secondEntry: '100.64.0.7:8443',
			directEntry: '[::1]:8443',
			forgedFirst: 'public.example',
			forwarded: 'public.example',
			direct: 'localhost:18080',
			missing: undefined,
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

	test('orders safe startup locale candidates without losing script or regional priority', () => {
		assert.deepStrictEqual(['en-US', 'zh-CN;q=0.9', 'zh-Hant-HK', 'zh-TW', 'fr-FR', '../../product'].map(getWebClientStartupLocaleCandidates), [
			['en-us', 'en'],
			['zh-cn', 'zh-hans', 'zh', 'en'],
			['zh-hant-hk', 'zh-hant', 'zh', 'en'],
			['zh-tw', 'zh-hant', 'zh', 'en'],
			['fr-fr', 'fr', 'en'],
			['en'],
		]);
	});

	test('reads matching startup translations and safely falls back to English', async () => {
		const [english, simplified, traditional] = await Promise.all(['en', 'zh-hans', 'zh-hant'].map(async locale => {
			const file = FileAccess.asFileUri(`vs/platform/remote/common/workbench-startup.nls.${locale}.json`).fsPath;
			const messages: IWebClientStartupMessages = JSON.parse(await fs.readFile(file, 'utf8'));
			return messages.firstTitle;
		}));
		const messages = new WebClientStartupMessages(relative => join(FileAccess.asFileUri('').fsPath, relative));
		const translations = await Promise.all(['zh-CN;q=0.9', 'zh-Hant-HK', 'zh-TW', 'fr-FR', '../../product'].map(locale => messages.get(locale)));
		assert.deepStrictEqual(translations.map(value => value.firstTitle), [simplified, traditional, traditional, english, english]);
	});

	test('all startup translations preserve the English message keys, types and placeholders', async () => {
		const messages = new WebClientStartupMessages(relative => join(FileAccess.asFileUri('').fsPath, relative));
		const translations = await Promise.all(['en', 'zh-hans', 'zh-hant'].map(locale => messages.get(locale)));
		const contract = (messages: IWebClientStartupMessages) => Object.entries(messages).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => ({
			key, type: Array.isArray(value) ? 'array' : typeof value,
			arrayTypes: Array.isArray(value) ? value.map(item => typeof item) : undefined,
			placeholders: typeof value === 'string' ? (value.match(/\{\d+\}/g) ?? []).sort() : [],
		}));
		assert.deepStrictEqual(translations.slice(1).map(contract), [contract(translations[0]), contract(translations[0])]);
	});

	test('coalesces concurrent startup locale reads and never probes unshipped request locales', async () => {
		const inventory = new DeferredPromise<string[]>();
		const readsStarted = new DeferredPromise<void>();
		const contents = new DeferredPromise<void>();
		let directoryReads = 0;
		const fileReads: string[] = [];
		const messages = new WebClientStartupMessages(relative => relative, {
			readDirectory: async () => { directoryReads++; return inventory.p; },
			readFile: async file => {
				fileReads.push(file);
				if (fileReads.length === 2) {
					void readsStarted.complete();
				}
				await contents.p;
				return JSON.stringify({ firstTitle: file.includes('.zh-hant.') ? 'traditional' : 'english' });
			},
		});
		const pending = Promise.all(['zh-Hant-HK', 'zh-TW', 'en', 'fr-FR'].map(locale => messages.get(locale)));
		const beforeInventory = { directoryReads, fileReads: fileReads.length };
		await inventory.complete(['workbench-startup.nls.en.json', 'workbench-startup.nls.zh-hant.json', 'unrelated.json']);
		await readsStarted.p;
		const beforeContents = { directoryReads, fileReads: fileReads.length };
		await contents.complete();
		const translations = await pending;
		const otherLocales = await Promise.all(Array.from({ length: 100 }, (_, index) => messages.get(`unshipped-${index}`)));
		assert.deepStrictEqual({
			beforeInventory, beforeContents, directoryReads,
			fileReads: fileReads.sort(),
			titles: translations.map(value => value.firstTitle),
			sameTraditional: translations[0] === translations[1],
			sameEnglish: otherLocales.every(value => value === translations[2]) && translations[2] === translations[3],
		}, {
			beforeInventory: { directoryReads: 1, fileReads: 0 },
			beforeContents: { directoryReads: 1, fileReads: 2 },
			directoryReads: 1,
			fileReads: ['vs/platform/remote/common/workbench-startup.nls.en.json', 'vs/platform/remote/common/workbench-startup.nls.zh-hant.json'],
			titles: ['traditional', 'traditional', 'english', 'english'],
			sameTraditional: true, sameEnglish: true,
		});
	});

	test('a cached fallback never hides a more specific shipped startup locale', async () => {
		const reads: string[] = [];
		const messages = new WebClientStartupMessages(relative => relative, {
			readDirectory: async () => ['workbench-startup.nls.zh-hant.json', 'workbench-startup.nls.zh-hant-hk.json'],
			readFile: async file => { reads.push(file); return JSON.stringify({ firstTitle: file }); },
		});
		const script = await messages.get('zh-Hant');
		const region = await messages.get('zh-Hant-HK');
		const expected = ['vs/platform/remote/common/workbench-startup.nls.zh-hant.json', 'vs/platform/remote/common/workbench-startup.nls.zh-hant-hk.json'];
		assert.deepStrictEqual({ reads, titles: [script.firstTitle, region.firstTitle] }, { reads: expected, titles: expected });
	});

	test('startup message caches belong to one resource root', async () => {
		const create = (root: string) => new WebClientStartupMessages(relative => `${root}/${relative}`, {
			readDirectory: async () => ['workbench-startup.nls.en.json'],
			readFile: async file => JSON.stringify({ firstTitle: file }),
		});
		const translations = await Promise.all([create('first').get('en'), create('second').get('en')]);
		assert.deepStrictEqual(translations.map(value => value.firstTitle), ['first/vs/platform/remote/common/workbench-startup.nls.en.json', 'second/vs/platform/remote/common/workbench-startup.nls.en.json']);
	});

	test('a malformed startup translation fails without falling back and does not poison retries', async () => {
		let malformed = true;
		const reads: string[] = [];
		const messages = new WebClientStartupMessages(relative => relative, {
			readDirectory: async () => ['workbench-startup.nls.en.json', 'workbench-startup.nls.fr.json'],
			readFile: async file => { reads.push(file); return malformed ? '{' : JSON.stringify({ firstTitle: 'repaired' }); },
		});
		await assert.rejects(messages.get('fr-CA'), SyntaxError);
		malformed = false;
		const repaired = await messages.get('fr-CA');
		assert.deepStrictEqual({ reads, title: repaired.firstTitle }, {
			reads: ['vs/platform/remote/common/workbench-startup.nls.fr.json', 'vs/platform/remote/common/workbench-startup.nls.fr.json'], title: 'repaired',
		});
	});

	test('a startup translation removed after enumeration can still fall back to English', async () => {
		const reads: string[] = [];
		const messages = new WebClientStartupMessages(relative => relative, {
			readDirectory: async () => ['workbench-startup.nls.en.json', 'workbench-startup.nls.fr.json'],
			readFile: async file => {
				reads.push(file);
				if (file.endsWith('.fr.json')) {
					throw Object.assign(new Error('Missing translation'), { code: 'ENOENT' });
				}
				return JSON.stringify({ firstTitle: 'english' });
			},
		});
		const translation = await messages.get('fr-CA');
		assert.deepStrictEqual({ reads, title: translation.firstTitle }, {
			reads: ['vs/platform/remote/common/workbench-startup.nls.fr.json', 'vs/platform/remote/common/workbench-startup.nls.en.json'], title: 'english',
		});
	});

	test('missing default startup messages remain an error', async () => {
		const reads: string[] = [];
		const messages = new WebClientStartupMessages(relative => relative, {
			readDirectory: async () => [],
			readFile: async file => { reads.push(file); throw Object.assign(new Error('Missing default'), { code: 'ENOENT' }); },
		});
		await assert.rejects(messages.get('zh-Hant-HK'), { code: 'ENOENT' });
		assert.deepStrictEqual(reads, ['vs/platform/remote/common/workbench-startup.nls.en.json']);
	});

	test('startup locale directory failures are retried instead of cached as an empty catalog', async () => {
		let directoryReads = 0;
		let fileReads = 0;
		const messages = new WebClientStartupMessages(relative => relative, {
			readDirectory: async () => {
				if (++directoryReads === 1) {
					throw Object.assign(new Error('Directory unavailable'), { code: 'EACCES' });
				}
				return ['workbench-startup.nls.en.json'];
			},
			readFile: async () => { fileReads++; return JSON.stringify({ firstTitle: 'english' }); },
		});
		await assert.rejects(messages.get('en'), { code: 'EACCES' });
		const first = await messages.get('en');
		const second = await messages.get('en');
		assert.deepStrictEqual({ directoryReads, fileReads, title: first.firstTitle, same: first === second }, { directoryReads: 2, fileReads: 1, title: 'english', same: true });
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
						const publicOrigin = versioned ? 'https://public.example:8443' : undefined;
						const createWebClient = () => new WebClientServer(
							new NoneServerConnectionToken(), '/base', '/oss-release', false, publicOrigin ? [publicOrigin] : undefined,
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
						const workbenchFile = `workbench${isBuilt ? '' : '-dev'}.html`;
						for (const name of [workbenchFile, 'workbench-startup.html', 'callback.html']) {
							const relative = `vs/code/browser/workbench/${name}` as const;
							const contents = await fs.readFile(FileAccess.asFileUri(relative).fsPath, 'utf8');
							await fs.writeFile(join(directory, 'out', relative), `${contents}\n<!-- ${name} from test root -->`);
						}
						const messageDirectory = join(directory, 'out', 'vs/platform/remote/common');
						await fs.mkdir(messageDirectory, { recursive: true });
						const english: IWebClientStartupMessages = JSON.parse(await fs.readFile(FileAccess.asFileUri('vs/platform/remote/common/workbench-startup.nls.en.json').fsPath, 'utf8'));
						const title = `startup root ${isBuilt}-${manifest}-${versioned}`;
						await fs.writeFile(join(messageDirectory, 'workbench-startup.nls.en.json'), JSON.stringify({ ...english, firstTitle: title }));
						const webClient = createWebClient();
						server = http.createServer((req, res) => {
							const parsedUrl = new URL(req.url!, 'http://example.test');
							void webClient.handle(req, res, parsedUrl, parsedUrl.pathname);
						});
						await new Promise<void>((resolve, reject) => {
							server!.once('error', reject);
							server!.listen(0, '127.0.0.1', resolve);
						});
						const address = server.address();
						if (!address || typeof address === 'string') {
							throw new Error('Expected a TCP listener.');
						}
						const origin = `http://127.0.0.1:${address.port}`;
						const prefixes = [undefined, '/forwarded'];
						const responses = await Promise.all(prefixes.map(async prefix => {
							const headers: Record<string, string> = { 'accept-language': 'zh-Hant-HK' };
							if (publicOrigin) {
								Object.assign(headers, { 'x-original-host': 'attacker.invalid', 'x-forwarded-host': 'attacker.invalid', 'x-forwarded-port': '9999', 'x-forwarded-proto': 'http' });
							}
							if (prefix) {
								headers['x-forwarded-prefix'] = prefix;
							}
							const response = await fetch(`${origin}/`, { headers });
							const html = await response.text();
							const settings = /id="vscode-workbench-startup" data-settings="(?<settings>[^"]*)"/.exec(html)?.groups?.settings;
							assert.ok(settings, html);
							const configuration: IWebClientStartupConfiguration = JSON.parse(settings.replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
							const workbenchSettings = /id="vscode-workbench-web-configuration" data-settings="(?<settings>[^"]*)"/.exec(html)?.groups?.settings;
							assert.ok(workbenchSettings);
							const workbenchConfiguration: { remoteAuthority: string } = JSON.parse(workbenchSettings.replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
							return {
								status: response.status,
								remoteAuthority: workbenchConfiguration.remoteAuthority,
								cache: configuration.resourceCache,
								title: configuration.messages.firstTitle,
								templatesFromRoot: html.includes(`<!-- ${workbenchFile} from test root -->`) && html.includes('<!-- workbench-startup.html from test root -->'),
								startupScripts: [...html.matchAll(/<script id="vscode-workbench-startup-script" type="module" src="(?<src>[^"]*)"/g)].map(match => match.groups?.src),
								startupBeforeMain: html.indexOf('id="vscode-workbench-startup-script"') < html.indexOf('id="vscode-workbench-main"'),
								mainScripts: [...html.matchAll(/<script id="vscode-workbench-main" type="(?<type>[^"]*)"/g)].map(match => match.groups?.type),
							};
						}));
						const callback = await fetch(`${origin}/callback`);
						assert.deepStrictEqual({ responses, callbackStatus: callback.status, callbackFromRoot: (await callback.text()).includes('<!-- callback.html from test root -->') }, {
							responses: prefixes.map(prefix => {
								const staticRoot = `${prefix ?? '/base'}/oss-release${getWebClientStaticAssetRoute(versioned ? 'release' : undefined)}`;
								return {
									status: 200,
									remoteAuthority: new URL(publicOrigin ?? origin).host,
									cache: versioned ? `${staticRoot}/out/vs/code/browser/workbench/cache/manifest.json` : undefined,
									title, templatesFromRoot: true,
									startupScripts: [`${staticRoot}/out/vs/code/browser/workbench/workbenchStartup.js`],
									startupBeforeMain: true,
									mainScripts: [versioned ? 'application/json' : 'module'],
								};
							}),
							callbackStatus: 200, callbackFromRoot: true,
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
