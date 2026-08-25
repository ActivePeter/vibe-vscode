/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TerminalExitReason, TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { LogicalWorkspaceProjectionCoordinator } from '../../../../services/logicalWorkspace/browser/logicalWorkspaceProjection.js';
import { ILogicalWorkspaceService, ILogicalWorkspaceShellLayout, LogicalWorkspaceActivationActor } from '../../../../services/logicalWorkspace/common/logicalWorkspace.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { LogicalWorkspaceTerminalAdapter } from '../../browser/logicalWorkspaceTerminalAdapter.js';

suite('LogicalWorkspaceTerminalAdapter', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('completes a terminal projection transaction before an awaited reconcile resolves', async () => {
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
		const createInstance = (logicalTerminalId: string, logicalWorkspaceId: string): ITerminalInstance => ({
			shellLaunchConfig: { logicalTerminalId, logicalWorkspaceId },
			exitReason: TerminalExitReason.Unknown,
		} satisfies Partial<ITerminalInstance> as ITerminalInstance);
		foreground = [createInstance('inactive-1', inactiveWorkspace.id), createInstance('inactive-2', inactiveWorkspace.id)];
		background = [createInstance('active-1', activeWorkspaceId), createInstance('active-2', activeWorkspaceId)];

		const adapter = store.add(new LogicalWorkspaceTerminalAdapter(
			logicalWorkspaceService,
			terminalService,
			store.add(new TestStorageService()),
			new NullLogService(),
		));
		const coordinator = Reflect.get(adapter, 'projectionCoordinator') as LogicalWorkspaceProjectionCoordinator;
		await coordinator.requestReconcile();

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
		logicalWorkspaceService.setShellLayout(activeWorkspaceId, createShellLayout());
		await timeout(0);
		assert.strictEqual(foregroundReads, 0);
	});

	test('a delayed editor terminal restore cannot overwrite a newer Workspace projection', async () => {
		const store = disposables.add(new DisposableStore());
		const instantiationService = store.add(workbenchInstantiationService(undefined, store));
		const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
		const firstWorkspace = logicalWorkspaceService.activeWorkspace;
		const secondWorkspace = logicalWorkspaceService.createWorkspace('Second');
		const changedInstances = store.add(new Emitter<void>());
		const disposedInstances = store.add(new Emitter<ITerminalInstance>());
		const firstOpenStarted = new DeferredPromise<void>();
		const releaseFirstOpen = new DeferredPromise<void>();
		const completedOpens: string[] = [];
		let foreground: ITerminalInstance[] = [];
		let background: ITerminalInstance[] = [];
		const terminalService = new class extends mock<ITerminalService>() {
			override readonly onDidChangeInstances = changedInstances.event;
			override readonly onDidDisposeInstance = disposedInstances.event;
			override readonly whenConnected = Promise.resolve();
			override get foregroundInstances(): readonly ITerminalInstance[] { return foreground; }
			override get instances(): readonly ITerminalInstance[] { return [...foreground, ...background]; }
			override moveToBackground(instance: ITerminalInstance): void {
				foreground = foreground.filter(candidate => candidate !== instance);
				background.push(instance);
				changedInstances.fire();
			}
			override async showBackgroundTerminal(instance: ITerminalInstance): Promise<void> {
				background = background.filter(candidate => candidate !== instance);
				foreground.push(instance);
				changedInstances.fire();
				const logicalTerminalId = instance.shellLaunchConfig.logicalTerminalId!;
				if (logicalTerminalId === 'first') {
					await firstOpenStarted.complete();
					await releaseFirstOpen.p;
				}
				completedOpens.push(logicalTerminalId);
			}
		};
		const createEditorInstance = (instanceId: number, logicalTerminalId: string, logicalWorkspaceId: string): ITerminalInstance => ({
			instanceId,
			target: TerminalLocation.Editor,
			shellLaunchConfig: { logicalTerminalId, logicalWorkspaceId },
			exitReason: TerminalExitReason.Unknown,
		} satisfies Partial<ITerminalInstance> as ITerminalInstance);
		const firstTerminal = createEditorInstance(1, 'first', firstWorkspace.id);
		const secondTerminal = createEditorInstance(2, 'second', secondWorkspace.id);
		background = [firstTerminal, secondTerminal];

		const adapter = store.add(new LogicalWorkspaceTerminalAdapter(
			logicalWorkspaceService,
			terminalService,
			store.add(new TestStorageService()),
			new NullLogService(),
		));
		const coordinator = Reflect.get(adapter, 'projectionCoordinator') as LogicalWorkspaceProjectionCoordinator;
		await firstOpenStarted.p;

		logicalWorkspaceService.activateWorkspace(secondWorkspace.id, LogicalWorkspaceActivationActor.Picker);
		const secondProjection = coordinator.requestReconcile();
		await releaseFirstOpen.complete();
		await secondProjection;
		await timeout(0);

		assert.deepStrictEqual({
			foreground: foreground.map(instance => instance.shellLaunchConfig.logicalTerminalId),
			background: background.map(instance => instance.shellLaunchConfig.logicalTerminalId),
			completedOpens,
		}, {
			foreground: ['second'],
			background: ['first'],
			completedOpens: ['first', 'second'],
		});
	});

});

function createShellLayout(): ILogicalWorkspaceShellLayout {
	return {
		primarySideBar: { visible: true, width: 300, height: 800, activeCompositeId: 'explorer' },
		panel: { visible: true, width: 1200, height: 300, activeCompositeId: 'terminal' },
		auxiliaryBar: { visible: false, width: 300, height: 800, activeCompositeId: 'chat' },
	};
}
