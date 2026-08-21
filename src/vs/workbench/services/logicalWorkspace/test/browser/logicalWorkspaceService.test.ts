/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { TestContextService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { AsyncProjectionCoordinator, ILogicalWorkspaceProjection, LogicalWorkspaceProjectionCoordinator } from '../../browser/logicalWorkspaceProjection.js';
import { LogicalWorkspaceService } from '../../browser/logicalWorkspaceService.js';
import { ILogicalWorkspaceStateStore, LogicalWorkspaceStateStore, LOGICAL_WORKSPACE_SHARED_STATE_KEY } from '../../browser/logicalWorkspaceStateStore.js';
import { ILogicalWorkspaceShellLayout, LogicalWorkspaceActivationActor, onDidChangeLogicalWorkspaceStateSlice } from '../../common/logicalWorkspace.js';

class TestLogicalWorkspaceStateStore extends Disposable implements ILogicalWorkspaceStateStore {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSharedState = this._register(new Emitter<void>());
	readonly onDidChangeSharedState = this._onDidChangeSharedState.event;

	private sharedState: unknown;
	private readonly activeWorkspaceIds = new Map<string, string>();
	writeCount = 0;

	readSharedState(): unknown {
		return this.sharedState;
	}

	writeSharedState(state: object): void {
		this.sharedState = state;
		this.writeCount++;
	}

	readActiveWorkspaceId(physicalWorkspaceId: string): string | undefined {
		return this.activeWorkspaceIds.get(physicalWorkspaceId);
	}

	writeActiveWorkspaceId(physicalWorkspaceId: string, workspaceId: string): void {
		this.activeWorkspaceIds.set(physicalWorkspaceId, workspaceId);
	}

	setSharedState(state: unknown): void {
		this.sharedState = state;
		this._onDidChangeSharedState.fire();
	}
}

suite('LogicalWorkspaceService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let storageService: TestStorageService;
	let contextService: TestContextService;
	let stateStore: TestLogicalWorkspaceStateStore;

	setup(() => {
		storageService = disposables.add(new TestStorageService());
		contextService = new TestContextService();
		stateStore = disposables.add(new TestLogicalWorkspaceStateStore());
	});

	function createService(store = stateStore): LogicalWorkspaceService {
		return disposables.add(new LogicalWorkspaceService(storageService, contextService, store));
	}

	test('stores shared state internally and broadcasts it to another page', async () => {
		const receiverStorageService = disposables.add(new TestStorageService());
		const sourceStore = disposables.add(new LogicalWorkspaceStateStore(storageService, contextService));
		const receiverStore = disposables.add(new LogicalWorkspaceStateStore(receiverStorageService, contextService));
		const state = { schemaVersion: 2, workspaces: [{ id: 'shared' }] };
		const receiverChanged = Event.toPromise(receiverStore.onDidChangeSharedState);

		sourceStore.writeSharedState(state);
		await receiverChanged;

		assert.deepStrictEqual({
			sourceKeys: storageService.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE),
			receiverKeys: receiverStorageService.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE),
			sourceState: sourceStore.readSharedState(),
			receiverState: receiverStore.readSharedState(),
		}, {
			sourceKeys: [LOGICAL_WORKSPACE_SHARED_STATE_KEY],
			receiverKeys: [LOGICAL_WORKSPACE_SHARED_STATE_KEY],
			sourceState: state,
			receiverState: state,
		});
	});

	test('converges concurrent page writes on one revision winner', async () => {
		const firstStorageService = disposables.add(new TestStorageService());
		const secondStorageService = disposables.add(new TestStorageService());
		const firstStore = disposables.add(new LogicalWorkspaceStateStore(firstStorageService, contextService));
		const secondStore = disposables.add(new LogicalWorkspaceStateStore(secondStorageService, contextService));
		const converged = Event.toPromise(Event.any(firstStore.onDidChangeSharedState, secondStore.onDidChangeSharedState));

		firstStore.writeSharedState({ schemaVersion: 2, workspaces: [{ id: 'first' }] });
		secondStore.writeSharedState({ schemaVersion: 2, workspaces: [{ id: 'second' }] });
		await converged;

		assert.deepStrictEqual({
			firstState: firstStore.readSharedState(),
			firstStoredValue: firstStorageService.get(LOGICAL_WORKSPACE_SHARED_STATE_KEY, StorageScope.WORKSPACE),
		}, {
			firstState: secondStore.readSharedState(),
			firstStoredValue: secondStorageService.get(LOGICAL_WORKSPACE_SHARED_STATE_KEY, StorageScope.WORKSPACE),
		});
	});

	test('recovers a missed broadcast before an older page write can split state', async () => {
		const firstStorageService = disposables.add(new TestStorageService());
		const secondStorageService = disposables.add(new TestStorageService());
		const firstStore = disposables.add(new LogicalWorkspaceStateStore(firstStorageService, contextService));
		const winner = { schemaVersion: 2, workspaces: [{ id: 'winner' }] };
		firstStore.writeSharedState({ schemaVersion: 2, workspaces: [{ id: 'superseded' }] });
		firstStore.writeSharedState(winner);

		const secondStore = disposables.add(new LogicalWorkspaceStateStore(secondStorageService, contextService));
		const secondPageConverged = Event.toPromise(secondStore.onDidChangeSharedState);
		secondStore.writeSharedState({ schemaVersion: 2, workspaces: [{ id: 'stale-write' }] });
		await secondPageConverged;

		assert.deepStrictEqual({
			firstState: firstStore.readSharedState(),
			secondState: secondStore.readSharedState(),
			secondStoredValue: secondStorageService.get(LOGICAL_WORKSPACE_SHARED_STATE_KEY, StorageScope.WORKSPACE),
		}, {
			firstState: winner,
			secondState: winner,
			secondStoredValue: firstStorageService.get(LOGICAL_WORKSPACE_SHARED_STATE_KEY, StorageScope.WORKSPACE),
		});
	});

	test('announces activation before changing the active workspace', () => {
		const service = createService();
		const previousWorkspaceId = service.activeWorkspace.id;
		const workspace = service.createWorkspace('Review');
		const observed: object[] = [];

		disposables.add(service.onWillChangeActiveWorkspace(event => observed.push({ phase: 'will', activeWorkspaceId: service.activeWorkspace.id, sequence: service.activationSequence, event })));
		disposables.add(service.onDidChangeActiveWorkspace(event => observed.push({ phase: 'did', activeWorkspaceId: service.activeWorkspace.id, sequence: service.activationSequence, event })));
		service.activateWorkspace(workspace.id, LogicalWorkspaceActivationActor.Picker);

		assert.deepStrictEqual(observed, [
			{
				phase: 'will',
				activeWorkspaceId: previousWorkspaceId,
				sequence: 0,
				event: { actor: LogicalWorkspaceActivationActor.Picker, sequence: 1, previousWorkspaceId, workspaceId: workspace.id },
			},
			{
				phase: 'did',
				activeWorkspaceId: workspace.id,
				sequence: 1,
				event: { actor: LogicalWorkspaceActivationActor.Picker, sequence: 1, previousWorkspaceId, workspaceId: workspace.id },
			},
		]);
	});

	test('persists shell layout including a part without an active composite', () => {
		const service = createService();
		const workspace = service.createWorkspace('Review');
		const shellLayout: ILogicalWorkspaceShellLayout = {
			primarySideBar: { visible: true, width: 280, height: 800, activeCompositeId: 'workbench.view.explorer' },
			panel: { visible: true, width: 1200, height: 260, activeCompositeId: 'workbench.panel.terminal' },
			auxiliaryBar: { visible: false, width: 300, height: 800, activeCompositeId: '' },
		};
		service.setShellLayout(workspace.id, shellLayout);
		service.activateWorkspace(workspace.id, LogicalWorkspaceActivationActor.Picker);
		service.dispose();

		const restoredService = createService();

		assert.deepStrictEqual(restoredService.activeWorkspace, {
			...workspace,
			shellLayout,
		});
	});

	test('stores the active workspace in page state without rewriting shared snapshots', () => {
		const service = createService();
		const workspace = service.createWorkspace('Review');
		const writesBeforeActivation = stateStore.writeCount;

		service.activateWorkspace(workspace.id, LogicalWorkspaceActivationActor.Picker);

		assert.deepStrictEqual({
			activeWorkspaceId: stateStore.readActiveWorkspaceId(contextService.getWorkspace().id),
			sharedStateWrites: stateStore.writeCount,
		}, {
			activeWorkspaceId: workspace.id,
			sharedStateWrites: writesBeforeActivation,
		});
	});

	test('accepts external shared snapshots with last-write-wins while preserving a valid page selection', () => {
		const service = createService();
		const activeWorkspace = service.createWorkspace('Active');
		service.activateWorkspace(activeWorkspace.id, LogicalWorkspaceActivationActor.Picker);
		const incomingWorkspace = {
			id: 'incoming',
			name: 'Incoming',
			terminalIds: [],
			chatSessionResources: [],
			shellLayout: undefined,
		};
		const writesBeforeIncomingState = stateStore.writeCount;

		stateStore.setSharedState({
			schemaVersion: 2,
			workspaces: [activeWorkspace, incomingWorkspace],
		});

		assert.deepStrictEqual({
			workspaceIds: service.workspaces.map(workspace => workspace.id),
			activeWorkspaceId: service.activeWorkspace.id,
			writeCount: stateStore.writeCount,
		}, {
			workspaceIds: [activeWorkspace.id, incomingWorkspace.id],
			activeWorkspaceId: activeWorkspace.id,
			writeCount: writesBeforeIncomingState,
		});
	});

	test('rejects malformed shared snapshots without failing startup or external synchronization', () => {
		const malformedStates: readonly unknown[] = [
			null,
			42,
			{ schemaVersion: 2, workspaces: [null] },
			{ schemaVersion: 2, workspaces: ['workspace'] },
			{
				schemaVersion: 2,
				workspaces: [{ id: 'invalid-layout', name: 'Invalid', terminalIds: [], chatSessionResources: [], shellLayout: null }],
			},
		];
		const startupWorkspaceCounts = malformedStates.map(raw => {
			const store = disposables.add(new TestLogicalWorkspaceStateStore());
			store.setSharedState(raw);
			return createService(store).workspaces.length;
		});

		const service = createService();
		const originalWorkspaceIds = service.workspaces.map(workspace => workspace.id);
		for (const raw of malformedStates) {
			assert.doesNotThrow(() => stateStore.setSharedState(raw));
		}

		assert.deepStrictEqual({
			startupWorkspaceCounts,
			workspaceIdsAfterExternalChanges: service.workspaces.map(workspace => workspace.id),
		}, {
			startupWorkspaceCounts: [1, 1, 1, 1, 1],
			workspaceIdsAfterExternalChanges: originalWorkspaceIds,
		});
	});

	test('updates an ownership slice across pages without changing the active Workspace', async () => {
		const firstStorageService = disposables.add(new TestStorageService());
		const secondStorageService = disposables.add(new TestStorageService());
		const firstStore = disposables.add(new LogicalWorkspaceStateStore(firstStorageService, contextService));
		const secondStore = disposables.add(new LogicalWorkspaceStateStore(secondStorageService, contextService));
		const secondPageReceivedInitialState = Event.toPromise(secondStore.onDidChangeSharedState);
		const firstService = disposables.add(new LogicalWorkspaceService(firstStorageService, contextService, firstStore));
		await secondPageReceivedInitialState;
		const secondService = disposables.add(new LogicalWorkspaceService(secondStorageService, contextService, secondStore));
		const activeWorkspace = secondService.activeWorkspace;
		const sessionResource = URI.parse('test-session:external');
		const observed: object[] = [];
		const onDidChangeOwnership = onDidChangeLogicalWorkspaceStateSlice(secondService, state => ({
			activeWorkspaceId: state.activeWorkspaceId,
			sessionResources: state.workspaces.find(workspace => workspace.id === state.activeWorkspaceId)?.chatSessionResources ?? [],
		}));
		const ownershipChanged = Event.toPromise(onDidChangeOwnership);
		disposables.add(onDidChangeOwnership(slice => observed.push(slice)));

		firstService.bindChatSession(firstService.activeWorkspace.id, sessionResource);
		await ownershipChanged;
		secondService.setShellLayout(activeWorkspace.id, {
			primarySideBar: { visible: true, width: 280, height: 800, activeCompositeId: 'workbench.view.explorer' },
			panel: { visible: false, width: 1200, height: 260, activeCompositeId: 'workbench.panel.terminal' },
			auxiliaryBar: { visible: false, width: 300, height: 800, activeCompositeId: '' },
		});

		assert.deepStrictEqual(observed, [{
			activeWorkspaceId: activeWorkspace.id,
			sessionResources: [sessionResource.toString()],
		}]);
	});

	test('moves session ownership with one atomic catalog commit', () => {
		const service = createService();
		const firstWorkspaceId = service.activeWorkspace.id;
		const secondWorkspace = service.createWorkspace('Second');
		const sessionResource = URI.parse('test-session:atomic-move');
		service.bindChatSession(firstWorkspaceId, sessionResource);
		let workspaceChangeCount = 0;
		disposables.add(service.onDidChangeWorkspaces(() => workspaceChangeCount++));

		service.updateChatSessionOwnership(secondWorkspace.id, [sessionResource], [sessionResource]);

		assert.deepStrictEqual({
			firstOwnsSession: service.workspaceContainsChatSession(firstWorkspaceId, sessionResource),
			secondOwnsSession: service.workspaceContainsChatSession(secondWorkspace.id, sessionResource),
			workspaceChangeCount,
		}, {
			firstOwnsSession: false,
			secondOwnsSession: true,
			workspaceChangeCount: 1,
		});
	});

	test('exposes pending terminal ownership and persists it only on lease commit', () => {
		const service = createService();
		const workspaceId = service.activeWorkspace.id;
		const rolledBackLease = service.acquireTerminalOwnership(workspaceId, 'rolled-back-terminal');
		assert.deepStrictEqual({
			visibleWhilePending: service.workspaceContainsTerminal(workspaceId, 'rolled-back-terminal'),
			persistedWhilePending: service.activeWorkspace.terminalIds.includes('rolled-back-terminal'),
		}, {
			visibleWhilePending: true,
			persistedWhilePending: false,
		});
		rolledBackLease.dispose();

		const committedLease = service.acquireTerminalOwnership(workspaceId, 'committed-terminal');
		committedLease.commit();
		committedLease.dispose();

		assert.deepStrictEqual({
			rolledBackOwner: service.workspaceContainsTerminal(workspaceId, 'rolled-back-terminal'),
			committedOwner: service.workspaceContainsTerminal(workspaceId, 'committed-terminal'),
			persistedTerminalIds: service.activeWorkspace.terminalIds,
		}, {
			rolledBackOwner: false,
			committedOwner: true,
			persistedTerminalIds: ['committed-terminal'],
		});
	});

	test('assigns a concurrently claimed terminal to the first successful creation', () => {
		const service = createService();
		const firstWorkspaceId = service.activeWorkspace.id;
		const secondWorkspace = service.createWorkspace('Second');
		const firstLease = service.acquireTerminalOwnership(firstWorkspaceId, 'shared-terminal');
		const secondLease = service.acquireTerminalOwnership(secondWorkspace.id, 'shared-terminal');

		assert.deepStrictEqual({
			firstPendingOwner: service.workspaceContainsTerminal(firstWorkspaceId, 'shared-terminal'),
			secondPendingOwner: service.workspaceContainsTerminal(secondWorkspace.id, 'shared-terminal'),
		}, {
			firstPendingOwner: true,
			secondPendingOwner: false,
		});

		secondLease.commit();
		secondLease.dispose();
		firstLease.dispose();

		assert.deepStrictEqual({
			firstOwner: service.workspaceContainsTerminal(firstWorkspaceId, 'shared-terminal'),
			secondOwner: service.workspaceContainsTerminal(secondWorkspace.id, 'shared-terminal'),
		}, {
			firstOwner: false,
			secondOwner: true,
		});
	});

	test('falls back with ordered activation events when an external snapshot removes the active workspace', () => {
		const service = createService();
		const fallbackWorkspace = service.activeWorkspace;
		const removedWorkspace = service.createWorkspace('Removed');
		service.activateWorkspace(removedWorkspace.id, LogicalWorkspaceActivationActor.Picker);
		const observed: object[] = [];
		disposables.add(service.onWillChangeActiveWorkspace(event => observed.push({ phase: 'will', activeWorkspaceId: service.activeWorkspace.id, event })));
		disposables.add(service.onDidChangeActiveWorkspace(event => observed.push({ phase: 'did', activeWorkspaceId: service.activeWorkspace.id, event })));

		stateStore.setSharedState({ schemaVersion: 2, workspaces: [fallbackWorkspace] });

		const event = {
			actor: LogicalWorkspaceActivationActor.SharedState,
			sequence: 2,
			previousWorkspaceId: removedWorkspace.id,
			workspaceId: fallbackWorkspace.id,
		};
		assert.deepStrictEqual(observed, [
			{ phase: 'will', activeWorkspaceId: removedWorkspace.id, event },
			{ phase: 'did', activeWorkspaceId: fallbackWorkspace.id, event },
		]);
	});

	test('projection coordinator restores initially and captures before switching', async () => {
		const service = createService();
		const initialWorkspaceId = service.activeWorkspace.id;
		const restoredWorkspaceIds: string[] = [];
		const capturedWorkspaceIds: string[] = [];
		const projection: ILogicalWorkspaceProjection = {
			id: 'testProjection',
			capture: workspaceId => capturedWorkspaceIds.push(workspaceId),
			restore: async context => {
				if (context.isCurrent()) {
					restoredWorkspaceIds.push(context.workspace.id);
				}
			},
		};
		const coordinator = disposables.add(new LogicalWorkspaceProjectionCoordinator(service, projection, storageService, new NullLogService()));
		await timeout(0);

		const nextWorkspace = service.createWorkspace('Next');
		service.activateWorkspace(nextWorkspace.id, LogicalWorkspaceActivationActor.Picker);
		await coordinator.requestReconcile();

		assert.deepStrictEqual({
			initiallyRestored: restoredWorkspaceIds.includes(initialWorkspaceId),
			lastRestored: restoredWorkspaceIds.at(-1),
			capturedWorkspaceIds,
		}, {
			initiallyRestored: true,
			lastRestored: nextWorkspace.id,
			capturedWorkspaceIds: [initialWorkspaceId],
		});
	});

	test('async projection resolves coalesced callers only after the newest projection', async () => {
		const firstStarted = new DeferredPromise<void>();
		const releaseFirst = new DeferredPromise<void>();
		const applied: string[] = [];
		const coordinator = disposables.add(new AsyncProjectionCoordinator<string>('test', async context => {
			applied.push(context.value);
			if (context.value === 'first') {
				await firstStarted.complete();
				await releaseFirst.p;
			}
		}, new NullLogService()));

		const first = coordinator.request('first');
		await firstStarted.p;
		let supersededRequestResolved = false;
		const second = coordinator.request('second').then(() => supersededRequestResolved = true);
		const third = coordinator.request('third');
		assert.strictEqual(supersededRequestResolved, false);

		await releaseFirst.complete();
		await Promise.all([first, second, third]);

		assert.deepStrictEqual({ applied, supersededRequestResolved }, {
			applied: ['first', 'third'],
			supersededRequestResolved: true,
		});
	});
});
