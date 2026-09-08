/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import type * as http from 'http';
import { fromNodeHeaders } from 'better-auth/node';
import { FileAccess } from '../../base/common/network.js';
import { isAbsolute } from '../../base/common/path.js';
import { matchVibePublicOrigin } from '../common/vibeAuthentication.js';
import type { ServerParsedArgs } from './serverEnvironmentService.js';
import { VibeAuthenticationService } from './vibeAuthentication.js';
import { vibeLogoDataUri } from './vibeBranding.js';

const requestBodyMaximumBytes = 16 * 1024;
const administratorEmail = 'administrator@vibe.invalid';

type Locale = 'en' | 'zh-cn';

// Authentication runs before Workbench NLS is available. Load the packaged bundles once.
type Messages = typeof import('./vibe-authentication.nls.en.json');
const messages: Record<Locale, Messages> = {
	en: JSON.parse(readFileSync(FileAccess.asFileUri('vs/server/node/vibe-authentication.nls.en.json').fsPath, 'utf8')),
	'zh-cn': JSON.parse(readFileSync(FileAccess.asFileUri('vs/server/node/vibe-authentication.nls.zh-cn.json').fsPath, 'utf8')),
};

interface AuthenticationPageOptions {
	readonly kind: 'login' | 'register' | 'logout';
	readonly locale: Locale;
	readonly basePath: string;
	readonly returnTo: string;
	readonly username?: string;
	readonly error?: string;
}

interface RenderedAuthenticationPage {
	readonly content: string;
	readonly styleNonce: string;
}

interface AuthenticationSession {
	readonly authenticated: boolean;
	readonly username?: string;
}

interface BetterAuthError {
	readonly code?: string;
}

export interface VibeAuthenticationServerOptions {
	readonly authenticationService: VibeAuthenticationService;
}

class RequestBodyTooLargeError extends Error { }

/**
 * Adapts Better Auth to the full-screen login UI and Caddy forward-auth contract.
 */
export class VibeAuthenticationServer {
	private readonly authenticationService: VibeAuthenticationService;
	private readonly basePath: string;
	private readonly authPath: string;
	private readonly apiPath: string;

	constructor(options: VibeAuthenticationServerOptions) {
		this.authenticationService = options.authenticationService;
		this.basePath = this.authenticationService.basePath;
		this.authPath = `${this.basePath}/auth`;
		this.apiPath = `${this.authPath}/api`;
	}

	public get publicOrigins(): readonly string[] {
		return this.authenticationService.publicOrigins;
	}

	public async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<boolean> {
		const requestUrl = new URL(request.url ?? '/', 'http://authentication.invalid');
		const pathname = requestUrl.pathname;
		if (pathname !== this.authPath && !pathname.startsWith(`${this.authPath}/`)) {
			return false;
		}

		try {
			await this.dispatch(request, response, requestUrl);
		} catch (error) {
			console.error('Vibe authentication request failed:', error instanceof Error ? error.message : String(error));
			if (!response.headersSent) {
				this.sendText(response, 500, 'Internal Server Error');
			} else {
				response.destroy();
			}
		}
		return true;
	}

	public dispose(): void {
		this.authenticationService.dispose();
	}

