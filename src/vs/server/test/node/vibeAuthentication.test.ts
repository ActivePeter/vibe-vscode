/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import type * as http from 'http';
import * as os from 'os';
import * as sinon from 'sinon';
import { FileAccess } from '../../../base/common/network.js';
import { join } from '../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { getRandomTestPath } from '../../../base/test/node/testUtils.js';
import { VibeAuthenticationService } from '../../node/vibeAuthentication.js';
import { createVibeAuthenticationServer, VibeAuthenticationServer } from '../../node/vibeAuthenticationServer.js';

const nodeHttp = await import('http');
const validPassword = 'correct horse battery staple';
const publicOrigin = 'https://vscode.example:8443';
const administratorName = '管理员';

suite('VibeAuthenticationServer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let harness: AuthenticationTestHarness;
	let testDirectory: string;

	setup(async function () {
		this.timeout(30_000);
		testDirectory = getRandomTestPath(os.tmpdir(), 'vsctests', 'vibe-authentication');
		fs.mkdirSync(testDirectory, { recursive: true });
		harness = await createHarness(testDirectory);
	});

	teardown(async () => {
		await harness.close();
		fs.rmSync(testDirectory, { recursive: true, force: true });
	});

	test('gates navigation and WebSocket requests before registration', async () => {
		const navigation = await request(harness.port, '/code/auth/verify', {
			headers: {
				accept: 'text/html',
				'x-forwarded-method': 'GET',
				'x-forwarded-uri': '/code/?folder=%2Fworkspace',
			},
		});
		const webSocket = await request(harness.port, '/code/auth/verify', {
			headers: {
				accept: 'text/html',
				'x-forwarded-upgrade': 'websocket',
				'x-forwarded-method': 'GET',
				'x-forwarded-uri': '/code/stable-id',
			},
		});
		const status = await request(harness.port, '/code/auth/api/status');
		const nonAuthenticationPath = await request(harness.port, '/code/');

		assert.deepStrictEqual({
			navigation: { status: navigation.status, location: navigation.headers.location },
			webSocket: { status: webSocket.status, body: webSocket.body },
			status: JSON.parse(status.body),
			nonAuthenticationPath: nonAuthenticationPath.status,
		}, {
			navigation: { status: 303, location: `${publicOrigin}/code/auth/register?return_to=%2Fcode%2F%3Ffolder%3D%252Fworkspace` },
			webSocket: { status: 401, body: '{"authenticated":false}' },
			status: { authenticated: false, registrationOpen: true },
			nonAuthenticationPath: 404,
		});
	});

	test('registers, persists, authenticates, renews, and logs out', async function () {
		this.timeout(30_000);
		const registrationPage = await request(harness.port, '/code/auth/register?lang=zh-cn&return_to=%2Fcode%2F', {
			headers: { accept: 'text/html', 'accept-language': 'zh-CN' },
		});
		const registration = await postForm(harness.port, '/code/auth/register?lang=zh-cn', {
			return_to: '/code/',
			username: administratorName,
			password: validPassword,
			confirm_password: validPassword,
		});
		const sessionCookie = getSessionCookie(registration.headers);
		assert.ok(sessionCookie);
		const sessionSetCookie = getSessionSetCookie(registration.headers);

		await new Promise(resolve => setTimeout(resolve, 1_100));
		await harness.close();
		harness = await createHarness(testDirectory);
		const authorized = await request(harness.port, '/code/auth/verify', {
			headers: { cookie: sessionCookie, 'x-forwarded-uri': '/code/' },
		});
		const renewedCookie = getSessionSetCookie(authorized.headers);
		const status = await request(harness.port, '/code/auth/api/status', { headers: { cookie: sessionCookie } });
		const closedRegistration = await request(harness.port, '/code/auth/register', { headers: { accept: 'text/html' } });
		const logoutPage = await request(harness.port, '/code/auth/logout?lang=en', { headers: { accept: 'text/html', cookie: sessionCookie } });
		const logout = await postForm(harness.port, '/code/auth/logout', { return_to: '/code/' }, sessionCookie);
		const afterLogout = await request(harness.port, '/code/auth/verify', {
			headers: { cookie: sessionCookie, accept: 'application/json', 'x-forwarded-uri': '/code/' },
		});
		const databaseContents = fs.readFileSync(join(testDirectory, 'better-auth.sqlite3'));

		assert.deepStrictEqual({
			registrationPage: {
				status: registrationPage.status,
				language: registrationPage.headers['content-language'],
				localized: registrationPage.body.includes('创建管理员账号'),
			},
			registration: { status: registration.status, location: registration.headers.location },
			sessionCookieAttributes: {
				httpOnly: sessionSetCookie?.includes('HttpOnly'),
				secure: sessionSetCookie?.includes('Secure'),
				sameSite: sessionSetCookie?.includes('SameSite=Lax'),
				path: sessionSetCookie?.includes('Path=/code/'),
			},
			authorized: authorized.status,
			renewed: Boolean(renewedCookie),
			renewalCookieCount: setCookieValues(authorized.headers).length,
			status: JSON.parse(status.body),
			closedRegistration: { status: closedRegistration.status, location: closedRegistration.headers.location },
			logoutPage: logoutPage.body.includes('Sign out of this browser'),
			logout: { status: logout.status, location: logout.headers.location },
			afterLogout: afterLogout.status,
			stateModes: {
				directory: fs.statSync(testDirectory).mode & 0o777,
				database: fs.statSync(join(testDirectory, 'better-auth.sqlite3')).mode & 0o777,
				secret: fs.statSync(join(testDirectory, 'better-auth.secret')).mode & 0o777,
			},
			storesPlaintextPassword: databaseContents.includes(Buffer.from(validPassword)),
		}, {
			registrationPage: { status: 200, language: 'zh-cn', localized: true },
			registration: { status: 303, location: `${publicOrigin}/code/` },
			sessionCookieAttributes: { httpOnly: true, secure: true, sameSite: true, path: true },
			authorized: 204,
			renewed: true,
			renewalCookieCount: 1,
			status: { authenticated: true, registrationOpen: false, username: administratorName },
			closedRegistration: { status: 303, location: `${publicOrigin}/code/auth/login?return_to=%2Fcode%2F` },
			logoutPage: true,
			logout: { status: 303, location: `${publicOrigin}/code/auth/login` },
			afterLogout: 401,
			stateModes: { directory: 0o700, database: 0o600, secret: 0o600 },
			storesPlaintextPassword: false,
		});
	});

	test('enforces one administrator under concurrent registration', async function () {
		this.timeout(30_000);
		const responses = await Promise.all([
			postForm(harness.port, '/code/auth/register', {
				return_to: '/code/', username: 'first-admin', password: validPassword, confirm_password: validPassword,
			}),
			postForm(harness.port, '/code/auth/register', {
				return_to: '/code/', username: 'second-admin', password: validPassword, confirm_password: validPassword,
			}),
		]);
		const successfulResponse = responses.find(response => response.status === 303);
		assert.ok(successfulResponse);
		const ownerStatus = await request(harness.port, '/code/auth/api/status', {
			headers: { cookie: getSessionCookie(successfulResponse.headers) },
		});

		assert.deepStrictEqual({
			statuses: responses.map(response => response.status).sort((left, right) => left - right),
			registrationOpen: harness.authenticationService.registrationOpen,
			registeredUsername: JSON.parse(ownerStatus.body).username,
		}, {
			statuses: [303, 409],
			registrationOpen: false,
			registeredUsername: responses[0].status === 303 ? 'first-admin' : 'second-admin',
		});
	});

	test('does not rate-limit session verification during workbench resource loading', async function () {
		this.timeout(30_000);
		const registration = await postForm(harness.port, '/code/auth/register', {
			return_to: '/code/', username: 'admin', password: validPassword, confirm_password: validPassword,
		});
		const sessionCookie = getSessionCookie(registration.headers);
		assert.ok(sessionCookie);

		const responses = await Promise.all(Array.from({ length: 125 }, () => request(harness.port, '/code/auth/verify', {
			headers: { cookie: sessionCookie, 'x-forwarded-uri': '/code/out/resource.js' },
		})));

		assert.deepStrictEqual([...new Set(responses.map(response => response.status))], [204]);
	});

	test('uses Better Auth origin checks, rate limits, and bounded request bodies', async function () {
		this.timeout(30_000);
		const crossOrigin = await postForm(harness.port, '/code/auth/register?lang=en', {
			return_to: '/code/', username: 'admin', password: validPassword, confirm_password: validPassword,
		}, undefined, 'https://attacker.invalid');
		const oversizedBody = `username=${'a'.repeat(17_000)}`;
		const oversized = await Promise.all(['content-length', 'transfer-encoding'].map(header => request(harness.port, '/code/auth/register', {
			method: 'POST',
			body: oversizedBody,
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				[header]: header === 'content-length' ? Buffer.byteLength(oversizedBody) : 'chunked',
				origin: publicOrigin,
				'x-forwarded-proto': 'https',
			},
		})));
		const registration = await postForm(harness.port, '/code/auth/register', {
			return_to: '/code/', username: 'admin', password: validPassword, confirm_password: validPassword,
		});
		assert.strictEqual(registration.status, 303);
		const attempts: number[] = [];
		for (let index = 0; index < 6; index++) {
			attempts.push((await postForm(harness.port, '/code/auth/login', {
				return_to: '/code/', username: 'admin', password: 'incorrect password value',
			})).status);
		}

		assert.deepStrictEqual({
			crossOrigin: { status: crossOrigin.status, message: crossOrigin.body.includes('browser address could not be verified') },
			oversized: oversized.map(response => ({ status: response.status, body: response.body })),
			attempts,
		}, {
			crossOrigin: { status: 403, message: true },
			oversized: [{ status: 413, body: 'Payload Too Large' }, { status: 413, body: 'Payload Too Large' }],
			attempts: [401, 401, 401, 401, 401, 429],
		});
	});

	test('rejects unlisted hosts even when the Origin header is allowed', async () => {
		const body = new URLSearchParams({ username: 'admin', password: validPassword, confirm_password: validPassword }).toString();
		const forgedHeaders = {
			host: 'attacker.invalid',
			'x-original-host': 'attacker.invalid',
			'x-forwarded-host': 'attacker.invalid',
			'x-forwarded-proto': 'http',
			'x-vibe-public-origin': 'https://attacker.invalid',
			'content-type': 'application/x-www-form-urlencoded',
		};
		const denied = await request(harness.port, '/code/auth/register', {
			method: 'POST', body, headers: { ...forgedHeaders, origin: 'https://attacker.invalid' },
		});
		const forgedWithAllowedOrigin = await request(harness.port, '/code/auth/register', {
			method: 'POST', body, headers: { ...forgedHeaders, origin: publicOrigin },
		});
		const accepted = await postForm(harness.port, '/code/auth/register', { username: 'admin', password: validPassword, confirm_password: validPassword });
		const cookie = getSessionCookie(accepted.headers);
		const rejectedLogout = await postForm(harness.port, '/code/auth/logout', {}, cookie, 'https://attacker.invalid');
		const sessionAfterRejectedLogout = await request(harness.port, '/code/auth/verify', { headers: { cookie } });
		assert.deepStrictEqual({ denied: denied.status, forgedWithAllowedOrigin: forgedWithAllowedOrigin.status, accepted: accepted.status, logout: rejectedLogout.status, session: sessionAfterRejectedLogout.status }, {
			denied: 403, forgedWithAllowedOrigin: 403, accepted: 303, logout: 403, session: 204,
		});
	});

	test('selects the second allowed origin and keeps independently issued sessions separate', async () => {
		await harness.close();
		const secondOrigin = 'https://100.64.0.7:8443';
		const secondHost = new URL(secondOrigin).host;
		harness = await createHarness(testDirectory, '/code', [publicOrigin, secondOrigin]);
		const registration = await postForm(harness.port, '/code/auth/register', {
			username: 'admin', password: validPassword, confirm_password: validPassword,
		}, undefined, secondOrigin, secondHost);
		const secondCookie = getSessionCookie(registration.headers);
		const login = await postForm(harness.port, '/code/auth/login', { username: 'admin', password: validPassword });
		const firstCookie = getSessionCookie(login.headers);
		const verify = await request(harness.port, '/code/auth/verify', { headers: { host: 'private-proxy.invalid', 'x-forwarded-host': `${secondHost}, proxy.invalid`, cookie: secondCookie } });
		const logout = await postForm(harness.port, '/code/auth/logout', {}, secondCookie, secondOrigin, secondHost);
		const firstSession = await request(harness.port, '/code/auth/verify', { headers: { cookie: firstCookie } });
		const secondSession = await request(harness.port, '/code/auth/verify', { headers: { host: secondHost, cookie: secondCookie } });
		const handler = sinon.spy(harness.authenticationService, 'handle');
		try {
			const denied = await postForm(harness.port, '/code/auth/login', { username: 'admin', password: validPassword }, undefined, secondOrigin, 'attacker.invalid');
			const fallback = await request(harness.port, '/code/auth/verify', { headers: { host: 'attacker.invalid', accept: 'text/html', 'x-forwarded-uri': '//attacker.invalid/' } });
			const loginPage = await request(harness.port, '/code/auth/login?lang=zh-cn', { headers: { host: 'attacker.invalid' } });
			assert.deepStrictEqual({
				registration: [registration.status, registration.headers.location],
				login: [login.status, login.headers.location],
				cookies: { distinct: firstCookie !== secondCookie, hostOnly: !getSessionSetCookie(registration.headers)?.includes('Domain=') },
				verify: verify.status,
				logout: [logout.status, logout.headers.location],
				sessions: [firstSession.status, secondSession.status],
				unlisted: [denied.status, handler.callCount, fallback.headers.location, loginPage.status, loginPage.headers.location],
			}, {
				registration: [303, `${secondOrigin}/code/`], login: [303, `${publicOrigin}/code/`],
				cookies: { distinct: true, hostOnly: true }, verify: 204,
				logout: [303, `${secondOrigin}/code/auth/login`], sessions: [204, 401],
				unlisted: [403, 0, `${publicOrigin}/code/`, 303, `${publicOrigin}/code/auth/login?lang=zh-cn`],
			});
		} finally {
			handler.restore();
		}
	});

	test('validates CLI configuration before creating persistent state', async () => {
		const stateDirectory = join(testDirectory, 'invalid-configuration');
		const args = { 'auth-state-dir': stateDirectory, 'public-origin': [publicOrigin] };
		await assert.rejects(createVibeAuthenticationServer({ 'auth-state-dir': stateDirectory }, ''), /--public-origin/);
		for (const stateDirectory of ['', 'relative-state']) {
			await assert.rejects(createVibeAuthenticationServer({ ...args, 'auth-state-dir': stateDirectory }, ''), /absolute path/);
		}
		for (const origin of ['http://vscode.example', 'https:vscode.example', 'https://user:password@vscode.example', 'https://vscode.example/path', 'https://vscode.example?query=1', 'https://vscode.example#fragment', 'https://*.example', 'https://vs\tcode.example', 'https://vscode.example\\']) {
			await assert.rejects(createVibeAuthenticationServer({ ...args, 'public-origin': [publicOrigin, origin] }, ''), /HTTPS origin/);
		}
		for (const ttl of ['59', '604801', 'NaN', '1.5', '']) {
			await assert.rejects(createVibeAuthenticationServer({ ...args, 'auth-session-ttl-seconds': ttl }, ''), /session lifetime/);
		}
		for (const basePath of ['code', '/code/', '//code', '/code?query', '/code#fragment']) {
			await assert.rejects(createVibeAuthenticationServer(args, basePath), /server base path/);
		}
		assert.strictEqual(fs.existsSync(stateDirectory), false);
		assert.strictEqual(await createVibeAuthenticationServer({}, ''), undefined);
		const server = await createVibeAuthenticationServer({ ...args, 'public-origin': [`${publicOrigin},https://localhost:8443`, publicOrigin] }, '');
		try {
			assert.deepStrictEqual(server?.publicOrigins, [publicOrigin, 'https://localhost:8443']);
		} finally {
			server?.dispose();
		}
	});

	test('normalizes the root base path once for the service and HTTP adapter', async () => {
		await harness.close();
		harness = await createHarness(testDirectory, '/');
		const status = await request(harness.port, '/auth/api/status');
		const registration = await postForm(harness.port, '/auth/register', {
			username: 'admin', password: validPassword, confirm_password: validPassword,
		});
		assert.deepStrictEqual({
			basePath: harness.authenticationService.basePath,
			status: JSON.parse(status.body),
			location: registration.headers.location,
			cookiePath: getSessionSetCookie(registration.headers)?.includes('Path=/;'),
		}, { basePath: '', status: { authenticated: false, registrationOpen: true }, location: `${publicOrigin}/`, cookiePath: true });
	});

	test('maps Better Auth failures consistently across all form routes and both locales', async () => {
		const handler = sinon.stub(harness.authenticationService, 'handle');
		try {
			for (const locale of ['en', 'zh-cn']) {
				const bundle: typeof import('../../node/vibe-authentication.nls.en.json') = JSON.parse(fs.readFileSync(FileAccess.asFileUri(`vs/server/node/vibe-authentication.nls.${locale}.json`).fsPath, 'utf8'));
				for (const route of ['login', 'register', 'logout']) {
					for (const [status, code, message] of [
						[429, 'INVALID_PASSWORD', 'rateLimited'],
						[403, 'INVALID_USERNAME', 'invalidOrigin'],
						[400, 'INVALID_ORIGIN', 'invalidOrigin'],
						[400, 'INVALID_USERNAME', 'invalidUsername'],
						[400, 'USERNAME_TOO_SHORT', 'invalidUsername'],
						[400, 'USERNAME_TOO_LONG', 'invalidUsername'],
						[400, 'PASSWORD_TOO_SHORT', 'invalidPassword'],
						[400, 'PASSWORD_TOO_LONG', 'invalidPassword'],
						[400, 'INVALID_PASSWORD', 'invalidPassword'],
						[400, 'UNRECOGNIZED_ERROR', route === 'login' ? 'invalidCredentials' : 'invalidRequest'],
					] as const) {
						handler.resolves(Response.json({ code }, { status }));
						const response = await postForm(harness.port, `/code/auth/${route}?lang=${locale}`, {});
						assert.deepStrictEqual({ status: response.status, localized: response.body.includes(bundle[message]) }, {
							status, localized: true,
						}, `${route}/${locale}/${code}`);
					}
				}
			}
		} finally {
			handler.restore();
		}
	});

	test('does not call Better Auth for an already closed registration', async () => {
		const form = { username: 'admin', password: validPassword, confirm_password: validPassword };
		assert.strictEqual((await postForm(harness.port, '/code/auth/register', form)).status, 303);
		const handler = sinon.spy(harness.authenticationService, 'handle');
		try {
			const response = await postForm(harness.port, '/code/auth/register?lang=en', form);
			assert.deepStrictEqual({ status: response.status, calls: handler.callCount }, { status: 409, calls: 0 });
		} finally {
			handler.restore();
		}
	});

	test('ships matching message keys and renders both packaged locales', async () => {
		const bundles = ['en', 'zh-cn'].map(locale => JSON.parse(fs.readFileSync(FileAccess.asFileUri(`vs/server/node/vibe-authentication.nls.${locale}.json`).fsPath, 'utf8')));
		const pages = await Promise.all(['en', 'zh-cn'].map(locale => request(harness.port, `/code/auth/register?lang=${locale}`)));
		assert.deepStrictEqual({ keys: Object.keys(bundles[0]).sort(), rendered: pages.map((page, index) => page.status === 200 && page.body.includes(bundles[index].registerTitle) && page.body.includes(bundles[index].alternateLanguage)) }, {
			keys: Object.keys(bundles[1]).sort(), rendered: [true, true],
		});
	});

	test('fails closed when persistent authentication state is malformed', async () => {
		await harness.close();
		fs.writeFileSync(join(testDirectory, 'better-auth.secret'), 'malformed', { mode: 0o600 });
		await assert.rejects(createHarness(testDirectory), /secret is malformed/);
		assert.strictEqual(fs.readFileSync(join(testDirectory, 'better-auth.secret'), 'utf8'), 'malformed');
		harness = { ...harness, close: async () => { } };
	});
});

