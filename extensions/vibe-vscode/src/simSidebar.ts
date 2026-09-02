/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	isSafeSimPath,
	isSimWebviewMessage,
	renderSimWebview,
	type SimWebviewMessage,
	SimWebviewMessageType,
	SimWebviewSurface,
} from './simWebview';
import type { VibeSubPluginHostContext } from './subplugins';

export interface SimSidebarActions {
	readonly handleMessage: (message: SimWebviewMessage) => Promise<void>;
	readonly observeRoute: (path: string) => void;
	readonly openEditor: (path: string) => void;
}

/** Projects Sim's native navigation tree into the Activity Bar container. */
export class SimSidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private currentPath = '/workspace';
	private view: vscode.WebviewView | undefined;
	private viewDisposable: vscode.Disposable | undefined;

	constructor(
		private readonly actions: SimSidebarActions,
		private configuredBaseUrl: string,
		private hostContext: VibeSubPluginHostContext,
	) { }

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.viewDisposable?.dispose();
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		this.render();

		const subscriptions: vscode.Disposable[] = [];
		subscriptions.push(webviewView.webview.onDidReceiveMessage(message => this.handleMessage(message)));
		subscriptions.push(webviewView.onDidDispose(() => {
			if (this.view === webviewView) {
				this.view = undefined;
				this.viewDisposable = undefined;
			}
		}));
		this.viewDisposable = vscode.Disposable.from(...subscriptions);
	}

	updateBaseUrl(configuredBaseUrl: string): void {
		this.configuredBaseUrl = configuredBaseUrl;
		this.render();
	}

	updateHostContext(hostContext: VibeSubPluginHostContext): void {
		this.hostContext = hostContext;
		if (this.view) {
			void this.view.webview.postMessage({ source: 'vibe-extension', type: 'context', context: hostContext });
		}
	}

	navigate(path: string): void {
		if (!isSafeSimPath(path)) {
			return;
		}
		if (this.currentPath === path) {
			return;
		}
		this.currentPath = path;
		if (this.view) {
			void this.view.webview.postMessage({ source: 'vibe-extension', type: 'navigate', path });
		}
	}

	dispose(): void {
		this.viewDisposable?.dispose();
		this.viewDisposable = undefined;
		this.view = undefined;
	}

	private handleMessage(value: unknown): void {
		if (!isSimWebviewMessage(value)) {
			return;
		}

		if (value.type === SimWebviewMessageType.OpenEditor && isSafeSimPath(value.path)) {
			this.actions.openEditor(value.path);
			return;
		}
		if (value.type === SimWebviewMessageType.RouteChanged && isSafeSimPath(value.path)) {
			this.currentPath = value.path;
			if (value.userInitiated) {
				this.actions.openEditor(value.path);
			} else {
				this.actions.observeRoute(value.path);
			}
			return;
		}
		void this.actions.handleMessage(value);
	}

	private render(): void {
		if (!this.view) {
			return;
		}
		this.view.webview.html = renderSimWebview({
			configuredBaseUrl: this.configuredBaseUrl,
			hostContext: this.hostContext,
			initialPath: this.currentPath,
			surface: SimWebviewSurface.Sidebar,
		});
	}
}