	private async dispatch(request: http.IncomingMessage, response: http.ServerResponse, requestUrl: URL): Promise<void> {
		const route = requestUrl.pathname.slice(this.authPath.length) || '/';
		if (request.method === 'POST' && !this.matchPublicOrigin(request)) {
			this.sendText(response, 403, messages[resolveLocale(request, requestUrl)].invalidOrigin);
			return;
		}
		if ((request.method === 'GET' || request.method === 'HEAD') && ['/', '/login', '/register', '/logout'].includes(route) && !this.matchPublicOrigin(request)) {
			this.redirect(request, response, `${requestUrl.pathname}${requestUrl.search}`);
			return;
		}
		if (request.method === 'GET' && route === '/health') {
			this.authenticationService.checkHealth();
			this.sendEmpty(response, 204);
			return;
		}
		if (request.method === 'GET' && route === '/api/status') {
			await this.handleStatus(request, response);
			return;
		}
		if ((request.method === 'GET' || request.method === 'HEAD') && route === '/verify') {
			await this.handleVerify(request, response);
			return;
		}
		if ((request.method === 'GET' || request.method === 'HEAD') && (route === '/' || route === '/login')) {
			await this.handleLoginPage(request, response, requestUrl);
			return;
		}
		if ((request.method === 'GET' || request.method === 'HEAD') && route === '/register') {
			await this.handleRegisterPage(request, response, requestUrl);
			return;
		}
		if ((request.method === 'GET' || request.method === 'HEAD') && route === '/logout') {
			await this.handleLogoutPage(request, response, requestUrl);
			return;
		}
		if (request.method === 'POST' && route === '/login') {
			await this.handleLogin(request, response, requestUrl);
			return;
		}
		if (request.method === 'POST' && route === '/register') {
			await this.handleRegister(request, response, requestUrl);
			return;
		}
		if (request.method === 'POST' && route === '/logout') {
			await this.handleLogout(request, response, requestUrl);
			return;
		}

		response.setHeader('Allow', 'GET, HEAD, POST');
		this.sendText(response, 405, 'Method Not Allowed');
	}

	private async handleStatus(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		const session = await this.readSession(request, response);
		this.sendJson(response, 200, {
			authenticated: session.authenticated,
			registrationOpen: this.authenticationService.registrationOpen,
			...(session.authenticated ? { username: session.username } : {}),
		});
	}

	private async handleVerify(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		if (!this.matchPublicOrigin(request)) {
			if (this.isNavigationRequest(request)) {
				this.redirect(request, response, sanitizeReturnTo(firstHeader(request.headers['x-forwarded-uri']), this.basePath, this.authPath));
			} else {
				this.sendJson(response, 401, { authenticated: false });
			}
			return;
		}
		const session = await this.readSession(request, response);
		if (session.authenticated) {
			// Only 2xx responses use Caddy's single-cookie renewal bridge. Denials
			// pass through directly and can clear multiple stale Better Auth cookies.
			const cookies = response.getHeader('Set-Cookie');
			if (Array.isArray(cookies) && cookies.length > 1) {
				throw new Error('Successful session verification must emit at most one cookie for the Caddy renewal bridge.');
			}
			this.sendEmpty(response, 204);
			return;
		}

		if (this.isNavigationRequest(request)) {
			const forwardedUri = firstHeader(request.headers['x-forwarded-uri']);
			const returnTo = sanitizeReturnTo(forwardedUri, this.basePath, this.authPath);
			const destination = this.authenticationService.registrationOpen ? 'register' : 'login';
			this.redirect(request, response, `${this.authPath}/${destination}?return_to=${encodeURIComponent(returnTo)}`);
			return;
		}

		this.sendJson(response, 401, { authenticated: false });
	}

	private async handleLoginPage(request: http.IncomingMessage, response: http.ServerResponse, requestUrl: URL): Promise<void> {
		const returnTo = sanitizeReturnTo(requestUrl.searchParams.get('return_to'), this.basePath, this.authPath);
		if (this.authenticationService.registrationOpen) {
			this.redirect(request, response, `${this.authPath}/register?return_to=${encodeURIComponent(returnTo)}`);
			return;
		}
		if ((await this.readSession(request, response)).authenticated) {
			this.redirect(request, response, returnTo);
			return;
		}
		this.renderPage(request, response, {
			kind: 'login',
			locale: resolveLocale(request, requestUrl),
			returnTo,
		});
	}

	private async handleRegisterPage(request: http.IncomingMessage, response: http.ServerResponse, requestUrl: URL): Promise<void> {
		const returnTo = sanitizeReturnTo(requestUrl.searchParams.get('return_to'), this.basePath, this.authPath);
		if (!this.authenticationService.registrationOpen) {
			this.redirect(request, response, `${this.authPath}/login?return_to=${encodeURIComponent(returnTo)}`);
			return;
		}
		this.renderPage(request, response, {
			kind: 'register',
			locale: resolveLocale(request, requestUrl),
			returnTo,
		});
	}

