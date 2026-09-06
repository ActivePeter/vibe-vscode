/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { safeIntl } from '../../../base/common/date.js';
import type { IWebClientStartupMessages } from '../../../platform/remote/common/webClientStartup.js';
import type { IWorkbenchStartupState } from './workbenchStartupController.js';

/** Projects startup state into the existing accessible overlay; owns no loading or persistence. */
export class WorkbenchStartupView extends Disposable {
	private readonly numberFormats = [0, 1, 2].map(maximumFractionDigits => safeIntl.NumberFormat(undefined, { maximumFractionDigits }));
	private readonly mode: HTMLElement;
	private readonly title: HTMLElement;
	private readonly detail: HTMLElement;
	private readonly progress: HTMLElement;
	private readonly metrics: HTMLElement;
	private readonly network: HTMLElement;
	private readonly cache: HTMLElement;
	private readonly action: HTMLButtonElement;

	constructor(private readonly overlay: HTMLElement, private readonly messages: IWebClientStartupMessages, reload: () => void) {
		super();
		const element = (name: string) => {
			// eslint-disable-next-line no-restricted-syntax -- These fixed IDs are the server-rendered startup template's contract.
			const value = overlay.querySelector<HTMLElement>(`#vscode-workbench-startup-${name}`);
			if (!value) {
				this.dispose();
				throw new Error(`Missing startup element: ${name}`);
			}
			return value;
		};
		this.mode = element('mode');
		this.title = element('title');
		this.detail = element('detail');
		this.progress = element('progress');
		this.metrics = element('metrics');
		this.network = element('network');
		this.cache = element('cache');
		this.action = element('action') as HTMLButtonElement;
		this.action.addEventListener('click', reload);
		this._register(toDisposable(() => this.action.removeEventListener('click', reload)));
	}

	private format(template: string, ...values: (string | number)[]): string {
		return template.replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)] ?? ''));
	}

	private bytes(bytes: number): string {
		let value = bytes;
		let unit = 0;
		while (value >= 1024 && unit < this.messages.byteUnits.length - 1) {
			value /= 1024;
			unit++;
		}
		const maximumFractionDigits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
		return `${this.numberFormats[maximumFractionDigits].value.format(value)} ${this.messages.byteUnits[unit]}`;
	}

	render(state: IWorkbenchStartupState): void {
		const messages = this.messages;
		this.overlay.setAttribute('data-cache-mode', state.mode);
		this.overlay.setAttribute('data-state', state.phase);
		this.overlay.setAttribute('aria-busy', String(state.phase !== 'ready' && state.phase !== 'error'));
		this.mode.textContent = messages[`${state.mode}Mode`];
		this.title.textContent = messages[`${state.mode}Title`];
		this.detail.textContent = {
			loading: messages.loadingResources, starting: messages.startingWorkbench,
			restoring: messages.restoringWorkbench, slow: messages.slowLoading,
			error: state.cacheEnabled ? messages.chunkLoadError : messages.loadError, ready: messages.ready,
		}[state.phase];
		this.overlay.style.setProperty('--vscode-workbench-startup-progress', `${state.progress}%`);
		this.progress.setAttribute('aria-label', state.cacheEnabled ? messages.resourceProgressLabel : messages.progressLabel);
		if (state.phase === 'error') {
			this.progress.removeAttribute('aria-valuenow');
		} else {
			this.progress.setAttribute('aria-valuenow', String(state.progress));
		}
		this.metrics.hidden = this.network.hidden = this.cache.hidden = !state.cache;
		if (state.cache) {
			const value = state.cache;
			this.metrics.textContent = this.format(messages.preparedBytes, this.bytes(value.completedBytes), this.bytes(value.totalBytes), Math.round(value.completedBytes / Math.max(1, value.totalBytes) * 100));
			this.network.textContent = this.format(messages.networkBytes, this.bytes(state.bytesPerSecond), this.bytes(value.transferredBytes));
			this.cache.textContent = this.format(messages.cachedChunks, this.bytes(value.cachedBytes), Math.round(value.cachedBytes / Math.max(1, value.completedBytes) * 100), value.completedChunks, value.totalChunks);
			this.network.title = this.cache.title = messages.chunkDescription;
		}
		this.progress.setAttribute('aria-valuetext', [this.detail, this.metrics, this.network, this.cache].filter(element => !element.hidden).map(element => element.textContent).join('. '));
		this.action.hidden = state.phase !== 'slow' && state.phase !== 'error';
		this.action.textContent = state.phase === 'error' && state.cacheEnabled ? messages.resumeDownload : messages.reload;
	}
}
