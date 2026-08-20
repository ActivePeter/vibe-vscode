/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TestContextService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { AsyncProjectionCoordinator, ILogicalWorkspaceProjection, LogicalWorkspaceProjectionCoordinator } from '../../browser/logicalWorkspaceProjection.js';
import { LogicalWorkspaceService } from '../../browser/logicalWorkspaceService.js';
import { ILogicalWorkspaceStateStore } from '../../browser/logicalWorkspaceStateStore.js';
import { ILogicalWorkspaceShellLayout, LogicalWorkspaceActivationActor } from '../../common/logicalWorkspace.js';

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
