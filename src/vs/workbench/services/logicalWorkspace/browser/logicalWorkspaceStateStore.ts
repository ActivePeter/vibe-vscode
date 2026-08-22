/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BroadcastDataChannel } from '../../../../base/browser/broadcast.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

export const LOGICAL_WORKSPACE_SHARED_STATE_KEY = 'workbench.logicalWorkspace.sharedState.v2';
const LOGICAL_WORKSPACE_ACTIVE_SESSION_KEY = 'vibe.logicalWorkspace.activeWorkspaceId';
const LOGICAL_WORKSPACE_SHARED_STATE_CHANNEL = 'vibe.logicalWorkspace.sharedState';

const enum LogicalWorkspaceSharedStateMessageType {
	Request = 'request',
	State = 'state',
}

const enum LogicalWorkspaceRevisionResult {
	Accepted = 'accepted',
	Equal = 'equal',
	Older = 'older',
}

interface ILogicalWorkspaceSharedStateRequest {
	readonly type: LogicalWorkspaceSharedStateMessageType.Request;
	readonly physicalWorkspaceId: string;
	readonly sourceId: string;
}

interface ILogicalWorkspaceSharedStateBroadcast {
	readonly type: LogicalWorkspaceSharedStateMessageType.State;
	readonly physicalWorkspaceId: string;
	readonly sourceId: string;
	readonly targetSourceId?: string;
	readonly storedState: IStoredLogicalWorkspaceSharedState;
}

type LogicalWorkspaceSharedStateMessage = ILogicalWorkspaceSharedStateRequest | ILogicalWorkspaceSharedStateBroadcast;

interface ILogicalWorkspaceStateRevision {
	readonly counter: number;
	readonly source: string;
}

interface IStoredLogicalWorkspaceSharedState {
	readonly storageVersion: 1;
	readonly revision: ILogicalWorkspaceStateRevision;
	readonly state: object;
}

export const ILogicalWorkspaceStateStore = createDecorator<ILogicalWorkspaceStateStore>('logicalWorkspaceStateStore');

/**
 * Separates shared Workspace state from the current page's active Workspace selection.
 */
export interface ILogicalWorkspaceStateStore {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSharedState: Event<void>;

	readSharedState(): unknown;
	writeSharedState(state: object): void;
	readActiveWorkspaceId(physicalWorkspaceId: string): string | undefined;
	writeActiveWorkspaceId(physicalWorkspaceId: string, workspaceId: string): void;
}

export class LogicalWorkspaceStateStore extends Disposable implements ILogicalWorkspaceStateStore {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSharedState = this._register(new Emitter<void>());
	readonly onDidChangeSharedState = this._onDidChangeSharedState.event;

