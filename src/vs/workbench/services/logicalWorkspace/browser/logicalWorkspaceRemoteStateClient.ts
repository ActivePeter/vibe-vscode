/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, RunOnceScheduler } from '../../../../base/common/async.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { equals } from '../../../../base/common/objects.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { applyLogicalWorkspaceMutation, ILogicalWorkspace, ILogicalWorkspaceMutation, ILogicalWorkspaceSharedState, ILogicalWorkspaceViewMutation, LogicalWorkspaceMutationType } from '../common/logicalWorkspace.js';
import { IRemoteLogicalWorkspaceStateResult, IRemoteLogicalWorkspaceStateSnapshot, RemoteLogicalWorkspaceStateCommand, parseRemoteLogicalWorkspaceStateSnapshot } from '../common/logicalWorkspaceRemote.js';

const REMOTE_RETRY_DELAYS = [1000, 5000, 15000, 30000] as const;

class RemoteLogicalWorkspaceProtocolError extends Error { }

interface IPendingLogicalWorkspaceMutation {
	readonly mutation: ILogicalWorkspaceMutation;
	readonly completion?: DeferredPromise<void>;
}

/**
 * Maintains an optimistic projection over best-effort view-state writes. Each replaceable write
 * is sent once; an unknown outcome is reconciled by reading server truth. Additive UUID creation
 * is kept non-optimistic and may be retried after that read.
 */
export class RemoteLogicalWorkspaceStateClient extends Disposable {

