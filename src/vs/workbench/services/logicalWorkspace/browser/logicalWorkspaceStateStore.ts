/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { equals } from '../../../../base/common/objects.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { PersistentConnectionEventType } from '../../../../platform/remote/common/remoteAgentConnection.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IRemoteAgentService } from '../../remote/common/remoteAgentService.js';
import { applyLogicalWorkspaceMutation, ILogicalWorkspace, ILogicalWorkspaceMutation, ILogicalWorkspaceSharedState, ILogicalWorkspaceViewMutation, LogicalWorkspaceMutationType, parseLogicalWorkspaceSharedState } from '../common/logicalWorkspace.js';
import { REMOTE_LOGICAL_WORKSPACE_STATE_CHANNEL_NAME } from '../common/logicalWorkspaceRemote.js';
import { RemoteLogicalWorkspaceStateClient } from './logicalWorkspaceRemoteStateClient.js';

export const LOGICAL_WORKSPACE_SHARED_STATE_KEY = 'workbench.logicalWorkspace.sharedState.v2';
const LOGICAL_WORKSPACE_ACTIVE_SESSION_KEY = 'vibe.logicalWorkspace.activeWorkspaceId';
const LEGACY_LOGICAL_WORKSPACE_ACTIVE_SESSION_KEY = 'workbench.logicalWorkspace.activeWorkspace.v1:';

export const ILogicalWorkspaceStateStore = createDecorator<ILogicalWorkspaceStateStore>('logicalWorkspaceStateStore');

/**
 * Keeps shared Logical Workspace state behind one authoritative backend while the current
 * Workspace selection remains local to each browser page.
 */
export interface ILogicalWorkspaceStateStore {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSharedState: Event<void>;

	readSharedState(): unknown;
	initializeSharedState(state: ILogicalWorkspaceSharedState): Promise<ILogicalWorkspaceSharedState>;
	createWorkspace(workspace: ILogicalWorkspace): Promise<void>;
	applyMutation(mutation: ILogicalWorkspaceViewMutation): void;
	readActiveWorkspaceId(physicalWorkspaceId: string): string | undefined;
	writeActiveWorkspaceId(physicalWorkspaceId: string, workspaceId: string): void;
}

export class LogicalWorkspaceStateStore extends Disposable implements ILogicalWorkspaceStateStore {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSharedState = this._register(new Emitter<void>());
	readonly onDidChangeSharedState = this._onDidChangeSharedState.event;

