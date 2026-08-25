/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IPickOptions, IQuickInputService, IQuickPickItem, QuickPickInput } from '../../../../../platform/quickinput/common/quickInput.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ILogicalWorkspaceService } from '../../../../services/logicalWorkspace/common/logicalWorkspace.js';
import { PickLogicalWorkspaceAction } from '../../browser/logicalWorkspace.contribution.js';

suite('Logical Workspace Contribution', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('focuses the active workspace and describes implemented state', async () => {
		const store = disposables.add(new DisposableStore());
		const instantiationService = store.add(workbenchInstantiationService(undefined, store));
		const workspaces = [
			{ id: 'first', name: 'First', terminalIds: [], shellLayout: undefined },
			{ id: 'active', name: 'Active', terminalIds: [], shellLayout: undefined },
		];
		instantiationService.stub(ILogicalWorkspaceService, new class extends mock<ILogicalWorkspaceService>() {
			override readonly workspaces = workspaces;
			override readonly activeWorkspace = workspaces[1];
		});

		let activeItemLabel: string | undefined;
		let quickPickItems: readonly IQuickPickItem[] = [];
		instantiationService.stub(IQuickInputService, new class extends mock<IQuickInputService>() {
			override pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: IPickOptions<T> & { canPickMany: true }, token?: CancellationToken): Promise<T[] | undefined>;
			override pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: IPickOptions<T> & { canPickMany: false }, token?: CancellationToken): Promise<T | undefined>;
			override async pick<T extends IQuickPickItem>(_picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: Omit<IPickOptions<T>, 'canPickMany'>, _token?: CancellationToken): Promise<T | undefined> {
				quickPickItems = (await _picks).filter((pick): pick is T => pick.type !== 'separator');
				activeItemLabel = (await options?.activeItem)?.label;
				return undefined;
			}
		});

		await instantiationService.invokeFunction(accessor => new PickLogicalWorkspaceAction().run(accessor));

		assert.strictEqual(activeItemLabel, 'Active');
		assert.deepStrictEqual(quickPickItems.map(item => ({ label: item.label, description: item.description })), [
			{ label: 'First', description: "Restores this context's layout, terminals, and editors" },
			{ label: 'Active', description: 'Active workbench context' },
			{ label: 'New Workspace...', description: 'Creates an independent layout, terminal, and editor context' },
		]);
		store.dispose();
	});
});
