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
}

/**
 * Serializes asynchronous UI projections and coalesces pending work to the newest request.
 * A caller-provided target identity keeps feedback for the in-flight target in the same
 * generation: the active transaction finishes, then one coalesced refresh observes its effects.
 * A different target invalidates the active generation immediately.
 * Projection implementations must check `isCurrent` after every asynchronous boundary.
 */
export class AsyncProjectionCoordinator<T> extends Disposable {

	private requestSequence = 0;
	private projectionGeneration = 0;
	private pendingRequest: IAsyncProjectionRequest<T> | undefined;
	private applyingRequest: IAsyncProjectionRequest<T> | undefined;
	private running: Promise<void> | undefined;
	private readonly waiters: IAsyncProjectionWaiter[] = [];
	private disposed = false;

	constructor(
		private readonly id: string,
		private readonly apply: (context: IAsyncProjectionContext<T>) => Promise<void>,
		private readonly logService: ILogService,
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
		const completion = new Promise<void>(resolve => this.waiters.push({ sequence, resolve }));
		this.ensureRunning();
		return completion;
	}

	async whenIdle(): Promise<void> {
		while (this.running) {
			await this.running;
		}
	}

	private ensureRunning(): void {
		if (!this.running) {
			const running = this.run();
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

			try {
				await this.apply(context);
			} catch (error) {
				this.logService.error(`${this.id} projection failed`, error);
			} finally {
				this.applyingRequest = undefined;
				this.resolveWaitersThrough(request.sequence);
			}
		}
	}

	private resolveWaitersThrough(sequence: number): void {
		for (let index = this.waiters.length - 1; index >= 0; index--) {
			if (this.waiters[index].sequence <= sequence) {
				this.waiters.splice(index, 1)[0].resolve();
			}
		}
	}

	override dispose(): void {
		this.disposed = true;
		this.pendingRequest = undefined;
		this.projectionGeneration++;
		this.resolveWaitersThrough(Number.POSITIVE_INFINITY);
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
	readonly whenReady: Promise<void>;

	constructor(
		private readonly logicalWorkspaceService: ILogicalWorkspaceService,
		private readonly projection: ILogicalWorkspaceProjection,
		storageService: IStorageService,
		private readonly logService: ILogService,
	) {
		super();
		this.asyncProjection = this._register(new AsyncProjectionCoordinator(
			projection.id,
			context => this.restore(context),
			logService,
			(current, next) => current.workspace.id === next.workspace.id && current.activationSequence === next.activationSequence,
		));

		this._register(logicalWorkspaceService.onWillChangeActiveWorkspace(event => {
			if (event.actor !== LogicalWorkspaceActivationActor.SharedState) {
				this.captureProjectedState(event.previousWorkspaceId);
			}
		}));
		this._register(onDidChangeLogicalWorkspaceStateSlice(logicalWorkspaceService, state => this.getStateSlice(state))(() => {
			void this.requestReconcile();
		}));
		if (projection.capture) {
			this._register(storageService.onWillSaveState(() => {
				this.captureProjectedState(logicalWorkspaceService.activeWorkspace.id);
			}));
		}

		this.whenReady = this.initialize();
	}

	private async initialize(): Promise<void> {
		await this.requestReconcile();
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

	/** Captures only when the UI and authority still describe the same successful projection. */
	captureProjectedState(workspaceId: string): void {
		if (!this.canCapture(workspaceId)) {
			return;
		}
		try {
			this.projection.capture?.(workspaceId);
		} catch (error) {
			this.logService.error(`${this.projection.id} projection capture failed`, error);
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