interface AuthenticationTestHarness {
	readonly authenticationService: VibeAuthenticationService;
	readonly port: number;
	readonly close: () => Promise<void>;
}

async function createHarness(stateDirectory: string, basePath = '/code', publicOrigins = [publicOrigin]): Promise<AuthenticationTestHarness> {
	const authenticationService = await VibeAuthenticationService.create({
		stateDirectory,
		publicOrigins,
		basePath,
		sessionTtlSeconds: 60,
		sessionUpdateAgeSeconds: 1,
	});
	const authenticationServer = new VibeAuthenticationServer({ authenticationService });
	const server = nodeHttp.createServer(async (request, response) => {
		if (!await authenticationServer.handle(request, response)) {
			response.writeHead(404, { 'Content-Type': 'text/plain' });
			response.end('Not Found');
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen({ host: '127.0.0.1', port: 0 }, () => {
			server.off('error', reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Authentication test server did not bind a TCP port.');
	}
	return {
		authenticationService,
		port: address.port,
		close: async () => {
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
			authenticationServer.dispose();
		},
	};
}

interface TestResponse {
	readonly status: number;
	readonly headers: http.IncomingHttpHeaders;
	readonly body: string;
}

function request(port: number, path: string, options: {
	readonly method?: string;
	readonly headers?: http.OutgoingHttpHeaders;
	readonly body?: string;
} = {}): Promise<TestResponse> {
	return new Promise((resolve, reject) => {
		const request = nodeHttp.request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: new URL(publicOrigin).host, ...options.headers } }, response => {
			const chunks: Buffer[] = [];
			response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
			response.on('end', () => resolve({
				status: response.statusCode ?? 0,
				headers: response.headers,
				body: Buffer.concat(chunks).toString('utf8'),
			}));
		});
		request.on('error', reject);
		request.end(options.body);
	});
}

function postForm(port: number, path: string, values: Record<string, string>, cookie?: string, origin?: string, host = new URL(publicOrigin).host): Promise<TestResponse> {
	const body = new URLSearchParams(values).toString();
	return request(port, path, {
		method: 'POST',
		body,
		headers: {
			host,
			'content-type': 'application/x-www-form-urlencoded',
			'content-length': Buffer.byteLength(body),
			origin: origin ?? publicOrigin,
			'x-forwarded-proto': 'https',
			...(cookie ? { cookie } : {}),
		},
	});
}

function getSessionCookie(headers: http.IncomingHttpHeaders): string {
	return getSessionSetCookie(headers)?.split(';', 1)[0] ?? '';
}

function getSessionSetCookie(headers: http.IncomingHttpHeaders): string | undefined {
	return setCookieValues(headers).find(value => /^(?:__Secure-)?vibe\.session_token=/.test(value));
}

function setCookieValues(headers: http.IncomingHttpHeaders): string[] {
	const value = headers['set-cookie'];
	return Array.isArray(value) ? value : value ? [value] : [];
}
