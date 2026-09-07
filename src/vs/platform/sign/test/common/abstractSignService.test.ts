/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AbstractSignService, IVsdaValidator } from '../../common/abstractSignService.js';

class TestSignService extends AbstractSignService {
	constructor(private readonly validator: IVsdaValidator) {
		super();
	}
	protected override async getValidator() { return this.validator; }
	protected override async signValue(value: string) { return `signed:${value}`; }
}

suite('AbstractSignService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const outcome of ['ok', 'error', 'throw'] as const) {
		test(`preserves validation and disposal when the signing module returns ${outcome}`, async () => {
			let disposed = 0;
			const service = new TestSignService({
				createNewMessage: value => `challenge:${value}`,
				validate: () => {
					if (outcome === 'throw') {
						throw new Error('Invalid signature');
					}
					return outcome;
				},
				dispose: () => disposed++,
			});
			const message = await service.createNewMessage('value');
			assert.deepStrictEqual({
				identified: message.id !== '',
				challenge: message.data,
				signed: await service.sign('value'),
				valid: await service.validate(message, 'signature'),
				reused: await service.validate(message, 'signature'),
				disposed,
			}, {
				identified: true, challenge: 'challenge:value', signed: 'signed:value',
				valid: outcome === 'ok', reused: false, disposed: 1,
			});
		});
	}
});
