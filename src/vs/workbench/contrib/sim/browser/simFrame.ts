/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/sim.css';
import { $, addDisposableListener, append, getWindow } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ISimHostContext, ISimMessage, isSafeSimPath, isSimMessage, SimSurface } from '../common/sim.js';

/** Hosted Sim uses the Workbench origin, so main's SameSite=Lax cookie remains first-party. */
export function resolveSimBaseUrl(configured: string, workbenchUrl: string): URL | undefined {
	try {
		const workbench = new URL(workbenchUrl);
		const root = new URL(configured.trim() || workbench.origin);
		if (!['http:', 'https:'].includes(root.protocol) || root.origin !== workbench.origin
			|| root.username || root.password || root.search || root.hash || !isSafeSimPath(root.pathname)) {
			return undefined;
		}
		root.pathname = `${root.pathname.replace(/\/+$/, '')}/`;
		return root;
	} catch {
		return undefined;
	}
}

export function simRouteUrl(root: URL, path: string, surface: SimSurface, token: string): string | undefined {
	if (!isSafeSimPath(path)) {
		return undefined;
	}
	const url = new URL(`.${path}`, root);
	if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
		return undefined;
	}
	url.searchParams.delete('_vscodeSurface');
	if (surface !== 'fullscreen') {
		url.searchParams.set('_vscodeSurface', surface);
	}
	url.hash = `_vscodeEmbed=${encodeURIComponent(token)}`;
	return url.toString();
}

/** Owns one trusted first-party iframe and its connection generation, not authentication state. */
export class SimFrame extends Disposable {
	readonly element: HTMLElement;
	private readonly overlay: HTMLElement;
	private readonly message: HTMLElement;
	private readonly retryButton: Button;
	private readonly connection = this._register(new DisposableStore());
	private readonly authenticationRequest = this._register(new MutableDisposable());
	private readonly connectionTimer = this._register(new MutableDisposable());
	private frame: HTMLIFrameElement | undefined;
	private token = '';
	private generation = 0;
	private ready = false;
	private loginRequired = false;

	constructor(
		parent: HTMLElement,
		readonly surface: SimSurface,
		private root: URL | undefined,
		private path: string,
		private context: ISimHostContext,
		private readonly authPath: string,
		private readonly handleMessage: (message: ISimMessage) => void,
	) {
		super();
		this.element = append(parent, $('.sim-surface'));
		this.element.dataset.surface = surface;
		this._register(toDisposable(() => this.element.remove()));
		this.overlay = append(this.element, $('.sim-connection'));
		this.overlay.setAttribute('role', 'status');
		this.overlay.setAttribute('aria-live', 'polite');
		this.message = append(this.overlay, $('p'));
		this.retryButton = this._register(new Button(this.overlay, { ...defaultButtonStyles }));
		this._register(this.retryButton.onDidClick(() => {
			if (this.loginRequired) {
				const window = getWindow(this.element);
				this.navigateToLogin(`${this.authPath}/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`);
			} else {
				this.load();
			}
		}));
		const window = getWindow(parent);
		this._register(addDisposableListener(window, 'message', event => this.receiveMessage(event)));
		this._register(addDisposableListener(window, 'focus', () => { void this.checkAuthentication(); }));
		this.load();
	}

	setContext(context: ISimHostContext): void {
		this.context = context;
		if (this.ready) {
			this.send('context', context);
		}
	}

	setBaseUrl(root: URL | undefined): void {
		this.root = root;
		this.load();
	}

	navigate(path: string): void {
		if (isSafeSimPath(path) && path !== this.path) {
			this.path = path;
			this.load();
		}
	}

	focus(): void {
		if (this.ready) {
			this.frame?.focus();
		} else if (!this.retryButton.element.hidden) {
			this.retryButton.focus();
		}
	}

	protected requestStatus(signal: AbortSignal): Promise<Response> {
		return getWindow(this.element).fetch(`${this.authPath}/api/status`, { credentials: 'same-origin', cache: 'no-store', signal });
	}

	protected navigateToLogin(url: string): void {
		getWindow(this.element).location.assign(url);
	}

	/** Only a definitive main status response may ask for login; transport failure is not logout. */
	protected async checkAuthentication(onlyWhileConnecting = false): Promise<void> {
		if (!this.frame || this.loginRequired || (onlyWhileConnecting && this.ready) || this._store.isDisposed) {
			return;
		}
		const generation = this.generation;
		const controller = new AbortController();
		this.authenticationRequest.value = toDisposable(() => controller.abort());
		const isCurrent = () => !controller.signal.aborted && !this._store.isDisposed && generation === this.generation && (!onlyWhileConnecting || !this.ready);
		try {
			const response = await this.requestStatus(controller.signal);
			if (!isCurrent() || !response.ok) {
				return;
			}
			const status: { authenticated?: boolean } | null = await response.json();
			if (!isCurrent() || status?.authenticated !== false) {
				return;
			}
			this.connection.clear();
			this.connectionTimer.clear();
			this.token = '';
			this.ready = false;
			this.frame?.remove();
			this.frame = undefined;
			this.loginRequired = true;
			this.showMessage('authentication', localize('sim.signInRequired', "Your Vibe VS Code login has expired. Sign in to reconnect to Sim."));
			this.retryButton.label = localize('sim.signIn', "Sign In");
		} catch {
			// main remains the authority. A missing endpoint or failed probe never invents logout.
		}
	}