	private async handleLogoutPage(request: http.IncomingMessage, response: http.ServerResponse, requestUrl: URL): Promise<void> {
		const session = await this.readSession(request, response);
		if (!session.authenticated) {
			this.redirect(request, response, `${this.authPath}/login`);
			return;
		}
		this.renderPage(request, response, {
			kind: 'logout',
			locale: resolveLocale(request, requestUrl),
			returnTo: `${this.basePath}/`,
			username: session.username,
		});
	}

	private async handleLogin(request: http.IncomingMessage, response: http.ServerResponse, requestUrl: URL): Promise<void> {
		const locale = resolveLocale(request, requestUrl);
		const form = await this.readFormOrReply(request, response);
		if (!form) {
			return;
		}
		const username = getSingleFormValue(form, 'username')?.normalize('NFC') ?? '';
		const password = getSingleFormValue(form, 'password') ?? '';
		const returnTo = sanitizeReturnTo(getSingleFormValue(form, 'return_to'), this.basePath, this.authPath);
		const authenticationResponse = await this.invokeBetterAuth(request, 'POST', '/sign-in/username', {
			username,
			password,
			rememberMe: true,
		});
		this.copyBetterAuthHeaders(authenticationResponse, response);
		if (authenticationResponse.ok) {
			this.redirect(request, response, returnTo);
			return;
		}
		const error = await readBetterAuthError(authenticationResponse);
		this.renderPage(request, response, {
			kind: 'login',
			locale,
			returnTo,
			username,
			error: describeBetterAuthFailure(authenticationResponse, error, locale, 'invalidCredentials'),
		}, authenticationResponse.status);
	}

	private async handleRegister(request: http.IncomingMessage, response: http.ServerResponse, requestUrl: URL): Promise<void> {
		const locale = resolveLocale(request, requestUrl);
		const form = await this.readFormOrReply(request, response);
		if (!form) {
			return;
		}
		const username = getSingleFormValue(form, 'username')?.normalize('NFC') ?? '';
		const password = getSingleFormValue(form, 'password') ?? '';
		const confirmation = getSingleFormValue(form, 'confirm_password') ?? '';
		const returnTo = sanitizeReturnTo(getSingleFormValue(form, 'return_to'), this.basePath, this.authPath);
		if (password !== confirmation) {
			this.renderPage(request, response, {
				kind: 'register', locale, returnTo, username, error: messages[locale].passwordMismatch,
			}, 400);
			return;
		}
		const authenticationResponse = this.authenticationService.registrationOpen ? await this.invokeBetterAuth(request, 'POST', '/sign-up/email', {
			email: administratorEmail,
			name: username,
			username,
			password,
		}) : undefined;
		if (authenticationResponse) {
			this.copyBetterAuthHeaders(authenticationResponse, response);
		}
		if (authenticationResponse?.ok) {
			this.redirect(request, response, returnTo);
			return;
		}

		if (!authenticationResponse || !this.authenticationService.registrationOpen) {
			this.renderPage(request, response, {
				kind: 'login', locale, returnTo, username, error: messages[locale].registrationClosed,
			}, 409);
			return;
		}
		const error = await readBetterAuthError(authenticationResponse);
		this.renderPage(request, response, {
			kind: 'register',
			locale,
			returnTo,
			username,
			error: describeBetterAuthFailure(authenticationResponse, error, locale, 'invalidRequest'),
		}, authenticationResponse.status);
	}

	private async handleLogout(request: http.IncomingMessage, response: http.ServerResponse, requestUrl: URL): Promise<void> {
		const locale = resolveLocale(request, requestUrl);
		const form = await this.readFormOrReply(request, response);
		if (!form) {
			return;
		}
		const authenticationResponse = await this.invokeBetterAuth(request, 'POST', '/sign-out', {});
		this.copyBetterAuthHeaders(authenticationResponse, response);
		if (authenticationResponse.ok) {
			this.redirect(request, response, `${this.authPath}/login`);
			return;
		}
		const error = await readBetterAuthError(authenticationResponse);
		this.renderPage(request, response, {
			kind: 'logout',
			locale,
			returnTo: `${this.basePath}/`,
			error: describeBetterAuthFailure(authenticationResponse, error, locale, 'invalidRequest'),
		}, authenticationResponse.status);
	}

