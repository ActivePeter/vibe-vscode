/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { getBuiltinExtensionPackageNLSCandidates, getWebClientResourceScheme } from '../../node/webClientServer.js';

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
});
