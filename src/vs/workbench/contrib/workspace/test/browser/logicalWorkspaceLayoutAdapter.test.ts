/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { ViewContainerLocation } from '../../../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { ILogicalWorkspaceService, ILogicalWorkspaceShellLayout } from '../../../../services/logicalWorkspace/common/logicalWorkspace.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { LogicalWorkspaceLayoutAdapter } from '../../browser/logicalWorkspaceLayoutAdapter.js';

suite('LogicalWorkspaceLayoutAdapter', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('materializes a hidden part before restoring its size', async () => {
		const store = disposables.add(new DisposableStore());
		const layout: ILogicalWorkspaceShellLayout = {
			primarySideBar: { visible: true, width: 250, height: 800, activeCompositeId: 'explorer' },
			panel: { visible: true, width: 1200, height: 300, activeCompositeId: 'terminal' },
			auxiliaryBar: { visible: false, width: 320, height: 800, activeCompositeId: 'chat' },
		};
		const workspace = { id: 'workspace', name: 'Workspace', terminalIds: [], shellLayout: layout };
		const logicalWorkspaceService = new class extends mock<ILogicalWorkspaceService>() {
			override readonly state = { activeWorkspaceId: workspace.id, workspaces: [workspace] };
			override readonly workspaces = this.state.workspaces;
			override readonly activeWorkspace = workspace;
			override readonly activationSequence = 0;
			override readonly isReady = true;
			override readonly whenReady = Promise.resolve();
			override readonly onWillChangeActiveWorkspace = Event.None;
			override readonly onDidChangeActiveWorkspace = Event.None;
			override readonly onDidChangeState = Event.None;
			override setShellLayout(): void { }
		};

		const visibility = new Map<Parts, boolean>([
			[Parts.SIDEBAR_PART, true],
			[Parts.PANEL_PART, true],
			[Parts.AUXILIARYBAR_PART, false],
		]);
		const sizes = new Map<Parts, { width: number; height: number }>([
			[Parts.SIDEBAR_PART, { width: 250, height: 800 }],
			[Parts.PANEL_PART, { width: 1200, height: 300 }],
			[Parts.AUXILIARYBAR_PART, { width: 480, height: 800 }],
		]);
		const auxiliaryVisibilityChanges: boolean[] = [];
		const layoutService = new class extends mock<IWorkbenchLayoutService>() {
			override isVisible(part: Parts): boolean {
				return visibility.get(part) ?? false;
			}
			override setPartHidden(hidden: boolean, part: Parts): void {
				visibility.set(part, !hidden);
				if (part === Parts.AUXILIARYBAR_PART) {
					auxiliaryVisibilityChanges.push(hidden);
				}
			}
			override getSize(part: Parts) {
				return sizes.get(part)!;
			}
			override resizePart(part: Parts, widthDelta: number, heightDelta: number): void {
				const size = sizes.get(part)!;
				sizes.set(part, { width: size.width + widthDelta, height: size.height + heightDelta });
			}
		};
		const paneCompositePartService = new class extends mock<IPaneCompositePartService>() {
			override getActivePaneComposite() { return undefined; }
			override async openPaneComposite() { return undefined; }
			override getLastActivePaneCompositeId(location: ViewContainerLocation): string {
				switch (location) {
					case ViewContainerLocation.Sidebar: return 'explorer';
					case ViewContainerLocation.Panel: return 'terminal';
					case ViewContainerLocation.AuxiliaryBar: return 'chat';
				}
			}
		};

		store.add(new LogicalWorkspaceLayoutAdapter(
			logicalWorkspaceService,
			layoutService,
			paneCompositePartService,
			store.add(new TestStorageService()),
			new NullLogService(),
		));
		await timeout(0);

		assert.deepStrictEqual({
			size: sizes.get(Parts.AUXILIARYBAR_PART),
			visible: visibility.get(Parts.AUXILIARYBAR_PART),
			visibilityChanges: auxiliaryVisibilityChanges,
		}, {
			size: { width: 320, height: 800 },
			visible: false,
			visibilityChanges: [false, true],
		});
		store.dispose();
	});
});