	private async readSession(request: http.IncomingMessage, response: http.ServerResponse): Promise<AuthenticationSession> {
		const authenticationResponse = await this.invokeBetterAuth(request, 'GET', '/get-session');
		this.copyBetterAuthHeaders(authenticationResponse, response);
		if (!authenticationResponse.ok) {
			if (authenticationResponse.status >= 500) {
				throw new Error(`Better Auth session lookup failed with ${authenticationResponse.status}.`);
			}
			return { authenticated: false };
		}
		const value: unknown = await authenticationResponse.json();
		if (!isRecord(value) || !isRecord(value.user) || typeof value.user.name !== 'string') {
			return { authenticated: false };
		}
		return { authenticated: true, username: value.user.name };
	}

	private async invokeBetterAuth(request: http.IncomingMessage, method: 'GET' | 'POST', route: string, body?: object): Promise<Response> {
		const publicOrigin = this.matchPublicOrigin(request) ?? this.publicOrigins[0];
		const headers = fromNodeHeaders(request.headers);
		headers.delete('content-length');
		headers.set('host', new URL(publicOrigin).host);
		headers.set('x-vibe-client-ip', (firstCommaSeparatedValue(firstHeader(request.headers['x-forwarded-for'])) ?? request.socket.remoteAddress ?? 'unknown').slice(0, 128));
		if (body) {
			headers.set('content-type', 'application/json');
		} else {
			headers.delete('content-type');
		}
		return this.authenticationService.handle(new Request(`${publicOrigin}${this.apiPath}${route}`, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
		}));
	}

	private copyBetterAuthHeaders(source: Response, target: http.ServerResponse): void {
		for (const value of source.headers.getSetCookie()) {
			target.appendHeader('Set-Cookie', value);
		}
		const retryAfter = source.headers.get('retry-after');
		if (retryAfter) {
			target.setHeader('Retry-After', retryAfter);
		}
	}

	private async readFormOrReply(request: http.IncomingMessage, response: http.ServerResponse): Promise<URLSearchParams | undefined> {
		try {
			return await readForm(request);
		} catch (error) {
			if (error instanceof RequestBodyTooLargeError) {
				this.sendText(response, 413, 'Payload Too Large');
				return undefined;
			}
			throw error;
		}
	}

	private renderPage(request: http.IncomingMessage, response: http.ServerResponse, options: Omit<AuthenticationPageOptions, 'basePath'>, statusCode = 200): void {
		const rendered = renderAuthenticationPage({ ...options, basePath: this.basePath });
		response.writeHead(statusCode, authenticationDocumentHeaders(rendered.styleNonce, options.locale));
		if (request.method === 'HEAD') {
			response.end();
		} else {
			response.end(rendered.content);
		}
	}

	private isNavigationRequest(request: http.IncomingMessage): boolean {
		if (firstHeader(request.headers.upgrade)?.toLowerCase() === 'websocket' || firstHeader(request.headers['x-forwarded-upgrade'])?.toLowerCase() === 'websocket') {
			return false;
		}
		const forwardedMethod = firstHeader(request.headers['x-forwarded-method']) ?? request.method;
		if (forwardedMethod !== 'GET' && forwardedMethod !== 'HEAD') {
			return false;
		}
		const fetchMode = firstHeader(request.headers['sec-fetch-mode']);
		const accept = firstHeader(request.headers.accept) ?? '';
		return fetchMode === 'navigate' || accept.split(',').some(value => value.trim().startsWith('text/html'));
	}

	private matchPublicOrigin(request: http.IncomingMessage): string | undefined {
		return matchVibePublicOrigin(this.publicOrigins, firstHeader(request.headers['x-forwarded-host']), request.headers.host);
	}

	private redirect(request: http.IncomingMessage, response: http.ServerResponse, location: string): void {
		response.writeHead(303, {
			'Cache-Control': 'no-store',
			'Location': `${this.matchPublicOrigin(request) ?? this.publicOrigins[0]}${location}`,
			'Referrer-Policy': 'no-referrer',
			'X-Content-Type-Options': 'nosniff',
		});
		response.end();
	}

	private sendEmpty(response: http.ServerResponse, statusCode: number): void {
		response.writeHead(statusCode, {
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
		});
		response.end();
	}

	private sendJson(response: http.ServerResponse, statusCode: number, value: object): void {
		response.writeHead(statusCode, {
			'Cache-Control': 'no-store',
			'Content-Type': 'application/json; charset=utf-8',
			'Referrer-Policy': 'no-referrer',
			'X-Content-Type-Options': 'nosniff',
		});
		response.end(JSON.stringify(value));
	}

	private sendText(response: http.ServerResponse, statusCode: number, value: string): void {
		response.writeHead(statusCode, {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
			'X-Content-Type-Options': 'nosniff',
		});
		response.end(value);
	}
}

