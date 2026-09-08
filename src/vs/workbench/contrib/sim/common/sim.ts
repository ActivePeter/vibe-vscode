/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const SIM_DEFAULT_PATH = '/workspace';

export type SimSurface = 'sidebar' | 'editor' | 'fullscreen';

/** A projection of extension API context, never a Session or Workspace ownership record. */
export interface ISimHostContext {
	readonly language: string;
	readonly activeFile?: {
		readonly uri: string;
		readonly selection?: {
			readonly startLine: number;
			readonly startCharacter: number;
			readonly endLine: number;
			readonly endCharacter: number;
		};
	};
}

export interface ISimMessage {
	readonly source: 'sim';
	readonly token: string;
	readonly type: 'ready' | 'routeChanged' | 'openEditor' | 'openFile' | 'openDiff' | 'openTerminal' | 'openExternal';
	readonly payload?: {
		readonly path?: string;
		readonly userInitiated?: boolean;
		readonly uri?: string;
		readonly originalUri?: string;
		readonly modifiedUri?: string;
		readonly title?: string;
		readonly line?: number;
		readonly character?: number;
	};
}

const unsafePathCharacters = /[\\\u0000-\u001F\u007F]/;

/** A Sim route cannot escape or traverse the configured root, including after URL decoding. */
export function isSafeSimPath(value: unknown): value is string {
	if (typeof value !== 'string' || !value.startsWith('/') || unsafePathCharacters.test(value)) {
		return false;
	}
	try {
		const decodedPath = decodeURIComponent(value.split(/[?#]/, 1)[0]);
		return !decodedPath.startsWith('//')
			&& !decodedPath.split('/').some(segment => segment === '.' || segment === '..')
			&& !unsafePathCharacters.test(decodedPath);
	} catch {
		return false;
	}
}

/** Validate the wire envelope before interpreting payloads or dispatching capabilities. */
export function isSimMessage(value: unknown): value is ISimMessage {
	if (typeof value !== 'object' || value === null || !('source' in value) || value.source !== 'sim'
		|| !('token' in value) || typeof value.token !== 'string' || !('type' in value) || typeof value.type !== 'string') {
		return false;
	}
	if (!['ready', 'routeChanged', 'openEditor', 'openFile', 'openDiff', 'openTerminal', 'openExternal'].includes(value.type)) {
		return false;
	}
	if (!('payload' in value) || value.payload === undefined) {
		return true;
	}
	if (typeof value.payload !== 'object' || value.payload === null || Array.isArray(value.payload)) {
		return false;
	}
	const payload = value.payload as Record<string, unknown>;
	for (const key of ['path', 'uri', 'originalUri', 'modifiedUri', 'title'] as const) {
		if (key in payload && typeof payload[key] !== 'string') {
			return false;
		}
	}
	for (const key of ['line', 'character'] as const) {
		if (key in payload && (typeof payload[key] !== 'number' || !Number.isSafeInteger(payload[key]) || payload[key] < 0)) {
			return false;
		}
	}
	return !('userInitiated' in payload) || typeof payload.userInitiated === 'boolean';
}