	private readonly fallbackSessionState = new Map<string, string>();
	private readonly physicalWorkspaceId: string;
	private readonly sourceId = generateUuid();
	private readonly sharedStateChannel: BroadcastDataChannel<unknown>;
	private sharedState: unknown;
	private revision: ILogicalWorkspaceStateRevision | undefined;
	private revisionCounter = 0;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this.physicalWorkspaceId = workspaceContextService.getWorkspace().id;
		const storedState = this.parseStoredState(storageService.get(LOGICAL_WORKSPACE_SHARED_STATE_KEY, StorageScope.WORKSPACE));
		this.sharedState = storedState?.state;
		this.revision = storedState?.revision;
		this.revisionCounter = storedState?.revision?.counter ?? 0;
		this.sharedStateChannel = this._register(new BroadcastDataChannel<unknown>(`${LOGICAL_WORKSPACE_SHARED_STATE_CHANNEL}.${this.physicalWorkspaceId}`));
		this._register(storageService.onDidChangeValue(StorageScope.WORKSPACE, LOGICAL_WORKSPACE_SHARED_STATE_KEY, this._store)(() => this.acceptStorageState()));
		this._register(this.sharedStateChannel.onDidReceiveData(data => this.acceptBroadcastMessage(data)));
		this.postSharedStateMessage({
			type: LogicalWorkspaceSharedStateMessageType.Request,
			physicalWorkspaceId: this.physicalWorkspaceId,
			sourceId: this.sourceId,
		});
	}

	readSharedState(): unknown {
		return this.sharedState;
	}

	writeSharedState(state: object): void {
		const revision = { counter: ++this.revisionCounter, source: this.sourceId };
		const storedState: IStoredLogicalWorkspaceSharedState = { storageVersion: 1, revision, state };
		this.sharedState = state;
		this.revision = revision;
		this.storageService.store(LOGICAL_WORKSPACE_SHARED_STATE_KEY, JSON.stringify(storedState), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.broadcastSharedState(storedState);
	}

	private postSharedStateMessage(message: LogicalWorkspaceSharedStateMessage): void {
		try {
			this.sharedStateChannel.postData(message);
		} catch {
			// Workspace storage remains authoritative if browser cross-page messaging is unavailable.
		}
	}

	private broadcastSharedState(storedState: IStoredLogicalWorkspaceSharedState, targetSourceId?: string): void {
		this.postSharedStateMessage({
			type: LogicalWorkspaceSharedStateMessageType.State,
			physicalWorkspaceId: this.physicalWorkspaceId,
			sourceId: this.sourceId,
			targetSourceId,
			storedState,
		});
	}

	private broadcastCurrentSharedState(targetSourceId?: string): void {
		if (!this.revision || !this.sharedState || typeof this.sharedState !== 'object') {
			return;
		}
		this.broadcastSharedState({ storageVersion: 1, revision: this.revision, state: this.sharedState }, targetSourceId);
	}

	readActiveWorkspaceId(physicalWorkspaceId: string): string | undefined {
		const key = this.activeWorkspaceKey(physicalWorkspaceId);
		try {
			return mainWindow.sessionStorage.getItem(key) ?? this.fallbackSessionState.get(key);
		} catch {
			return this.fallbackSessionState.get(key);
		}
	}

	writeActiveWorkspaceId(physicalWorkspaceId: string, workspaceId: string): void {
		const key = this.activeWorkspaceKey(physicalWorkspaceId);
		this.fallbackSessionState.set(key, workspaceId);
		try {
			mainWindow.sessionStorage.setItem(key, workspaceId);
		} catch {
			// The in-memory fallback keeps this page coherent when browser storage is unavailable.
		}
	}

	private activeWorkspaceKey(physicalWorkspaceId: string): string {
		return `${LOGICAL_WORKSPACE_ACTIVE_SESSION_KEY}.${physicalWorkspaceId}`;
	}

	private acceptBroadcastMessage(data: unknown): void {
		if (!data || typeof data !== 'object') {
			return;
		}
		const message = data as Record<string, unknown>;
		if (message.physicalWorkspaceId !== this.physicalWorkspaceId || typeof message.sourceId !== 'string' || message.sourceId === this.sourceId) {
			return;
		}
		if (message.type === LogicalWorkspaceSharedStateMessageType.Request) {
			this.broadcastCurrentSharedState();
			return;
		}
		if (message.type !== LogicalWorkspaceSharedStateMessageType.State || (message.targetSourceId !== undefined && message.targetSourceId !== this.sourceId)) {
			return;
		}
		const storedState = this.parseStoredStateEnvelope(message.storedState);
		if (!storedState) {
			return;
		}

		let serializedState: string | undefined;
		try {
			serializedState = JSON.stringify(storedState);
		} catch {
			return;
		}
		if (serializedState === undefined) {
			return;
		}
		const revisionResult = this.acceptRevisionedState(storedState);
		if (revisionResult !== LogicalWorkspaceRevisionResult.Accepted) {
			if (revisionResult === LogicalWorkspaceRevisionResult.Older) {
				this.broadcastCurrentSharedState(message.sourceId);
			}
			return;
		}

		if (this.storageService.get(LOGICAL_WORKSPACE_SHARED_STATE_KEY, StorageScope.WORKSPACE) !== serializedState) {
			this.storageService.storeAll([{
				key: LOGICAL_WORKSPACE_SHARED_STATE_KEY,
				value: serializedState,
				scope: StorageScope.WORKSPACE,
				target: StorageTarget.MACHINE,
			}], true);
		}
		this._onDidChangeSharedState.fire();
	}

	private acceptStorageState(): void {
		const storedState = this.parseStoredState(this.storageService.get(LOGICAL_WORKSPACE_SHARED_STATE_KEY, StorageScope.WORKSPACE));
		if (!storedState) {
			return;
		}
		if (storedState.revision) {
			if (this.acceptRevisionedState(storedState) !== LogicalWorkspaceRevisionResult.Accepted) {
				return;
			}
		} else if (this.revision) {
			return;
		} else {
			this.sharedState = storedState.state;
		}
		this._onDidChangeSharedState.fire();
	}

	private acceptRevisionedState(storedState: IStoredLogicalWorkspaceSharedState): LogicalWorkspaceRevisionResult {
		this.revisionCounter = Math.max(this.revisionCounter, storedState.revision.counter);
		if (this.revision) {
			const comparison = this.compareRevisions(storedState.revision, this.revision);
			if (comparison <= 0) {
				return comparison < 0 ? LogicalWorkspaceRevisionResult.Older : LogicalWorkspaceRevisionResult.Equal;
			}
		}
		this.revision = storedState.revision;
		this.sharedState = storedState.state;
		return LogicalWorkspaceRevisionResult.Accepted;
	}

	private compareRevisions(first: ILogicalWorkspaceStateRevision, second: ILogicalWorkspaceStateRevision): number {
		const counterDifference = first.counter - second.counter;
		if (counterDifference !== 0 || first.source === second.source) {
			return counterDifference;
		}
		return first.source < second.source ? -1 : 1;
	}

	private parseStoredState(raw: string | undefined): { readonly state: unknown; readonly revision?: undefined } | IStoredLogicalWorkspaceSharedState | undefined {
		if (!raw) {
			return undefined;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			return this.parseStoredStateEnvelope(parsed) ?? { state: parsed };
		} catch {
			return undefined;
		}
	}

	private parseStoredStateEnvelope(raw: unknown): IStoredLogicalWorkspaceSharedState | undefined {
		if (!raw || typeof raw !== 'object') {
			return undefined;
		}
		const candidate = raw as Record<string, unknown>;
		if (candidate.storageVersion !== 1 || !candidate.revision || typeof candidate.revision !== 'object' || !candidate.state || typeof candidate.state !== 'object') {
			return undefined;
		}
		const revision = candidate.revision as Record<string, unknown>;
		if (typeof revision.counter !== 'number' || !Number.isSafeInteger(revision.counter) || revision.counter < 0 || typeof revision.source !== 'string' || !revision.source) {
			return undefined;
		}
		return {
			storageVersion: 1,
			revision: { counter: revision.counter, source: revision.source },
			state: candidate.state,
		};
	}
}

registerSingleton(ILogicalWorkspaceStateStore, LogicalWorkspaceStateStore, InstantiationType.Delayed);
