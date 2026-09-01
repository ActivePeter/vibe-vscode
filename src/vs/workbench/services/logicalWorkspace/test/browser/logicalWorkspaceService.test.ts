/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { StorageScope, StorageTarget, WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';
import { WorkbenchState, Workspace } from '../../../../../platform/workspace/common/workspace.js';
import { TestContextService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { TestRemoteAgentService } from '../../../../test/browser/workbenchTestServices.js';
import { IRemoteAgentConnection } from '../../../remote/common/remoteAgentService.js';
import { AsyncProjectionCoordinator, ILogicalWorkspaceProjection, LogicalWorkspaceProjectionCoordinator } from '../../browser/logicalWorkspaceProjection.js';
import { LogicalWorkspaceService } from '../../browser/logicalWorkspaceService.js';
import { RemoteLogicalWorkspaceStateClient } from '../../browser/logicalWorkspaceRemoteStateClient.js';
import { ILogicalWorkspaceStateStore, LogicalWorkspaceStateStore } from '../../browser/logicalWorkspaceStateStore.js';
import { applyLogicalWorkspaceMutation, ILogicalWorkspaceMutation, ILogicalWorkspaceService, ILogicalWorkspaceSharedState, ILogicalWorkspaceShellLayout, ILogicalWorkspaceStateChangeEvent, ILogicalWorkspaceStateSnapshot, LogicalWorkspaceActivationActor, LogicalWorkspaceMutationType, LogicalWorkspaceStateChangeKind, parseLogicalWorkspaceMutation, parseLogicalWorkspaceSharedState } from '../../common/logicalWorkspace.js';
import { IRemoteLogicalWorkspaceStateResult, IRemoteLogicalWorkspaceStateSnapshot, RemoteLogicalWorkspaceStateCommand, RemoteLogicalWorkspaceStateErrorCode } from '../../common/logicalWorkspaceRemote.js';

class TestLogicalWorkspaceStateStore extends Disposable implements ILogicalWorkspaceStateStore {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSharedState = this._register(new Emitter<void>());
	readonly onDidChangeSharedState = this._onDidChangeSharedState.event;

	private sharedState: unknown;
	private readonly activeWorkspaceIds = new Map<string, string>();
	private initializeGate: DeferredPromise<ILogicalWorkspaceSharedState> | undefined;
	private sharedStateEmittedDuringInitialize: ILogicalWorkspaceSharedState | undefined;
	writeCount = 0;

	readSharedState(): unknown {
		return this.sharedState;
	}

	async initializeSharedState(state: ILogicalWorkspaceSharedState): Promise<ILogicalWorkspaceSharedState> {
		const initializedState = this.initializeGate ? await this.initializeGate.p : state;
		this.sharedState = initializedState;
		this.initializeGate = undefined;
		this.writeCount++;
		if (this.sharedStateEmittedDuringInitialize) {
			this.sharedState = this.sharedStateEmittedDuringInitialize;
			this._onDidChangeSharedState.fire();
		}
		return initializedState;
	}

	async createWorkspace(workspace: ILogicalWorkspaceSharedState['workspaces'][number]): Promise<void> {
		this.applyMutation({ type: LogicalWorkspaceMutationType.CreateWorkspace, workspace });
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

	delayInitialize(): DeferredPromise<ILogicalWorkspaceSharedState> {
		return this.initializeGate = new DeferredPromise<ILogicalWorkspaceSharedState>();
	}

	emitDuringInitialize(state: ILogicalWorkspaceSharedState): void {
		this.sharedStateEmittedDuringInitialize = state;
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
	private failNextMutationBeforeCommit = false;
	private initializationError: IRemoteLogicalWorkspaceStateResult<never> | undefined;
	initializationCalls = 0;
	mutationCalls = 0;

	delayNextMutationResponse(): DeferredPromise<void> {
		this.nextMutationResponseGate = new DeferredPromise<void>();
		return this.nextMutationResponseGate;
	}

	dropNextMutationResult(): void {
		this.dropNextMutationResponse = true;
	}

	failNextMutationRequest(): void {
		this.failNextMutationBeforeCommit = true;
	}

	failInitialization(): void {
		this.initializationError = this.error('The Logical Workspace state database is unavailable. No automatic recovery was attempted.', RemoteLogicalWorkspaceStateErrorCode.StorageUnavailable);
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
				this.initializationCalls++;
				if (this.initializationError) {
					return this.initializationError as T;
				}
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
				this.mutationCalls++;
				if (this.failNextMutationBeforeCommit) {
					this.failNextMutationBeforeCommit = false;
					throw new Error('Mutation request failed before commit');
				}
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

	private error(message: string, code = RemoteLogicalWorkspaceStateErrorCode.InvalidRequest): IRemoteLogicalWorkspaceStateResult<never> {
		return { status: 'error', code, message };
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

	test('does not retry a terminal database-open error', async () => {
		const channel = disposables.add(new TestRemoteLogicalWorkspaceChannel());
		channel.failInitialization();
		const client = disposables.add(new RemoteLogicalWorkspaceStateClient('physical', channel, new NullLogService(), [1]));

		await assert.rejects(client.initialize(state('workspace')), /No automatic recovery was attempted/);
		await timeout(10);

		assert.deepStrictEqual({ initializationCalls: channel.initializationCalls }, { initializationCalls: 1 });
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

	test('keeps a new Workspace hidden until its durable identity is confirmed', async () => {
		const channel = disposables.add(new TestRemoteLogicalWorkspaceChannel());
		const client = disposables.add(new RemoteLogicalWorkspaceStateClient('physical', channel, new NullLogService(), [0]));
		await client.initialize(state('existing'));
		channel.failNextMutationRequest();
		const workspace = { id: 'created', name: 'Created', terminalIds: [], shellLayout: undefined };
		let creationResolved = false;
		const creation = client.createWorkspace(workspace).then(() => creationResolved = true);

		assert.deepStrictEqual({ state: client.state, creationResolved }, {
			state: state('existing'),
			creationResolved: false,
		});

		await creation;
		assert.deepStrictEqual({ state: client.state, mutationCalls: channel.mutationCalls }, {
			state: { schemaVersion: 2, workspaces: [state('existing').workspaces[0], workspace] },
			mutationCalls: 2,
		});
	});

	test('confirms a committed creation from read after its response is lost', async () => {
		const channel = disposables.add(new TestRemoteLogicalWorkspaceChannel());
		const client = disposables.add(new RemoteLogicalWorkspaceStateClient('physical', channel, new NullLogService(), [0]));
		await client.initialize(state('existing'));
		channel.dropNextMutationResult();
		const workspace = { id: 'created', name: 'Created', terminalIds: [], shellLayout: undefined };

		await client.createWorkspace(workspace);

		assert.deepStrictEqual({ state: client.state, mutationCalls: channel.mutationCalls }, {
			state: { schemaVersion: 2, workspaces: [state('existing').workspaces[0], workspace] },
			mutationCalls: 1,
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

	test('announces activation before changing the active workspace', async () => {
		const service = createService();
		const previousWorkspaceId = service.activeWorkspace.id;
		const workspace = await service.createWorkspace('Review');
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

	test('persists shell layout including a part without an active composite', async () => {
		const service = createService();
		const workspace = await service.createWorkspace('Review');
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

	test('stores the active workspace in page state without rewriting shared snapshots', async () => {
		const service = createService();
		const workspace = await service.createWorkspace('Review');
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

	test('preserves a valid page selection until the authoritative catalog is ready', async () => {
		const physicalWorkspaceId = contextService.getWorkspace().id;
		const selectedWorkspaceId = 'workspace-b';
		stateStore.writeActiveWorkspaceId(physicalWorkspaceId, selectedWorkspaceId);
		const initialize = stateStore.delayInitialize();
		stateStore.emitDuringInitialize({
			schemaVersion: 2,
			workspaces: [
				{ id: 'workspace-a', name: 'A', terminalIds: [], shellLayout: undefined },
				{ id: selectedWorkspaceId, name: 'B', terminalIds: [], shellLayout: undefined },
			],
		});
		const service = createService();

		assert.deepStrictEqual({
			isReady: service.isReady,
			storedActiveWorkspaceId: stateStore.readActiveWorkspaceId(physicalWorkspaceId),
		}, {
			isReady: false,
			storedActiveWorkspaceId: selectedWorkspaceId,
		});

		await initialize.complete({
			schemaVersion: 2,
			workspaces: [{ id: 'workspace-a', name: 'A', terminalIds: [], shellLayout: undefined }],
		});
		await service.whenReady;

		assert.deepStrictEqual({
			isReady: service.isReady,
			activeWorkspaceId: service.activeWorkspace.id,
			storedActiveWorkspaceId: stateStore.readActiveWorkspaceId(physicalWorkspaceId),
		}, {
			isReady: true,
			activeWorkspaceId: selectedWorkspaceId,
			storedActiveWorkspaceId: selectedWorkspaceId,
		});
	});

	/*
	 * Initialization selection precedence:
	 *
	 * | Candidate source        | Candidate | Page selection | Authoritative catalog | Result |
	 * | stale catalog fallback  | A         | B              | A, B                  | B      |
	 * | stale catalog fallback  | A         | missing        | A, B                  | A      |
	 * | generated fallback      | P         | B              | A, B                  | B      |
	 * | configuration migration | C         | A              | C, A                  | C      |
	 * | legacy selection        | B         | missing        | A, B                  | B      |
	 *
	 * The page selection is the authority. A provisional fallback is considered only when that
	 * selection is absent from the authoritative catalog.
	 */
	test('does not replace a valid page selection with a provisional catalog fallback', async () => {
		const physicalWorkspaceId = contextService.getWorkspace().id;
		const firstWorkspace = { id: 'workspace-a', name: 'A', terminalIds: [], shellLayout: undefined };
		const selectedWorkspace = { id: 'workspace-b', name: 'B', terminalIds: [], shellLayout: undefined };
		stateStore.setSharedState({ schemaVersion: 2, workspaces: [firstWorkspace] });
		stateStore.writeActiveWorkspaceId(physicalWorkspaceId, selectedWorkspace.id);
		const initialize = stateStore.delayInitialize();
		const service = createService();

		await initialize.complete({ schemaVersion: 2, workspaces: [firstWorkspace, selectedWorkspace] });
		await service.whenReady;

		assert.deepStrictEqual({
			activeWorkspaceId: service.activeWorkspace.id,
			storedActiveWorkspaceId: stateStore.readActiveWorkspaceId(physicalWorkspaceId),
		}, {
			activeWorkspaceId: selectedWorkspace.id,
			storedActiveWorkspaceId: selectedWorkspace.id,
		});
	});

	test('preserves a valid legacy selection after the authoritative catalog is ready', async () => {
		const firstWorkspace = { id: 'workspace-a', name: 'A', terminalIds: [], shellLayout: undefined };
		const selectedWorkspace = { id: 'workspace-b', name: 'B', terminalIds: [], shellLayout: undefined };
		storageService.store('workbench.logicalWorkspace.state.v1', JSON.stringify({
			schemaVersion: 1,
			activeWorkspaceId: selectedWorkspace.id,
			workspaces: [firstWorkspace, selectedWorkspace],
		}), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const initialize = stateStore.delayInitialize();
		const service = createService();

		await initialize.complete({ schemaVersion: 2, workspaces: [firstWorkspace, selectedWorkspace] });
		await service.whenReady;

		assert.deepStrictEqual({
			activeWorkspaceId: service.activeWorkspace.id,
			storedActiveWorkspaceId: stateStore.readActiveWorkspaceId(contextService.getWorkspace().id),
		}, {
			activeWorkspaceId: selectedWorkspace.id,
			storedActiveWorkspaceId: selectedWorkspace.id,
		});
	});

	test('production remote store preserves page selection across reentrant initialization events', async () => {
		const physicalWorkspaceId = 'production-remote-initialization';
		const selectedWorkspaceId = 'workspace-b';
		const authoritativeState: ILogicalWorkspaceSharedState = {
			schemaVersion: 2,
			workspaces: [
				{ id: 'workspace-a', name: 'A', terminalIds: [], shellLayout: undefined },
				{ id: selectedWorkspaceId, name: 'B', terminalIds: [], shellLayout: undefined },
			],
		};
		const channel = disposables.add(new TestRemoteLogicalWorkspaceChannel());
		await channel.call(RemoteLogicalWorkspaceStateCommand.Initialize, { physicalWorkspaceId, state: authoritativeState });
		const connection = {
			remoteAuthority: 'test-remote',
			onReconnecting: Event.None,
			onDidStateChange: Event.None,
			getChannel: () => channel,
		} as unknown as IRemoteAgentConnection;
		const remoteAgentService = new class extends TestRemoteAgentService {
			override getConnection(): IRemoteAgentConnection { return connection; }
		};
		const productionContext = new TestContextService(new Workspace(physicalWorkspaceId, [], false, null, () => false, 'Physical'));
		const productionStorage = disposables.add(new TestStorageService());
		const productionStore = disposables.add(new LogicalWorkspaceStateStore(productionStorage, productionContext, remoteAgentService, new NullLogService()));
		productionStore.writeActiveWorkspaceId(physicalWorkspaceId, selectedWorkspaceId);
		const service = disposables.add(new LogicalWorkspaceService(productionStorage, productionContext, productionStore, new TestConfigurationService()));

		await service.whenReady;

		assert.deepStrictEqual({
			activeWorkspaceId: service.activeWorkspace.id,
			storedActiveWorkspaceId: productionStore.readActiveWorkspaceId(physicalWorkspaceId),
			workspaces: service.workspaces,
		}, {
			activeWorkspaceId: selectedWorkspaceId,
			storedActiveWorkspaceId: selectedWorkspaceId,
			workspaces: authoritativeState.workspaces,
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

	test('accepts authoritative external snapshots while preserving a valid page selection', async () => {
		const service = createService();
		const activeWorkspace = await service.createWorkspace('Active');
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

	test('falls back with ordered activation events when an external snapshot removes the active workspace', async () => {
		const service = createService();
		const fallbackWorkspace = service.activeWorkspace;
		const removedWorkspace = await service.createWorkspace('Removed');
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

		const nextWorkspace = await service.createWorkspace('Next');
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

	test('initial projection readiness waits for the real UI commit', async () => {
		const service = createService();
		const restoreStarted = new DeferredPromise<void>();
		const releaseRestore = new DeferredPromise<void>();
		let ready = false;
		const projection: ILogicalWorkspaceProjection = {
			id: 'initialProjectionReadiness',
			restore: async context => {
				await restoreStarted.complete();
				await releaseRestore.p;
				assert.strictEqual(context.isCurrent(), true);
			},
		};
		const coordinator = disposables.add(new LogicalWorkspaceProjectionCoordinator(service, projection, storageService, new NullLogService()));
		void coordinator.whenReady.then(() => ready = true);

		await restoreStarted.p;
		assert.strictEqual(ready, false);
		await releaseRestore.complete();
		await coordinator.whenReady;
		assert.strictEqual(ready, true);
	});

	test('initial projection readiness rejects when its same-target feedback tail fails', async () => {
		const service = createService();
		await service.whenReady;
		const workspaceId = service.activeWorkspace.id;
		const expectedError = new Error('feedback projection failed');
		let restoreCount = 0;
		const projection: ILogicalWorkspaceProjection = {
			id: 'failedInitialFeedback',
			stateSlice: state => state.workspaces.find(workspace => workspace.id === state.activeWorkspaceId)?.editorWorkingSet,
			restore: async () => {
				restoreCount++;
				if (restoreCount === 1) {
					service.setEditorWorkingSet(workspaceId, 'updated');
					return;
				}
				throw expectedError;
			},
		};
		const coordinator = disposables.add(new LogicalWorkspaceProjectionCoordinator(service, projection, storageService, new NullLogService()));

		await assert.rejects(coordinator.whenReady, error => error === expectedError);
		assert.strictEqual(restoreCount, 2);
	});

	test('initial projection readiness recovers when newer queued work succeeds', async () => {
		const service = createService();
		await service.whenReady;
		const workspaceId = service.activeWorkspace.id;
		const firstRestoreStarted = new DeferredPromise<void>();
		const releaseFirstRestore = new DeferredPromise<void>();
		let restoreCount = 0;
		const projection: ILogicalWorkspaceProjection = {
			id: 'recoveredInitialProjection',
			stateSlice: state => state.workspaces.find(workspace => workspace.id === state.activeWorkspaceId)?.editorWorkingSet,
			restore: async () => {
				if (++restoreCount === 1) {
					await firstRestoreStarted.complete();
					await releaseFirstRestore.p;
					throw new Error('obsolete projection failed');
				}
			},
		};
		const coordinator = disposables.add(new LogicalWorkspaceProjectionCoordinator(service, projection, storageService, new NullLogService()));
		await firstRestoreStarted.p;
		service.setEditorWorkingSet(workspaceId, 'updated');
		await releaseFirstRestore.complete();

		await coordinator.whenReady;
		assert.strictEqual(restoreCount, 2);
	});

	test('projection coordinator observes initial and event-driven readiness failures', async () => {
		const readiness = new DeferredPromise<void>();
		const stateChanges = disposables.add(new Emitter<ILogicalWorkspaceStateChangeEvent>());
		let state: ILogicalWorkspaceStateSnapshot = {
			activeWorkspaceId: 'workspace-a',
			workspaces: [{ id: 'workspace-a', name: 'A', terminalIds: [], shellLayout: undefined }],
		};
		const service = new class extends mock<ILogicalWorkspaceService>() {
			override readonly onWillChangeActiveWorkspace = Event.None;
			override readonly onDidChangeState = stateChanges.event;
			override get state(): ILogicalWorkspaceStateSnapshot { return state; }
			override get activeWorkspace() { return state.workspaces[0]; }
			override get activationSequence(): number { return 0; }
			override readonly whenReady = readiness.p;
		}();
		const errors: string[] = [];
		const logService = new class extends NullLogService {
			override error(message: string | Error, ...args: unknown[]): void {
				errors.push([message, ...args].map(value => value instanceof Error ? value.message : String(value)).join(': '));
			}
		}();
		const coordinator = disposables.add(new LogicalWorkspaceProjectionCoordinator(service, {
			id: 'failedReadiness',
			stateSlice: snapshot => snapshot.workspaces[0].editorWorkingSet,
			restore: async () => { },
		}, storageService, logService));
		const expectedError = new Error('Workspace authority failed');
		const initialFailure = assert.rejects(coordinator.whenReady, error => error === expectedError);
		const previousState = state;
		state = {
			...state,
			workspaces: [{ ...state.workspaces[0], editorWorkingSet: 'updated' }],
		};
		stateChanges.fire({ changed: LogicalWorkspaceStateChangeKind.Workspaces, previousState, state });

		await readiness.error(expectedError);
		await initialFailure;
		await timeout(0);

		assert.deepStrictEqual(errors.sort(), [
			'failedReadiness initial projection failed: Workspace authority failed',
			'failedReadiness projection reconciliation failed: Workspace authority failed',
		]);
	});

	test('capture acknowledges locally-authored state without restoring the live UI', async () => {
		const service = createService();
		await service.whenReady;
		const activeWorkspaceId = service.activeWorkspace.id;
		const restored: Array<string | undefined> = [];
		const projection: ILogicalWorkspaceProjection = {
			id: 'localCaptureFeedback',
			stateSlice: state => state.workspaces.find(workspace => workspace.id === state.activeWorkspaceId)?.editorWorkingSet,
			capture: workspaceId => service.setEditorWorkingSet(workspaceId, 'captured'),
			restore: async context => { restored.push(context.workspace.editorWorkingSet); },
		};
		const coordinator = disposables.add(new LogicalWorkspaceProjectionCoordinator(service, projection, storageService, new NullLogService()));
		await coordinator.whenReady;

		coordinator.captureProjectedState(activeWorkspaceId);
		await timeout(0);

		assert.deepStrictEqual({
			restored,
			editorWorkingSet: service.activeWorkspace.editorWorkingSet,
		}, {
			restored: [undefined],
			editorWorkingSet: 'captured',
		});
	});

	test('same active Workspace content refresh converges before a later capture', async () => {
		const service = createService();
		await service.whenReady;
		const activeWorkspaceId = service.activeWorkspace.id;
		const nextWorkspace = await service.createWorkspace('Next');
		service.setEditorWorkingSet(activeWorkspaceId, 'v1');
		const firstRestoreStarted = new DeferredPromise<void>();
		const releaseFirstRestore = new DeferredPromise<void>();
		const secondRestoreStarted = new DeferredPromise<void>();
		const releaseSecondRestore = new DeferredPromise<void>();
		const secondRestoreApplied = new DeferredPromise<void>();
		const nextWorkspaceRestored = new DeferredPromise<void>();
		const restored: Array<string | undefined> = [];
		const captured: Array<string | undefined> = [];
		let projectedEditorState: string | undefined;
		const projection: ILogicalWorkspaceProjection = {
			id: 'sameTargetContentProjection',
			capture: () => captured.push(projectedEditorState),
			restore: async context => {
				const editorState = context.workspace.editorWorkingSet;
				restored.push(editorState);
				if (editorState === 'v1') {
					await firstRestoreStarted.complete();
					await releaseFirstRestore.p;
				}
				if (editorState === 'v2') {
					await secondRestoreStarted.complete();
					await releaseSecondRestore.p;
				}
				if (!context.isCurrent()) {
					return;
				}
				projectedEditorState = editorState;
				if (editorState === 'v2') {
					await secondRestoreApplied.complete();
				}
				if (context.workspace.id === nextWorkspace.id) {
					await nextWorkspaceRestored.complete();
				}
			},
		};
		const coordinator = disposables.add(new LogicalWorkspaceProjectionCoordinator(service, projection, storageService, new NullLogService()));
		let initialProjectionReady = false;
		void coordinator.whenReady.then(() => initialProjectionReady = true);
		await firstRestoreStarted.p;

		stateStore.setSharedState({
			schemaVersion: 2,
			workspaces: service.workspaces.map(workspace => workspace.id === activeWorkspaceId ? { ...workspace, editorWorkingSet: 'v2' } : workspace),
		});
		await releaseFirstRestore.complete();
		await secondRestoreStarted.p;
		assert.strictEqual(initialProjectionReady, false);
		await releaseSecondRestore.complete();
		await secondRestoreApplied.p;
		await coordinator.whenReady;

		service.activateWorkspace(nextWorkspace.id, LogicalWorkspaceActivationActor.Picker);
		await nextWorkspaceRestored.p;

		assert.deepStrictEqual({ restored, captured }, {
			restored: ['v1', 'v2', undefined],
			captured: ['v2'],
		});
	});

	test('does not capture an obsolete projection while newer same-Workspace content is pending', async () => {
		const service = createService();
		await service.whenReady;
		const activeWorkspaceId = service.activeWorkspace.id;
		const nextWorkspace = await service.createWorkspace('Next');
		service.setEditorWorkingSet(activeWorkspaceId, 'v1');
		const v2RestoreStarted = new DeferredPromise<void>();
		const releaseV2Restore = new DeferredPromise<void>();
		const nextWorkspaceRestored = new DeferredPromise<void>();
		const captured: Array<{ readonly workspaceId: string; readonly editorWorkingSet: string | undefined }> = [];
		let projectedEditorWorkingSet: string | undefined;
		const projection: ILogicalWorkspaceProjection = {
			id: 'pendingSameTargetContentProjection',
			stateSlice: state => state.workspaces.find(workspace => workspace.id === state.activeWorkspaceId)?.editorWorkingSet,
			capture: workspaceId => {
				captured.push({ workspaceId, editorWorkingSet: projectedEditorWorkingSet });
				service.setEditorWorkingSet(workspaceId, projectedEditorWorkingSet ?? '');
			},
			restore: async context => {
				if (context.workspace.editorWorkingSet === 'v2') {
					await v2RestoreStarted.complete();
					await releaseV2Restore.p;
				}
				if (!context.isCurrent()) {
					return;
				}
				projectedEditorWorkingSet = context.workspace.editorWorkingSet;
				if (context.workspace.id === nextWorkspace.id) {
					await nextWorkspaceRestored.complete();
				}
			},
		};
		const coordinator = disposables.add(new LogicalWorkspaceProjectionCoordinator(service, projection, storageService, new NullLogService()));
		await coordinator.whenReady;

		stateStore.setSharedState({
			schemaVersion: 2,
			workspaces: service.workspaces.map(workspace => workspace.id === activeWorkspaceId ? { ...workspace, editorWorkingSet: 'v2' } : workspace),
		});
		await v2RestoreStarted.p;
		storageService.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);
		service.activateWorkspace(nextWorkspace.id, LogicalWorkspaceActivationActor.Picker);
		await releaseV2Restore.complete();
		await nextWorkspaceRestored.p;

		assert.deepStrictEqual({
			captured,
			authoritativeEditorWorkingSet: service.workspaces.find(workspace => workspace.id === activeWorkspaceId)?.editorWorkingSet,
			projectedEditorWorkingSet,
		}, {
			captured: [],
			authoritativeEditorWorkingSet: 'v2',
			projectedEditorWorkingSet: undefined,
		});
	});

	test('does not capture a state slice whose restore was rejected', async () => {
		const service = createService();
		await service.whenReady;
		const activeWorkspaceId = service.activeWorkspace.id;
		const nextWorkspace = await service.createWorkspace('Next');
		service.setEditorWorkingSet(activeWorkspaceId, 'v1');
		let projectedEditorWorkingSet: string | undefined;
		const captured: string[] = [];
		const projection: ILogicalWorkspaceProjection = {
			id: 'rejectedStateSliceProjection',
			stateSlice: state => state.workspaces.find(workspace => workspace.id === state.activeWorkspaceId)?.editorWorkingSet,
			capture: workspaceId => {
				captured.push(workspaceId);
				service.setEditorWorkingSet(workspaceId, projectedEditorWorkingSet ?? '');
			},
			restore: async context => {
				if (context.workspace.editorWorkingSet === 'v2') {
					return false;
				}
				projectedEditorWorkingSet = context.workspace.editorWorkingSet;
				return true;
			},
		};
		const coordinator = disposables.add(new LogicalWorkspaceProjectionCoordinator(service, projection, storageService, new NullLogService()));
		await coordinator.whenReady;

		stateStore.setSharedState({
			schemaVersion: 2,
			workspaces: service.workspaces.map(workspace => workspace.id === activeWorkspaceId ? { ...workspace, editorWorkingSet: 'v2' } : workspace),
		});
		await coordinator.requestReconcile();
		coordinator.captureProjectedState(activeWorkspaceId);
		storageService.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);
		service.activateWorkspace(nextWorkspace.id, LogicalWorkspaceActivationActor.Picker);

		assert.deepStrictEqual({
			captured,
			projectedEditorWorkingSet,
			authoritativeEditorWorkingSet: service.workspaces.find(workspace => workspace.id === activeWorkspaceId)?.editorWorkingSet,
		}, {
			captured: [],
			projectedEditorWorkingSet: 'v1',
			authoritativeEditorWorkingSet: 'v2',
		});
	});

	test('async projection resolves coalesced callers only after the newest projection', async () => {
		const firstStarted = new DeferredPromise<void>();
		const releaseFirst = new DeferredPromise<void>();
		const applied: string[] = [];
		const coordinator = disposables.add(new AsyncProjectionCoordinator<string>(async context => {
			applied.push(context.value);
			if (context.value === 'first') {
				await firstStarted.complete();
				await releaseFirst.p;
			}
		}));

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

	test('async projection rejects a failed request and continues with newer work', async () => {
		const firstStarted = new DeferredPromise<void>();
		const releaseFirst = new DeferredPromise<void>();
		const expectedError = new Error('projection failed');
		const applied: string[] = [];
		const coordinator = disposables.add(new AsyncProjectionCoordinator<string>(async context => {
			applied.push(context.value);
			if (context.value === 'first') {
				await firstStarted.complete();
				await releaseFirst.p;
				throw expectedError;
			}
		}));

		const first = assert.rejects(coordinator.request('first'), error => error === expectedError);
		await firstStarted.p;
		const second = coordinator.request('second');
		await releaseFirst.complete();
		await Promise.all([first, second]);

		assert.deepStrictEqual(applied, ['first', 'second']);
	});

	test('same-target projection feedback queues a refresh without invalidating the active transaction', async () => {
		const firstStarted = new DeferredPromise<void>();
		const releaseFirst = new DeferredPromise<void>();
		const applied: string[] = [];
		let firstCurrentAfterAsyncBoundary: boolean | undefined;
		const coordinator = disposables.add(new AsyncProjectionCoordinator<string>(async context => {
			applied.push(context.value);
			if (applied.length === 1) {
				await firstStarted.complete();
				await releaseFirst.p;
				firstCurrentAfterAsyncBoundary = context.isCurrent();
			}
		}, (current, next) => current === next));

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

	test('synchronous projection feedback cannot start a concurrent runner', async () => {
		const releaseFirst = new DeferredPromise<void>();
		const firstStarted = new DeferredPromise<void>();
		const applied: string[] = [];
		let activeApplyCount = 0;
		let maximumActiveApplyCount = 0;
		const coordinator = disposables.add(new AsyncProjectionCoordinator<string>(async context => {
			activeApplyCount++;
			maximumActiveApplyCount = Math.max(maximumActiveApplyCount, activeApplyCount);
			applied.push(context.value);
			if (applied.length === 1) {
				void coordinator.request('workspace');
				await firstStarted.complete();
				await releaseFirst.p;
			}
			activeApplyCount--;
		}, (current, next) => current === next));

		const first = coordinator.request('workspace');
		await firstStarted.p;
		assert.strictEqual(maximumActiveApplyCount, 1);
		await releaseFirst.complete();
		await first;
		await coordinator.whenIdle();

		assert.deepStrictEqual({ applied, maximumActiveApplyCount }, {
			applied: ['workspace', 'workspace'],
			maximumActiveApplyCount: 1,
		});
	});
});
