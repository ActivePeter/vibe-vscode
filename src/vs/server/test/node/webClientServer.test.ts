/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { CacheControl, getBuiltinExtensionPackageNLSCandidates, getWebClientResourceScheme, getWebClientStaticAssetCacheControl, getWebClientStaticAssetRoute } from '../../node/webClientServer.js';

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
});
