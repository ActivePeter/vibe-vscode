/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import product from '../../../product/common/product.js';
import { SignService } from '../../browser/signService.js';

class TestSignService extends SignService {
	getValidatorForTest() {
		return super.getValidator();
	}
}

suite('Browser SignService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('does not request optional assets when the server advertises no signing module', async () => {
		const service = new TestSignService({ _serviceBrand: undefined, ...product, remoteConnectionSigning: false });
		assert.deepStrictEqual({
			validator: await service.getValidatorForTest(),
			message: await service.createNewMessage('challenge'),
			signed: await service.sign('response'),
			unknownValidator: await service.validate({ id: 'unknown', data: 'challenge' }, 'response'),
		}, {
			validator: undefined,
			message: { id: '', data: 'challenge' },
			signed: 'response',
			unknownValidator: false,
		});
	});
});
