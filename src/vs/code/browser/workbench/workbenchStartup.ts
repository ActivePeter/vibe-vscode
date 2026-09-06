/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../base/browser/window.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import type { IWebClientStartupConfiguration } from '../../../platform/remote/common/webClientStartup.js';
import { WorkbenchStartupController } from './workbenchStartupController.js';
import { WorkbenchStartupView } from './workbenchStartupView.js';

function startWorkbenchStartup(overlay: HTMLElement, mainScript: HTMLScriptElement, configuration: IWebClientStartupConfiguration): void {
	const resourceCache = configuration.resourceCache ? new URL(configuration.resourceCache, mainWindow.location.origin).href : undefined;
	const lifetime = new DisposableStore();
	const delay = (callback: () => void, milliseconds: number) => {
		const handle = mainWindow.setTimeout(callback, milliseconds);
		return toDisposable(() => mainWindow.clearTimeout(handle));
	};
	const interval = (callback: () => void, milliseconds: number) => {
		const handle = mainWindow.setInterval(callback, milliseconds);
		return toDisposable(() => mainWindow.clearInterval(handle));
	};
	const listen = (target: EventTarget, type: string, callback: () => void) => {
		target.addEventListener(type, callback);
		lifetime.add(toDisposable(() => target.removeEventListener(type, callback)));
	};
	let view: WorkbenchStartupView;
	try {
		view = lifetime.add(new WorkbenchStartupView(overlay, configuration.messages, () => mainWindow.location.reload()));
	} catch (error) {
		lifetime.dispose();
		throw error;
	}
	const controller = lifetime.add(new WorkbenchStartupController(resourceCache, {
		now: () => mainWindow.performance.now(), delay, interval,
		loadCache: () => import(new URL('loader.js', resourceCache).href),
		startNative: () => new Promise<void>((resolve, reject) => {
			const script = mainWindow.document.createElement('script');
			script.type = 'module';
			script.src = mainScript.src;
			listen(script, 'load', resolve);
			listen(script, 'error', () => reject(new Error('The native workbench module failed to load.')));
			mainWindow.document.body.appendChild(script);
		}),
		startCached: async prepared => {
			const text = await prepared.style.text();
			if (lifetime.isDisposed) {
				return;
			}
			const style = mainWindow.document.createElement('style');
			style.id = 'vscode-workbench-cached-styles';
			style.textContent = text;
			mainWindow.document.head.appendChild(style);
			const url = URL.createObjectURL(prepared.script);
			try {
				await import(url);
			} finally {
				URL.revokeObjectURL(url);
			}
		},
		render: state => {
			view.render(state);
			if (state.phase === 'ready') {
				const remove = () => {
					lifetime.dispose();
					overlay.remove();
				};
				lifetime.add(delay(remove, mainWindow.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220));
			}
		},
		logError: error => console.error('Unable to start the workbench.', error),
	}));

	// This module precedes the main module in both documents. Register synchronously:
	// no await may allow that module's load/error event to pass before its listener exists.
	listen(mainScript, 'load', () => controller.resourcesLoaded());
	listen(mainScript, 'error', () => controller.fail());
	listen(mainWindow, 'pagehide', () => lifetime.dispose());
	const mutations = new mainWindow.MutationObserver(() => {
		// eslint-disable-next-line no-restricted-syntax -- Observe the upstream workbench shell; this entry does not create it.
		if (mainWindow.document.querySelector('.monaco-workbench')) {
			mutations.disconnect();
			controller.restoringWorkbench();
		}
	});
	lifetime.add(toDisposable(() => mutations.disconnect()));
	mutations.observe(mainWindow.document.body, { childList: true });
	const checkReady = () => {
		if (mainWindow.performance.getEntriesByName('code/didStartWorkbench', 'mark').length) {
			controller.complete();
		}
	};
	if (mainWindow.PerformanceObserver) {
		const readiness = new mainWindow.PerformanceObserver(checkReady);
		lifetime.add(toDisposable(() => readiness.disconnect()));
		try {
			readiness.observe({ type: 'mark', buffered: true });
		} catch {
			readiness.observe({ entryTypes: ['mark'] });
		}
	} else {
		lifetime.add(interval(checkReady, 100));
	}
	checkReady();
	void controller.start();
}

// eslint-disable-next-line no-restricted-syntax -- Adopt the server-rendered startup document before the workbench loads.
const overlay = mainWindow.document.getElementById('vscode-workbench-startup');
// eslint-disable-next-line no-restricted-syntax -- The server owns this script tag and selects its native/cached mode.
const mainScript = mainWindow.document.querySelector<HTMLScriptElement>('#vscode-workbench-main');
if (overlay && mainScript) {
	const configuration: IWebClientStartupConfiguration = JSON.parse(overlay.getAttribute('data-settings')!);
	startWorkbenchStartup(overlay, mainScript, configuration);
}
