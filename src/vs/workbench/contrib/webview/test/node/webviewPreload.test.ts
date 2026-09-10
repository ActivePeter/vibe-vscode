/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

function preloadSource(): string {
	return readFileSync(FileAccess.asFileUri('vs/workbench/contrib/webview/browser/pre/index.html').fsPath, 'utf8').replace(/\r\n/g, '\n');
}

/** Exercise the standalone preload's real handlers without changing the test process globals. */
function preloadSection(start: string, end: string): string {
	const source = preloadSource();
	const startIndex = source.indexOf(start);
	const endIndex = source.indexOf(end, startIndex);
	assert.ok(startIndex >= 0 && endIndex > startIndex);
	return source.slice(startIndex, endIndex);
}

function createBody(classes: Set<string>) {
	return {
		classList: {
			contains: (name: string) => classes.has(name),
			toggle: (name: string, visible: boolean) => { if (visible) { classes.add(name); } else { classes.delete(name); } },
		},
	};
}

type TestFrame = { contentDocument: { body: ReturnType<typeof createBody> | null } | null } | undefined;

suite('Webview preload lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('focus polling tolerates a replacement document before its body is ready', () => {
		let target: TestFrame;
		let focused = false;
		const classes = new Set<string>();
		const transitions: string[] = [];
		const intervals: number[] = [];
		const pollers: Array<() => void> = [];
		const dependencies = {
			document: { hasFocus: () => focused },
			getActiveFrame: () => target,
			onFocus: () => transitions.push('focus'),
			onBlur: () => transitions.push('blur'),
			setInterval: (callback: () => void, interval: number) => { pollers.push(callback); intervals.push(interval); },
		};
		new Function(...Object.keys(dependencies), `${preloadSection('const trackFocus =', 'const getActiveFrame =')}\ntrackFocus({ onFocus, onBlur });`)(...Object.values(dependencies));
		const poll = () => pollers.forEach(callback => callback());
		poll();
		target = { contentDocument: null };
		poll();
		target = { contentDocument: { body: null } };
		poll();
		target.contentDocument!.body = createBody(classes);
		classes.add('vscode-context-menu-visible');
		poll();
		poll();
		target = { contentDocument: { body: null } };
		poll();
		target.contentDocument!.body = createBody(classes);
		poll();
		classes.clear();
		poll();
		target = undefined;
		focused = true;
		poll();
		focused = false;
		poll();
		assert.deepStrictEqual({ intervals, transitions }, {
			intervals: [250],
			transitions: ['focus', 'blur', 'focus', 'blur', 'focus', 'blur'],
		});
	});

	test('context-menu notifications tolerate a missing body and apply to the ready document', () => {
		let target: TestFrame;
		const handlers: Array<(event: undefined, data: { visible: boolean }) => void> = [];
		const dependencies = {
			getActiveFrame: () => target,
			hostMessaging: { onMessage: (_name: string, handler: (event: undefined, data: { visible: boolean }) => void) => handlers.push(handler) },
		};
		new Function(...Object.keys(dependencies), preloadSection('hostMessaging.onMessage(\'set-context-menu-visible\'', 'hostMessaging.onMessage(\'set-title\''))(...Object.values(dependencies));
		const notify = (visible: boolean) => handlers.forEach(handler => handler(undefined, { visible }));
		notify(true);
		target = { contentDocument: null };
		notify(true);
		target = { contentDocument: { body: null } };
		notify(true);
		const classes = new Set<string>();
		target.contentDocument!.body = createBody(classes);
		notify(true);
		const shown = [...classes];
		notify(false);
		assert.deepStrictEqual({ handlerCount: handlers.length, shown, hidden: [...classes] }, {
			handlerCount: 1, shown: ['vscode-context-menu-visible'], hidden: [],
		});
	});

	test('deferred HTML writes preserve only the current frame, document, and update', () => {
		const observations: Array<{ change: string; writes: string[] }> = [];
		for (const change of ['none', 'generation', 'frame', 'document', 'during-write']) {
			const writes: string[] = [];
			const callbacks: Array<() => void> = [];
			const contentDocument = {
				open: () => writes.push('open'),
				write: (html: string) => { writes.push(html); if (change === 'during-write') { pendingFrame = undefined; } },
				close: () => writes.push('close'),
			};
			const newFrame = { contentDocument };
			let pendingFrame: typeof newFrame | undefined = newFrame;
			const dependencies = {
				currentUpdateId: 1, updateId: 1, newFrame,
				getPendingFrame: () => pendingFrame,
				perfMark: () => { },
				setTimeout: (callback: () => void) => callbacks.push(callback),
				newDocument: 'native-html',
				hookupOnLoadHandlers: () => writes.push('hookup'),
				initialStyleVersion: 1, styleVersion: 1,
				applyStyles: () => writes.push('styles'),
			};
			const loader: { load: (document: typeof contentDocument) => void; supersede: () => void } = new Function(...Object.keys(dependencies), `
				${preloadSection('const isCurrentFrame =', 'newFrame.title =')}
				${preloadSection('function onFrameLoaded(contentDocument)', 'if (!options.allowScripts && isSafari)')}
				return { load: onFrameLoaded, supersede: () => { updateId++; } };
			`)(...Object.values(dependencies));
			loader.load(contentDocument);
			if (change === 'generation') { loader.supersede(); }
			if (change === 'frame') { pendingFrame = undefined; }
			if (change === 'document') { newFrame.contentDocument = { ...contentDocument }; }
			callbacks.forEach(callback => callback());
			observations.push({ change, writes });
		}
		assert.deepStrictEqual(observations, [
			{ change: 'none', writes: ['open', 'native-html', 'close', 'hookup'] },
			{ change: 'generation', writes: [] },
			{ change: 'frame', writes: [] },
			{ change: 'document', writes: [] },
			{ change: 'during-write', writes: ['open', 'native-html', 'close'] },
		]);
	});

	test('obsolete load callbacks cannot cancel the current frame deadline', () => {
		let current = true;
		const callbacks: Array<() => void> = [];
		const cleared: Array<number | undefined> = [];
		const loads: string[] = [];
		const listeners = new Map<string, (event: { target: { id: string } }) => void>();
		const contentDocument = { id: 'current' };
		const contentWindow = { addEventListener: (name: string, listener: (event: { target: { id: string } }) => void) => listeners.set(name, listener) };
		const frame: { contentDocument: typeof contentDocument | null; contentWindow: typeof contentWindow | null } = { contentDocument, contentWindow };
		const dependencies = {
			isCurrentFrame: () => current,
			loadTimeout: undefined,
			clearTimeout: (id: number | undefined) => cleared.push(id),
			setTimeout: (callback: () => void) => callbacks.push(callback),
			assertIsDefined: <T>(value: T | null) => { assert.ok(value); return value; },
			onLoad: (document: typeof contentDocument) => loads.push(document.id),
		};
		const loader: { hook: (targetFrame: typeof frame) => void; setDeadline: (id: number) => void; deadline: () => number | undefined } = new Function(...Object.keys(dependencies), `
			${preloadSection('function hookupOnLoadHandlers(newFrame)', '// Bubble out various events')}
			}
			return { hook: hookupOnLoadHandlers, setDeadline: id => { loadTimeout = id; }, deadline: () => loadTimeout };
		`)(...Object.values(dependencies));
		loader.hook(frame);
		loader.setDeadline(99);
		current = false;
		frame.contentDocument = null;
		frame.contentWindow = null;
		callbacks[0]();
		listeners.get('load')!({ target: contentDocument });
		loader.hook(frame);
		const obsolete = { deadline: loader.deadline(), cleared: [...cleared], loads: [...loads] };
		current = true;
		frame.contentDocument = contentDocument;
		frame.contentWindow = contentWindow;
		loader.hook(frame);
		callbacks[1]();
		assert.deepStrictEqual({ obsolete, current: { deadline: loader.deadline(), cleared, loads } }, {
			obsolete: { deadline: 99, cleared: [undefined], loads: [] },
			current: { deadline: undefined, cleared: [undefined, 99, 2], loads: ['current'] },
		});
	});

	test('the preload CSP authorizes the current inline script', () => {
		const source = preloadSource();
		const script = /<script async type="module">(?<script>[\s\S]*?)<\/script>/.exec(source)?.groups?.script;
		assert.ok(script);
		const hash = createHash('sha256').update(script).digest('base64');
		const policy = /<meta http-equiv="Content-Security-Policy"\s+content="(?<policy>[^"]+)"/.exec(source)?.groups?.policy;
		assert.ok(policy?.includes(`'sha256-${hash}'`), 'The inline preload script must match its CSP hash');
	});
});
