/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';

const compiled = buildSync({
	entryPoints: [fileURLToPath(new URL('../src/simWebview.ts', import.meta.url))],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	external: ['vscode'],
	write: false,
}).outputFiles[0].text;
const simWebview = runInNewContext(`${compiled}\nmodule.exports;`, {
	module: { exports: {} },
	require: (name: string) => {
		assert.strictEqual(name, 'vscode');
		return { env: { language: 'en' }, l10n: { t: (value: string) => value } };
	},
}) as typeof import('../src/simWebview.ts');

class TestElement extends EventTarget {
	className = '';
	textContent = '';
	dataset: Record<string, string> = {};
	src = '';
}

class TestPermission extends EventTarget {
	state: 'prompt' | 'granted' | 'denied';

	constructor(state: TestPermission['state']) {
		super();
		this.state = state;
	}

	change(state: TestPermission['state']): void {
		this.state = state;
		this.dispatchEvent(new Event('change'));
	}
}

/** Runs the actual generated webview script with controllable browser boundaries. */
async function createWebview(permissionState: TestPermission['state'] = 'prompt', configuredBaseUrl = '') {
	const permission = new TestPermission(permissionState);
	let permissionQuery = () => Promise.resolve(permission);
	const elements = new Map(['sim', 'overlay', 'failure-title', 'failure-description', 'failure-help', 'retry'].map(id => [id, new TestElement()]));
	const getElement = (id: string) => elements.get(id)!;
	const frame = getElement('sim');
	const hostMessages: object[] = [];
	const simMessages: object[] = [];
	const contentWindow = { postMessage: (message: object) => simMessages.push(message) };
	Object.assign(frame, { contentWindow });
	const window = Object.assign(new EventTarget(), { location: { ancestorOrigins: ['https://workbench.example'] } });
	const timers = new Map<number, () => void>();
	let timerId = 0;
	const probes: { url: string; signal: AbortSignal; result: ReturnType<typeof Promise.withResolvers<{ ok: boolean }>> }[] = [];
	const html = simWebview.renderSimWebview({
		configuredBaseUrl,
		hostContext: { language: 'en' },
		initialPath: '/workspace',
		surface: simWebview.SimWebviewSurface.Sidebar,
	});
	const script = /<script nonce="[^"]+">(?<script>[\s\S]*?)<\/script>/.exec(html)?.groups?.script;
	assert.ok(script);
	runInNewContext(script, {
		window,
		document: { getElementById: getElement, referrer: '' },
		navigator: { permissions: { query: () => permissionQuery() } },
		URL,
		AbortController,
		fetch: (url: URL, options: { signal: AbortSignal }) => {
			const result = Promise.withResolvers<{ ok: boolean }>();
			probes.push({ url: url.toString(), signal: options.signal, result });
			return result.promise;
		},
		setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
		clearTimeout: (id: number) => timers.delete(id),
		acquireVsCodeApi: () => ({ getState: () => undefined, setState: () => { }, postMessage: (message: object) => hostMessages.push(message) }),
	});
	await setImmediate();

	const receive = (data: object, origin = 'https://workbench.example', source = contentWindow) => {
		window.dispatchEvent(Object.assign(new Event('message'), { data, origin, source }));
	};
	return {
		frame, permission, probes, simMessages, hostMessages,
		getElement,
		token: () => decodeURIComponent(new URL(frame.src).hash.slice('#_vscodeEmbed='.length)),
		receive,
		setPermissionQuery: (query: typeof permissionQuery) => { permissionQuery = query; },
		retry: async () => { getElement('retry').dispatchEvent(new Event('click')); await setImmediate(); },
		expire: () => { for (const [id, callback] of timers) { timers.delete(id); callback(); } },
		state: () => ({ overlay: getElement('overlay').className, failure: getElement('overlay').dataset.failure, title: getElement('failure-title').textContent, retry: getElement('retry').textContent }),
	};
}