	private readonly _onDidChangeState = this._register(new Emitter<ILogicalWorkspaceSharedState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly retryScheduler: RunOnceScheduler;
	private readonly pendingMutations: IPendingLogicalWorkspaceMutation[] = [];
	private initialization: DeferredPromise<void> | undefined;
	private initialState: ILogicalWorkspaceSharedState | undefined;
	private authoritativeSnapshot: IRemoteLogicalWorkspaceStateSnapshot | undefined;
	private projectedState: ILogicalWorkspaceSharedState | undefined;
	private inFlightMutation: IPendingLogicalWorkspaceMutation | undefined;
	private initialized = false;
	private refreshRequested = false;
	private running = false;
	private fatal = false;
	private consecutiveFailures = 0;

	constructor(
		private readonly physicalWorkspaceId: string,
		private readonly channel: IChannel,
		private readonly logService: ILogService,
		private readonly retryDelays: readonly number[] = REMOTE_RETRY_DELAYS,
	) {
		super();
		if (retryDelays.length === 0) {
			throw new Error('Remote Logical Workspace retry delays must not be empty');
		}
		this.retryScheduler = this._register(new RunOnceScheduler(() => void this.run(), retryDelays[0]));
	}

	get state(): ILogicalWorkspaceSharedState | undefined {
		return this.projectedState;
	}

	initialize(state: ILogicalWorkspaceSharedState): Promise<void> {
		if (!this.initialization) {
			this.initialization = new DeferredPromise<void>();
			this.initialState = state;
			this.updateProjection(false);
			void this.run();
		}
		return this.initialization.p;
	}

	mutate(mutation: ILogicalWorkspaceViewMutation): void {
		this.enqueueMutation({ mutation });
	}

	/**
	 * Creates a stable catalog identity. Unlike replaceable view-state writes, creation can be
	 * retried safely because its UUID mutation is additive and idempotent. The promise resolves
	 * only after an authoritative snapshot contains that identity.
	 */
	createWorkspace(workspace: ILogicalWorkspace): Promise<void> {
		const existing = this.pendingMutations.find(pending => pending.mutation.type === LogicalWorkspaceMutationType.CreateWorkspace && pending.mutation.workspace.id === workspace.id);
		if (existing?.completion) {
			return existing.completion.p;
		}

		const completion = new DeferredPromise<void>();
		this.enqueueMutation({
			mutation: { type: LogicalWorkspaceMutationType.CreateWorkspace, workspace },
			completion,
		});
		return completion.p;
	}

	private enqueueMutation(pending: IPendingLogicalWorkspaceMutation): void {
		if (this.fatal) {
			const error = new Error(`Cannot apply '${pending.mutation.type}' after a fatal remote state error`);
			this.logService.error(`[Logical Workspace] ${error.message}`);
			void pending.completion?.error(error);
			return;
		}
		if (!this.coalesceMutation(pending)) {
			this.pendingMutations.push(pending);
		}
		this.updateProjection(false);
		if (this.initialization) {
			void this.run();
		}
	}

	requestRefresh(): void {
		if (this.fatal) {
			return;
		}
		this.retryScheduler.cancel();
		if (this.initialized) {
			this.refreshRequested = true;
		}
		void this.run();
	}

	private async run(): Promise<void> {
		if (this.running || this.fatal || !this.initialization || !this.initialState) {
			return;
		}
		this.running = true;
		try {
			if (!this.initialized) {
				const snapshot = await this.callForSnapshot(RemoteLogicalWorkspaceStateCommand.Initialize, {
					physicalWorkspaceId: this.physicalWorkspaceId,
					state: this.initialState,
				});
				if (this._store.isDisposed) {
					return;
				}
				this.acceptSnapshot(snapshot, true);
				this.initialized = true;
				this.initialization.complete();
			}

			while (!this.fatal) {
				if (this.refreshRequested) {
					this.refreshRequested = false;
					const snapshot = await this.callForOptionalSnapshot(RemoteLogicalWorkspaceStateCommand.Read, {
						physicalWorkspaceId: this.physicalWorkspaceId,
					});
					if (this._store.isDisposed) {
						return;
					}
					if (!snapshot) {
						throw new RemoteLogicalWorkspaceProtocolError('The authoritative Logical Workspace state disappeared after initialization');
					}
					this.acceptSnapshot(snapshot, true);
					continue;
				}

				const pending = this.pendingMutations[0];
				if (!pending) {
					break;
				}
				this.inFlightMutation = pending;
				const snapshot = await this.callForSnapshot(RemoteLogicalWorkspaceStateCommand.Mutate, {
					physicalWorkspaceId: this.physicalWorkspaceId,
					mutation: pending.mutation,
				});
				if (this._store.isDisposed) {
					return;
				}
				this.inFlightMutation = undefined;
				if (pending.mutation.type !== LogicalWorkspaceMutationType.CreateWorkspace && this.pendingMutations[0] === pending) {
					this.pendingMutations.shift();
				}
				this.acceptSnapshot(snapshot, true);
				if (pending.mutation.type === LogicalWorkspaceMutationType.CreateWorkspace && !pending.completion?.isResolved) {
					throw new RemoteLogicalWorkspaceProtocolError(`Remote create did not confirm Logical Workspace '${pending.mutation.workspace.id}'`);
				}
			}

			this.consecutiveFailures = 0;
			this.retryScheduler.cancel();
		} catch (error) {
			const failedMutation = this.inFlightMutation;
			this.inFlightMutation = undefined;
			if (this._store.isDisposed) {
				return;
			}
			if (error instanceof RemoteLogicalWorkspaceProtocolError) {
				this.fatal = true;
				this.retryScheduler.cancel();
				this.rejectPendingCreations(error);
				this.pendingMutations.length = 0;
				this.updateProjection(true);
				if (!this.initialized) {
					this.initialization.error(error);
				}
				this.logService.error('[Logical Workspace] Remote state protocol failed', error);
			} else {
				if (failedMutation?.mutation.type === LogicalWorkspaceMutationType.CreateWorkspace) {
					// First reconcile the unknown result. If the server did not commit the additive
					// UUID mutation, the next pass can safely submit that same creation again.
					this.refreshRequested = true;
					this.logService.warn(`[Logical Workspace] Create '${failedMutation.mutation.workspace.id}' has an unknown remote outcome; reconciling before retry`);
				} else if (failedMutation && this.pendingMutations[0] === failedMutation) {
					this.pendingMutations.shift();
					this.refreshRequested = true;
					this.updateProjection(true);
					this.logService.warn(`[Logical Workspace] Discarded '${failedMutation.mutation.type}' after an unknown remote outcome; refreshing server truth`);
				} else if (this.initialized) {
					this.refreshRequested = true;
				}
				this.scheduleRetry(error);
			}
		} finally {
			this.running = false;
		}
	}

	private async callForSnapshot(command: RemoteLogicalWorkspaceStateCommand.Initialize | RemoteLogicalWorkspaceStateCommand.Mutate, arg: object): Promise<IRemoteLogicalWorkspaceStateSnapshot> {
		const snapshot = await this.callForOptionalSnapshot(command, arg);
		if (!snapshot) {
			throw new RemoteLogicalWorkspaceProtocolError(`Remote command '${command}' returned no Logical Workspace state`);
		}
		return snapshot;
	}

	private async callForOptionalSnapshot(command: RemoteLogicalWorkspaceStateCommand, arg: object): Promise<IRemoteLogicalWorkspaceStateSnapshot | undefined> {
		const raw = await this.channel.call<unknown>(command, arg);
		if (!raw || typeof raw !== 'object') {
			throw new RemoteLogicalWorkspaceProtocolError(`Remote command '${command}' returned a malformed result`);
		}
		const result = raw as Partial<IRemoteLogicalWorkspaceStateResult<unknown>>;
		if (result.status === 'error') {
			const message = typeof result.message === 'string' ? result.message : `Remote command '${command}' failed`;
			throw new RemoteLogicalWorkspaceProtocolError(message);
		}
		if (result.status !== 'ok') {
			throw new RemoteLogicalWorkspaceProtocolError(`Remote command '${command}' returned a malformed result`);
		}
		if (result.value === undefined && command === RemoteLogicalWorkspaceStateCommand.Read) {
			return undefined;
		}
		const snapshot = parseRemoteLogicalWorkspaceStateSnapshot(result.value);
		if (!snapshot) {
			throw new RemoteLogicalWorkspaceProtocolError(`Remote command '${command}' returned a malformed snapshot`);
		}
		return snapshot;
	}

	private acceptSnapshot(snapshot: IRemoteLogicalWorkspaceStateSnapshot, emit: boolean): void {
		this.confirmPendingCreations(snapshot);
		if (this.authoritativeSnapshot && snapshot.revision <= this.authoritativeSnapshot.revision) {
			// A refresh can return the current revision after an unknown mutation left the optimistic
			// queue. Recompute even when the authoritative snapshot itself did not advance.
			this.updateProjection(emit);
			return;
		}
		this.authoritativeSnapshot = snapshot;
		this.updateProjection(emit);
	}

	private updateProjection(emit: boolean): void {
		let state = this.authoritativeSnapshot?.state ?? this.initialState;
		if (!state) {
			return;
		}
		for (const pending of this.pendingMutations) {
			// Catalog identities are not optimistic: consumers may persist durable resources
			// against an identity as soon as it becomes visible. View state remains optimistic.
			if (pending.mutation.type !== LogicalWorkspaceMutationType.CreateWorkspace) {
				state = applyLogicalWorkspaceMutation(state, pending.mutation);
			}
		}
		if (equals(this.projectedState, state)) {
			return;
		}
		this.projectedState = state;
		if (emit) {
			this._onDidChangeState.fire(state);
		}
	}

	private coalesceMutation(candidate: IPendingLogicalWorkspaceMutation): boolean {
		const mutation = candidate.mutation;
		if (mutation.type !== LogicalWorkspaceMutationType.SetShellLayout && mutation.type !== LogicalWorkspaceMutationType.SetEditorWorkingSet) {
			return false;
		}
		for (let index = this.pendingMutations.length - 1; index >= 0; index--) {
			const pending = this.pendingMutations[index];
			if (pending === this.inFlightMutation || pending.mutation.type !== mutation.type) {
				continue;
			}
			if (pending.mutation.workspaceId === mutation.workspaceId) {
				this.pendingMutations[index] = candidate;
				return true;
			}
		}
		return false;
	}

	private confirmPendingCreations(snapshot: IRemoteLogicalWorkspaceStateSnapshot): void {
		const workspaceIds = new Set(snapshot.state.workspaces.map(workspace => workspace.id));
		for (let index = this.pendingMutations.length - 1; index >= 0; index--) {
			const pending = this.pendingMutations[index];
			if (pending.mutation.type === LogicalWorkspaceMutationType.CreateWorkspace && workspaceIds.has(pending.mutation.workspace.id)) {
				this.pendingMutations.splice(index, 1);
				void pending.completion?.complete();
			}
		}
	}

	private rejectPendingCreations(error: unknown): void {
		for (const pending of this.pendingMutations) {
			if (pending.mutation.type === LogicalWorkspaceMutationType.CreateWorkspace) {
				void pending.completion?.error(error);
			}
		}
	}

	private scheduleRetry(error: unknown): void {
		this.consecutiveFailures++;
		const retryDelay = this.retryDelays[Math.min(this.consecutiveFailures - 1, this.retryDelays.length - 1)];
		this.logService.warn(`[Logical Workspace] Remote state synchronization failed; retrying in ${retryDelay}ms: ${toErrorMessage(error)}`);
		this.retryScheduler.schedule(retryDelay);
	}

	override dispose(): void {
		this.rejectPendingCreations(new Error('Remote Logical Workspace state client was disposed'));
		super.dispose();
	}
}
