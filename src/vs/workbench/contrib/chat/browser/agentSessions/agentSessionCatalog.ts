/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';

const defaultRetryDelays = [1_000, 5_000, 30_000, 120_000] as const;
const defaultEventHistoryLimit = 100;

/**
 * Determines what a catalog refresh does after a non-cancellation failure.
 */
export const enum CatalogRefreshFailureAction {
	/** Preserve the last complete snapshot and retry in the catalog-owned background loop. */
	Retry = 'retry',
	/** Preserve the last complete snapshot and return without scheduling a retry. */
	Preserve = 'preserve',
	/** Preserve the last complete snapshot and reject the foreground refresh. */
	Throw = 'throw',
}

/**
 * Severity attached to a structured catalog lifecycle event.
 */
export const enum AgentSessionCatalogEventLevel {
	Trace = 'trace',
	Info = 'info',
	Warning = 'warning',
	Error = 'error',
}

/**
 * Structured lifecycle event retained by {@link AgentSessionCatalog} for diagnostics.
 */
export interface IAgentSessionCatalogEvent {
	readonly sequence: number;
	readonly timestamp: number;
	readonly catalog: string;
	readonly kind: 'refreshStarted' | 'snapshotDiscarded' | 'refreshCancelled' | 'refreshFailed' | 'retryScheduled' | 'retrySuperseded' | 'refreshSucceeded' | 'refreshRecovered';
	readonly level: AgentSessionCatalogEventLevel;
	readonly trigger: 'foreground' | 'retry';
	readonly generation: number;
	readonly message: string;
	readonly attempt?: number;
	readonly retryDelay?: number;
	readonly failureAction?: CatalogRefreshFailureAction;
}

/**
 * A complete snapshot is the only result allowed to prove that a previous item was removed.
 */
export interface ICompleteCatalogSnapshot<T> {
	readonly kind: 'complete';
	readonly items: readonly T[];
}

/**
 * A partial snapshot may add or update known items, but absence from it never means removal.
 */
export interface IPartialCatalogSnapshot<T> {
	readonly kind: 'partial';
	readonly items: readonly T[];
	readonly error: unknown;
}

/**
 * A cancelled read carries no catalog information and must not mutate committed state.
 */
export interface ICancelledCatalogSnapshot {
	readonly kind: 'cancelled';
}

/**
 * Result contract for a catalog source. It keeps data completeness separate from failure policy.
 */
export type CatalogSnapshot<T> = ICompleteCatalogSnapshot<T> | IPartialCatalogSnapshot<T> | ICancelledCatalogSnapshot;

/** Creates a catalog snapshot whose presence and absence information are both authoritative. */
export function completeCatalogSnapshot<T>(items: readonly T[]): ICompleteCatalogSnapshot<T> {
	return { kind: 'complete', items };
}

/** Creates a catalog snapshot whose items are safe to merge but whose omissions are not authoritative. */
export function partialCatalogSnapshot<T>(items: readonly T[], error: unknown): IPartialCatalogSnapshot<T> {
	return { kind: 'partial', items, error };
}

/** Creates a neutral result for a cancelled or superseded catalog read. */
export function cancelledCatalogSnapshot(): ICancelledCatalogSnapshot {
	return { kind: 'cancelled' };
}

/**
 * Delta emitted after catalog state has been committed.
 */
export interface IAgentSessionCatalogDelta<T> {
	readonly addedOrUpdated?: readonly T[];
	readonly removed?: readonly T[];
}

/**
 * Source and policy required by {@link AgentSessionCatalog}.
 */
export interface IAgentSessionCatalogOptions<T> {
	readonly name: string;
	readonly keyOf: (item: T) => string;
	readonly equals: (left: T, right: T) => boolean;
	readonly read: (token: CancellationToken) => Promise<CatalogSnapshot<T>>;
	readonly classifyError: (error: unknown) => CatalogRefreshFailureAction;
	readonly retryDelays?: readonly number[];
	/** Maximum number of structured lifecycle events retained in memory. Set to `0` to disable retention. */
	readonly eventHistoryLimit?: number;
}

/**
 * Owns an Agent Session provider's last-known-good catalog and its refresh state machine.
 *
 * Complete snapshots replace the catalog and may emit removals. Partial snapshots are merged
 * additively. Failed and cancelled reads preserve committed state. Retryable failures are handled
 * by one disposable, generation-aware background loop instead of ad-hoc timers in controllers.
 * Every loop transition is recorded as a structured event before it is broadcast; event severity
 * is the single source for the corresponding system log level.
 */
