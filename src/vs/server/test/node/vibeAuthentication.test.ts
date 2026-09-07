/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import type * as http from 'http';
import * as os from 'os';
import { join } from '../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { getRandomTestPath } from '../../../base/test/node/testUtils.js';
import { VibeAuthenticationService } from '../../node/vibeAuthentication.js';
import { VibeAuthenticationServer } from '../../node/vibeAuthenticationServer.js';

const nodeHttp = await import('http');
const validPassword = 'correct horse battery staple';

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
				connection: 'upgrade',
				upgrade: 'websocket',
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
			navigation: { status: 303, location: '/code/auth/register?return_to=%2Fcode%2F%3Ffolder%3D%252Fworkspace' },
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
			username: '管理员',
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
		const originProbe = await postForm(harness.port, '/code/auth/api/origin-check', {}, sessionCookie);
		const authorizedAfterOriginProbe = await request(harness.port, '/code/auth/verify', {
			headers: { cookie: sessionCookie, 'x-forwarded-uri': '/code/' },
		});
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
				containsWorkbench: registrationPage.body.includes('workbench.desktop.main.js'),
				containsLegacyCsrf: registrationPage.body.includes('csrf_token'),
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
			originProbe: { status: originProbe.status, sessionPreserved: authorizedAfterOriginProbe.status },
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
			registrationPage: { status: 200, language: 'zh-cn', localized: true, containsWorkbench: false, containsLegacyCsrf: false },
			registration: { status: 303, location: '/code/' },
			sessionCookieAttributes: { httpOnly: true, secure: true, sameSite: true, path: true },
			authorized: 204,
			renewed: true,
			originProbe: { status: 204, sessionPreserved: 204 },
			status: { authenticated: true, registrationOpen: false, username: '管理员' },
			closedRegistration: { status: 303, location: '/code/auth/login?return_to=%2Fcode%2F' },
			logoutPage: true,
			logout: { status: 303, location: '/code/auth/login' },
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
		const sameOriginProbe = await postForm(harness.port, '/code/auth/api/origin-check', {});
		const crossOriginProbe = await postForm(harness.port, '/code/auth/api/origin-check', {}, undefined, 'https://attacker.invalid');
		const crossOrigin = await postForm(harness.port, '/code/auth/register?lang=en', {
			return_to: '/code/', username: 'admin', password: validPassword, confirm_password: validPassword,
		}, undefined, 'https://attacker.invalid');
		const oversized = await request(harness.port, '/code/auth/register', {
			method: 'POST',
			body: `username=${'a'.repeat(17_000)}`,
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				origin: `https://127.0.0.1:${harness.port}`,
				'x-forwarded-proto': 'https',
			},
		});
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
			originProbe: { sameOrigin: sameOriginProbe.status, crossOrigin: crossOriginProbe.status },
			crossOrigin: { status: crossOrigin.status, message: crossOrigin.body.includes('browser address could not be verified') },
			oversized: { status: oversized.status, body: oversized.body },
			attempts,
		}, {
			originProbe: { sameOrigin: 204, crossOrigin: 403 },
			crossOrigin: { status: 403, message: true },
			oversized: { status: 413, body: 'Payload Too Large' },
			attempts: [401, 401, 401, 401, 401, 429],
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

async function createHarness(stateDirectory: string): Promise<AuthenticationTestHarness> {
	const authenticationService = await VibeAuthenticationService.create({
		stateDirectory,
		basePath: '/code',
		sessionTtlSeconds: 60,
		sessionUpdateAgeSeconds: 1,
	});
	const authenticationServer = new VibeAuthenticationServer({ authenticationService, basePath: '/code' });
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
		const request = nodeHttp.request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers }, response => {
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

function postForm(port: number, path: string, values: Record<string, string>, cookie?: string, origin?: string): Promise<TestResponse> {
	const body = new URLSearchParams(values).toString();
	return request(port, path, {
		method: 'POST',
		body,
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			'content-length': Buffer.byteLength(body),
			origin: origin ?? `https://127.0.0.1:${port}`,
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
