/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { equals } from '../../../../base/common/objects.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ILogicalWorkspace, ILogicalWorkspaceService, ILogicalWorkspaceStateSnapshot, LogicalWorkspaceActivationActor, onDidChangeLogicalWorkspaceStateSlice } from '../common/logicalWorkspace.js';

export interface IAsyncProjectionContext<T> {
	readonly value: T;
	readonly sequence: number;
	readonly isCurrent: () => boolean;
}

interface IAsyncProjectionRequest<T> {
	readonly value: T;
	readonly sequence: number;
	readonly generation: number;
	readonly isStillCurrent: () => boolean;
}

interface IAsyncProjectionWaiter {
	readonly sequence: number;
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
}

/**
 * Serializes asynchronous UI projections and coalesces pending work to the newest request.
 * A caller-provided target identity keeps feedback for the in-flight target in the same
 * generation: the active transaction finishes, then one coalesced refresh observes its effects.
 * A different target invalidates the active generation immediately.
 * Projection implementations must check `isCurrent` after every asynchronous boundary.
 * A failed apply rejects the requests represented by that apply without stopping newer work.
 */
export class AsyncProjectionCoordinator<T> extends Disposable {

	private requestSequence = 0;
	private projectionGeneration = 0;
	private pendingRequest: IAsyncProjectionRequest<T> | undefined;
	private applyingRequest: IAsyncProjectionRequest<T> | undefined;
	private running: Promise<void> | undefined;
	private readonly waiters: IAsyncProjectionWaiter[] = [];
	private lastFailure: { readonly sequence: number; readonly error: unknown } | undefined;
	private disposed = false;

	constructor(
		private readonly apply: (context: IAsyncProjectionContext<T>) => Promise<void>,
		private readonly isSameTarget: (current: T, next: T) => boolean = () => false,
	) {
		super();
	}

	request(value: T, isStillCurrent: () => boolean = () => true): Promise<void> {
		if (this.disposed) {
			return Promise.resolve();
		}

		const sequence = ++this.requestSequence;
		const latestRequest = this.pendingRequest ?? this.applyingRequest;
		const generation = latestRequest && this.isSameTarget(latestRequest.value, value)
			? latestRequest.generation
			: ++this.projectionGeneration;
		this.pendingRequest = { value, sequence, generation, isStillCurrent };
		const completion = new Promise<void>((resolve, reject) => this.waiters.push({ sequence, resolve, reject }));
		this.ensureRunning();
		return completion;
	}

	/** Waits for all queued work and rejects when the newest completed projection failed. */
	async whenIdle(): Promise<void> {
		while (this.running) {
			await this.running;
		}
		if (this.lastFailure) {
			throw this.lastFailure.error;
		}
	}

	private ensureRunning(): void {
		if (!this.running) {
			// Publish the runner before invoking projection code. An apply call can synchronously
			// emit feedback that requests another projection before reaching its first await.
			const running = Promise.resolve().then(() => this.run());
			this.running = running.finally(() => {
				this.running = undefined;
				if (this.pendingRequest && !this.disposed) {
					this.ensureRunning();
				}
			});
		}
	}

	private async run(): Promise<void> {
		while (this.pendingRequest && !this.disposed) {
			const request = this.pendingRequest;
			this.pendingRequest = undefined;
			this.applyingRequest = request;
			const context: IAsyncProjectionContext<T> = {
				value: request.value,
				sequence: request.sequence,
				isCurrent: () => !this.disposed && request.generation === this.projectionGeneration && request.isStillCurrent(),
			};

			let failed = false;
			let failure: unknown;
			try {
				await this.apply(context);
			} catch (error) {
				failed = true;
				failure = error;
			} finally {
				this.applyingRequest = undefined;
				this.lastFailure = failed ? { sequence: request.sequence, error: failure } : undefined;
				this.settleWaitersThrough(request.sequence, failed, failure);
			}
		}
	}

	private settleWaitersThrough(sequence: number, failed = false, failure?: unknown): void {
		for (let index = this.waiters.length - 1; index >= 0; index--) {
			if (this.waiters[index].sequence <= sequence) {
				const waiter = this.waiters.splice(index, 1)[0];
				if (failed) {
					waiter.reject(failure);
				} else {
					waiter.resolve();
				}
			}
		}
	}

	override dispose(): void {
		this.disposed = true;
		this.pendingRequest = undefined;
		this.projectionGeneration++;
		this.lastFailure = undefined;
		this.settleWaitersThrough(Number.POSITIVE_INFINITY);
		super.dispose();
	}
}

export interface ILogicalWorkspaceProjectionContext {
	readonly workspace: ILogicalWorkspace;
	readonly activationSequence: number;
	readonly isCurrent: () => boolean;
}

/**
 * Contract implemented by every Logical Workspace projection adapter.
 */
export interface ILogicalWorkspaceProjection {
	readonly id: string;
	/** Selects the complete semantic state consumed by this projection. */
	stateSlice?(state: ILogicalWorkspaceStateSnapshot): unknown;

	/** Captures the currently projected state before a switch or page save. */
	capture?(workspaceId: string): void;

	/**
	 * Restores the requested Workspace and ignores stale work through `context.isCurrent`.
	 * Returning `false` leaves the last successfully projected snapshot unchanged.
	 */
	restore(context: ILogicalWorkspaceProjectionContext): Promise<boolean | void>;
}