export class AgentSessionCatalog<T> extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<IAgentSessionCatalogDelta<T>>());
	readonly onDidChange: Event<IAgentSessionCatalogDelta<T>> = this._onDidChange.event;
	private readonly _onDidRecordEvent = this._register(new Emitter<IAgentSessionCatalogEvent>());
	/** Diagnostic event emitted after the record is retained and projected to the system log. */
	readonly onDidRecordEvent: Event<IAgentSessionCatalogEvent> = this._onDidRecordEvent.event;

	private _items = new Map<string, T>();
	private readonly _eventHistory: IAgentSessionCatalogEvent[] = [];
	private _eventSequence = 0;
	private _refreshGeneration = 0;
	private _contentGeneration = 0;
	private _consecutiveFailures = 0;
	private _failureAction: CatalogRefreshFailureAction | undefined;
	private _failureRevision = 0;
	private _isDisposed = false;

	private readonly _retryDelays: readonly number[];
	private readonly _eventHistoryLimit: number;
	private readonly _retryScheduler: RunOnceScheduler;

	constructor(
		private readonly options: IAgentSessionCatalogOptions<T>,
		private readonly logService: ILogService,
	) {
		super();

		this._retryDelays = options.retryDelays ?? defaultRetryDelays;
		this._eventHistoryLimit = Math.max(0, Math.floor(options.eventHistoryLimit ?? defaultEventHistoryLimit));
		this._retryScheduler = this._register(new RunOnceScheduler(() => {
			void this._runRefresh(CancellationToken.None, ++this._refreshGeneration, 'retry').catch(() => {
				// Throw-classified failures have already been logged. This is the background-loop boundary.
			});
		}, 0));
	}

	get items(): readonly T[] {
		return Array.from(this._items.values());
	}

	/**
	 * Bounded lifecycle history for diagnostics. Consumers should use {@link onDidRecordEvent}
	 * for live observation and must not use diagnostics events to orchestrate catalog control flow.
	 */
	get eventHistory(): readonly IAgentSessionCatalogEvent[] {
		return this._eventHistory.slice();
	}

	/**
	 * Requests an immediate refresh. A newer request supersedes any older in-flight result.
	 */
	async refresh(token: CancellationToken): Promise<void> {
		const supersededRetry = this._retryScheduler.isScheduled();
		this._retryScheduler.cancel();
		const refreshGeneration = ++this._refreshGeneration;
		if (supersededRetry) {
			this._recordEvent({
				kind: 'retrySuperseded',
				level: AgentSessionCatalogEventLevel.Trace,
				trigger: 'foreground',
				generation: refreshGeneration,
				message: 'Scheduled background retry was superseded by a foreground refresh',
				attempt: this._consecutiveFailures,
				failureAction: this._failureAction,
			});
		}
		await this._runRefresh(token, refreshGeneration, 'foreground');
	}

	/**
	 * Commits an item from an explicit authoritative event, independently of snapshot refreshes.
	 */
	upsert(item: T): void {
		const key = this.options.keyOf(item);
		const previous = this._items.get(key);
		// The event is newer authority even when the cache already has the same value.
		this._contentGeneration++;
		if (previous && this.options.equals(previous, item)) {
			return;
		}

		this._items.set(key, item);
		this._onDidChange.fire({ addedOrUpdated: [item] });
	}

	/**
	 * Removes an item in response to an explicit authoritative deletion event.
	 */
	delete(key: string): void {
		const previous = this._items.get(key);
		// An absent cache entry does not make an older in-flight snapshot authoritative.
		this._contentGeneration++;
		if (!previous) {
			return;
		}

		this._items.delete(key);
		this._onDidChange.fire({ removed: [previous] });
	}

	private async _runRefresh(token: CancellationToken, refreshGeneration: number, trigger: IAgentSessionCatalogEvent['trigger']): Promise<void> {
		this._recordEvent({
			kind: 'refreshStarted',
			level: AgentSessionCatalogEventLevel.Trace,
			trigger,
			generation: refreshGeneration,
			message: trigger === 'retry' ? 'Background retry started' : 'Foreground refresh started',
		});
		if (!this._isCurrent(refreshGeneration, token)) {
			this._recordStoppedRefresh(token, refreshGeneration, trigger, 'Refresh was cancelled or superseded before reading');
			return;
		}

		while (this._isCurrent(refreshGeneration, token)) {
			const contentGeneration = this._contentGeneration;
			let snapshot: CatalogSnapshot<T>;
			try {
				snapshot = await this.options.read(token);
			} catch (error) {
				if (token.isCancellationRequested || isCancellationError(error)) {
					this._recordStoppedRefresh(token, refreshGeneration, trigger, 'Catalog source read was cancelled', true);
					return;
				}
				if (!this._isCurrent(refreshGeneration, token)) {
					this._recordStoppedRefresh(token, refreshGeneration, trigger, 'Failed source result was superseded');
					return;
				}
				if (contentGeneration !== this._contentGeneration) {
					this._recordEvent({
						kind: 'snapshotDiscarded',
						level: AgentSessionCatalogEventLevel.Trace,
						trigger,
						generation: refreshGeneration,
						message: 'Failed source result was discarded because an explicit catalog event committed newer content',
					});
					continue;
				}
				this._handleFailure(error, refreshGeneration, trigger);
				return;
			}

			if (token.isCancellationRequested || snapshot.kind === 'cancelled') {
				this._recordStoppedRefresh(token, refreshGeneration, trigger, 'Catalog source returned a cancelled result', true);
				return;
			}
			if (!this._isCurrent(refreshGeneration, token)) {
				this._recordStoppedRefresh(token, refreshGeneration, trigger, 'Catalog snapshot was superseded before commit');
				return;
			}
			if (contentGeneration !== this._contentGeneration) {
				// An explicit event committed newer state while the source was being read. Re-read instead
				// of allowing the older snapshot to overwrite that event.
				this._recordEvent({
					kind: 'snapshotDiscarded',
					level: AgentSessionCatalogEventLevel.Trace,
					trigger,
					generation: refreshGeneration,
					message: 'Catalog snapshot was discarded because an explicit catalog event committed newer content',
				});
				continue;
			}

			if (snapshot.kind === 'complete') {
				const failureRevision = this._failureRevision;
				this._commitComplete(snapshot.items);
				this._recordSuccess(refreshGeneration, trigger, failureRevision);
				return;
			}

			if (isCancellationError(snapshot.error)) {
				this._recordStoppedRefresh(token, refreshGeneration, trigger, 'Partial catalog source read was cancelled', true);
				return;
			}
			this._commitPartial(snapshot.items);
			if (!this._isCurrent(refreshGeneration, token)) {
				// A synchronous delta consumer requested a newer refresh while the partial commit event
				// was being delivered. The newer generation now owns failure handling and retry policy.
				this._recordStoppedRefresh(token, refreshGeneration, trigger, 'Partial snapshot failure handling was superseded');
				return;
			}
			this._handleFailure(snapshot.error, refreshGeneration, trigger);
			return;
		}
	}

	private _isCurrent(refreshGeneration: number, token: CancellationToken): boolean {
		return !this._isDisposed && !token.isCancellationRequested && refreshGeneration === this._refreshGeneration;
	}

	private _commitComplete(items: readonly T[]): void {
		const nextItems = new Map<string, T>();
		for (const item of items) {
			nextItems.set(this.options.keyOf(item), item);
		}

		const addedOrUpdated: T[] = [];
		for (const [key, item] of nextItems) {
			const previous = this._items.get(key);
			if (!previous || !this.options.equals(previous, item)) {
				addedOrUpdated.push(item);
			}
		}

		const removed: T[] = [];
		for (const [key, item] of this._items) {
			if (!nextItems.has(key)) {
				removed.push(item);
			}
		}

		this._items = nextItems;
		this._emitCommittedDelta(addedOrUpdated, removed);
	}

	private _commitPartial(items: readonly T[]): void {
		const addedOrUpdated: T[] = [];
		for (const item of items) {
			const key = this.options.keyOf(item);
			const previous = this._items.get(key);
			if (!previous || !this.options.equals(previous, item)) {
				this._items.set(key, item);
				addedOrUpdated.push(item);
			}
		}
		this._emitCommittedDelta(addedOrUpdated, []);
	}

	private _emitCommittedDelta(addedOrUpdated: readonly T[], removed: readonly T[]): void {
		if (addedOrUpdated.length === 0 && removed.length === 0) {
			return;
		}

		this._contentGeneration++;
		this._onDidChange.fire({
			...(addedOrUpdated.length > 0 ? { addedOrUpdated } : undefined),
			...(removed.length > 0 ? { removed } : undefined),
		});
	}

	private _handleFailure(error: unknown, refreshGeneration: number, trigger: IAgentSessionCatalogEvent['trigger']): void {
		const action = this.options.classifyError(error);
		const message = toErrorMessage(error);
		if (action === CatalogRefreshFailureAction.Throw) {
			this._failureAction = action;
			this._failureRevision++;
			this._recordEvent({
				kind: 'refreshFailed',
				level: AgentSessionCatalogEventLevel.Error,
				trigger,
				generation: refreshGeneration,
				message: `Catalog refresh failed with a non-recoverable error: ${message}`,
				attempt: this._consecutiveFailures + 1,
				failureAction: action,
			}, error);
			throw error;
		}

		this._consecutiveFailures++;
		this._failureAction = action;
		this._failureRevision++;
		this._recordEvent({
			kind: 'refreshFailed',
			level: this._consecutiveFailures === 1 ? AgentSessionCatalogEventLevel.Warning : AgentSessionCatalogEventLevel.Trace,
			trigger,
			generation: refreshGeneration,
			message: `Catalog refresh failed; preserving the last complete snapshot: ${message}`,
			attempt: this._consecutiveFailures,
			failureAction: action,
		}, error);

		this._scheduleRetry(refreshGeneration, trigger);
	}

	private _recordSuccess(refreshGeneration: number, trigger: IAgentSessionCatalogEvent['trigger'], failureRevision: number): void {
		if (failureRevision !== this._failureRevision) {
			// A synchronous delta consumer started a newer refresh which failed before this
			// commit finished broadcasting. That newer generation owns recovery state.
			this._recordEvent({
				kind: 'refreshSucceeded',
				level: AgentSessionCatalogEventLevel.Trace,
				trigger,
				generation: refreshGeneration,
				message: 'Catalog refresh committed successfully; a newer refresh owns recovery state',
			});
			return;
		}

		this._retryScheduler.cancel();
		const recoveredFailures = this._consecutiveFailures;
		this._consecutiveFailures = 0;
		this._failureAction = undefined;
		this._failureRevision++;
		if (recoveredFailures > 0) {
			this._recordEvent({
				kind: 'refreshRecovered',
				level: AgentSessionCatalogEventLevel.Info,
				trigger,
				generation: refreshGeneration,
				message: `Catalog refresh recovered after ${recoveredFailures} failed attempt(s)`,
				attempt: recoveredFailures,
			});
			return;
		}

		this._recordEvent({
			kind: 'refreshSucceeded',
			level: AgentSessionCatalogEventLevel.Trace,
			trigger,
			generation: refreshGeneration,
			message: 'Catalog refresh completed successfully',
		});
	}

	private _recordStoppedRefresh(
		token: CancellationToken,
		refreshGeneration: number,
		trigger: IAgentSessionCatalogEvent['trigger'],
		message: string,
		cancelled = token.isCancellationRequested,
	): void {
		this._recordEvent({
			kind: cancelled ? 'refreshCancelled' : 'snapshotDiscarded',
			level: AgentSessionCatalogEventLevel.Trace,
			trigger,
			generation: refreshGeneration,
			message,
		});
		if (cancelled) {
			// A foreground cancellation must not terminate a pre-existing independent recovery loop.
			this._scheduleRetry(refreshGeneration, trigger, 'Background recovery retry retained after cancellation');
		}
	}

	private _scheduleRetry(
		refreshGeneration: number,
		trigger: IAgentSessionCatalogEvent['trigger'],
		message = 'Background retry scheduled',
	): void {
		if (
			this._failureAction !== CatalogRefreshFailureAction.Retry
			|| this._retryDelays.length === 0
			|| this._retryScheduler.isScheduled()
			|| refreshGeneration !== this._refreshGeneration
			|| this._isDisposed
		) {
			return;
		}

		const retryIndex = Math.min(this._consecutiveFailures - 1, this._retryDelays.length - 1);
		const retryDelay = this._retryDelays[retryIndex];
		this._recordEvent({
			kind: 'retryScheduled',
			level: AgentSessionCatalogEventLevel.Trace,
			trigger,
			generation: refreshGeneration,
			message: `${message} in ${retryDelay}ms`,
			attempt: this._consecutiveFailures,
			retryDelay,
			failureAction: this._failureAction,
		});
		if (refreshGeneration === this._refreshGeneration && !this._isDisposed) {
			this._retryScheduler.schedule(retryDelay);
		}
	}

	private _recordEvent(
		event: Omit<IAgentSessionCatalogEvent, 'sequence' | 'timestamp' | 'catalog'>,
		error?: unknown,
	): void {
		const record: IAgentSessionCatalogEvent = {
			...event,
			sequence: ++this._eventSequence,
			timestamp: Date.now(),
			catalog: this.options.name,
		};
		if (this._eventHistoryLimit > 0) {
			this._eventHistory.push(record);
			if (this._eventHistory.length > this._eventHistoryLimit) {
				this._eventHistory.splice(0, this._eventHistory.length - this._eventHistoryLimit);
			}
		}
		const logMessage = `[${record.catalog}][${record.kind}] ${record.message}`;
		switch (record.level) {
			case AgentSessionCatalogEventLevel.Trace:
				this.logService.trace(logMessage);
				break;
			case AgentSessionCatalogEventLevel.Info:
				this.logService.info(logMessage);
				break;
			case AgentSessionCatalogEventLevel.Warning:
				this.logService.warn(logMessage, error);
				break;
			case AgentSessionCatalogEventLevel.Error:
				this.logService.error(logMessage, error);
				break;
		}
		this._onDidRecordEvent.fire(record);
	}

	override dispose(): void {
		this._isDisposed = true;
		this._refreshGeneration++;
		super.dispose();
	}
}
