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
import { applyLogicalWorkspaceMutation, ILogicalWorkspaceMutation, ILogicalWorkspaceSharedState, LogicalWorkspaceMutationType } from '../common/logicalWorkspace.js';
import { IRemoteLogicalWorkspaceStateResult, IRemoteLogicalWorkspaceStateSnapshot, RemoteLogicalWorkspaceStateCommand, parseRemoteLogicalWorkspaceStateSnapshot } from '../common/logicalWorkspaceRemote.js';

const REMOTE_RETRY_DELAYS = [1000, 5000, 15000, 30000] as const;

class RemoteLogicalWorkspaceProtocolError extends Error { }

/**
 * Maintains an optimistic projection over best-effort view-state writes. Each mutation is sent
 * once; an unknown transport outcome is reconciled by reading server truth, never by replaying
 * an older write.
 */
export class RemoteLogicalWorkspaceStateClient extends Disposable {

	private readonly _onDidChangeState = this._register(new Emitter<ILogicalWorkspaceSharedState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly retryScheduler: RunOnceScheduler;
	private readonly pendingMutations: ILogicalWorkspaceMutation[] = [];
	private initialization: DeferredPromise<void> | undefined;
	private initialState: ILogicalWorkspaceSharedState | undefined;
	private authoritativeSnapshot: IRemoteLogicalWorkspaceStateSnapshot | undefined;
	private projectedState: ILogicalWorkspaceSharedState | undefined;
	private inFlightMutation: ILogicalWorkspaceMutation | undefined;
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

	mutate(mutation: ILogicalWorkspaceMutation): void {
		if (this.fatal) {
			this.logService.error(`[Logical Workspace] Cannot apply '${mutation.type}' after a fatal remote state error`);
			return;
		}
		if (!this.coalesceMutation(mutation)) {
			this.pendingMutations.push(mutation);
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

				const mutation = this.pendingMutations[0];
				if (!mutation) {
					break;
				}
				this.inFlightMutation = mutation;
				const snapshot = await this.callForSnapshot(RemoteLogicalWorkspaceStateCommand.Mutate, {
					physicalWorkspaceId: this.physicalWorkspaceId,
					mutation,
				});
				if (this._store.isDisposed) {
					return;
				}
				if (this.pendingMutations[0] === mutation) {
					this.pendingMutations.shift();
				}
				this.inFlightMutation = undefined;
				this.acceptSnapshot(snapshot, true);
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
				this.pendingMutations.length = 0;
				this.updateProjection(true);
				if (!this.initialized) {
					this.initialization.error(error);
				}
				this.logService.error('[Logical Workspace] Remote state protocol failed', error);
			} else {
				if (failedMutation && this.pendingMutations[0] === failedMutation) {
					this.pendingMutations.shift();
					this.refreshRequested = true;
					this.updateProjection(true);
					this.logService.warn(`[Logical Workspace] Discarded '${failedMutation.type}' after an unknown remote outcome; refreshing server truth`);
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
		for (const mutation of this.pendingMutations) {
			state = applyLogicalWorkspaceMutation(state, mutation);
		}
		if (equals(this.projectedState, state)) {
			return;
		}
		this.projectedState = state;
		if (emit) {
			this._onDidChangeState.fire(state);
		}
	}

	private coalesceMutation(mutation: ILogicalWorkspaceMutation): boolean {
		if (mutation.type !== LogicalWorkspaceMutationType.SetShellLayout && mutation.type !== LogicalWorkspaceMutationType.SetEditorWorkingSet) {
			return false;
		}
		for (let index = this.pendingMutations.length - 1; index >= 0; index--) {
			const pending = this.pendingMutations[index];
			if (pending === this.inFlightMutation || pending.type !== mutation.type) {
				continue;
			}
			if (pending.workspaceId === mutation.workspaceId) {
				this.pendingMutations[index] = mutation;
				return true;
			}
		}
		return false;
	}

	private scheduleRetry(error: unknown): void {
		this.consecutiveFailures++;
		const retryDelay = this.retryDelays[Math.min(this.consecutiveFailures - 1, this.retryDelays.length - 1)];
		this.logService.warn(`[Logical Workspace] Remote state synchronization failed; retrying in ${retryDelay}ms: ${toErrorMessage(error)}`);
		this.retryScheduler.schedule(retryDelay);
	}
}
