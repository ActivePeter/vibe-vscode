/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSafeSimPath } from '../src/simWebviewProtocol.ts';

describe('Sim webview protocol', () => {
	it('accepts same-origin absolute routes', () => {
		assert.deepStrictEqual([
			isSafeSimPath('/'),
			isSafeSimPath('/workspace/project?tab=agent#session'),
		], [
			true,
			true,
		]);
	});

	it('rejects routes that can escape or traverse the configured root', () => {
		assert.deepStrictEqual([
			isSafeSimPath('//attacker.example'),
			isSafeSimPath('/\\attacker.example'),
			isSafeSimPath('/%5c%5cattacker.example'),
			isSafeSimPath('/%2f%2fattacker.example'),
			isSafeSimPath('/../outside'),
			isSafeSimPath('/%2e%2e/outside'),
		], [false, false, false, false, false, false]);
	});

	it('rejects malformed and control-character routes', () => {
		assert.deepStrictEqual([
			isSafeSimPath('/workspace%'),
			isSafeSimPath('/workspace%00session'),
			isSafeSimPath('/workspace\nsession'),
		], [false, false, false]);
	});
});
