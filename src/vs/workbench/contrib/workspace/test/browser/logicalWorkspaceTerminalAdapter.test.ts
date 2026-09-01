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
import { IEditorGroupsService, IEditorWorkingSetOptions } from '../../../../services/editor/common/editorGroupsService.js';
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
			override prepareEditorTerminalsForWorkingSet(): void { }
			override async restoreUnclaimedEditorTerminals(): Promise<boolean> {
				return false;
			}
		};
		let editorApplyCount = 0;
		const editorGroupsService = new class extends mock<IEditorGroupsService>() {
			override readonly whenReady = Promise.resolve();
			override async applySerializedWorkingSet(_workingSet: string, options?: IEditorWorkingSetOptions): Promise<boolean> {
				editorApplyCount++;
				options?.onWillApply?.();
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

	test('does not apply an editor working set after Terminal projection fails', async () => {
		const store = disposables.add(new DisposableStore());
		const instantiationService = store.add(workbenchInstantiationService(undefined, store));
		const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
		await logicalWorkspaceService.whenReady;
		logicalWorkspaceService.setEditorWorkingSet(logicalWorkspaceService.activeWorkspace.id, 'editor-working-set');
		const expectedError = new Error('terminal projection failed');
		const terminalProjectionService = new class extends mock<ILogicalWorkspaceTerminalProjectionService>() {
			override readonly whenReady = Promise.resolve();
			override async requestReconcile(): Promise<void> {
				throw expectedError;
			}
			override prepareEditorTerminalsForWorkingSet(): void { }
			override async restoreUnclaimedEditorTerminals(): Promise<boolean> {
				return false;
			}
		};
		let editorApplyCount = 0;
		const editorGroupsService = new class extends mock<IEditorGroupsService>() {
			override readonly whenReady = Promise.resolve();
			override async applySerializedWorkingSet(_workingSet: string, options?: IEditorWorkingSetOptions): Promise<boolean> {
				editorApplyCount++;
				options?.onWillApply?.();
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

		await assert.rejects(adapter.whenReady, error => error === expectedError);
		assert.strictEqual(editorApplyCount, 0);
		store.dispose();
	});

	test('does not prepare editor Terminals when working set validation returns false', async () => {
		const store = disposables.add(new DisposableStore());
		const instantiationService = store.add(workbenchInstantiationService(undefined, store));
		const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
		await logicalWorkspaceService.whenReady;
		logicalWorkspaceService.setEditorWorkingSet(logicalWorkspaceService.activeWorkspace.id, 'malformed-editor-working-set');
		let terminalVisible = true;
		let prepareCount = 0;
		let restoreCount = 0;
		const terminalProjectionService = new class extends mock<ILogicalWorkspaceTerminalProjectionService>() {
			override readonly whenReady = Promise.resolve();
			override async requestReconcile(): Promise<void> { }
			override prepareEditorTerminalsForWorkingSet(): void {
				prepareCount++;
				terminalVisible = false;
			}
			override async restoreUnclaimedEditorTerminals(): Promise<boolean> {
				restoreCount++;
				terminalVisible = true;
				return true;
			}
		};
		const editorGroupsService = new class extends mock<IEditorGroupsService>() {
			override readonly whenReady = Promise.resolve();
			override async applySerializedWorkingSet(): Promise<boolean> {
				// Production EditorParts returns before onWillApply for malformed state.
				return false;
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

		await adapter.whenReady;

		assert.deepStrictEqual({ terminalVisible, prepareCount, restoreCount }, {
			terminalVisible: true,
			prepareCount: 0,
			restoreCount: 0,
		});
		store.dispose();
	});

	test('rolls back prepared editor Terminals when working set apply returns false or throws', async () => {
		for (const outcome of ['false', 'throw'] as const) {
			const store = disposables.add(new DisposableStore());
			const instantiationService = store.add(workbenchInstantiationService(undefined, store));
			const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
			await logicalWorkspaceService.whenReady;
			logicalWorkspaceService.setEditorWorkingSet(logicalWorkspaceService.activeWorkspace.id, 'validated-editor-working-set');
			const expectedError = new Error('editor apply failed');
			let terminalVisible = true;
			let prepareCount = 0;
			let restoreCount = 0;
			const terminalProjectionService = new class extends mock<ILogicalWorkspaceTerminalProjectionService>() {
				override readonly whenReady = Promise.resolve();
				override async requestReconcile(): Promise<void> { }
				override prepareEditorTerminalsForWorkingSet(): void {
					prepareCount++;
					terminalVisible = false;
				}
				override async restoreUnclaimedEditorTerminals(): Promise<boolean> {
					restoreCount++;
					terminalVisible = true;
					return true;
				}
			};
			const editorGroupsService = new class extends mock<IEditorGroupsService>() {
				override readonly whenReady = Promise.resolve();
				override async applySerializedWorkingSet(_workingSet: string, options?: IEditorWorkingSetOptions): Promise<boolean> {
					options?.onWillApply?.();
					if (outcome === 'throw') {
						throw expectedError;
					}
					return false;
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

			if (outcome === 'throw') {
				await assert.rejects(adapter.whenReady, error => error === expectedError);
			} else {
				await adapter.whenReady;
			}

			assert.deepStrictEqual({ outcome, terminalVisible, prepareCount, restoreCount }, {
				outcome,
				terminalVisible: true,
				prepareCount: 1,
				restoreCount: 1,
			});
			store.dispose();
		}
	});

	test('finalizes unclaimed editor Terminals only after the editor working set is applied', async () => {
		const store = disposables.add(new DisposableStore());
		const instantiationService = store.add(workbenchInstantiationService(undefined, store));
		const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
		await logicalWorkspaceService.whenReady;
		logicalWorkspaceService.setEditorWorkingSet(logicalWorkspaceService.activeWorkspace.id, 'editor-working-set');
		const events: string[] = [];
		const terminalProjectionService = new class extends mock<ILogicalWorkspaceTerminalProjectionService>() {
			override readonly whenReady = Promise.resolve();
			override async requestReconcile(): Promise<void> {
				events.push('terminal-reconcile');
			}
			override prepareEditorTerminalsForWorkingSet(): void {
				events.push('terminal-prepare');
			}
			override async restoreUnclaimedEditorTerminals(): Promise<boolean> {
				events.push('terminal-finalize');
				return false;
			}
		};
		const editorGroupsService = new class extends mock<IEditorGroupsService>() {
			override readonly whenReady = Promise.resolve();
			override async applySerializedWorkingSet(_workingSet: string, options?: IEditorWorkingSetOptions): Promise<boolean> {
				options?.onWillApply?.();
				events.push('editor-apply');
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

		await adapter.whenReady;
		assert.deepStrictEqual(events, ['terminal-reconcile', 'terminal-prepare', 'editor-apply', 'terminal-finalize']);
		store.dispose();
	});

	test('does not confirm editor projection when unclaimed Terminal finalization fails', async () => {
		const store = disposables.add(new DisposableStore());
		const instantiationService = store.add(workbenchInstantiationService(undefined, store));
		const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
		await logicalWorkspaceService.whenReady;
		logicalWorkspaceService.setEditorWorkingSet(logicalWorkspaceService.activeWorkspace.id, 'editor-working-set');
		const expectedError = new Error('editor Terminal open failed');
		let finalizationCount = 0;
		const terminalProjectionService = new class extends mock<ILogicalWorkspaceTerminalProjectionService>() {
			override readonly whenReady = Promise.resolve();
			override async requestReconcile(): Promise<void> { }
			override prepareEditorTerminalsForWorkingSet(): void { }
			override async restoreUnclaimedEditorTerminals(): Promise<boolean> {
				if (++finalizationCount === 1) {
					throw expectedError;
				}
				return false;
			}
		};
		let editorApplyCount = 0;
		const editorGroupsService = new class extends mock<IEditorGroupsService>() {
			override readonly whenReady = Promise.resolve();
			override async applySerializedWorkingSet(_workingSet: string, options?: IEditorWorkingSetOptions): Promise<boolean> {
				editorApplyCount++;
				options?.onWillApply?.();
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
		const coordinator = Reflect.get(adapter, 'projectionCoordinator') as LogicalWorkspaceProjectionCoordinator;

		await assert.rejects(adapter.whenReady, error => error === expectedError);
		await coordinator.requestReconcile();

		assert.deepStrictEqual({ editorApplyCount, finalizationCount }, { editorApplyCount: 2, finalizationCount: 2 });
		store.dispose();
	});

	test('does not block initial projection on Terminal connection and reconciles after connection', async () => {
		const store = disposables.add(new DisposableStore());
		const instantiationService = store.add(workbenchInstantiationService(undefined, store));
		const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
		await logicalWorkspaceService.whenReady;

		const terminalConnection = new DeferredPromise<void>();
		const changedInstances = store.add(new Emitter<void>());
		const terminalMoved = new DeferredPromise<void>();
		let foreground: ITerminalInstance[] = [];
		const terminalService = new class extends mock<ITerminalService>() {
			override readonly onDidChangeInstances = changedInstances.event;
			override readonly whenConnected = terminalConnection.p;
			override get foregroundInstances(): readonly ITerminalInstance[] { return foreground; }
			override get instances(): readonly ITerminalInstance[] { return foreground; }
			override moveToBackground(): void {
				foreground = [];
				void terminalMoved.complete();
			}
		}();
		const adapter = store.add(new LogicalWorkspaceTerminalAdapter(
			logicalWorkspaceService,
			terminalService,
			store.add(new TestStorageService()),
			new NullLogService(),
		));
		let ready = false;
		void adapter.whenReady.then(() => ready = true);

		await timeout(0);
		const readyBeforeConnection = ready;
		foreground = [{
			instanceId: 1,
			target: TerminalLocation.Panel,
			shellLaunchConfig: { logicalWorkspaceId: 'other-workspace' },
		} satisfies Partial<ITerminalInstance> as ITerminalInstance];
		await terminalConnection.complete();
		await terminalMoved.p;
		await adapter.requestReconcile();

		assert.deepStrictEqual({ readyBeforeConnection, foreground }, { readyBeforeConnection: true, foreground: [] });
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

	test('restores an editor Terminal that remains unclaimed after working set adoption', async () => {
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
		const existingTerminal = createEditorInstance(1, 'existing', firstWorkspace.id);
		const lateTerminal = createEditorInstance(2, 'late', firstWorkspace.id);
		const hiddenTerminal = createEditorInstance(3, 'hidden', firstWorkspace.id);
		hiddenTerminal.shellLaunchConfig.hideFromUser = true;
		foreground = [existingTerminal];
		background = [hiddenTerminal];

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
		// The new editor Terminal completes after A was captured and while B is active.
		foreground.push(lateTerminal);
		changedInstances.fire();
		await coordinator.requestReconcile();

		logicalWorkspaceService.activateWorkspace(firstWorkspace.id, LogicalWorkspaceActivationActor.Picker);
		await coordinator.requestReconcile();
		const staleRestore = await adapter.restoreUnclaimedEditorTerminals(firstWorkspace.id, logicalWorkspaceService.activationSequence - 1);
		// Model the late open winning the race back into A immediately before destructive apply.
		background = background.filter(instance => instance !== lateTerminal);
		foreground.push(lateTerminal);
		adapter.prepareEditorTerminalsForWorkingSet(firstWorkspace.id, logicalWorkspaceService.activationSequence);
		// Applying A's serialized working set adopts the existing Terminal before finalization.
		background = background.filter(instance => instance !== existingTerminal);
		foreground.push(existingTerminal);
		const restored = await adapter.restoreUnclaimedEditorTerminals(firstWorkspace.id, logicalWorkspaceService.activationSequence);

		assert.deepStrictEqual({
			foreground: foreground.map(instance => instance.shellLaunchConfig.logicalTerminalId),
			background: background.map(instance => instance.shellLaunchConfig.logicalTerminalId),
			completedOpens,
			staleRestore,
			restored,
		}, {
			foreground: ['existing', 'late'],
			background: ['hidden'],
			completedOpens: ['late'],
			staleRestore: false,
			restored: true,
		});
	});

	test('converges to a newer Workspace when editor Terminal finalization completes late', async () => {
		const store = disposables.add(new DisposableStore());
		const instantiationService = store.add(workbenchInstantiationService(undefined, store));
		const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
		await logicalWorkspaceService.whenReady;
		const firstWorkspace = logicalWorkspaceService.activeWorkspace;
		const secondWorkspace = await logicalWorkspaceService.createWorkspace('Second');
		const changedInstances = store.add(new Emitter<void>());
		const showStarted = new DeferredPromise<void>();
		const releaseShow = new DeferredPromise<void>();
		const instance = {
			instanceId: 1,
			target: TerminalLocation.Editor,
			shellLaunchConfig: { logicalTerminalId: 'late', logicalWorkspaceId: firstWorkspace.id },
			exitReason: TerminalExitReason.Unknown,
		} satisfies Partial<ITerminalInstance> as ITerminalInstance;
		let foreground: ITerminalInstance[] = [];
		let background: ITerminalInstance[] = [instance];
		const terminalService = new class extends mock<ITerminalService>() {
			override readonly onDidChangeInstances = changedInstances.event;
			override readonly whenConnected = Promise.resolve();
			override get foregroundInstances(): readonly ITerminalInstance[] { return foreground; }
			override get instances(): readonly ITerminalInstance[] { return [...foreground, ...background]; }
			override moveToBackground(instance: ITerminalInstance): void {
				foreground = foreground.filter(candidate => candidate !== instance);
				if (!background.includes(instance)) {
					background.push(instance);
				}
				changedInstances.fire();
			}
			override async showBackgroundTerminal(instance: ITerminalInstance): Promise<void> {
				background = background.filter(candidate => candidate !== instance);
				foreground.push(instance);
				changedInstances.fire();
				await showStarted.complete();
				await releaseShow.p;
			}
		};
		const adapter = store.add(new LogicalWorkspaceTerminalAdapter(
			logicalWorkspaceService,
			terminalService,
			store.add(new TestStorageService()),
			new NullLogService(),
		));
		await adapter.whenReady;

		const finalization = adapter.restoreUnclaimedEditorTerminals(firstWorkspace.id, logicalWorkspaceService.activationSequence);
		await showStarted.p;
		logicalWorkspaceService.activateWorkspace(secondWorkspace.id, LogicalWorkspaceActivationActor.Picker);
		await releaseShow.complete();
		const restored = await finalization;
		await adapter.requestReconcile();

		assert.deepStrictEqual({ foreground, background, restored }, { foreground: [], background: [instance], restored: false });
		store.dispose();
	});

});

function createShellLayout(): ILogicalWorkspaceShellLayout {
	return {
		primarySideBar: { visible: true, width: 300, height: 800, activeCompositeId: 'explorer' },
		panel: { visible: true, width: 1200, height: 300, activeCompositeId: 'terminal' },
		auxiliaryBar: { visible: false, width: 300, height: 800, activeCompositeId: 'chat' },
	};
}
