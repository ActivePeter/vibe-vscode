/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, type IDisposable } from '../../../base/common/lifecycle.js';
import type { IPreparedWorkbenchCache, IWebClientCacheProgress } from './workbenchCache.js';

type StartupMode = 'unknown' | 'checking' | 'first' | 'reuse' | 'repair' | 'unavailable';
type StartupPhase = 'loading' | 'starting' | 'restoring' | 'slow' | 'error' | 'ready';

export interface IWorkbenchStartupState {
	readonly mode: StartupMode;
	readonly phase: StartupPhase;
	readonly progress: number;
	readonly cacheEnabled: boolean;
	readonly cache: IWebClientCacheProgress | undefined;
	readonly bytesPerSecond: number;
}

export interface IWorkbenchStartupHost {
	now(): number;
	delay(callback: () => void, milliseconds: number): IDisposable;
	interval(callback: () => void, milliseconds: number): IDisposable;
	loadCache(): Promise<Pick<typeof import('./workbenchCache.js'), 'isWorkbenchCacheSupported' | 'prepareWorkbenchCache'>>;
	startCached(prepared: IPreparedWorkbenchCache): Promise<void>;
	startNative(): Promise<void>;
	render(state: IWorkbenchStartupState): void;
	logError(error: unknown): void;
}

/** Owns transfer samples, not cache storage or the startup state machine. */
export class WorkbenchStartupMetrics {
	private readonly samples: { time: number; bytes: number }[] = [];
	private transferredBytes = 0;

	constructor(private readonly startedAt: number) { }

	accept(transferredBytes: number, now: number): void {
		const bytes = Math.max(0, transferredBytes - this.transferredBytes);
		this.transferredBytes = transferredBytes;
		if (bytes > 0) {
			this.samples.push({ time: now, bytes });
		}
	}

	bytesPerSecond(now: number): number {
		while (this.samples.length && this.samples[0].time <= now - 2000) {
			this.samples.shift();
		}
		return this.samples.reduce((total, sample) => total + sample.bytes, 0) / (Math.min(2000, Math.max(1, now - this.startedAt)) / 1000);
	}
}

/** Owns startup transitions and timers. Only the workbench readiness mark permits a cache commit. */
export class WorkbenchStartupController extends Disposable {
	private readonly timers = this._register(new DisposableStore());
	private readonly metrics: WorkbenchStartupMetrics;
	private state: Omit<IWorkbenchStartupState, 'bytesPerSecond'>;
	private prepared: IPreparedWorkbenchCache | undefined;
	private started = false;

	constructor(private readonly resourceCache: string | undefined, private readonly host: IWorkbenchStartupHost) {
		super();
		this.metrics = new WorkbenchStartupMetrics(host.now());
		this.state = { mode: resourceCache ? 'checking' : 'unknown', phase: 'loading', progress: resourceCache ? 0 : 18, cacheEnabled: !!resourceCache, cache: undefined };
	}

	private get active(): boolean {
		return !this._store.isDisposed && this.state.phase !== 'ready' && this.state.phase !== 'error';
	}

	private render(): void {
		if (!this._store.isDisposed) {
			this.host.render({ ...this.state, bytesPerSecond: this.active ? this.metrics.bytesPerSecond(this.host.now()) : 0 });
		}
	}

	private update(phase: StartupPhase, progress = this.state.progress): void {
		if (this.active) {
			this.state = { ...this.state, phase, progress: Math.max(this.state.progress, progress) };
			this.render();
		}
	}

	async start(): Promise<void> {
		if (this.started || !this.active) {
			return;
		}
		this.started = true;
		this.render();
		this.timers.add(this.host.delay(() => this.update('slow'), 60000));
		if (!this.resourceCache) {
			return; // The document's native module is already scheduled; never start it a second time.
		}
		this.timers.add(this.host.interval(() => this.render(), 500));
		try {
			const loader = await this.host.loadCache();
			if (!this.active) {
				return;
			}
			if (!loader.isWorkbenchCacheSupported()) {
				this.state = { ...this.state, cacheEnabled: false, mode: 'unavailable' };
				this.update('loading', 18);
				await this.host.startNative();
				this.resourcesLoaded();
				return;
			}
			const prepared = await loader.prepareWorkbenchCache(this.resourceCache, value => {
				if (!this.active) {
					return;
				}
				this.metrics.accept(value.transferredBytes, this.host.now());
				const mode: StartupMode = value.storage === 'unavailable' ? 'unavailable'
					: value.cachedBytes > 0 ? (value.transferredBytes > 0 ? 'repair' : 'reuse')
						: value.transferredBytes > 0 ? 'first' : 'checking';
				this.state = { ...this.state, mode, cache: { ...value } };
				this.update('loading', Math.round(value.completedBytes / Math.max(1, value.totalBytes) * 100));
			});
			if (!this.active) {
				return;
			}
			this.prepared = prepared;
			this.update('starting', 100);
			await this.host.startCached(prepared);
		} catch (error) {
			if (!this._store.isDisposed) {
				this.host.logError(error);
				this.fail();
			}
		}
	}

	resourcesLoaded(): void {
		if (this.state.phase !== 'restoring') {
			this.update('starting', 62);
		}
	}

	restoringWorkbench(): void {
		this.update('restoring', 84);
	}

	fail(): void {
		if (this.active) {
			this.state = { ...this.state, phase: 'error' };
			this.timers.clear();
			this.render();
		}
	}

	complete(): void {
		if (this._store.isDisposed || this.state.phase === 'ready') {
			return;
		}
		this.state = { ...this.state, phase: 'ready', progress: 100 };
		this.timers.clear();
		const prepared = this.prepared;
		this.prepared = undefined;
		// Readiness may arrive while import(blob:) is still awaiting its completion.
		// Clear ownership before starting the commit so repeated marks cannot commit twice.
		void prepared?.commit().catch(error => this.host.logError(error));
		this.render();
	}
}
