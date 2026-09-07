/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import '../../browser/chat.contribution.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IChatSessionRoutingProvider, IChatSessionRoutingProviderService } from '../../common/sessionRouter.js';

suite('Shared chat contribution', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('registers the session routing provider service without the floating input window', () => {
		const descriptors = getSingletonServiceDescriptors().filter(([id]) => id === IChatSessionRoutingProviderService);
		const instantiationService = store.add(new InstantiationService(new ServiceCollection(...descriptors), true));
		const service = instantiationService.invokeFunction(accessor => accessor.get(IChatSessionRoutingProviderService));
		const before = service.getProvider();
		const provider: IChatSessionRoutingProvider = {
			getCandidateSessions: () => [],
			resolveSessionResource: () => undefined,
			dispatchToSession: async () => ({ status: 'rejected' }),
			dispatchToNewSession: async () => ({ status: 'rejected' }),
			revealSession: async () => { },
		};
		const registration = store.add(service.registerProvider(provider));
		const registered = service.getProvider();
		registration.dispose();
		assert.deepStrictEqual({ count: descriptors.length, before, registered, after: service.getProvider() }, {
			count: 1, before: undefined, registered: provider, after: undefined,
		});
	});
});
