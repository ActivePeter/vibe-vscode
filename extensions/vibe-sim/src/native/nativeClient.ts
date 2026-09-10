/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import WebSocket from 'ws';
import type { NativeConnectionInfo } from '../protocol';
import { isSafeSimPath } from '../simSurface';
import type { TransportHeaders } from '../transportProtocol';

export const nativeOrigin = 'https://sim.vscode.invalid';
const forbiddenHeader = /^(?:host|origin|cookie|set-cookie|authorization|www-authenticate|authentication-info|connection|content-length|accept-encoding|transfer-encoding|upgrade|forwarded|proxy-.*|sec-.*|x-original-host|x-forwarded-.*|x-vibe-.*|x-api-key)$/i;

/** Owns a private connection generation, never a runtime start or a browser login. */
export class NativeClient {
	private readonly lifetime = new AbortController();
	constructor(readonly runId: string, private readonly connection: NativeConnectionInfo, private readonly isCurrent: () => boolean) { }

	dispose(): void { this.lifetime.abort(); }

	private assertCurrent(): void {
		if (this.lifetime.signal.aborted || !this.isCurrent()) { throw new Error('The Sim connection has ended'); }
	}

	private headers(incoming: TransportHeaders = []): Headers {
		const result = new Headers();
		for (const [key, value] of incoming) { if (!forbiddenHeader.test(key)) { result.append(key, value); } }
		result.set('x-vibe-agent-gateway', this.connection.gateway);
		result.set('host', 'sim.vscode.invalid');
		result.set('origin', nativeOrigin);
		// Node fetch derives Host from its loopback URL. Only this private adapter
		// may supply the virtual authority that native Sim uses for same-origin checks.
		result.set('x-forwarded-host', 'sim.vscode.invalid');
		result.set('x-forwarded-proto', 'https');
		return result;
	}

	/** Redirects are followed only within this instance. Credentials cannot follow an external Location. */
	async request(route: string, options: { method?: string; headers?: TransportHeaders; body?: Uint8Array; signal?: AbortSignal; redirect?: 'follow' | 'manual' | 'error' } = {}) {
		this.assertCurrent();
		if (!isSafeSimPath(route)) { throw new Error('Invalid Sim route'); }
		let target = new URL(route, nativeOrigin);
		let method = options.method ?? 'GET';
		let body = options.body;
		const realtime = target.pathname.startsWith('/socket.io/');
		const origin = `http://127.0.0.1:${realtime ? this.connection.realtimePort : this.connection.applicationPort}`;
		for (let redirects = 0; redirects <= 8; redirects++) {
			this.assertCurrent();
			const url = new URL(`${target.pathname}${target.search}`, origin);
			const response = await fetch(url, {
				method, headers: this.headers(options.headers), body: body ? new Uint8Array(body) : undefined, redirect: 'manual',
				signal: AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : [])]),
			});
			this.assertCurrent();
			const location = response.headers.get('location');
			const redirect = location && [301, 302, 303, 307, 308].includes(response.status);
			const nextPath = redirect ? publicRoute(location, target, origin) : undefined;
			if (redirect && !nextPath) {
				await response.body?.cancel();
				throw new Error('Sim redirected outside this instance');
			}
			if (!redirect || options.redirect === 'manual') {
				return { response, headers: publicResponseHeaders(response.headers, target, origin), path: `${target.pathname}${target.search}`, redirected: redirects > 0 };
			}
			await response.body?.cancel();
			if (options.redirect === 'error') { throw new Error('Sim redirect was not permitted'); }
			target = new URL(nextPath!, nativeOrigin);
			if (response.status === 303 && method !== 'HEAD' || [301, 302].includes(response.status) && method === 'POST') { method = 'GET'; body = undefined; }
		}
		throw new Error('Too many Sim redirects');
	}

	openSocket(route: string, protocols: readonly string[]): WebSocket {
		this.assertCurrent();
		if (!isSafeSimPath(route) || new URL(route, nativeOrigin).pathname !== '/socket.io/') { throw new Error('Invalid Sim socket route'); }
		const socket = new WebSocket(`ws://127.0.0.1:${this.connection.realtimePort}${route}`, [...protocols], {
			headers: Object.fromEntries(this.headers()), followRedirects: false, handshakeTimeout: 10000, maxPayload: 32 * 1024 * 1024,
		});
		const abort = () => socket.terminate();
		this.lifetime.signal.addEventListener('abort', abort, { once: true });
		socket.once('close', () => this.lifetime.signal.removeEventListener('abort', abort));
		return socket;
	}
}

function publicRoute(value: string, target: URL, privateOrigin: string): string | undefined {
	try {
		const url = new URL(value, target);
		const route = `${url.pathname}${url.search}${url.hash}`;
		return [nativeOrigin, privateOrigin].includes(url.origin) && !url.username && !url.password && isSafeSimPath(route) ? route : undefined;
	} catch { return undefined; }
}

/** Only this adapter knows the private origin. Next router redirects become routes, not listener URLs. */
export function publicResponseHeaders(headers: Headers, target: URL, privateOrigin: string): [string, string][] {
	const result: [string, string][] = [];
	for (const [key, value] of headers) {
		// Node fetch already decodes compression. Middleware, preload and browser reporting
		// metadata are not part of the native API and may contain private absolute URLs.
		if (forbiddenHeader.test(key) || key.startsWith('x-middleware-') || [
			'content-encoding', 'content-security-policy', 'content-security-policy-report-only',
			'link', 'refresh', 'alt-svc', 'report-to', 'reporting-endpoints', 'sourcemap', 'x-sourcemap',
		].includes(key)) { continue; }
		if (['location', 'content-location', 'x-nextjs-redirect', 'x-action-redirect'].includes(key)) {
			const action = key === 'x-action-redirect' ? /^(.*);(push|replace)$/.exec(value) : null;
			const route = publicRoute(action?.[1] ?? value, target, privateOrigin);
			if (route) { result.push([key, action ? `${route};${action[2]}` : route]); }
		} else { result.push([key, value]); }
	}
	return result;
}
