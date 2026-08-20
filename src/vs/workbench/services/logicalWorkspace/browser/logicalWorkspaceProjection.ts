/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ILogicalWorkspace, ILogicalWorkspaceService, LogicalWorkspaceActivationActor } from '../common/logicalWorkspace.js';

export interface IAsyncProjectionContext<T> {
	readonly value: T;
	readonly sequence: number;
	readonly isCurrent: () => boolean;
}

interface IAsyncProjectionRequest<T> {
	readonly value: T;
	readonly sequence: number;
	readonly isStillCurrent: () => boolean;
}

interface IAsyncProjectionWaiter {
	readonly sequence: number;
	readonly resolve: () => void;
}

/**
 * Serializes asynchronous UI projections and coalesces pending work to the newest request.
 * Projection implementations must check `isCurrent` after every asynchronous boundary.
 */
export class AsyncProjectionCoordinator<T> extends Disposable {

	private requestSequence = 0;
	private pendingRequest: IAsyncProjectionRequest<T> | undefined;
	private running: Promise<void> | undefined;
	private readonly waiters: IAsyncProjectionWaiter[] = [];
	private disposed = false;

	constructor(
		private readonly id: string,
		private readonly apply: (context: IAsyncProjectionContext<T>) => Promise<void>,
		private readonly logService: ILogService,
	) {
		super();
	}

	request(value: T, isStillCurrent: () => boolean = () => true): Promise<void> {
		if (this.disposed) {
			return Promise.resolve();
		}

		const sequence = ++this.requestSequence;
		this.pendingRequest = { value, sequence, isStillCurrent };
		const completion = new Promise<void>(resolve => this.waiters.push({ sequence, resolve }));
		this.ensureRunning();
		return completion;
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
			const context: IAsyncProjectionContext<T> = {
				value: request.value,
				sequence: request.sequence,
				isCurrent: () => !this.disposed && request.sequence === this.requestSequence && request.isStillCurrent(),
			};

			try {
				await this.apply(context);
			} catch (error) {
				this.logService.error(`${this.id} projection failed`, error);
			} finally {
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
		this.requestSequence++;
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

	/** Captures the currently projected state before a switch or page save. */
	capture?(workspaceId: string): void;

	/** Restores the requested Workspace and ignores stale work through `context.isCurrent`. */
	restore(context: ILogicalWorkspaceProjectionContext): Promise<void>;
}

interface ILogicalWorkspaceProjectionIntent {
	readonly workspace: ILogicalWorkspace;
	readonly activationSequence: number;
}

/**
 * Applies the shared Logical Workspace projection lifecycle to a projection adapter.
 */
export class LogicalWorkspaceProjectionCoordinator extends Disposable {

	private readonly asyncProjection: AsyncProjectionCoordinator<ILogicalWorkspaceProjectionIntent>;
	private projectedWorkspaceId: string | undefined;

	constructor(
		private readonly logicalWorkspaceService: ILogicalWorkspaceService,
		private readonly projection: ILogicalWorkspaceProjection,
		storageService: IStorageService,
		logService: ILogService,
	) {
		super();
		this.asyncProjection = this._register(new AsyncProjectionCoordinator(
			projection.id,
			context => this.restore(context),
			logService,
		));

		this._register(logicalWorkspaceService.onWillChangeActiveWorkspace(event => {
			if (event.actor !== LogicalWorkspaceActivationActor.SharedState && this.projectedWorkspaceId === event.previousWorkspaceId) {
				this.capture(event.previousWorkspaceId, logService);
			}
		}));
		this._register(logicalWorkspaceService.onDidChangeActiveWorkspace(() => {
			void this.requestReconcile();
		}));
		if (projection.capture) {
			this._register(storageService.onWillSaveState(() => {
				if (this.projectedWorkspaceId === logicalWorkspaceService.activeWorkspace.id) {
					this.capture(this.projectedWorkspaceId, logService);
				}
			}));
		}

		void this.requestReconcile();
	}

	requestReconcile(): Promise<void> {
		const intent: ILogicalWorkspaceProjectionIntent = {
			workspace: this.logicalWorkspaceService.activeWorkspace,
			activationSequence: this.logicalWorkspaceService.activationSequence,
		};
		return this.asyncProjection.request(intent, () => this.isCurrent(intent));
	}

	private async restore(context: IAsyncProjectionContext<ILogicalWorkspaceProjectionIntent>): Promise<void> {
		const intent = context.value;
		await this.projection.restore({
			workspace: intent.workspace,
			activationSequence: intent.activationSequence,
			isCurrent: context.isCurrent,
		});
		if (context.isCurrent()) {
			this.projectedWorkspaceId = intent.workspace.id;
		}
	}

	private capture(workspaceId: string, logService: ILogService): void {
		try {
			this.projection.capture?.(workspaceId);
		} catch (error) {
			logService.error(`${this.projection.id} projection capture failed`, error);
		}
	}

	private isCurrent(intent: ILogicalWorkspaceProjectionIntent): boolean {
		return this.logicalWorkspaceService.activeWorkspace.id === intent.workspace.id
			&& this.logicalWorkspaceService.activationSequence === intent.activationSequence;
	}
}
