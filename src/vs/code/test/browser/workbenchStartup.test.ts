/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { FileAccess } from '../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import type { IWebClientStartupMessages } from '../../../platform/remote/common/webClientStartup.js';
import type { IPreparedWorkbenchCache, IWebClientCacheProgress } from '../../browser/workbench/workbenchCache.js';
import { IWorkbenchStartupHost, IWorkbenchStartupState, WorkbenchStartupController, WorkbenchStartupMetrics } from '../../browser/workbench/workbenchStartupController.js';
import { WorkbenchStartupView } from '../../browser/workbench/workbenchStartupView.js';

declare const __readFileInTests: (path: string) => Promise<string>;

suite('Workbench startup', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const manifest = 'https://example.test/static/version/out/cache/manifest.json';
	const progress: IWebClientCacheProgress = { totalBytes: 100, completedBytes: 50, cachedBytes: 0, transferredBytes: 25, completedChunks: 1, totalChunks: 2, storage: 'available' };

	function fixture(resourceCache: string | undefined = manifest) {
		const states: IWorkbenchStartupState[] = [];
		const calls = { loader: 0, prepare: 0, native: 0, cached: 0, commit: 0, errors: 0 };
		const timeouts = new Set<() => void>();
		const intervals = new Set<() => void>();
		const preparing = new DeferredPromise<void>();
		const executing = new DeferredPromise<void>();
		let report: (value: IWebClientCacheProgress) => void = () => { };
		const prepared: IPreparedWorkbenchCache = { script: new Blob(['']), style: new Blob(['']), commit: async () => { calls.commit++; } };
		const hooks: { supported: boolean; load?: Promise<Awaited<ReturnType<IWorkbenchStartupHost['loadCache']>>>; prepare?: Promise<IPreparedWorkbenchCache>; execute?: Promise<void> } = { supported: true };
		const loader = {
			isWorkbenchCacheSupported: () => hooks.supported,
			prepareWorkbenchCache: async (_url: string, onProgress: (value: IWebClientCacheProgress) => void) => {
				calls.prepare++;
				report = onProgress;
				void preparing.complete();
				return hooks.prepare ?? prepared;
			},
		};
		const host: IWorkbenchStartupHost = {
			now: () => 1000,
			delay: callback => { timeouts.add(callback); return toDisposable(() => timeouts.delete(callback)); },
			interval: callback => { intervals.add(callback); return toDisposable(() => intervals.delete(callback)); },
			loadCache: async () => { calls.loader++; return hooks.load ?? loader; },
			startCached: async () => { calls.cached++; void executing.complete(); await hooks.execute; },
			startNative: async () => { calls.native++; },
			render: value => states.push(value),
			logError: () => { calls.errors++; },
		};
		const controller = store.add(new WorkbenchStartupController(resourceCache, host));
		return { controller, states, calls, hooks, loader, prepared, preparing, executing, timeouts, intervals, report: (value: IWebClientCacheProgress) => report(value) };
	}

	test('native document startup is not duplicated and failure remains a reload state', async () => {
		const value = fixture('');
		await value.controller.start();
		await value.controller.start();
		value.controller.resourcesLoaded();
		value.controller.fail();
		assert.deepStrictEqual({ calls: value.calls, state: value.states.at(-1), timers: value.timeouts.size }, {
			calls: { loader: 0, prepare: 0, native: 0, cached: 0, commit: 0, errors: 0 },
			state: { mode: 'unknown', phase: 'error', progress: 62, cacheEnabled: false, cache: undefined, bytesPerSecond: 0 }, timers: 0,
		});
	});

	test('only authoritative readiness commits, including readiness during the cached import', async () => {
		const value = fixture();
		const execution = new DeferredPromise<void>();
		value.hooks.execute = execution.p;
		const pending = value.controller.start();
		await value.executing.p;
		assert.strictEqual(value.calls.commit, 0);
		value.controller.complete();
		value.controller.complete();
		await execution.complete();
		await pending;
		await value.controller.start();
		assert.deepStrictEqual({ calls: value.calls, phase: value.states.at(-1)?.phase, timers: value.timeouts.size + value.intervals.size }, {
			calls: { loader: 1, prepare: 1, native: 0, cached: 1, commit: 1, errors: 0 }, phase: 'ready', timers: 0,
		});
	});

	test('a late native module load cannot regress the observed workbench restore phase', async () => {
		const value = fixture('');
		await value.controller.start();
		value.controller.restoringWorkbench();
		value.controller.resourcesLoaded();
		assert.deepStrictEqual({ phases: value.states.map(state => state.phase), progress: value.states.at(-1)?.progress }, { phases: ['loading', 'restoring'], progress: 84 });
	});

	test('reports first, reuse, repair and unavailable from real chunk progress, not a saved readiness marker', async () => {
		const value = fixture();
		const preparation = new DeferredPromise<IPreparedWorkbenchCache>();
		value.hooks.prepare = preparation.p;
		const pending = value.controller.start();
		await value.preparing.p;
		value.report(progress);
		value.report({ ...progress, cachedBytes: 50, transferredBytes: 0 });
		value.report({ ...progress, cachedBytes: 25 });
		value.report({ ...progress, storage: 'unavailable' });
		assert.deepStrictEqual(value.states.map(state => state.mode), ['checking', 'first', 'reuse', 'repair', 'unavailable']);
		await preparation.complete(value.prepared);
		await pending;
		assert.deepStrictEqual({ native: value.calls.native, cached: value.calls.cached, cacheEnabled: value.states.at(-1)?.cacheEnabled }, { native: 0, cached: 1, cacheEnabled: true });
	});

	test('an unsupported cache API starts exactly one native module without recovery redirects', async () => {
		const value = fixture();
		value.hooks.supported = false;
		await value.controller.start();
		await value.controller.start();
		value.controller.fail();
		assert.deepStrictEqual({ calls: value.calls, state: value.states.at(-1) }, {
			calls: { loader: 1, prepare: 0, native: 1, cached: 0, commit: 0, errors: 0 },
			state: { mode: 'unavailable', phase: 'error', progress: 62, cacheEnabled: false, cache: undefined, bytesPerSecond: 0 },
		});
	});

	test('a preparation failure stops timers and ignores late progress without committing', async () => {
		const value = fixture();
		const preparation = new DeferredPromise<IPreparedWorkbenchCache>();
		value.hooks.prepare = preparation.p;
		const pending = value.controller.start();
		await value.preparing.p;
		await preparation.error(new Error('interrupted'));
		await pending;
		value.report(progress);
		value.controller.resourcesLoaded();
		assert.deepStrictEqual({ phase: value.states.at(-1)?.phase, cached: value.calls.cached, commits: value.calls.commit, errors: value.calls.errors, timers: value.timeouts.size + value.intervals.size }, { phase: 'error', cached: 0, commits: 0, errors: 1, timers: 0 });
	});

	test('disposal while the loader is pending cannot start native or cached work', async () => {
		const value = fixture();
		const loader = new DeferredPromise<typeof value.loader>();
		value.hooks.load = loader.p;
		const pending = value.controller.start();
		value.controller.dispose();
		await loader.complete(value.loader);
		await pending;
		assert.deepStrictEqual({ calls: value.calls, renders: value.states.length, timers: value.timeouts.size + value.intervals.size }, { calls: { loader: 1, prepare: 0, native: 0, cached: 0, commit: 0, errors: 0 }, renders: 1, timers: 0 });
	});

	test('disposal during preparation rejects late projection and readiness', async () => {
		const value = fixture();
		const preparation = new DeferredPromise<IPreparedWorkbenchCache>();
		value.hooks.prepare = preparation.p;
		const pending = value.controller.start();
		await value.preparing.p;
		value.controller.dispose();
		value.report(progress);
		await preparation.complete(value.prepared);
		await pending;
		value.controller.complete();
		assert.deepStrictEqual({ cached: value.calls.cached, commits: value.calls.commit, renders: value.states.length }, { cached: 0, commits: 0, renders: 1 });
	});

	test('slow loading is recoverable when progress resumes and preparation alone is not readiness', async () => {
		const value = fixture();
		const preparation = new DeferredPromise<IPreparedWorkbenchCache>();
		value.hooks.prepare = preparation.p;
		const pending = value.controller.start();
		await value.preparing.p;
		for (const timeout of value.timeouts) { timeout(); }
		value.report(progress);
		await preparation.complete(value.prepared);
		await pending;
		value.controller.restoringWorkbench();
		assert.deepStrictEqual({ phases: value.states.map(state => state.phase), progress: value.states.at(-1)?.progress, commits: value.calls.commit }, { phases: ['loading', 'slow', 'loading', 'starting', 'restoring'], progress: 100, commits: 0 });
	});

	test('a cache commit failure is reported without changing successful startup', async () => {
		const value = fixture();
		value.hooks.prepare = Promise.resolve({ ...value.prepared, commit: async () => { throw new Error('storage gone'); } });
		await value.controller.start();
		value.controller.complete();
		await Promise.resolve();
		assert.deepStrictEqual({ phase: value.states.at(-1)?.phase, errors: value.calls.errors }, { phase: 'ready', errors: 1 });
	});

	test('readiness before startup prevents a second workbench load', async () => {
		const value = fixture();
		value.controller.complete();
		await value.controller.start();
		assert.deepStrictEqual({ phase: value.states.at(-1)?.phase, loader: value.calls.loader, commits: value.calls.commit, timers: value.timeouts.size }, { phase: 'ready', loader: 0, commits: 0, timers: 0 });
	});

	test('metrics count only new compressed bytes and expire the two-second window', () => {
		const metrics = new WorkbenchStartupMetrics(0);
		metrics.accept(1000, 500);
		metrics.accept(1000, 1000);
		const first = metrics.bytesPerSecond(1000);
		metrics.accept(2000, 1500);
		assert.deepStrictEqual([first, metrics.bytesPerSecond(2500), metrics.bytesPerSecond(3500)], [1000, 500, 0]);
	});

	test('malformed startup markup fails without leaking a partially constructed view', async () => {
		const messages: IWebClientStartupMessages = JSON.parse(await __readFileInTests(FileAccess.asFileUri('vs/platform/remote/common/workbench-startup.nls.en.json').fsPath));
		const overlay = mainWindow.document.createElement('div');
		assert.throws(() => new WorkbenchStartupView(overlay, messages, () => { }), /Missing startup element/);
	});

	test('the external startup entry observes errors from the following native module', async () => {
		const messages: IWebClientStartupMessages = JSON.parse(await __readFileInTests(FileAccess.asFileUri('vs/platform/remote/common/workbench-startup.nls.en.json').fsPath));
		const frame = mainWindow.document.createElement('iframe');
		store.add(toDisposable(() => frame.remove()));
		const configuration = JSON.stringify({ messages }).replace(/"/g, '&quot;');
		const elements = ['mode', 'title', 'detail', 'progress', 'metrics', 'network', 'cache', 'action'].map(name => `<p id="vscode-workbench-startup-${name}"></p>`).join('');
		const startup = new URL('../../browser/workbench/workbenchStartup.js', import.meta.url).href;
		frame.srcdoc = `<div id="vscode-workbench-startup" data-settings="${configuration}">${elements}</div>
			<script type="module" src="${startup}"></script>
			<script id="vscode-workbench-main" type="module">
				document.getElementById('vscode-workbench-main').dispatchEvent(new Event('error'));
			</script>`;
		await new Promise<void>(resolve => {
			frame.onload = () => resolve();
			mainWindow.document.body.appendChild(frame);
		});
		const overlay = frame.contentDocument!.getElementById('vscode-workbench-startup')!;
		assert.deepStrictEqual({ state: overlay.getAttribute('data-state'), busy: overlay.getAttribute('aria-busy') }, { state: 'error', busy: 'false' });
	});

	test('view renders accessible chunk errors, native reloads and readiness without retaining click listeners', async () => {
		const messages: IWebClientStartupMessages = JSON.parse(await __readFileInTests(FileAccess.asFileUri('vs/platform/remote/common/workbench-startup.nls.en.json').fsPath));
		const overlay = mainWindow.document.createElement('div');
		for (const name of ['mode', 'title', 'detail', 'progress', 'metrics', 'network', 'cache', 'action']) {
			const element = mainWindow.document.createElement(name === 'action' ? 'button' : 'p');
			element.id = `vscode-workbench-startup-${name}`;
			overlay.appendChild(element);
		}
		let reloads = 0;
		const view = store.add(new WorkbenchStartupView(overlay, messages, () => reloads++));
		const action = overlay.querySelector('button')!;
		const bar = overlay.querySelector('#vscode-workbench-startup-progress')!;
		const state: IWorkbenchStartupState = { mode: 'repair', phase: 'error', progress: 50, cacheEnabled: true, cache: progress, bytesPerSecond: 0 };
		view.render(state);
		const chunkError = { label: action.textContent, value: bar.getAttribute('aria-valuenow'), detail: bar.getAttribute('aria-valuetext')?.startsWith(messages.chunkLoadError) };
		action.click();
		view.render({ ...state, cacheEnabled: false, cache: undefined });
		const nativeError = { label: action.textContent, metricsHidden: overlay.querySelector<HTMLElement>('#vscode-workbench-startup-metrics')!.hidden, detail: bar.getAttribute('aria-valuetext') };
		view.render({ ...state, phase: 'ready', progress: 100 });
		view.dispose();
		action.click();
		assert.deepStrictEqual({ chunkError, nativeError, reloads, ready: overlay.getAttribute('data-state'), busy: overlay.getAttribute('aria-busy'), hidden: action.hidden }, {
			chunkError: { label: messages.resumeDownload, value: null, detail: true },
			nativeError: { label: messages.reload, metricsHidden: true, detail: messages.loadError },
			reloads: 1, ready: 'ready', busy: 'false', hidden: true,
		});
	});
});