interface ILogicalWorkspaceProjectionIntent {
	readonly workspace: ILogicalWorkspace;
	readonly activationSequence: number;
	readonly stateSlice: unknown;
}

/**
 * Applies the shared Logical Workspace projection lifecycle to a projection adapter.
 */
export class LogicalWorkspaceProjectionCoordinator extends Disposable {

	private readonly asyncProjection: AsyncProjectionCoordinator<ILogicalWorkspaceProjectionIntent>;
	private projectedWorkspaceId: string | undefined;
	private projectedStateSlice: unknown;
	private capturingProjection = false;
	readonly whenReady: Promise<void>;

	constructor(
		private readonly logicalWorkspaceService: ILogicalWorkspaceService,
		private readonly projection: ILogicalWorkspaceProjection,
		storageService: IStorageService,
		private readonly logService: ILogService,
	) {
		super();
		this.asyncProjection = this._register(new AsyncProjectionCoordinator(
			context => this.restore(context),
			(current, next) => current.workspace.id === next.workspace.id && current.activationSequence === next.activationSequence,
		));

		this._register(logicalWorkspaceService.onWillChangeActiveWorkspace(event => {
			if (event.actor !== LogicalWorkspaceActivationActor.SharedState) {
				this.captureProjectedState(event.previousWorkspaceId);
			}
		}));
		this._register(onDidChangeLogicalWorkspaceStateSlice(logicalWorkspaceService, state => this.getStateSlice(state))(() => {
			if (this.capturingProjection) {
				return;
			}
			this.requestReconcileFromEvent();
		}));
		if (projection.capture) {
			this._register(storageService.onWillSaveState(() => {
				this.captureProjectedState(logicalWorkspaceService.activeWorkspace.id);
			}));
		}

		this.whenReady = this.initialize();
		// Readiness remains rejection-bearing for callers that need to sequence startup, while this
		// observer owns logging immediately so a late or absent caller cannot create an unhandled
		// rejection.
		void this.whenReady.catch(error => this.logService.error(`${this.projection.id} initial projection failed`, error));
	}

	private async initialize(): Promise<void> {
		// Authority readiness failures occur before any projection request exists and must reject the
		// readiness barrier directly. Apply failures are retained by the async coordinator below.
		await this.logicalWorkspaceService.whenReady;
		try {
			await this.requestReconcile();
		} catch {
			// The request outcome is retained by the async coordinator. A queued newer request may
			// still converge the current target, so readiness is decided only once the queue is idle.
		}
		await this.asyncProjection.whenIdle();
	}

	async requestReconcile(): Promise<void> {
		await this.logicalWorkspaceService.whenReady;
		if (this._store.isDisposed) {
			return;
		}
		const intent: ILogicalWorkspaceProjectionIntent = {
			workspace: this.logicalWorkspaceService.activeWorkspace,
			activationSequence: this.logicalWorkspaceService.activationSequence,
			stateSlice: this.getStateSlice(),
		};
		return this.asyncProjection.request(intent, () => this.isCurrent(intent));
	}

	/** Event listeners cannot await reconciliation, so this boundary owns any readiness failure. */
	requestReconcileFromEvent(): void {
		void this.requestReconcile().catch(error => this.logService.error(`${this.projection.id} projection reconciliation failed`, error));
	}

	/** Captures only when the UI and authority still describe the same successful projection. */
	captureProjectedState(workspaceId: string): void {
		if (!this.canCapture(workspaceId)) {
			return;
		}
		this.capturingProjection = true;
		try {
			this.projection.capture?.(workspaceId);
			if (this.projectedWorkspaceId === workspaceId && this.logicalWorkspaceService.activeWorkspace.id === workspaceId) {
				// The capture wrote the state represented by the live UI. Acknowledge that local
				// feedback instead of destructively restoring the same serialized state.
				this.projectedStateSlice = this.getStateSlice();
			}
		} catch (error) {
			this.logService.error(`${this.projection.id} projection capture failed`, error);
		} finally {
			this.capturingProjection = false;
		}
	}

	private async restore(context: IAsyncProjectionContext<ILogicalWorkspaceProjectionIntent>): Promise<void> {
		const intent = context.value;
		const restored = await this.projection.restore({
			workspace: intent.workspace,
			activationSequence: intent.activationSequence,
			isCurrent: context.isCurrent,
		});
		if (restored !== false && context.isCurrent()) {
			this.projectedWorkspaceId = intent.workspace.id;
			this.projectedStateSlice = intent.stateSlice;
		}
	}

	private canCapture(workspaceId: string): boolean {
		return this.projectedWorkspaceId === workspaceId && equals(this.projectedStateSlice, this.getStateSlice());
	}

	private isCurrent(intent: ILogicalWorkspaceProjectionIntent): boolean {
		return this.logicalWorkspaceService.activeWorkspace.id === intent.workspace.id
			&& this.logicalWorkspaceService.activationSequence === intent.activationSequence;
	}

	private getStateSlice(state = this.logicalWorkspaceService.state): unknown {
		return this.projection.stateSlice?.(state) ?? state.workspaces.find(workspace => workspace.id === state.activeWorkspaceId);
	}
}
