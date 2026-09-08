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

class TestFrame extends TestElement {
	private readonly messages: object[];
	private readonly replaceFrame: (replacement: TestFrame) => void;
	readonly contentWindow = { postMessage: (message: object) => this.messages.push(message) };

	constructor(messages: object[], replaceFrame: (replacement: TestFrame) => void) {
		super();
		this.messages = messages;
		this.replaceFrame = replaceFrame;
	}

	cloneNode(): TestFrame {
		return new TestFrame(this.messages, this.replaceFrame);
	}

	replaceWith(replacement: TestFrame): void {
		this.replaceFrame(replacement);
	}
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
	const hostMessages: object[] = [];
	const simMessages: object[] = [];
	elements.set('sim', new TestFrame(simMessages, replacement => elements.set('sim', replacement)));
	const currentFrame = () => getElement('sim') as TestFrame;
	const window = Object.assign(new EventTarget(), { location: { ancestorOrigins: ['https://workbench.example'] } });
	const timers = new Map<number, () => void>();
	let timerId = 0;
	const resourceRequests: string[] = [];
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
		fetch: (url: URL) => {
			resourceRequests.push(url.toString());
			return Promise.resolve({ ok: false, status: 401 });
		},
		setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
		clearTimeout: (id: number) => timers.delete(id),
		acquireVsCodeApi: () => ({ getState: () => undefined, setState: () => { }, postMessage: (message: object) => hostMessages.push(message) }),
	});
	await setImmediate();

	const receive = (data: object, origin = 'https://workbench.example', source = currentFrame().contentWindow) => {
		window.dispatchEvent(Object.assign(new Event('message'), { data, origin, source }));
	};
	return {
		permission, resourceRequests, simMessages, hostMessages,
		get frame() { return currentFrame(); },
		getElement,
		pendingTimers: () => timers.size,
		token: () => decodeURIComponent(new URL(currentFrame().src).hash.slice('#_vscodeEmbed='.length)),
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
		const pendingFrame = view.frame;
		const pendingUrl = view.frame.src;
		view.expire();
		await setImmediate();
		assert.deepStrictEqual({ ...view.state(), sameNavigation: view.frame === pendingFrame && view.frame.src === pendingUrl, requests: view.resourceRequests }, {
			overlay: 'overlay failed', failure: 'local-network', title: 'Waiting for browser permission', retry: 'Refresh', sameNavigation: true, requests: [],
		});
	});

	it('connects when permission is granted after the deadline', async () => {
		const view = await createWebview();
		await view.retry();
		const previousFrame = view.frame;
		const previousToken = view.token();
		view.expire();
		await setImmediate();
		view.permission.change('granted');
		await setImmediate();
		view.receive({ source: 'sim', token: view.token(), type: 'ready' });
		assert.deepStrictEqual({ overlay: view.state().overlay, newFrame: view.frame !== previousFrame, newToken: view.token() !== previousToken, timers: view.pendingTimers(), contexts: view.simMessages.length }, {
			overlay: 'overlay hidden', newFrame: true, newToken: true, timers: 0, contexts: 1,
		});
	});

	it('replaces the iframe document on a same-route retry and rejects the old browsing context', async () => {
		const view = await createWebview('granted');
		const previousFrame = view.frame;
		const previousToken = view.token();
		view.expire();
		await setImmediate();
		await view.retry();
		view.receive({ source: 'sim', token: view.token(), type: 'ready' }, 'https://workbench.example', previousFrame.contentWindow);
		const contextsFromOldFrame = view.simMessages.length;
		view.receive({ source: 'sim', token: view.token(), type: 'ready' });
		assert.deepStrictEqual({
			sameRoute: new URL(view.frame.src).pathname === new URL(previousFrame.src).pathname,
			newFrame: view.frame !== previousFrame,
			newWindow: view.frame.contentWindow !== previousFrame.contentWindow,
			newToken: view.token() !== previousToken,
			contextsFromOldFrame, overlay: view.state().overlay, contexts: view.simMessages.length,
		}, { sameRoute: true, newFrame: true, newWindow: true, newToken: true, contextsFromOldFrame: 0, overlay: 'overlay hidden', contexts: 1 });
	});

	it('ignores late load events from a replaced iframe', async () => {
		const view = await createWebview('granted');
		const previousFrame = view.frame;
		await view.retry();
		view.receive({ source: 'sim', token: view.token(), type: 'ready' });
		previousFrame.dispatchEvent(new Event('load'));
		assert.deepStrictEqual({ overlay: view.state().overlay, messages: view.simMessages.length }, { overlay: 'overlay hidden', messages: 1 });
	});

	it('waits for the iframe handshake without probing through the webview resource loader', async () => {
		const view = await createWebview('granted');
		const beforeHandshake = view.state().overlay;
		view.receive({ source: 'sim', token: view.token(), type: 'ready' });
		view.expire();
		await setImmediate();
		assert.deepStrictEqual({ beforeHandshake, overlay: view.state().overlay, requests: view.resourceRequests, contexts: view.simMessages.length }, {
			beforeHandshake: 'overlay', overlay: 'overlay hidden', requests: [], contexts: 1,
		});
	});

	it('reports a service failure when permission is granted but the handshake times out', async () => {
		const view = await createWebview('granted');
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

	it('accepts a late authenticated handshake after showing a service failure', async () => {
		const view = await createWebview('granted');
		view.expire();
		await setImmediate();
		const beforeHandshake = view.state().overlay;
		view.receive({ source: 'sim', token: view.token(), type: 'ready' });
		assert.deepStrictEqual({ beforeHandshake, overlay: view.state().overlay, timers: view.pendingTimers(), contexts: view.simMessages.length }, {
			beforeHandshake: 'overlay failed', overlay: 'overlay hidden', timers: 0, contexts: 1,
		});
	});

	it('ignores timeout permission results and ready messages from an obsolete navigation', async () => {
		const view = await createWebview('granted');
		const previousToken = view.token();
		const query = Promise.withResolvers<TestPermission>();
		view.setPermissionQuery(() => query.promise);
		view.expire();
		view.setPermissionQuery(() => Promise.resolve(view.permission));
		view.receive({ source: 'vibe-extension', type: 'navigate', path: '/workspace/other' });
		await setImmediate();
		query.resolve(view.permission);
		view.receive({ source: 'sim', token: previousToken, type: 'ready' });
		await setImmediate();
		assert.deepStrictEqual({ overlay: view.state().overlay, path: new URL(view.frame.src).pathname, timers: view.pendingTimers(), contexts: view.simMessages.length }, {
			overlay: 'overlay', path: '/workspace/other', timers: 1, contexts: 0,
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
		assert.deepStrictEqual({ ...view.state(), frame: view.frame.src, timers: view.pendingTimers(), contexts: view.simMessages.length }, {
			overlay: 'overlay failed', failure: 'local-network', title: 'Local network access is required', retry: 'Refresh', frame: 'about:blank', timers: 0, contexts: 0,
		});
	});

	it('does not require the Vibe gateway health route for an explicitly configured Sim URL', async () => {
		const view = await createWebview('prompt', 'https://sim.example/custom/');
		view.receive({ source: 'sim', token: view.token(), type: 'ready' }, 'https://sim.example');
		assert.deepStrictEqual({ overlay: view.state().overlay, path: new URL(view.frame.src).pathname, requests: view.resourceRequests }, {
			overlay: 'overlay hidden', path: '/custom/workspace', requests: [],
		});
	});
});
