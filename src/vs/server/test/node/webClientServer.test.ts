/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { CacheControl, getBuiltinExtensionPackageNLSCandidates, getWebClientResourceScheme, getWebClientStartupConfiguration, getWebClientStaticAssetCacheControl, getWebClientStaticAssetRoute, parseWebClientStartupTemplate } from '../../node/webClientServer.js';

suite('WebClientServer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

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

	test('localizes the pre-workbench cache status without changing its version identity', () => {
		const staticRoot = getWebClientStaticAssetRoute('release-1');
		const simplifiedChinese = getWebClientStartupConfiguration('zh-CN;q=0.9', staticRoot, staticRoot);
		const traditionalChinese = getWebClientStartupConfiguration('zh-Hant-HK', staticRoot, staticRoot);
		const english = getWebClientStartupConfiguration('fr-FR', undefined, '/static');

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
				first: english.messages.firstTitle,
				reuse: english.messages.reuseTitle,
				slow: english.messages.slowLoading,
				metrics: english.messages.processedBytes,
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
				first: 'Loading and caching resources for the first time',
				reuse: 'Reusing the local cache',
				slow: 'Loading is taking longer than usual and is still continuing. A slow network may need more time',
				metrics: 'Processed {0} · Progress {1}%',
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
});
