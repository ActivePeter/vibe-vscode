/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { runWithFakedTimers } from '../../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { AgentSessionCatalog, AgentSessionCatalogEventLevel, cancelledCatalogSnapshot, CatalogRefreshFailureAction, CatalogSnapshot, completeCatalogSnapshot, partialCatalogSnapshot } from '../../../browser/agentSessions/agentSessionCatalog.js';

interface ITestCatalogItem {
	readonly id: string;
	readonly value: number;
}

class RecordingLogService extends NullLogService {
	readonly entries: { readonly level: 'trace' | 'info' | 'warning' | 'error'; readonly message: string }[] = [];

	override trace(message: string): void {
		this.entries.push({ level: 'trace', message });
	}

	override info(message: string): void {
		this.entries.push({ level: 'info', message });
	}

	override warn(message: string): void {
		this.entries.push({ level: 'warning', message });
	}

	override error(message: string | Error): void {
		this.entries.push({ level: 'error', message: String(message) });
	}
}

suite('AgentSessionCatalog', () => {
	const disposables = new DisposableStore();

	teardown(() => disposables.clear());

	ensureNoDisposablesAreLeakedInTestSuite();

	function createCatalog(
		read: (token: CancellationToken) => Promise<CatalogSnapshot<ITestCatalogItem>>,
		classifyError: (error: unknown) => CatalogRefreshFailureAction = () => CatalogRefreshFailureAction.Preserve,
		retryDelays: readonly number[] = [],
		logService: NullLogService = new NullLogService(),
		eventHistoryLimit?: number,
	): AgentSessionCatalog<ITestCatalogItem> {
		return disposables.add(new AgentSessionCatalog({
			name: 'TestCatalog',
			keyOf: item => item.id,
			equals: (left, right) => left.id === right.id && left.value === right.value,
			read,
			classifyError,
			retryDelays,
			eventHistoryLimit,
		}, logService));
	}

	test('complete snapshots replace state while partial snapshots can only merge', async () => {
		let snapshot: CatalogSnapshot<ITestCatalogItem> = completeCatalogSnapshot([
			{ id: 'a', value: 1 },
			{ id: 'b', value: 1 },
		]);
		const catalog = createCatalog(async () => snapshot);
		await catalog.refresh(CancellationToken.None);

		const deltas: { addedOrUpdated: string[]; removed: string[] }[] = [];
		disposables.add(catalog.onDidChange(delta => deltas.push({
			addedOrUpdated: (delta.addedOrUpdated ?? []).map(item => `${item.id}:${item.value}`),
			removed: (delta.removed ?? []).map(item => item.id),
		})));

		snapshot = partialCatalogSnapshot([{ id: 'a', value: 2 }], new Error('history unavailable'));
		await catalog.refresh(CancellationToken.None);
		assert.deepStrictEqual({
			items: catalog.items,
			deltas,
		}, {
			items: [{ id: 'a', value: 2 }, { id: 'b', value: 1 }],
			deltas: [{ addedOrUpdated: ['a:2'], removed: [] }],
		});

		snapshot = completeCatalogSnapshot([{ id: 'a', value: 2 }]);
		await catalog.refresh(CancellationToken.None);
		assert.deepStrictEqual({
			items: catalog.items,
			deltas,
		}, {
			items: [{ id: 'a', value: 2 }],
			deltas: [
				{ addedOrUpdated: ['a:2'], removed: [] },
				{ addedOrUpdated: [], removed: ['b'] },
			],
		});
	});

	test('cancelled snapshots preserve committed state without publishing a delta', async () => {
		let snapshot: CatalogSnapshot<ITestCatalogItem> = completeCatalogSnapshot([{ id: 'a', value: 1 }]);
		const catalog = createCatalog(async () => snapshot);
		await catalog.refresh(CancellationToken.None);

		let changeCount = 0;
		disposables.add(catalog.onDidChange(() => changeCount++));
		snapshot = cancelledCatalogSnapshot();
		await catalog.refresh(CancellationToken.None);

		assert.deepStrictEqual({ items: catalog.items, changeCount }, {
			items: [{ id: 'a', value: 1 }],
			changeCount: 0,
		});
	});

	test('a superseded refresh cannot overwrite a newer complete snapshot', async () => {
		const olderRead = new DeferredPromise<CatalogSnapshot<ITestCatalogItem>>();
		let readCount = 0;
		const catalog = createCatalog(async () => {
			readCount++;
			if (readCount === 1) {
				return olderRead.p;
			}
			return completeCatalogSnapshot([{ id: 'newer', value: 2 }]);
		});

		const olderRefresh = catalog.refresh(CancellationToken.None);
		await timeout(0);
		await catalog.refresh(CancellationToken.None);
		olderRead.complete(completeCatalogSnapshot([{ id: 'older', value: 1 }]));
		await olderRefresh;

		assert.deepStrictEqual({ readCount, items: catalog.items }, {
			readCount: 2,
			items: [{ id: 'newer', value: 2 }],
		});
	});

	test('no-op authoritative events invalidate older complete snapshots without emitting deltas', async () => {
		const item = { id: 'a', value: 1 };
		const olderUpsertRead = new DeferredPromise<CatalogSnapshot<ITestCatalogItem>>();
		const upsertReadStarted = new DeferredPromise<void>();
		let upsertReadCount = 0;
		const upsertCatalog = createCatalog(async () => {
			upsertReadCount++;
			if (upsertReadCount === 1) {
				return completeCatalogSnapshot([item]);
			}
			if (upsertReadCount === 2) {
				await upsertReadStarted.complete();
				return olderUpsertRead.p;
			}
			return completeCatalogSnapshot([item]);
		});
		await upsertCatalog.refresh(CancellationToken.None);
		let upsertDeltaCount = 0;
		disposables.add(upsertCatalog.onDidChange(() => upsertDeltaCount++));
		const upsertRefresh = upsertCatalog.refresh(CancellationToken.None);
		await upsertReadStarted.p;
		upsertCatalog.upsert(item);
		await olderUpsertRead.complete(completeCatalogSnapshot([]));
		await upsertRefresh;

		const olderDeleteRead = new DeferredPromise<CatalogSnapshot<ITestCatalogItem>>();
		const deleteReadStarted = new DeferredPromise<void>();
		let deleteReadCount = 0;
		const deleteCatalog = createCatalog(async () => {
			deleteReadCount++;
			if (deleteReadCount === 1) {
				await deleteReadStarted.complete();
				return olderDeleteRead.p;
			}
			return completeCatalogSnapshot([]);
		});
		let deleteDeltaCount = 0;
		disposables.add(deleteCatalog.onDidChange(() => deleteDeltaCount++));
		const deleteRefresh = deleteCatalog.refresh(CancellationToken.None);
		await deleteReadStarted.p;
		deleteCatalog.delete(item.id);
		await olderDeleteRead.complete(completeCatalogSnapshot([item]));
		await deleteRefresh;

		assert.deepStrictEqual({
			upsert: { readCount: upsertReadCount, items: upsertCatalog.items, deltaCount: upsertDeltaCount },
			delete: { readCount: deleteReadCount, items: deleteCatalog.items, deltaCount: deleteDeltaCount },
		}, {
			upsert: { readCount: 3, items: [item], deltaCount: 0 },
			delete: { readCount: 2, items: [], deltaCount: 0 },
		});
	});

	test('a reentrant newer failure retains ownership of the background retry', () => runWithFakedTimers({ maxTaskCount: 10 }, async () => {
		let readCount = 0;
		const catalog = createCatalog(() => {
			readCount++;
			if (readCount === 3) {
				throw new Error('newer refresh failed synchronously');
			}
			return Promise.resolve(completeCatalogSnapshot([{
				id: readCount === 1 ? 'seed' : readCount === 2 ? 'committed' : 'recovered',
				value: readCount,
			}]));
		}, () => CatalogRefreshFailureAction.Retry, [10]);
		await catalog.refresh(CancellationToken.None);

		let requestedReentrantRefresh = false;
		disposables.add(catalog.onDidChange(() => {
			if (!requestedReentrantRefresh) {
				requestedReentrantRefresh = true;
				void catalog.refresh(CancellationToken.None);
			}
		}));
		await catalog.refresh(CancellationToken.None);
		await timeout(11);

		assert.deepStrictEqual({
			readCount,
			items: catalog.items,
			retryEvents: catalog.eventHistory
				.filter(event => event.kind === 'retryScheduled' || event.kind === 'refreshRecovered')
				.map(event => ({ kind: event.kind, trigger: event.trigger })),
		}, {
			readCount: 4,
			items: [{ id: 'recovered', value: 4 }],
			retryEvents: [
				{ kind: 'retryScheduled', trigger: 'foreground' },
				{ kind: 'refreshRecovered', trigger: 'retry' },
			],
		});
	}));

	test('structured event history is bounded', async () => {
		const catalog = createCatalog(
			async () => completeCatalogSnapshot([{ id: 'a', value: 1 }]),
			undefined,
			[],
			new NullLogService(),
			2,
		);

		await catalog.refresh(CancellationToken.None);
		await catalog.refresh(CancellationToken.None);

		assert.deepStrictEqual(catalog.eventHistory.map(event => ({ sequence: event.sequence, kind: event.kind })), [
			{ sequence: 3, kind: 'refreshStarted' },
			{ sequence: 4, kind: 'refreshSucceeded' },
		]);
	});

	test('preserve and throw failure actions keep the last complete snapshot', async () => {
		const state: { error?: Error } = {};
		const preserveLog = new RecordingLogService();
		const preserved = createCatalog(async () => {
			if (state.error) {
				throw state.error;
			}
			return completeCatalogSnapshot([{ id: 'a', value: 1 }]);
		}, undefined, [], preserveLog);
		await preserved.refresh(CancellationToken.None);
		state.error = new Error('preserved failure');
		await preserved.refresh(CancellationToken.None);

		const throwLog = new RecordingLogService();
		const rejected = createCatalog(
			async () => { throw new Error('fatal failure'); },
			() => CatalogRefreshFailureAction.Throw,
			[],
			throwLog,
		);
		await assert.rejects(rejected.refresh(CancellationToken.None), /fatal failure/);

		assert.deepStrictEqual({
			preservedItems: preserved.items,
			preserveEvents: preserved.eventHistory.filter(event => event.level === AgentSessionCatalogEventLevel.Warning).map(event => event.kind),
			preserveWarnings: preserveLog.entries.filter(entry => entry.level === 'warning').length,
			throwEvents: rejected.eventHistory.filter(event => event.level === AgentSessionCatalogEventLevel.Error).map(event => event.kind),
			throwErrors: throwLog.entries.filter(entry => entry.level === 'error').length,
		}, {
			preservedItems: [{ id: 'a', value: 1 }],
			preserveEvents: ['refreshFailed'],
			preserveWarnings: 1,
			throwEvents: ['refreshFailed'],
			throwErrors: 1,
		});
	});

	test('retry failures recover in the catalog-owned background loop', () => runWithFakedTimers({ maxTaskCount: 10 }, async () => {
		let readCount = 0;
		const recordedEvents: { readonly kind: string; readonly trigger: string }[] = [];
		const logService = new RecordingLogService();
		const catalog = createCatalog(async () => {
			readCount++;
			if (readCount === 1) {
				return completeCatalogSnapshot([{ id: 'a', value: 1 }]);
			}
			if (readCount === 2) {
				throw new Error('temporary failure');
			}
			return completeCatalogSnapshot([{ id: 'b', value: 1 }]);
		}, () => CatalogRefreshFailureAction.Retry, [10], logService);

		await catalog.refresh(CancellationToken.None);
		disposables.add(catalog.onDidRecordEvent(event => recordedEvents.push({ kind: event.kind, trigger: event.trigger })));
		await catalog.refresh(CancellationToken.None);
		assert.deepStrictEqual({ readCount, items: catalog.items }, {
			readCount: 2,
			items: [{ id: 'a', value: 1 }],
		});

		await catalog.refresh(CancellationToken.Cancelled);
		await timeout(11);
		assert.deepStrictEqual({
			readCount,
			items: catalog.items,
			recordedEvents,
			warningLogs: logService.entries.filter(entry => entry.level === 'warning').length,
			errorLogs: logService.entries.filter(entry => entry.level === 'error').length,
		}, {
			readCount: 3,
			items: [{ id: 'b', value: 1 }],
			recordedEvents: [
				{ kind: 'refreshStarted', trigger: 'foreground' },
				{ kind: 'refreshFailed', trigger: 'foreground' },
				{ kind: 'retryScheduled', trigger: 'foreground' },
				{ kind: 'retrySuperseded', trigger: 'foreground' },
				{ kind: 'refreshStarted', trigger: 'foreground' },
				{ kind: 'refreshCancelled', trigger: 'foreground' },
				{ kind: 'retryScheduled', trigger: 'foreground' },
				{ kind: 'refreshStarted', trigger: 'retry' },
				{ kind: 'refreshRecovered', trigger: 'retry' },
			],
			warningLogs: 1,
			errorLogs: 0,
		});
	}));
});
