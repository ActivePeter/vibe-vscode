/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VibeProjectContext } from 'vibe-vscode';

export const sidebarViewId = 'vibe-vscode.sim.sidebar';
export const editorViewType = 'vibe-vscode.sim.editor';
export const defaultPath = '/workspace';
export const selectionMaxLength = 32_000;
export type SimSurface = 'sidebar' | 'editor' | 'monitor';

export interface HostContext extends VibeProjectContext {
	readonly language: string;
	readonly activeFile?: { readonly uri: string; readonly selection: SourceSelection['range'] };
}

/** Source text is captured only by an explicit editor action, never by ordinary context updates. */
export interface SourceSelection {
	readonly uri: string;
	readonly language: string;
	readonly text: string;
	readonly range: { readonly startLine: number; readonly startCharacter: number; readonly endLine: number; readonly endCharacter: number };
}

export interface CreateChatRequest {
	readonly requestId: string;
	readonly workspaceId?: string;
	readonly catalog: Pick<VibeProjectContext, 'physicalWorkspace' | 'logicalWorkspaces'>;
	readonly projectUri: string;
	readonly logicalWorkspaceId?: string;
	readonly selection: SourceSelection;
}

export interface SimMessage {
	readonly source: 'sim';
	readonly token: string;
	readonly type: 'ready' | 'routeChanged' | 'titleChanged' | 'chatCreated' | 'openEditor' | 'openMonitor' | 'openFile' | 'openDiff' | 'openTerminal' | 'openExternal';
	readonly payload?: {
		readonly path?: string; readonly userInitiated?: boolean; readonly title?: string;
		readonly uri?: string; readonly originalUri?: string; readonly modifiedUri?: string;
		readonly line?: number; readonly character?: number; readonly requestId?: string; readonly error?: string;
	};
}

/** All transport and navigation paths stay inside the packaged application's origin. */
export function isSafeSimPath(value: unknown): value is string {
	if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(value)) {
		return false;
	}
	try {
		const decoded = decodeURIComponent(value.split(/[?#]/, 1)[0]);
		return !decoded.startsWith('//') && !/[\\\u0000-\u001f\u007f]/.test(decoded)
			&& !decoded.split('/').some(part => part === '.' || part === '..');
	} catch { return false; }
}

export function resourcePath(route: string): string {
	const pathname = route.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
	return /^\/workspace\/[^/]+\/(?:w|d|chat)\/[^/]+/.exec(pathname)?.[0] ?? pathname;
}

export function isMonitorPath(route: string): boolean {
	return /^\/(?:workspace\/[^/]+\/)?agents\/?$/.test(route.split(/[?#]/, 1)[0]);
}

export function editorKey(route: string): string {
	return isMonitorPath(route) ? 'monitor' : `editor:${resourcePath(route)}`;
}

export function simWorkspaceId(route: string): string | undefined {
	return /^\/workspace\/([^/?#]+)(?:\/|[?#]|$)/.exec(route)?.[1];
}

export function surfacePath(route: string, surface: SimSurface): string {
	const url = new URL(route, 'https://sim.vscode.invalid');
	url.searchParams.set('_vscodeSurface', surface === 'sidebar' ? 'sidebar' : 'editor');
	return `${url.pathname}${url.search}${url.hash}`;
}

export function isSimMessage(value: unknown): value is SimMessage {
	if (typeof value !== 'object' || !value || !('source' in value) || value.source !== 'sim'
		|| !('token' in value) || typeof value.token !== 'string' || !('type' in value)
		|| !['ready', 'routeChanged', 'titleChanged', 'chatCreated', 'openEditor', 'openMonitor', 'openFile', 'openDiff', 'openTerminal', 'openExternal'].includes(String(value.type))) {
		return false;
	}
	if (!('payload' in value) || value.payload === undefined) { return true; }
	if (typeof value.payload !== 'object' || !value.payload || Array.isArray(value.payload)) { return false; }
	const payload = value.payload as Record<string, unknown>;
	for (const key of ['path', 'title', 'uri', 'originalUri', 'modifiedUri', 'requestId', 'error']) {
		if (key in payload && (typeof payload[key] !== 'string' || payload[key].length > 8192)) { return false; }
	}
	for (const key of ['line', 'character']) {
		if (key in payload && (!Number.isSafeInteger(payload[key]) || Number(payload[key]) < 0)) { return false; }
	}
	return !('userInitiated' in payload) || typeof payload.userInitiated === 'boolean';
}
