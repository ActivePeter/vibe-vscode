/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TerminalExitReason } from '../../../../../platform/terminal/common/terminal.js';
import { ILogicalWorkspaceService } from '../../../../services/logicalWorkspace/common/logicalWorkspace.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { LogicalWorkspaceTerminalAdapter } from '../../browser/logicalWorkspaceTerminalAdapter.js';

suite('LogicalWorkspaceTerminalAdapter', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('coalesces projection feedback until every terminal has moved', async () => {
		const store = disposables.add(new DisposableStore());
		const instantiationService = store.add(workbenchInstantiationService(undefined, store));
		const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
		const activeWorkspaceId = logicalWorkspaceService.activeWorkspace.id;
		const inactiveWorkspace = logicalWorkspaceService.createWorkspace('Inactive');
		const changedInstances = store.add(new Emitter<void>());
		const disposedInstances = store.add(new Emitter<ITerminalInstance>());
		let foreground: ITerminalInstance[] = [];
		let background: ITerminalInstance[] = [];
		let foregroundReads = 0;
		let movedToBackground = 0;
		let restoredToForeground = 0;
		const terminalService = new class extends mock<ITerminalService>() {
			override readonly onDidChangeInstances = changedInstances.event;
			override readonly onDidDisposeInstance = disposedInstances.event;
			override readonly whenConnected = Promise.resolve();
			override get foregroundInstances(): readonly ITerminalInstance[] {
				foregroundReads++;
				return foreground;
			}
			override get instances(): readonly ITerminalInstance[] { return [...foreground, ...background]; }
			override moveToBackground(instance: ITerminalInstance): void {
				foreground = foreground.filter(candidate => candidate !== instance);
				background.push(instance);
				movedToBackground++;
				changedInstances.fire();
			}
			override async showBackgroundTerminal(instance: ITerminalInstance): Promise<void> {
				background = background.filter(candidate => candidate !== instance);
				foreground.push(instance);
				restoredToForeground++;
				changedInstances.fire();
			}
		};
		const adapter = store.add(new LogicalWorkspaceTerminalAdapter(
			logicalWorkspaceService,
			terminalService,
			store.add(new TestStorageService()),
			new NullLogService(),
		));
		await timeout(0);

		const createInstance = (logicalTerminalId: string): ITerminalInstance => ({
			shellLaunchConfig: { logicalTerminalId },
			exitReason: TerminalExitReason.Unknown,
		} satisfies Partial<ITerminalInstance> as ITerminalInstance);
		foreground = [createInstance('inactive-1'), createInstance('inactive-2')];
		background = [createInstance('active-1'), createInstance('active-2')];
		logicalWorkspaceService.bindTerminal(inactiveWorkspace.id, 'inactive-1');
		logicalWorkspaceService.bindTerminal(inactiveWorkspace.id, 'inactive-2');
		logicalWorkspaceService.bindTerminal(activeWorkspaceId, 'active-1');
		logicalWorkspaceService.bindTerminal(activeWorkspaceId, 'active-2');

		await adapter.restore({
			workspace: logicalWorkspaceService.activeWorkspace,
			activationSequence: logicalWorkspaceService.activationSequence,
			isCurrent: () => true,
		});
		await timeout(0);

		assert.deepStrictEqual({
			foreground: foreground.map(instance => instance.shellLaunchConfig.logicalTerminalId),
			background: background.map(instance => instance.shellLaunchConfig.logicalTerminalId),
			movedToBackground,
			restoredToForeground,
		}, {
			foreground: ['active-1', 'active-2'],
			background: ['inactive-1', 'inactive-2'],
			movedToBackground: 2,
			restoredToForeground: 2,
		});

		foregroundReads = 0;
		logicalWorkspaceService.setShellLayout(activeWorkspaceId, {
			primarySideBar: { visible: true, width: 300, height: 800, activeCompositeId: 'explorer' },
			panel: { visible: true, width: 1200, height: 300, activeCompositeId: 'terminal' },
			auxiliaryBar: { visible: false, width: 300, height: 800, activeCompositeId: 'chat' },
		});
		await timeout(0);
		assert.strictEqual(foregroundReads, 0);
		store.dispose();
	});
});
