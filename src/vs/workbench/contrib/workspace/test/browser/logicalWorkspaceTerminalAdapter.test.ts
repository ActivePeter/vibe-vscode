/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { TerminalExitReason, TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { LogicalWorkspaceProjectionCoordinator } from '../../../../services/logicalWorkspace/browser/logicalWorkspaceProjection.js';
import { LogicalWorkspaceService } from '../../../../services/logicalWorkspace/browser/logicalWorkspaceService.js';
import { ILogicalWorkspaceStateStore, LOGICAL_WORKSPACE_SHARED_STATE_KEY, LogicalWorkspaceStateStore } from '../../../../services/logicalWorkspace/browser/logicalWorkspaceStateStore.js';
import { ILogicalWorkspaceService, ILogicalWorkspaceShellLayout, ILogicalWorkspaceTerminalProjectionService, LogicalWorkspaceActivationActor, LogicalWorkspaceStateChangeKind } from '../../../../services/logicalWorkspace/common/logicalWorkspace.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { LogicalWorkspaceEditorAdapter } from '../../browser/logicalWorkspaceEditorAdapter.js';
import { LogicalWorkspaceTerminalAdapter } from '../../browser/logicalWorkspaceTerminalAdapter.js';

suite('LogicalWorkspaceTerminalAdapter', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('workbench fixture uses the production Logical Workspace state stack', async () => {
		const store = disposables.add(new DisposableStore());
		const instantiationService = store.add(workbenchInstantiationService(undefined, store));
		const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
		const logicalWorkspaceStateStore = instantiationService.get(ILogicalWorkspaceStateStore);
		await logicalWorkspaceService.whenReady;

		const stateChanges: LogicalWorkspaceStateChangeKind[] = [];
		let workspaceChanges = 0;
		store.add(logicalWorkspaceService.onDidChangeState(event => stateChanges.push(event.changed)));
		store.add(logicalWorkspaceService.onDidChangeWorkspaces(() => workspaceChanges++));

		const activeWorkspaceId = logicalWorkspaceService.activeWorkspace.id;
		const activeWorkspaceName = logicalWorkspaceService.activeWorkspace.name;
		logicalWorkspaceService.setShellLayout(activeWorkspaceId, createShellLayout());
		logicalWorkspaceService.setShellLayout(activeWorkspaceId, createShellLayout());
		logicalWorkspaceService.setEditorWorkingSet(activeWorkspaceId, 'editor-state');
		logicalWorkspaceService.setEditorWorkingSet(activeWorkspaceId, 'editor-state');
		const createdWorkspace = await logicalWorkspaceService.createWorkspace('  Review  ');
		await assert.rejects(logicalWorkspaceService.createWorkspace('   '), /must not be empty/);

		const rawPersistedState = instantiationService.get(IStorageService).get(LOGICAL_WORKSPACE_SHARED_STATE_KEY, StorageScope.WORKSPACE);
		const persistedState: unknown = JSON.parse(rawPersistedState ?? 'null');
		assert.deepStrictEqual({
			usesProductionService: logicalWorkspaceService instanceof LogicalWorkspaceService,
			usesProductionStore: logicalWorkspaceStateStore instanceof LogicalWorkspaceStateStore,
			createdWorkspaceName: createdWorkspace.name,
			stateChanges,
			workspaceChanges,
			persistedState,
		}, {
			usesProductionService: true,
			usesProductionStore: true,
			createdWorkspaceName: 'Review',
			stateChanges: [
				LogicalWorkspaceStateChangeKind.Workspaces,
				LogicalWorkspaceStateChangeKind.Workspaces,
				LogicalWorkspaceStateChangeKind.Workspaces,
			],
			workspaceChanges: 3,
			persistedState: {
				schemaVersion: 2,
				workspaces: [{
					id: activeWorkspaceId,
					name: activeWorkspaceName,
					terminalIds: [],
					shellLayout: createShellLayout(),
					editorWorkingSet: 'editor-state',
				}, {
					id: createdWorkspace.id,
					name: 'Review',
					terminalIds: [],
				}],
			},
		});
	});

	test('finishes Terminal projection before destructive editor restore', async () => {
		const store = disposables.add(new DisposableStore());
		const instantiationService = store.add(workbenchInstantiationService(undefined, store));
		const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
		await logicalWorkspaceService.whenReady;
		logicalWorkspaceService.setEditorWorkingSet(logicalWorkspaceService.activeWorkspace.id, 'editor-working-set');
		const terminalProjectionStarted = new DeferredPromise<void>();
		const releaseTerminalProjection = new DeferredPromise<void>();
		const terminalProjectionService = new class extends mock<ILogicalWorkspaceTerminalProjectionService>() {
			override readonly whenReady = Promise.resolve();
			override async requestReconcile(): Promise<void> {
				await terminalProjectionStarted.complete();
				await releaseTerminalProjection.p;
			}
		};
		let editorApplyCount = 0;
		const editorGroupsService = new class extends mock<IEditorGroupsService>() {
			override readonly whenReady = Promise.resolve();
			override async applySerializedWorkingSet(): Promise<boolean> {
				editorApplyCount++;
				return true;
			}
		};
		const editorService = new class extends mock<IEditorService>() {
			override readonly onDidEditorsChange = Event.None;
			override getEditors(): [] { return []; }
		};
		const adapter = store.add(new LogicalWorkspaceEditorAdapter(
			logicalWorkspaceService,
			editorGroupsService,
			editorService,
			terminalProjectionService,
			store.add(new TestStorageService()),
			new NullLogService(),
		));

		await terminalProjectionStarted.p;
		assert.strictEqual(editorApplyCount, 0);
		await releaseTerminalProjection.complete();
		await adapter.whenReady;
		assert.strictEqual(editorApplyCount, 1);
		store.dispose();
	});

	test('completes a terminal projection transaction before an awaited reconcile resolves', async () => {
		const store = disposables.add(new DisposableStore());
		const instantiationService = store.add(workbenchInstantiationService(undefined, store));
		const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
		await logicalWorkspaceService.whenReady;
		const activeWorkspaceId = logicalWorkspaceService.activeWorkspace.id;
		const inactiveWorkspace = await logicalWorkspaceService.createWorkspace('Inactive');
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

	test('leaves editor Terminal restoration to the editor working set owner', async () => {
		const store = disposables.add(new DisposableStore());
		const instantiationService = store.add(workbenchInstantiationService(undefined, store));
		const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
		await logicalWorkspaceService.whenReady;
		const firstWorkspace = logicalWorkspaceService.activeWorkspace;
		const secondWorkspace = await logicalWorkspaceService.createWorkspace('Second');
		const changedInstances = store.add(new Emitter<void>());
		const disposedInstances = store.add(new Emitter<ITerminalInstance>());
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
				completedOpens.push(instance.shellLaunchConfig.logicalTerminalId!);
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
		await coordinator.whenReady;

		logicalWorkspaceService.activateWorkspace(secondWorkspace.id, LogicalWorkspaceActivationActor.Picker);
		await coordinator.requestReconcile();

		assert.deepStrictEqual({
			foreground: foreground.map(instance => instance.shellLaunchConfig.logicalTerminalId),
			background: background.map(instance => instance.shellLaunchConfig.logicalTerminalId),
			completedOpens,
		}, {
			foreground: [],
			background: ['first', 'second'],
			completedOpens: [],
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