	private readonly fallbackSessionState = new Map<string, string>();
	private readonly physicalWorkspaceId: string;
	private readonly remoteClient: RemoteLogicalWorkspaceStateClient | undefined;
	private readonly localPendingMutations: ILogicalWorkspaceMutation[] = [];
	private sharedState: unknown;
	private localInitialized = false;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
		@ILogService logService: ILogService,
	) {
		super();
		this.physicalWorkspaceId = workspaceContextService.getWorkspace().id;
		this.sharedState = this.readLegacyBrowserState();

		const connection = remoteAgentService.getConnection();
		if (connection) {
			this.remoteClient = this._register(new RemoteLogicalWorkspaceStateClient(
				this.physicalWorkspaceId,
				connection.getChannel(REMOTE_LOGICAL_WORKSPACE_STATE_CHANNEL_NAME),
				logService,
			));
			this._register(this.remoteClient.onDidChangeState(state => this.acceptSharedState(state)));
			this._register(connection.onDidStateChange(event => {
				if (event.type === PersistentConnectionEventType.ConnectionGain) {
					this.remoteClient?.requestRefresh();
				}
			}));
		}
	}

	readSharedState(): unknown {
		return this.sharedState;
	}

	async initializeSharedState(state: ILogicalWorkspaceSharedState): Promise<ILogicalWorkspaceSharedState> {
		if (this.remoteClient) {
			await this.remoteClient.initialize(state);
			const remoteState = this.remoteClient.state;
			if (!remoteState) {
				throw new Error('The remote Logical Workspace state did not initialize');
			}
			this.acceptSharedState(remoteState);
			this.storageService.remove(LOGICAL_WORKSPACE_SHARED_STATE_KEY, StorageScope.WORKSPACE);
			return remoteState;
		}

		let localState = parseLogicalWorkspaceSharedState(this.sharedState) ?? state;
		for (const mutation of this.localPendingMutations) {
			localState = applyLogicalWorkspaceMutation(localState, mutation);
		}
		this.localPendingMutations.length = 0;
		this.localInitialized = true;
		this.sharedState = localState;
		this.persistLocalState(localState);
		return localState;
	}

	async createWorkspace(workspace: ILogicalWorkspace): Promise<void> {
		if (this.remoteClient) {
			await this.remoteClient.createWorkspace(workspace);
			const state = this.remoteClient.state;
			if (!state?.workspaces.some(candidate => candidate.id === workspace.id)) {
				throw new Error(`The remote Logical Workspace '${workspace.id}' was not confirmed`);
			}
			this.acceptSharedState(state);
			return;
		}

		const state = parseLogicalWorkspaceSharedState(this.sharedState);
		if (!this.localInitialized || !state) {
			throw new Error('The local Logical Workspace state is not initialized');
		}
		const next = applyLogicalWorkspaceMutation(state, { type: LogicalWorkspaceMutationType.CreateWorkspace, workspace });
		if (next === state) {
			return;
		}
		this.persistLocalState(next);
		this.acceptSharedState(next);
	}

	applyMutation(mutation: ILogicalWorkspaceViewMutation): void {
		if (this.remoteClient) {
			this.remoteClient.mutate(mutation);
			const projectedState = this.remoteClient.state;
			if (projectedState) {
				this.sharedState = projectedState;
			}
			return;
		}

		const state = parseLogicalWorkspaceSharedState(this.sharedState);
		if (!this.localInitialized || !state) {
			this.localPendingMutations.push(mutation);
			return;
		}
		const next = applyLogicalWorkspaceMutation(state, mutation);
		if (next === state) {
			return;
		}
		this.sharedState = next;
		this.persistLocalState(next);
	}

	readActiveWorkspaceId(physicalWorkspaceId: string): string | undefined {
		const key = this.activeWorkspaceKey(physicalWorkspaceId);
		try {
			return mainWindow.sessionStorage.getItem(this.legacyActiveWorkspaceKey(physicalWorkspaceId))
				?? mainWindow.sessionStorage.getItem(key)
				?? this.fallbackSessionState.get(key);
		} catch {
			return this.fallbackSessionState.get(key);
		}
	}

	writeActiveWorkspaceId(physicalWorkspaceId: string, workspaceId: string): void {
		const key = this.activeWorkspaceKey(physicalWorkspaceId);
		this.fallbackSessionState.set(key, workspaceId);
		try {
			mainWindow.sessionStorage.setItem(key, workspaceId);
			mainWindow.sessionStorage.removeItem(this.legacyActiveWorkspaceKey(physicalWorkspaceId));
		} catch {
			// The in-memory fallback keeps this page coherent when browser storage is unavailable.
		}
	}

	private acceptSharedState(state: ILogicalWorkspaceSharedState): void {
		if (equals(this.sharedState, state)) {
			return;
		}
		this.sharedState = state;
		this._onDidChangeSharedState.fire();
	}

	private persistLocalState(state: ILogicalWorkspaceSharedState): void {
		this.storageService.store(LOGICAL_WORKSPACE_SHARED_STATE_KEY, JSON.stringify(state), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private readLegacyBrowserState(): unknown {
		const raw = this.storageService.get(LOGICAL_WORKSPACE_SHARED_STATE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return undefined;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).storageVersion === 1) {
				return (parsed as Record<string, unknown>).state;
			}
			return parsed;
		} catch {
			return undefined;
		}
	}

	private activeWorkspaceKey(physicalWorkspaceId: string): string {
		return `${LOGICAL_WORKSPACE_ACTIVE_SESSION_KEY}.${physicalWorkspaceId}`;
	}

	private legacyActiveWorkspaceKey(physicalWorkspaceId: string): string {
		return `${LEGACY_LOGICAL_WORKSPACE_ACTIVE_SESSION_KEY}${physicalWorkspaceId}`;
	}
}

registerSingleton(ILogicalWorkspaceStateStore, LogicalWorkspaceStateStore, InstantiationType.Delayed);
