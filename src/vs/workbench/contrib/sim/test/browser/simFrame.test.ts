/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISimMessage, isSafeSimPath, isSimMessage } from '../../common/sim.js';
import { resolveSimBaseUrl, SimFrame, simRouteUrl } from '../../browser/simFrame.js';

suite('SimFrame', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const origin = 'https://sim.invalid';

	function create(request: (signal: AbortSignal) => Promise<Response> = async () => new Response('', { status: 404 })) {
		const parent = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(parent);
		disposables.add(toDisposable(() => parent.remove()));
		const messages: ISimMessage[] = [];
		const navigations: string[] = [];
		const host = disposables.add(new class extends SimFrame {
			protected override requestStatus(signal: AbortSignal): Promise<Response> { return request(signal); }
			protected override navigateToLogin(url: string): void { navigations.push(url); }
			check(onlyWhileConnecting = false): Promise<void> { return this.checkAuthentication(onlyWhileConnecting); }
		}(parent, 'sidebar', new URL(origin), '/workspace', { language: 'en' }, '/code/auth', message => messages.push(message)));
		const frame = () => host.element.querySelector('iframe')!;
		const token = () => new URLSearchParams(new URL(frame().src).hash.slice(1)).get('_vscodeEmbed')!;
		const receive = (type: ISimMessage['type'], payload?: ISimMessage['payload'], source = frame().contentWindow, eventOrigin = origin, frameToken = token()) => {
			mainWindow.dispatchEvent(new MessageEvent('message', { source, origin: eventOrigin, data: { source: 'sim', type, token: frameToken, payload } }));
		};
		return { host, parent, frame, token, receive, messages, navigations };
	}

	async function loadKeyboardDocument(client: ReturnType<typeof create>) {
		const frame = client.frame();
		const loaded = new DeferredPromise<void>();
		const listener = disposables.add(addDisposableListener(frame, 'load', () => { void loaded.complete(); }));
		frame.srcdoc = '<!doctype html><input>';
		await loaded.p;
		listener.dispose();
		client.receive('ready');
		const input = frame.contentDocument!.querySelector('input')!;
		input.focus();
		return input;
	}

	test('accepts only a same-origin gateway and keeps surface and route under its root', () => {
		const root = resolveSimBaseUrl(`${origin}/sim`, `${origin}/?folder=test`)!;
		const url = new URL(simRouteUrl(root, '/workspace/a?tab=agent', 'sidebar', 'generation:1')!);
		assert.deepStrictEqual({
			defaultRoot: resolveSimBaseUrl('', `${origin}/?folder=test`)?.href,
			root: root.href,
			path: url.pathname,
			query: [...url.searchParams],
			hash: url.hash,
			rejected: [
				'https://other.invalid', `${origin}:18080`, `https://user@sim.invalid`,
				`${origin}/?token=secret`, `${origin}/#secret`, 'javascript:alert(1)',
			].map(value => resolveSimBaseUrl(value, origin)),
		}, {
			defaultRoot: `${origin}/`, root: `${origin}/sim/`, path: '/sim/workspace/a',
			query: [['tab', 'agent'], ['_vscodeSurface', 'sidebar']], hash: '#_vscodeEmbed=generation%3A1',
			rejected: [undefined, undefined, undefined, undefined, undefined, undefined],
		});
	});

	test('rejects traversal, cross-origin, malformed and control-character routes', () => {
		assert.deepStrictEqual([
			'/', '/workspace/project?tab=agent#session', '//attacker.invalid', '/\\attacker.invalid',
			'/%5c%5cattacker.invalid', '/%2f%2fattacker.invalid', '/../outside', '/%2e%2e/outside',
			'/workspace%', '/workspace%00session', '/workspace\nsession',
		].map(isSafeSimPath), [true, true, false, false, false, false, false, false, false, false, false]);
	});

	test('validates payload types before dispatching a host capability', () => {
		assert.deepStrictEqual([
			{ type: 'openFile', payload: { uri: 'file:///test.ts', line: 0 } },
			{ type: 'openFile', payload: { uri: {} } },
			{ type: 'openFile', payload: { line: -1 } },
			{ type: 'openFile', payload: { character: 0.5 } },
			{ type: 'routeChanged', payload: { userInitiated: 'yes' } },
			{ type: 'ready', payload: [] },
			{ type: ['ready'] },
			{ type: 'executeCommand' },
		].map(message => isSimMessage({ source: 'sim', token: 'current', ...message })), [true, false, false, false, false, false, false, false]);
	});

	test('mounts directly in Workbench and only accepts the current frame, origin and token', () => {
		const { host, parent, frame, token, receive, messages } = create();
		receive('openFile', { uri: 'file:///too-early' });
		receive('ready', undefined, mainWindow);
		receive('ready', undefined, frame().contentWindow, 'https://other.invalid');
		receive('ready', undefined, frame().contentWindow, origin, 'wrong');
		assert.strictEqual(host.element.dataset.state, 'connecting');
		receive('ready');
		receive('openFile', { uri: 'file:///allowed' });
		assert.deepStrictEqual({
			parent: frame().parentElement === host.element && host.element.parentElement === parent,
			frameCount: parent.querySelectorAll('iframe').length,
			state: host.element.dataset.state,
			messages,
			allow: frame().allow,
		}, {
			parent: true, frameCount: 1, state: 'ready',
			messages: [{ source: 'sim', token: token(), type: 'openFile', payload: { uri: 'file:///allowed' } }],
			allow: 'clipboard-read; clipboard-write; fullscreen',
		});
	});

	test('retry replaces the browsing context even for the same route and rejects old callbacks', () => {
		const { host, frame, token, receive, messages } = create();
		const previousFrame = frame();
		const previousWindow = previousFrame.contentWindow;
		const previousToken = token();
		host.setBaseUrl(new URL(origin));
		receive('ready', undefined, previousWindow, origin, previousToken);
		previousFrame.dispatchEvent(new Event('load'));
		assert.deepStrictEqual({ replaced: frame() !== previousFrame, newToken: token() !== previousToken, state: host.element.dataset.state }, { replaced: true, newToken: true, state: 'connecting' });
		receive('ready');
		receive('openFile', { uri: 'file:///old' }, previousWindow, origin, previousToken);
		receive('routeChanged', { path: '//attacker.invalid' });
		assert.deepStrictEqual(messages, []);
	});

	test('forwards unhandled host keys through the iframe element and honors host cancellation', async () => {
		const client = create();
		const input = await loadKeyboardDocument(client);
		const forwarded: { key: string; type: string; targetIsFrame: boolean }[] = [];
		for (const type of ['keydown', 'keyup'] as const) {
			disposables.add(addDisposableListener(client.parent, type, event => {
				forwarded.push({ key: event.key, type: event.type, targetIsFrame: event.target === client.frame() });
				event.preventDefault();
			}));
		}
		const events = [
			new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }),
			new KeyboardEvent('keyup', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }),
			new KeyboardEvent('keydown', { key: 'F1', keyCode: 112, bubbles: true, cancelable: true }),
			new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', keyCode: 80, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
		];
		for (const event of events) {
			input.dispatchEvent(event);
		}
		assert.deepStrictEqual({ forwarded, prevented: events.map(event => event.defaultPrevented) }, {
			forwarded: [
				{ key: 'Escape', type: 'keydown', targetIsFrame: true },
				{ key: 'Escape', type: 'keyup', targetIsFrame: true },
				{ key: 'F1', type: 'keydown', targetIsFrame: true },
				{ key: 'P', type: 'keydown', targetIsFrame: true },
			],
			prevented: [true, true, true, true],
		});
	});

	test('leaves handled keys, text editing, composition and an unfocused frame in Sim', async () => {
		const client = create();
		const input = await loadKeyboardDocument(client);
		const forwarded: string[] = [];
		disposables.add(addDisposableListener(client.parent, 'keydown', event => forwarded.push(event.key)));
		const handled = disposables.add(addDisposableListener(input, 'keydown', event => event.preventDefault()));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		handled.dispose();
		for (const options of [{ key: 'a' }, { key: 'a', ctrlKey: true }, { key: 'c', metaKey: true }, { key: 'Escape', isComposing: true }]) {
			input.dispatchEvent(new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true }));
		}
		client.parent.tabIndex = 0;
		client.parent.focus();
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1', bubbles: true, cancelable: true }));
		assert.deepStrictEqual(forwarded, []);
	});

	test('replaces keyboard listeners on each document load and ignores the old document', async () => {
		const client = create();
		const previousInput = await loadKeyboardDocument(client);
		const input = await loadKeyboardDocument(client);
		client.frame().dispatchEvent(new Event('load'));
		const forwarded: string[] = [];
		disposables.add(addDisposableListener(client.parent, 'keydown', event => forwarded.push(event.key)));
		previousInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1', bubbles: true, cancelable: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		assert.deepStrictEqual(forwarded, ['Escape']);
	});

	for (const transition of ['retry', 'logout', 'dispose'] as const) {
		test(`stale iframe keys cannot reach Workbench after ${transition}`, async () => {
			let authenticated = true;
			const client = create(async () => Response.json({ authenticated }));
			const input = await loadKeyboardDocument(client);
			const forwarded: string[] = [];
			disposables.add(addDisposableListener(client.frame(), 'keydown', event => forwarded.push(event.key)));
			if (transition === 'retry') {
				client.host.navigate('/workspace/new');
			} else if (transition === 'logout') {
				authenticated = false;
				await client.host.check();
			} else {
				client.host.dispose();
			}
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
			assert.deepStrictEqual(forwarded, []);
		});
	}

	test('login expiry clears the trusted frame and uses the main top-level login with return path', async () => {
		const { host, receive, navigations, messages } = create(async () => Response.json({ authenticated: false }));
		receive('ready');
		await host.check();
		host.element.querySelector<HTMLElement>('.monaco-button')!.click();
		assert.deepStrictEqual({ state: host.element.dataset.state, frames: host.element.querySelectorAll('iframe').length, navigations, messages }, {
			state: 'authentication', frames: 0,
			navigations: [`/code/auth/login?return_to=${encodeURIComponent(mainWindow.location.pathname + mainWindow.location.search)}`], messages: [],
		});
	});

	for (const transition of ['retry', 'ready', 'dispose'] as const) {
		test(`late authentication failure cannot override ${transition}`, async () => {
			const pending = new DeferredPromise<Response>();
			let signal: AbortSignal | undefined;
			const { host, receive, parent } = create(requestSignal => { signal = requestSignal; return pending.p; });
			const check = host.check(true);
			if (transition === 'retry') {
				host.navigate('/workspace/new');
			} else if (transition === 'ready') {
				receive('ready');
			} else {
				host.dispose();
			}
			await pending.complete(Response.json({ authenticated: false }));
			await check;
			assert.deepStrictEqual({ aborted: signal?.aborted, state: host.element.dataset.state, mounted: parent.contains(host.element) }, {
				aborted: true, state: transition === 'ready' ? 'ready' : 'connecting', mounted: transition !== 'dispose',
			});
		});
	}

	test('checks generation again after the asynchronous JSON body', async () => {
		const pending = new DeferredPromise<{ authenticated: boolean }>();
		const response = new class extends Response {
			override json(): Promise<{ authenticated: boolean }> { return pending.p; }
		}();
		const { host, receive } = create(async () => response);
		const check = host.check(true);
		await Promise.resolve();
		host.navigate('/workspace/new');
		receive('ready');
		await pending.complete({ authenticated: false });
		await check;
		assert.strictEqual(host.element.dataset.state, 'ready');
	});

	test('a timeout is retryable and a late valid handshake can still connect', () => runWithFakedTimers({}, async () => {
		const { host, receive } = create(async () => { throw new Error('offline'); });
		await timeout(12001);
		assert.strictEqual(host.element.dataset.state, 'service');
		receive('ready');
		await timeout(12001);
		assert.strictEqual(host.element.dataset.state, 'ready');
	}));
});
