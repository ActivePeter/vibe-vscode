/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IBulkEditService } from '../../../../../editor/browser/services/bulkEditService.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { TestClipboardService } from '../../../../../platform/clipboard/test/common/testClipboardService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ExplorerService } from '../../browser/explorerService.js';

suite('ExplorerService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps hidden roots in the model authority', async () => {
		const firstRoot = URI.file('/workspace/first');
		const secondRoot = URI.file('/workspace/second');
		const instantiationService = disposables.add(workbenchInstantiationService(undefined, disposables));
		instantiationService.stub(IWorkspaceContextService, new TestContextService(testWorkspace(firstRoot, secondRoot)));
		instantiationService.stub(IClipboardService, new TestClipboardService());
		instantiationService.stub(IBulkEditService, new class extends mock<IBulkEditService>() { });
		const explorerService = disposables.add(instantiationService.createInstance(ExplorerService));

		await explorerService.setActiveRoot(firstRoot);

		assert.deepStrictEqual({
			roots: explorerService.roots.map(root => root.resource.toString()),
			visibleRoots: explorerService.visibleRoots.map(root => root.resource.toString()),
			hiddenRootLookup: explorerService.findClosest(secondRoot)?.resource.toString(),
		}, {
			roots: [firstRoot.toString(), secondRoot.toString()],
			visibleRoots: [firstRoot.toString()],
			hiddenRootLookup: secondRoot.toString(),
		});
	});
});
