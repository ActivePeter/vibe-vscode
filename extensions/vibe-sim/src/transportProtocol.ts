/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isSafeSimPath } from './simSurface';

export const transportSource = 'sim-native-transport';
export const maxBodyBytes = 32 * 1024 * 1024;
// Sim's existing upload sessions use a single PUT through 50 MiB, then 8 MiB parts.
export const maxRequestBodyBytes = 64 * 1024 * 1024;
export const maxChunkBytes = 64 * 1024;
export type TransportHeaders = readonly (readonly [string, string])[];

interface Envelope {
	readonly source: typeof transportSource;
	readonly token: string;
	readonly id: number;
}

/** The browser sends a route, never a listener address, credential or arbitrary command. */
export type TransportRequest = Envelope & (
	| { readonly type: 'fetch'; readonly path: string; readonly method: string; readonly headers: TransportHeaders; readonly body?: Uint8Array; readonly redirect: 'follow' | 'manual' | 'error' }
	| { readonly type: 'pull' | 'cancel' | 'socketAck' }
	| { readonly type: 'socketOpen'; readonly path: string; readonly protocols: readonly string[] }
	| { readonly type: 'socketSend'; readonly data: string | Uint8Array }
	| { readonly type: 'socketClose'; readonly code?: number; readonly reason?: string }
);

export type TransportReply = Envelope & (
	| { readonly type: 'response'; readonly status: number; readonly statusText: string; readonly headers: TransportHeaders; readonly path: string; readonly redirected: boolean; readonly body: boolean }
	| { readonly type: 'chunk'; readonly data: Uint8Array }
	| { readonly type: 'end' | 'error' | 'socketError' }
	| { readonly type: 'socketOpened'; readonly protocol: string; readonly extensions: string }
	| { readonly type: 'socketData'; readonly data: string | Uint8Array }
	| { readonly type: 'socketSent'; readonly bytes: number }
	| { readonly type: 'socketClosed'; readonly code: number; readonly reason: string; readonly clean: boolean }
);

export type TransportReplyPayload<T = TransportReply> = T extends TransportReply ? Omit<T, 'source' | 'token'> : never;

export function isTransportRequest(value: unknown): value is TransportRequest {
	if (typeof value !== 'object' || !value || !('source' in value) || value.source !== transportSource
		|| !('token' in value) || typeof value.token !== 'string' || !('id' in value)
		|| !Number.isSafeInteger(value.id) || Number(value.id) < 1 || !('type' in value)) { return false; }
	const message = value as TransportRequest;
	switch (message.type) {
		case 'fetch':
			return isSafeSimPath(message.path) && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(message.method)
				&& ['follow', 'manual', 'error'].includes(message.redirect) && Array.isArray(message.headers) && message.headers.length <= 128
				&& message.headers.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(part => typeof part === 'string' && part.length <= 64 * 1024))
				&& (message.body === undefined || message.body instanceof Uint8Array && message.body.byteLength <= maxRequestBodyBytes);
		case 'pull': case 'cancel': case 'socketAck': return true;
		case 'socketOpen':
			return isSafeSimPath(message.path) && message.path.split('?')[0] === '/socket.io/'
				&& Array.isArray(message.protocols) && message.protocols.length <= 16 && message.protocols.every(protocol => typeof protocol === 'string' && /^[\w!#$%&'*+.^`|~-]{1,256}$/.test(protocol));
		case 'socketSend': return typeof message.data === 'string' ? message.data.length <= maxBodyBytes : message.data instanceof Uint8Array && message.data.byteLength <= maxBodyBytes;
		case 'socketClose': return (message.code === undefined || message.code === 1000 || Number.isInteger(message.code) && message.code >= 3000 && message.code < 5000)
			&& (message.reason === undefined || typeof message.reason === 'string' && new TextEncoder().encode(message.reason).byteLength <= 123);
		default: return false;
	}
}
