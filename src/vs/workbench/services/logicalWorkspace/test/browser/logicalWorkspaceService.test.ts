/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { StorageScope } from '../../../../../platform/storage/common/storage.js';
import { WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { TestContextService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { AsyncProjectionCoordinator, ILogicalWorkspaceProjection, LogicalWorkspaceProjectionCoordinator } from '../../browser/logicalWorkspaceProjection.js';
import { LogicalWorkspaceService } from '../../browser/logicalWorkspaceService.js';
import { RemoteLogicalWorkspaceStateClient } from '../../browser/logicalWorkspaceRemoteStateClient.js';
import { ILogicalWorkspaceStateStore } from '../../browser/logicalWorkspaceStateStore.js';
import { applyLogicalWorkspaceMutation, ILogicalWorkspaceMutation, ILogicalWorkspaceSharedState, ILogicalWorkspaceShellLayout, LogicalWorkspaceActivationActor, LogicalWorkspaceMutationType, parseLogicalWorkspaceMutation, parseLogicalWorkspaceSharedState } from '../../common/logicalWorkspace.js';
import { IRemoteLogicalWorkspaceStateResult, IRemoteLogicalWorkspaceStateSnapshot, RemoteLogicalWorkspaceStateCommand, RemoteLogicalWorkspaceStateErrorCode } from '../../common/logicalWorkspaceRemote.js';

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

	async initializeSharedState(state: ILogicalWorkspaceSharedState): Promise<ILogicalWorkspaceSharedState> {
		this.sharedState = state;
		this.writeCount++;
		return state;
	}

	applyMutation(mutation: ILogicalWorkspaceMutation): void {
		const state = this.sharedState as ILogicalWorkspaceSharedState | undefined;
		if (!state) {
			throw new Error('Test Logical Workspace state was not initialized');
		}
		this.sharedState = applyLogicalWorkspaceMutation(state, mutation);
		this.writeCount++;
		this._onDidChangeSharedState.fire();
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

class DeferredWorkspaceContextService extends TestContextService {

	private readonly completeWorkspace = new DeferredPromise<void>();

	override getWorkbenchState(): WorkbenchState {
		return WorkbenchState.WORKSPACE;
	}

	override async getCompleteWorkspace() {
		await this.completeWorkspace.p;
		return this.getWorkspace();
	}

	markWorkspaceComplete(): Promise<void> {
		return this.completeWorkspace.complete();
	}
}

class TestRemoteLogicalWorkspaceChannel extends Disposable implements IChannel {

	private readonly _onDidChange = this._register(new Emitter<{ readonly physicalWorkspaceId: string; readonly snapshot: IRemoteLogicalWorkspaceStateSnapshot }>());
	readonly onDidChange = this._onDidChange.event;
	private snapshots = new Map<string, IRemoteLogicalWorkspaceStateSnapshot>();
	private nextMutationResponseGate: DeferredPromise<void> | undefined;
	private dropNextMutationResponse = false;

	delayNextMutationResponse(): DeferredPromise<void> {
		this.nextMutationResponseGate = new DeferredPromise<void>();
		return this.nextMutationResponseGate;
	}

	dropNextMutationResult(): void {
		this.dropNextMutationResponse = true;
	}

	getSnapshot(physicalWorkspaceId: string): IRemoteLogicalWorkspaceStateSnapshot | undefined {
		return this.snapshots.get(physicalWorkspaceId);
	}

	async call<T>(command: string, arg?: unknown): Promise<T> {
		if (!arg || typeof arg !== 'object') {
			return this.error('Invalid request') as T;
		}
		const request = arg as Record<string, unknown>;
		const physicalWorkspaceId = request.physicalWorkspaceId;
		if (typeof physicalWorkspaceId !== 'string' || !physicalWorkspaceId) {
			return this.error('Invalid physical Workspace ID') as T;
		}

		switch (command) {
			case RemoteLogicalWorkspaceStateCommand.Initialize: {
				const state = parseLogicalWorkspaceSharedState(request.state);
				if (!state) {
					return this.error('Invalid initial state') as T;
				}
				let snapshot = this.snapshots.get(physicalWorkspaceId);
				if (!snapshot) {
					snapshot = { revision: 1, state };
					this.snapshots.set(physicalWorkspaceId, snapshot);
					this._onDidChange.fire({ physicalWorkspaceId, snapshot });
				}
				return this.ok(snapshot) as T;
			}
			case RemoteLogicalWorkspaceStateCommand.Read:
				return this.ok(this.snapshots.get(physicalWorkspaceId)) as T;
			case RemoteLogicalWorkspaceStateCommand.Mutate: {
				const mutation = parseLogicalWorkspaceMutation(request.mutation);
				const current = this.snapshots.get(physicalWorkspaceId);
				if (!mutation || !current) {
					return this.error('Invalid mutation') as T;
				}
				const state = applyLogicalWorkspaceMutation(current.state, mutation);
				if (state === current.state) {
					return this.ok(current) as T;
				}
				const snapshot = { revision: current.revision + 1, state };
				this.snapshots.set(physicalWorkspaceId, snapshot);
				this._onDidChange.fire({ physicalWorkspaceId, snapshot });
				if (this.nextMutationResponseGate) {
					const gate = this.nextMutationResponseGate;
					this.nextMutationResponseGate = undefined;
					await gate.p;
				}
				if (this.dropNextMutationResponse) {
					this.dropNextMutationResponse = false;
					throw new Error('Mutation response lost after commit');
				}
				return this.ok(snapshot) as T;
			}
			default:
				return this.error('Invalid command') as T;
		}
	}

	listen<T>(): Event<T> {
		return Event.None;
	}

	private ok<T>(value: T): IRemoteLogicalWorkspaceStateResult<T> {
		return { status: 'ok', value };
	}

	private error(message: string): IRemoteLogicalWorkspaceStateResult<never> {
		return { status: 'error', code: RemoteLogicalWorkspaceStateErrorCode.InvalidRequest, message };
	}
}

suite('RemoteLogicalWorkspaceStateClient', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function state(id: string): ILogicalWorkspaceSharedState {
		return { schemaVersion: 2, workspaces: [{ id, name: id, terminalIds: [], shellLayout: undefined }] };
	}

	test('keeps a pre-existing revision-one server state during new-page initialization', async () => {
		const channel = disposables.add(new TestRemoteLogicalWorkspaceChannel());
		const existing = disposables.add(new RemoteLogicalWorkspaceStateClient('physical', channel, new NullLogService()));
		await existing.initialize(state('existing'));

		const newPage = disposables.add(new RemoteLogicalWorkspaceStateClient('physical', channel, new NullLogService()));
		await newPage.initialize(state('new-page-default'));

		assert.deepStrictEqual({ existing: existing.state, newPage: newPage.state }, {
			existing: state('existing'),
			newPage: state('existing'),
		});
	});

	test('observes another page write after an explicit refresh', async () => {
		const channel = disposables.add(new TestRemoteLogicalWorkspaceChannel());
		const first = disposables.add(new RemoteLogicalWorkspaceStateClient('physical', channel, new NullLogService()));
		const second = disposables.add(new RemoteLogicalWorkspaceStateClient('physical', channel, new NullLogService()));
		await Promise.all([first.initialize(state('workspace')), second.initialize(state('other-default'))]);
		const shellLayout: ILogicalWorkspaceShellLayout = {
			primarySideBar: { visible: true, width: 280, height: 800, activeCompositeId: 'workbench.view.explorer' },
			panel: { visible: false, width: 1200, height: 260, activeCompositeId: 'workbench.panel.terminal' },
			auxiliaryBar: { visible: false, width: 300, height: 800, activeCompositeId: '' },
		};
		const committed = Event.toPromise(Event.filter(channel.onDidChange, event => event.snapshot.revision === 3));

		first.mutate({ type: LogicalWorkspaceMutationType.SetEditorWorkingSet, workspaceId: 'workspace', editorWorkingSet: 'editor-state' });
		second.mutate({ type: LogicalWorkspaceMutationType.SetShellLayout, workspaceId: 'workspace', shellLayout });
		await committed;
		const firstRefreshed = Event.toPromise(Event.filter(first.onDidChangeState, state => state.workspaces[0].shellLayout === shellLayout));
		first.requestRefresh();
		await firstRefreshed;
		await timeout(0);

		const expected = {
			schemaVersion: 2,
			workspaces: [{ id: 'workspace', name: 'workspace', terminalIds: [], shellLayout, editorWorkingSet: 'editor-state' }],
		};
		assert.deepStrictEqual({ first: first.state, second: second.state }, { first: expected, second: expected });
	});

	test('keeps a later server write hidden until refresh', async () => {
		const channel = disposables.add(new TestRemoteLogicalWorkspaceChannel());
		const first = disposables.add(new RemoteLogicalWorkspaceStateClient('physical', channel, new NullLogService()));
		const second = disposables.add(new RemoteLogicalWorkspaceStateClient('physical', channel, new NullLogService()));
		await Promise.all([first.initialize(state('workspace')), second.initialize(state('workspace'))]);
		const redLayout: ILogicalWorkspaceShellLayout = {
			primarySideBar: { visible: true, width: 280, height: 800, activeCompositeId: 'red' },
			panel: { visible: false, width: 1200, height: 260, activeCompositeId: '' },
			auxiliaryBar: { visible: false, width: 300, height: 800, activeCompositeId: '' },
		};
		const blueLayout: ILogicalWorkspaceShellLayout = {
			...redLayout,
			primarySideBar: { ...redLayout.primarySideBar, activeCompositeId: 'blue' },
		};
		const delayedResponse = channel.delayNextMutationResponse();
		const firstCommitted = Event.toPromise(Event.filter(channel.onDidChange, event => event.snapshot.revision === 2));
		first.mutate({ type: LogicalWorkspaceMutationType.SetShellLayout, workspaceId: 'workspace', shellLayout: redLayout });
		await firstCommitted;
		const secondCommitted = Event.toPromise(Event.filter(channel.onDidChange, event => event.snapshot.revision === 3));
		second.mutate({ type: LogicalWorkspaceMutationType.SetShellLayout, workspaceId: 'workspace', shellLayout: blueLayout });
		await secondCommitted;
		await delayedResponse.complete();
		await timeout(0);

		assert.deepStrictEqual(first.state?.workspaces[0].shellLayout, redLayout);
		const refreshed = Event.toPromise(Event.filter(first.onDidChangeState, state => state.workspaces[0].shellLayout === blueLayout));
		first.requestRefresh();
		await refreshed;
		assert.deepStrictEqual(first.state?.workspaces[0].shellLayout, blueLayout);
	});

	test('does not replay a committed mutation after its response is lost', async () => {
		const channel = disposables.add(new TestRemoteLogicalWorkspaceChannel());
		const first = disposables.add(new RemoteLogicalWorkspaceStateClient('physical', channel, new NullLogService(), [0]));
		const second = disposables.add(new RemoteLogicalWorkspaceStateClient('physical', channel, new NullLogService(), [0]));
		await Promise.all([first.initialize(state('workspace')), second.initialize(state('workspace'))]);
		const redLayout: ILogicalWorkspaceShellLayout = {
			primarySideBar: { visible: true, width: 280, height: 800, activeCompositeId: 'red' },
			panel: { visible: false, width: 1200, height: 260, activeCompositeId: '' },
			auxiliaryBar: { visible: false, width: 300, height: 800, activeCompositeId: '' },
		};
		const blueLayout: ILogicalWorkspaceShellLayout = {
			...redLayout,
			primarySideBar: { ...redLayout.primarySideBar, activeCompositeId: 'blue' },
		};
		channel.dropNextMutationResult();
		const redCommitted = Event.toPromise(Event.filter(channel.onDidChange, event => event.snapshot.revision === 2));
		first.mutate({ type: LogicalWorkspaceMutationType.SetShellLayout, workspaceId: 'workspace', shellLayout: redLayout });
		await redCommitted;
		const blueCommitted = Event.toPromise(Event.filter(channel.onDidChange, event => event.snapshot.revision === 3));
		second.mutate({ type: LogicalWorkspaceMutationType.SetShellLayout, workspaceId: 'workspace', shellLayout: blueLayout });
		await blueCommitted;
		await timeout(0);

		assert.deepStrictEqual(channel.getSnapshot('physical'), {
			revision: 3,
			state: { schemaVersion: 2, workspaces: [{ id: 'workspace', name: 'workspace', terminalIds: [], shellLayout: blueLayout }] },
		});
	});
});

suite('LogicalWorkspaceService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let storageService: TestStorageService;
	let contextService: TestContextService;
	let stateStore: TestLogicalWorkspaceStateStore;
	let configurationService: TestConfigurationService;

	setup(() => {
		storageService = disposables.add(new TestStorageService());
		contextService = new TestContextService();
		stateStore = disposables.add(new TestLogicalWorkspaceStateStore());
		configurationService = new TestConfigurationService();
	});

	function createService(store = stateStore): LogicalWorkspaceService {
		return disposables.add(new LogicalWorkspaceService(storageService, contextService, store, configurationService));
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

	test('migrates the server workspace catalog and editor working set over an empty browser catalog', async () => {
		const browserWorkspace = {
			id: 'browser-only',
			name: 'Workspace',
			terminalIds: [],
			shellLayout: undefined,
		};
		const configuredWorkspace = {
			id: 'configured',
			name: 'Configured',
			terminalIds: [],
			shellLayout: undefined,
			editorWorkingSet: '{"main":{},"auxiliary":{}}',
		};
		stateStore.setSharedState({ schemaVersion: 2, workspaces: [browserWorkspace] });
		stateStore.writeActiveWorkspaceId(contextService.getWorkspace().id, browserWorkspace.id);
		configurationService = new TestConfigurationService({
			'dever.logicalWorkspaceState': { schemaVersion: 2, workspaces: [configuredWorkspace] },
		});

		const service = createService();
		await service.whenReady;

		assert.deepStrictEqual({
			activeWorkspaceId: service.activeWorkspace.id,
			workspaces: service.workspaces,
			migrationComplete: storageService.getBoolean('workbench.logicalWorkspace.configurationMigration.v1', StorageScope.WORKSPACE),
		}, {
			activeWorkspaceId: configuredWorkspace.id,
			workspaces: [configuredWorkspace, browserWorkspace],
			migrationComplete: true,
		});
	});

	test('waits for complete workspace configuration before initializing shared state', async () => {
		const deferredContextService = new DeferredWorkspaceContextService();
		contextService = deferredContextService;
		const configuredWorkspace = {
			id: 'configured-after-workspace-load',
			name: 'Configured',
			terminalIds: [],
			shellLayout: undefined,
			editorWorkingSet: '{"main":{},"auxiliary":{}}',
		};
		const service = createService();

		assert.deepStrictEqual({
			sharedStateWrites: stateStore.writeCount,
			migrationComplete: storageService.getBoolean('workbench.logicalWorkspace.configurationMigration.v1', StorageScope.WORKSPACE, false),
		}, {
			sharedStateWrites: 0,
			migrationComplete: false,
		});

		await configurationService.setUserConfiguration('dever.logicalWorkspaceState', { schemaVersion: 2, workspaces: [configuredWorkspace] });
		await deferredContextService.markWorkspaceComplete();
		await service.whenReady;

		assert.deepStrictEqual({
			activeWorkspace: service.activeWorkspace,
			sharedStateWrites: stateStore.writeCount,
			migrationComplete: storageService.getBoolean('workbench.logicalWorkspace.configurationMigration.v1', StorageScope.WORKSPACE, false),
		}, {
			activeWorkspace: configuredWorkspace,
			sharedStateWrites: 1,
			migrationComplete: true,
		});
	});

	test('ignores an object default when workspace state is not configured', () => {
		const sharedWorkspace = {
			id: 'shared',
			name: 'Shared',
			terminalIds: [],
			shellLayout: undefined,
		};
		stateStore.setSharedState({ schemaVersion: 2, workspaces: [sharedWorkspace] });
		configurationService = new TestConfigurationService({ 'dever.logicalWorkspaceState': {} });

		const service = createService();

		assert.deepStrictEqual({
			workspaces: service.workspaces,
			migrationComplete: storageService.getBoolean('workbench.logicalWorkspace.configurationMigration.v1', StorageScope.WORKSPACE, false),
		}, {
			workspaces: [sharedWorkspace],
			migrationComplete: false,
		});
	});

	test('backfills a missing editor working set when configuration and shared state have the same Workspace', () => {
		const sharedWorkspace = {
			id: 'shared',
			name: 'Current Name',
			terminalIds: [],
			shellLayout: undefined,
		};
		const configuredWorkspace = {
			...sharedWorkspace,
			name: 'Legacy Name',
			editorWorkingSet: '{"main":{"serializedGrid":{}},"auxiliary":{}}',
		};
		stateStore.setSharedState({ schemaVersion: 2, workspaces: [sharedWorkspace] });
		configurationService = new TestConfigurationService({
			'dever.logicalWorkspaceState': { schemaVersion: 2, workspaces: [configuredWorkspace] },
		});

		const service = createService();

		assert.deepStrictEqual(service.activeWorkspace, {
			...sharedWorkspace,
			editorWorkingSet: configuredWorkspace.editorWorkingSet,
		});
	});

	test('accepts authoritative external snapshots while preserving a valid page selection', () => {
		const service = createService();
		const activeWorkspace = service.createWorkspace('Active');
		service.activateWorkspace(activeWorkspace.id, LogicalWorkspaceActivationActor.Picker);
		const incomingWorkspace = {
			id: 'incoming',
			name: 'Incoming',
			terminalIds: [],
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
				workspaces: [{ id: 'invalid-layout', name: 'Invalid', terminalIds: [], shellLayout: null }],
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

	test('drops obsolete Chat Session ownership data from shared snapshots', () => {
		stateStore.setSharedState({
			schemaVersion: 2,
			workspaces: [{
				id: 'shared',
				name: 'Shared',
				terminalIds: [],
				chatSessionResources: ['test-session:obsolete-owner'],
				shellLayout: undefined,
			}],
		});

		const service = createService();
		const expectedWorkspace = {
			id: 'shared',
			name: 'Shared',
			terminalIds: [],
			shellLayout: undefined,
		};

		assert.deepStrictEqual({
			activeWorkspace: service.activeWorkspace,
			sharedState: stateStore.readSharedState(),
		}, {
			activeWorkspace: expectedWorkspace,
			sharedState: { schemaVersion: 2, workspaces: [expectedWorkspace] },
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

	test('same-target projection feedback queues a refresh without invalidating the active transaction', async () => {
		const firstStarted = new DeferredPromise<void>();
		const releaseFirst = new DeferredPromise<void>();
		const applied: string[] = [];
		let firstCurrentAfterAsyncBoundary: boolean | undefined;
		const coordinator = disposables.add(new AsyncProjectionCoordinator<string>('test', async context => {
			applied.push(context.value);
			if (applied.length === 1) {
				await firstStarted.complete();
				await releaseFirst.p;
				firstCurrentAfterAsyncBoundary = context.isCurrent();
			}
		}, new NullLogService(), (current, next) => current === next));

		const first = coordinator.request('workspace');
		await firstStarted.p;
		const refresh = coordinator.request('workspace');
		await releaseFirst.complete();
		await Promise.all([first, refresh]);

		assert.deepStrictEqual({ applied, firstCurrentAfterAsyncBoundary }, {
			applied: ['workspace', 'workspace'],
			firstCurrentAfterAsyncBoundary: true,
		});
	});
});