	private load(): void {
		const generation = ++this.generation;
		this.connection.clear();
		this.authenticationRequest.clear();
		this.connectionTimer.clear();
		this.frame?.remove();
		this.frame = undefined;
		this.ready = false;
		this.loginRequired = false;
		this.token = generateUuid();
		const url = this.root && simRouteUrl(this.root, this.path, this.surface, this.token);
		if (!url) {
			this.showMessage('configuration', localize('sim.sameOriginRequired', "Sim must use the same origin as Vibe VS Code. Clear vibe-vscode.sim.baseUrl to use the authenticated gateway."));
			return;
		}
		this.showMessage('connecting', localize('sim.connecting', "Connecting to Sim…"));
		// A new browsing context is required: changing only the hash retains the old bridge token.
		const frame = this.element.ownerDocument.createElement('iframe');
		frame.title = localize('sim.title', "Sim Development Orchestration");
		frame.allow = 'clipboard-read; clipboard-write; fullscreen';
		this.frame = frame;
		const keyboardListeners = this.connection.add(new MutableDisposable());
		this.connection.add(addDisposableListener(frame, 'load', () => {
			if (generation === this.generation && this.frame === frame) {
				keyboardListeners.value = this.forwardKeyboardEvents(frame);
				this.send('ping');
				void this.checkAuthentication(true);
			}
		}));
		frame.src = url;
		this.element.prepend(frame);
		this.connectionTimer.value = disposableTimeout(() => {
			if (generation !== this.generation || this.ready) {
				return;
			}
			this.showMessage('service', localize('sim.unavailable', "Sim has not connected. Check that the Sim service is running, then retry."));
			void this.checkAuthentication(true);
		}, 12000);
	}

	private forwardKeyboardEvents(frame: HTMLIFrameElement): IDisposable {
		const document = frame.contentDocument;
		const window = document?.defaultView;
		if (!window) {
			return Disposable.None;
		}
		const controller = new AbortController();
		const forward = (event: KeyboardEvent) => {
			if (!this.ready || this._store.isDisposed || this.frame !== frame || frame.contentDocument !== document
				|| this.element.ownerDocument.activeElement !== frame || event.defaultPrevented || event.isComposing) {
				return;
			}
			// Keep text editing in Sim. Only unhandled escape / command-palette keys reach the host.
			if (event.key !== 'Escape' && event.key !== 'F1' && !((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyP')) {
				return;
			}
			const forwarded = new KeyboardEvent(event.type, {
				key: event.key, code: event.code, keyCode: event.keyCode, repeat: event.repeat,
				ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey,
				bubbles: true, cancelable: true,
			});
			// Dispatch from the iframe element so modal context and its command filter still apply.
			frame.dispatchEvent(forwarded);
			if (forwarded.defaultPrevented) {
				event.preventDefault();
			}
		};
		// A WindowProxy survives navigation. Abort removes listeners from the original document's window.
		window.addEventListener('keydown', forward, { signal: controller.signal });
		window.addEventListener('keyup', forward, { signal: controller.signal });
		return toDisposable(() => controller.abort());
	}

	private receiveMessage(event: MessageEvent): void {
		const message: unknown = event.data;
		if (!this.frame || event.source !== this.frame.contentWindow || event.origin !== this.root?.origin
			|| !isSimMessage(message) || message.token !== this.token) {
			return;
		}
		if (message.type === 'ready') {
			this.ready = true;
			this.connectionTimer.clear();
			this.authenticationRequest.clear();
			this.overlay.hidden = true;
			this.element.dataset.state = 'ready';
			this.send('context', this.context);
			return;
		}
		if (!this.ready) {
			return;
		}
		if (message.type === 'routeChanged' || message.type === 'openEditor') {
			if (!isSafeSimPath(message.payload?.path)) {
				return;
			}
			if (message.type === 'routeChanged') {
				this.path = message.payload.path;
			}
		}
		this.handleMessage(message);
	}

	private send(type: 'context' | 'ping', payload?: ISimHostContext): void {
		if (this.frame?.contentWindow && this.root && this.token) {
			this.frame.contentWindow.postMessage({ source: 'vibe-vscode', token: this.token, type, payload }, this.root.origin);
		}
	}

	private showMessage(state: string, message: string): void {
		this.element.dataset.state = state;
		this.overlay.hidden = false;
		this.message.textContent = message;
		this.retryButton.element.hidden = state === 'connecting';
		this.retryButton.label = localize('sim.retry', "Retry");
	}
}