export async function createVibeAuthenticationServer(args: Pick<ServerParsedArgs, 'auth-state-dir' | 'public-origin' | 'auth-session-ttl-seconds'>, basePath: string): Promise<VibeAuthenticationServer | undefined> {
	const stateDirectory = args['auth-state-dir'];
	if (stateDirectory === undefined) {
		if (args['public-origin'] !== undefined || args['auth-session-ttl-seconds'] !== undefined) {
			throw new Error('Authentication options require --auth-state-dir.');
		}
		return undefined;
	}
	if (!isAbsolute(stateDirectory)) {
		throw new Error('--auth-state-dir must be an absolute path.');
	}
	if (!args['public-origin']?.length) {
		throw new Error('Authentication requires --public-origin with the browser-visible HTTPS origin.');
	}
	const authenticationService = await VibeAuthenticationService.create({
		stateDirectory,
		publicOrigins: args['public-origin'],
		basePath,
		sessionTtlSeconds: args['auth-session-ttl-seconds'] === undefined ? undefined : Number(args['auth-session-ttl-seconds']),
	});
	return new VibeAuthenticationServer({ authenticationService });
}

function renderAuthenticationPage(options: AuthenticationPageOptions): RenderedAuthenticationPage {
	const text = messages[options.locale];
	const styleNonce = crypto.randomBytes(18).toString('base64');
	const authPath = `${options.basePath}/auth`;
	const alternateLocale: Locale = options.locale === 'en' ? 'zh-cn' : 'en';
	const alternateLabel = text.alternateLanguage;
	const localeTarget = `${authPath}/${options.kind}?lang=${alternateLocale}&return_to=${encodeURIComponent(options.returnTo)}`;
	const title = options.kind === 'register' ? text.registerTitle : options.kind === 'login' ? text.loginAction : text.logoutTitle;
	const description = options.kind === 'register' ? text.registerDescription : text.logoutDescription;
	const label = options.kind === 'register' ? text.setupLabel : text.logoutLabel;
	const action = options.kind === 'register' ? text.registerAction : options.kind === 'login' ? text.loginAction : text.logoutAction;
	const username = escapeHtml(options.username ?? '');
	const brandName = options.kind === 'login'
		? `<h1 id="page-title" class="brand-name">${escapeHtml(text.brand)}</h1>`
		: `<span class="brand-name">${escapeHtml(text.brand)}</span>`;
	const introduction = options.kind === 'login' ? '' : `<p class="eyebrow">${escapeHtml(label)}</p>
			<h1 id="page-title">${escapeHtml(title)}</h1>
			<p class="description">${escapeHtml(description)}</p>`;
	const error = options.error ? `<div class="message" role="alert">${escapeHtml(options.error)}</div>` : '';
	const credentials = options.kind === 'logout'
		? `<p class="account"><span>${escapeHtml(text.signedInAs)}</span><strong>${username}</strong></p>`
		: `<label>${escapeHtml(text.usernameLabel)}<input name="username" value="${username}" autocomplete="username" maxlength="64" required autofocus></label>
			<label>${escapeHtml(text.passwordLabel)}<input name="password" type="password" autocomplete="${options.kind === 'register' ? 'new-password' : 'current-password'}" maxlength="256" required></label>
			${options.kind === 'register' ? `<label>${escapeHtml(text.confirmPasswordLabel)}<input name="confirm_password" type="password" autocomplete="new-password" maxlength="256" required></label><p class="hint">${escapeHtml(text.passwordHint)}</p>` : ''}`;

	const content = `<!DOCTYPE html>
<html lang="${options.locale}">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta name="color-scheme" content="dark light">
	<title>${escapeHtml(title)} - ${escapeHtml(text.brand)}</title>
	<link rel="icon" href="${vibeLogoDataUri}" type="image/svg+xml" sizes="any">
	<style nonce="${styleNonce}">
		:root { color-scheme: dark; --page: #0f1117; --surface: #181b22; --surface-raised: #20242d; --text: #f0f1f3; --muted: #a8adb7; --border: #343945; --accent: #8ab4f8; --accent-strong: #a8c7fa; --button-text: #101318; --danger-bg: #3a2024; --danger-border: #8c3943; --focus: #9cc2ff; }
		* { box-sizing: border-box; }
		html, body { min-height: 100%; }
		body { margin: 0; background: var(--page); color: var(--text); font: 400 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
		.shell { min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 24px; }
		.card { width: min(100%, 400px); padding: 32px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 20px 60px rgba(0, 0, 0, .24); }
		.brand { display: flex; align-items: center; justify-content: center; gap: var(--vscode-spacing-size240, 24px); margin-bottom: 32px; }
		.brand-name { margin: 0; color: #2864F0; font-size: 24px; line-height: 1.25; font-weight: 600; letter-spacing: -.02em; }
		.mark { display: block; width: 40px; height: 40px; flex-shrink: 0; filter: drop-shadow(0 4px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, .14))); }
		.eyebrow { margin: 0 0 6px; color: var(--accent); font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
		h1 { margin: 0; font-size: 26px; line-height: 1.2; font-weight: 600; letter-spacing: -.02em; }
		.description { margin: 12px 0 24px; color: var(--muted); }
		.message { margin: 0 0 20px; padding: 12px; border: 1px solid var(--danger-border); border-radius: 6px; background: var(--danger-bg); }
		form { display: grid; gap: 16px; }
		label { display: grid; gap: 6px; font-size: 12px; font-weight: 600; }
		input { width: 100%; min-height: 40px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 4px; outline: none; background: var(--page); color: var(--text); font: inherit; }
		input:hover { border-color: var(--muted); }
		input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
		.hint { margin: -8px 0 0; color: var(--muted); font-size: 11px; }
		button { min-height: 40px; margin-top: 4px; padding: 8px 16px; border: 0; border-radius: 4px; background: var(--accent-strong); color: var(--button-text); font-family: inherit; font-size: 13px; font-weight: 600; line-height: 1.2; cursor: pointer; }
		button:hover { filter: brightness(1.06); }
		.account { display: grid; gap: 4px; margin: 0; padding: 16px; border-radius: 6px; background: var(--surface-raised); }
		.account span { color: var(--muted); font-size: 11px; }
		.account strong { font-weight: 600; overflow-wrap: anywhere; }
		.footer { margin: 24px 0 0; text-align: center; }
		a { color: var(--accent); text-underline-offset: 2px; }
		@media (prefers-color-scheme: light) { :root { color-scheme: light; --page: #f4f5f7; --surface: #ffffff; --surface-raised: #eef1f5; --text: #202124; --muted: #626872; --border: #c9ced6; --accent: #315f9d; --accent-strong: #2563a9; --button-text: #ffffff; --danger-bg: #fff0f1; --danger-border: #c76a74; --focus: #245f9e; } }
		@media (max-width: 480px) { .shell { padding: 16px; } .card { padding: 24px; } }
		@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; } }
	</style>
</head>
<body>
	<main class="shell">
		<section class="card" aria-labelledby="page-title">
			<div class="brand"><img class="mark" src="${vibeLogoDataUri}" width="40" height="40" alt="">${brandName}</div>
			${introduction}
			${error}
			<form method="post" action="${authPath}/${options.kind}?lang=${options.locale}" aria-label="${escapeHtml(action)}">
				<input type="hidden" name="return_to" value="${escapeHtml(options.returnTo)}">
				${credentials}
				<button type="submit">${escapeHtml(action)}</button>
			</form>
			<p class="footer"><a href="${escapeHtml(localeTarget)}" hreflang="${alternateLocale}">${escapeHtml(alternateLabel)}</a></p>
		</section>
	</main>
</body>
</html>`;

	return { content, styleNonce };
}

