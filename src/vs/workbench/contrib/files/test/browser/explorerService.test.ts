/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IBulkEditService } from '../../../../../editor/browser/services/bulkEditService.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IWorkspaceContextService, Workspace, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { NullFilesConfigurationService, TestContextService, TestFileService } from '../../../../test/common/workbenchTestServices.js';
import { ExplorerService } from '../../browser/explorerService.js';
import { IExplorerView } from '../../browser/files.js';
import { ExplorerItem } from '../../common/explorerModel.js';

suite('ExplorerService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps window-wide lookup separate from the current Project projection', async () => {
		const store = disposables.add(new DisposableStore());
		const parentFolder = new WorkspaceFolder({ uri: URI.file('/workspace'), name: 'workspace', index: 0 });
		const nestedFolder = new WorkspaceFolder({ uri: URI.file('/workspace/nested'), name: 'nested', index: 1 });
		const contextService = new TestContextService(new Workspace(
			'physical',
			[parentFolder, nestedFolder],
			false,
			URI.file('/workspace.code-workspace'),
			() => false,
		));
		const instantiationService = workbenchInstantiationService({
			configurationService: () => new TestConfigurationService({ explorer: {} }),
		}, store);
		instantiationService.stub(IWorkspaceContextService, contextService);
		instantiationService.stub(IClipboardService, new class extends mock<IClipboardService>() { });
		instantiationService.stub(IBulkEditService, new class extends mock<IBulkEditService>() { });

		const service = store.add(instantiationService.createInstance(ExplorerService));
		const [parentRoot, nestedRoot] = service.roots;
		const fileService = store.add(new TestFileService());
		const configurationService = new TestConfigurationService();
		const parentNested = new ExplorerItem(nestedFolder.uri, fileService, configurationService, NullFilesConfigurationService, parentRoot, true);
		const resource = URI.file('/workspace/nested/file.txt');
		const parentFile = new ExplorerItem(resource, fileService, configurationService, NullFilesConfigurationService, parentNested, false);
		const nestedFile = new ExplorerItem(resource, fileService, configurationService, NullFilesConfigurationService, nestedRoot, false);
		parentRoot.addChild(parentNested);
		parentNested.addChild(parentFile);
		nestedRoot.addChild(nestedFile);

		await service.setActiveRoot(parentFolder.uri);
		service.registerView(new class extends mock<IExplorerView>() {
			override getContext(): ExplorerItem[] {
				return [nestedFile, parentFile];
			}
		});

		assert.strictEqual(service.findClosest(resource), nestedFile);
		assert.strictEqual(service.findClosestRoot(resource), nestedRoot);
		assert.strictEqual(service.findClosestVisible(resource), parentFile);
		assert.strictEqual(service.findClosestVisibleRoot(resource), parentRoot);
		assert.deepStrictEqual(service.getContext(true), [parentFile]);

		const projectionCalls: string[] = [];
		const findClosed = new DeferredPromise<void>();
		service.registerView(new class extends mock<IExplorerView>() {
			override async closeFind(): Promise<void> {
				projectionCalls.push(`close:${service.visibleRoots.at(0)?.name}`);
				await findClosed.p;
			}
			override async setTreeInput(): Promise<void> {
				projectionCalls.push(`input:${service.visibleRoots.at(0)?.name}`);
			}
		});
		const activation = service.setActiveRoot(nestedFolder.uri);
		const beforeFindClosed = [...projectionCalls];
		findClosed.complete();
		await activation;
		await service.setActiveRoot(nestedFolder.uri);
		assert.deepStrictEqual({ beforeFindClosed, projectionCalls }, {
			beforeFindClosed: ['close:nested'],
			projectionCalls: ['close:nested', 'input:nested'],
		});

		store.dispose();
	});
});
