/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { isNativeAgentSessionsUIEnabled } from '../../common/product.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from './utils.js';

suite('Product', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('native Agent Sessions UI defaults to enabled', () => {
		assert.strictEqual(isNativeAgentSessionsUIEnabled({}), true);
	});

	test('native Agent Sessions UI can be disabled at the product level', () => {
		assert.strictEqual(isNativeAgentSessionsUIEnabled({ nativeAgentSessionsUIEnabled: false }), false);
	});
});