function authenticationDocumentHeaders(styleNonce: string, locale: Locale): http.OutgoingHttpHeaders {
	return {
		'Cache-Control': 'no-store',
		'Content-Language': locale,
		'Content-Security-Policy': `default-src 'none'; img-src data:; style-src 'nonce-${styleNonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
		'Content-Type': 'text/html; charset=utf-8',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
		'X-Frame-Options': 'DENY',
	};
}

async function readForm(request: http.IncomingMessage): Promise<URLSearchParams> {
	const contentType = firstHeader(request.headers['content-type'])?.split(';', 1)[0].trim().toLowerCase();
	if (contentType !== 'application/x-www-form-urlencoded') {
		return new URLSearchParams();
	}
	let size = 0;
	let tooLarge = false;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.byteLength;
		if (size > requestBodyMaximumBytes) {
			tooLarge = true;
			continue;
		}
		chunks.push(buffer);
	}
	if (tooLarge) {
		throw new RequestBodyTooLargeError();
	}
	return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

async function readBetterAuthError(response: Response): Promise<BetterAuthError> {
	try {
		const value: unknown = await response.json();
		return isRecord(value) && typeof value.code === 'string' ? { code: value.code } : {};
	} catch {
		return {};
	}
}

const betterAuthFailureMessages: Partial<Record<string, keyof Messages>> = {
	INVALID_ORIGIN: 'invalidOrigin',
	INVALID_USERNAME: 'invalidUsername',
	USERNAME_TOO_SHORT: 'invalidUsername',
	USERNAME_TOO_LONG: 'invalidUsername',
	PASSWORD_TOO_SHORT: 'invalidPassword',
	PASSWORD_TOO_LONG: 'invalidPassword',
	INVALID_PASSWORD: 'invalidPassword',
};

function describeBetterAuthFailure(response: Response, error: BetterAuthError, locale: Locale, fallback: 'invalidCredentials' | 'invalidRequest'): string {
	if (response.status === 429) {
		return messages[locale].rateLimited;
	}
	if (response.status === 403) {
		return messages[locale].invalidOrigin;
	}
	return messages[locale][betterAuthFailureMessages[error.code ?? ''] ?? fallback];
}

function getSingleFormValue(form: URLSearchParams, key: string): string | undefined {
	const values = form.getAll(key);
	return values.length === 1 ? values[0] : undefined;
}

function sanitizeReturnTo(value: string | null | undefined, basePath: string, authPath: string): string {
	const fallback = `${basePath}/`;
	if (!value || value.length > 2048 || !value.startsWith('/') || value.startsWith('//')) {
		return fallback;
	}
	try {
		const parsed = new URL(value, 'https://return.invalid');
		if (parsed.origin !== 'https://return.invalid' || (basePath && parsed.pathname !== basePath && !parsed.pathname.startsWith(`${basePath}/`)) || parsed.pathname === authPath || parsed.pathname.startsWith(`${authPath}/`)) {
			return fallback;
		}
		const pathname = basePath && parsed.pathname === basePath ? `${basePath}/` : parsed.pathname;
		return `${pathname}${parsed.search}${parsed.hash}`;
	} catch {
		return fallback;
	}
}

function resolveLocale(request: http.IncomingMessage, requestUrl?: URL): Locale {
	const requestedLocale = requestUrl?.searchParams.get('lang')?.toLowerCase();
	if (requestedLocale === 'zh-cn' || requestedLocale === 'zh') {
		return 'zh-cn';
	}
	if (requestedLocale === 'en') {
		return 'en';
	}
	const acceptedLanguages = firstHeader(request.headers['accept-language'])?.toLowerCase() ?? '';
	return acceptedLanguages.split(',').some(value => value.trim().startsWith('zh')) ? 'zh-cn' : 'en';
}

function firstHeader(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function firstCommaSeparatedValue(value: string | undefined): string | undefined {
	const first = value?.split(',', 1)[0].trim();
	return first || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string): string {
	const escapedCharacters: Record<string, string> = {
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'\'': '&#39;',
		'"': '&quot;',
	};
	return value.replace(/[&<>'"]/g, character => escapedCharacters[character] ?? character);
}