describe('Sim webview connection', () => {
	it('keeps a pending browser request alive while replacing Connecting with actionable guidance', async () => {
		const view = await createWebview();
		await view.retry();
		const pendingUrl = view.frame.src;
		view.expire();
		await setImmediate();
		assert.deepStrictEqual({ ...view.state(), sameNavigation: view.frame.src === pendingUrl, probeCancelled: view.probes[0].signal.aborted }, {
			overlay: 'overlay failed', failure: 'local-network', title: 'Waiting for browser permission', retry: 'Refresh', sameNavigation: true, probeCancelled: false,
		});
	});

	it('connects when permission is granted after the deadline', async () => {
		const view = await createWebview();
		await view.retry();
		const previousToken = view.token();
		view.expire();
		await setImmediate();
		view.permission.change('granted');
		await setImmediate();
		view.receive({ source: 'sim', token: view.token(), type: 'ready' });
		assert.deepStrictEqual({ overlay: view.state().overlay, newToken: view.token() !== previousToken, probesCancelled: view.probes.map(probe => probe.signal.aborted), contexts: view.simMessages.length }, {
			overlay: 'overlay hidden', newToken: true, probesCancelled: [true, true], contexts: 1,
		});
	});

	it('reports a gateway HTTP failure even while the permission API still reports prompt', async () => {
		const view = await createWebview();
		await view.retry();
		view.probes[0].result.resolve({ ok: false });
		await setImmediate();
		view.expire();
		assert.deepStrictEqual({ ...view.state(), probeUrl: view.probes[0].url }, {
			overlay: 'overlay failed', failure: 'service', title: 'Unable to load Sim', retry: 'Refresh', probeUrl: 'https://workbench.example/sim/__vibe_status',
		});
	});

	it('does not mistake a reachable gateway for a ready Sim bridge or a pending permission', async () => {
		const view = await createWebview();
		await view.retry();
		view.probes[0].result.resolve({ ok: true });
		await setImmediate();
		const beforeDeadline = view.state().overlay;
		view.expire();
		await setImmediate();
		assert.deepStrictEqual({ beforeDeadline, ...view.state(), contexts: view.simMessages.length }, {
			beforeDeadline: 'overlay', overlay: 'overlay failed', failure: 'service', title: 'Unable to load Sim', retry: 'Refresh', contexts: 0,
		});
	});

	it('does not let a delayed timeout permission query cover an already connected frame', async () => {
		const view = await createWebview('granted');
		const query = Promise.withResolvers<TestPermission>();
		view.setPermissionQuery(() => query.promise);
		view.expire();
		view.receive({ source: 'sim', token: view.token(), type: 'ready' });
		query.resolve(view.permission);
		await setImmediate();
		assert.deepStrictEqual({ overlay: view.state().overlay, contexts: view.simMessages.length }, { overlay: 'overlay hidden', contexts: 1 });
	});

	it('ignores a late failed probe after the bridge has connected', async () => {
		const view = await createWebview('granted');
		view.receive({ source: 'sim', token: view.token(), type: 'ready' });
		view.probes[0].result.resolve({ ok: false });
		await setImmediate();
		assert.deepStrictEqual({ overlay: view.state().overlay, cancelled: view.probes[0].signal.aborted }, { overlay: 'overlay hidden', cancelled: true });
	});

	it('ignores probes and ready messages from an obsolete navigation', async () => {
		const view = await createWebview('granted');
		const previousToken = view.token();
		view.receive({ source: 'vibe-extension', type: 'navigate', path: '/workspace/other' });
		await setImmediate();
		view.probes[0].result.resolve({ ok: false });
		view.receive({ source: 'sim', token: previousToken, type: 'ready' });
		await setImmediate();
		assert.deepStrictEqual({ overlay: view.state().overlay, path: new URL(view.frame.src).pathname, probesCancelled: view.probes.map(probe => probe.signal.aborted), contexts: view.simMessages.length }, {
			overlay: 'overlay', path: '/workspace/other', probesCancelled: [true, false], contexts: 0,
		});
	});

	it('does not attach a late permission watcher to an already connected navigation', async () => {
		const view = await createWebview();
		const query = Promise.withResolvers<TestPermission>();
		view.setPermissionQuery(() => query.promise);
		await view.retry();
		view.receive({ source: 'sim', token: view.token(), type: 'ready' });
		query.resolve(view.permission);
		await setImmediate();
		view.permission.change('denied');
		assert.deepStrictEqual({ overlay: view.state().overlay, frameRetained: view.frame.src !== 'about:blank' }, { overlay: 'overlay hidden', frameRetained: true });
	});

	it('invalidates an in-flight handshake when permission is denied', async () => {
		const view = await createWebview();
		await view.retry();
		const deniedToken = view.token();
		view.permission.change('denied');
		view.receive({ source: 'sim', token: deniedToken, type: 'ready' });
		assert.deepStrictEqual({ ...view.state(), frame: view.frame.src, cancelled: view.probes[0].signal.aborted, contexts: view.simMessages.length }, {
			overlay: 'overlay failed', failure: 'local-network', title: 'Local network access is required', retry: 'Refresh', frame: 'about:blank', cancelled: true, contexts: 0,
		});
	});

	it('does not require the Vibe gateway health route for an explicitly configured Sim URL', async () => {
		const view = await createWebview('prompt', 'https://sim.example/custom/');
		view.receive({ source: 'sim', token: view.token(), type: 'ready' }, 'https://sim.example');
		assert.deepStrictEqual({ overlay: view.state().overlay, path: new URL(view.frame.src).pathname, probes: view.probes.length }, {
			overlay: 'overlay hidden', path: '/custom/workspace', probes: 0,
		});
	});
});
