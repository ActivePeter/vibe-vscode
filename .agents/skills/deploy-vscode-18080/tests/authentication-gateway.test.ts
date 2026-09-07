/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(import.meta.dirname, '../../../..');
const caddyBinary = process.argv[2];
assert.ok(caddyBinary, 'Usage: node authentication-gateway.test.ts <pinned-caddy-binary>');
await access(caddyBinary, constants.X_OK);
Object.assign(globalThis, {
	_VSCODE_FILE_ROOT: pathToFileURL(join(root, 'out/')).href,
	_VSCODE_PRODUCT_JSON: JSON.parse(await readFile(join(root, 'product.json'), 'utf8')),
	_VSCODE_PACKAGE_JSON: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')),
});
registerHooks({ resolve(specifier, context, next) {
	assert.notEqual(specifier, 'better-sqlite3', 'the removed native dependency must not be loaded');
	return next(specifier, context);
} });
const { VibeAuthenticationService }: typeof import('../../../../src/vs/server/node/vibeAuthentication.js') = await import(pathToFileURL(join(root, 'out/vs/server/node/vibeAuthentication.js')));
const { VibeAuthenticationServer }: typeof import('../../../../src/vs/server/node/vibeAuthenticationServer.js') = await import(pathToFileURL(join(root, 'out/vs/server/node/vibeAuthenticationServer.js')));
const temporary = await mkdtemp(join(tmpdir(), 'vibe-gateway-review-'));
const socketPath = join(temporary, 'backend.sock');
let gateway: ChildProcess | undefined;
let adapter: InstanceType<typeof VibeAuthenticationServer> | undefined;
let backend: http.Server | undefined;
let gatewayLog = '';
let protectedRequests = 0;
try {
	const reservation = net.createServer();
	reservation.listen(0, '127.0.0.1');
	await once(reservation, 'listening');
	const address = reservation.address();
	assert.ok(address && typeof address !== 'string');
	const port = address.port;
	await new Promise<void>(resolve => reservation.close(() => resolve()));
	const publicOrigin = `https://configured.example:${port}`;
	const authentication = await VibeAuthenticationService.create({ stateDirectory: join(temporary, 'auth'), publicOrigin, sessionTtlSeconds: 60, sessionUpdateAgeSeconds: 1 });
	const authenticationServer = adapter = new VibeAuthenticationServer({ authenticationService: authentication });
	backend = http.createServer(async (request, response) => {
		if (!await authenticationServer.handle(request, response)) {
			protectedRequests++;
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ renewalHeader: request.headers['x-vibe-auth-set-cookie'] ?? null }));
		}
	});
	backend.on('upgrade', (_request, socket) => {
		protectedRequests++;
		socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n');
	});
	backend.listen(socketPath);
	await once(backend, 'listening');
	const certificate = join(temporary, 'cert.pem');
	const key = join(temporary, 'key.pem');
	await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', key, '-out', certificate]);
	// Keep this disposable test private; all routing and header rules are unchanged.
	const config = (await readFile(join(root, 'resources/server/vibe-vscode/Caddyfile'), 'utf8')).replace('bind 0.0.0.0', 'bind 127.0.0.1');
	const configPath = join(temporary, 'Caddyfile');
	await writeFile(configPath, config);
	gateway = spawn(caddyBinary, ['run', '--config', configPath, '--adapter', 'caddyfile'], { env: {
		...process.env,
		XDG_CONFIG_HOME: join(temporary, 'config'), XDG_DATA_HOME: join(temporary, 'data'),
		VIBE_VSCODE_PUBLIC_PORT: String(port), VIBE_VSCODE_TLS_CERT_PATH: certificate, VIBE_VSCODE_TLS_KEY_PATH: key,
		VIBE_VSCODE_AUTH_PATH: '/auth', VIBE_VSCODE_AUTH_ADDRESS: `unix/${socketPath}`, VIBE_VSCODE_BACKEND_ADDRESS: `unix/${socketPath}`,
	}, stdio: ['ignore', 'pipe', 'pipe'] });
	gateway.stdout?.on('data', chunk => { gatewayLog += chunk; });
	gateway.stderr?.on('data', chunk => { gatewayLog += chunk; });
	const request = (path: string, options: { method?: string; headers?: http.OutgoingHttpHeaders; body?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> => new Promise((resolve, reject) => {
		const req = https.request({ host: '127.0.0.1', port, path, rejectUnauthorized: false, method: options.method ?? 'GET', headers: options.headers }, response => {
			const chunks: Buffer[] = [];
			response.on('data', chunk => chunks.push(chunk));
			response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
		});
		req.on('upgrade', (response, socket) => { socket.destroy(); resolve({ status: response.statusCode ?? 0, headers: response.headers, body: '' }); });
		req.on('error', reject);
		req.setTimeout(5000, () => req.destroy(new Error('request timed out')));
		req.end(options.body);
	});
	for (let attempt = 0; attempt < 50; attempt++) {
		if (gateway.exitCode !== null) {
			throw new Error(gatewayLog);
		}
		try {
			if ((await request('/auth/api/status')).status === 200) {
				break;
			}
		} catch { }
		await delay(100);
	}
	const navigation = await request('/', { headers: { Accept: 'text/html' } });
	const asset = await request('/static/resource.js', { headers: { 'X-Vibe-Auth-Set-Cookie': 'attacker=1' } });
	const webSocketHeaders = { Connection: 'Upgrade', Upgrade: 'websocket', Accept: 'text/html', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' };
	const deniedSocket = await request('/websocket', { headers: webSocketHeaders });
	const authenticationSocket = await request('/auth/register', { headers: webSocketHeaders });
	assert.notEqual(authenticationSocket.status, 101);
	for (const path of ['/auth/../', '/auth/%2e%2e/', '/%61uth/../', '/auth%2f..%2f', '/auth/%2e%2e/static/resource.js', '/auth//../', '/auth/%2f..%2f..%2f']) {
		const traversal = await request(path);
		assert.equal(protectedRequests, 0, `authentication route normalization bypass: ${path}, status ${traversal.status}`);
	}
	assert.deepEqual([navigation.status, asset.status, deniedSocket.status, protectedRequests], [303, 401, 401, 0]);
	const form = new URLSearchParams({ username: 'review-admin', password: 'review-only password value', confirm_password: 'review-only password value', return_to: '/' }).toString();
	const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Host: 'attacker.invalid', 'X-Forwarded-Host': 'attacker.invalid', 'X-Original-Host': 'attacker.invalid' };
	const deniedRegistration = await request('/auth/register', { method: 'POST', headers: { ...headers, Origin: 'https://attacker.invalid' }, body: form });
	const registration = await request('/auth/register', { method: 'POST', headers: { ...headers, Origin: publicOrigin }, body: form });
	assert.deepEqual([deniedRegistration.status, registration.status], [403, 303]);
	const sessionCookie = registration.headers['set-cookie']?.find(value => value.startsWith('__Secure-vibe.session_token='));
	assert.ok(sessionCookie);
	const cookie = sessionCookie.split(';', 1)[0];
	await delay(1100);
	const allowed = await request('/static/resource.js', { headers: { Cookie: cookie, 'X-Vibe-Auth-Set-Cookie': 'attacker=1' } });
	assert.equal(allowed.status, 200);
	const renewalCookies = allowed.headers['set-cookie'] ?? [];
	assert.equal(renewalCookies.length, 1);
	assert.match(renewalCookies[0], /^__Secure-vibe\.session_token=/);
	assert.deepEqual(JSON.parse(allowed.body), { renewalHeader: null });
	const allowedSocket = await request('/websocket', { headers: { ...webSocketHeaders, Cookie: cookie } });
	assert.equal(allowedSocket.status, 101);
	const logout = await request('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: publicOrigin, Cookie: cookie }, body: '' });
	const deniedAfterLogout = await request('/static/resource.js', { headers: { Cookie: cookie } });
	assert.deepEqual([logout.status, deniedAfterLogout.status, protectedRequests], [303, 401, 2]);
	assert.ok((deniedAfterLogout.headers['set-cookie']?.length ?? 0) > 1, 'denials must preserve separate cookie-clearing headers');
	console.log('Real Caddy gateway passed: navigation 303; resources/WS 401; forged origin 403; registration 303; authorized HTTP 200/WS 101; exactly one renewal cookie; logout revocation and multi-cookie denial preserved. No better-sqlite3 import.');
} catch (error) {
	console.error(gatewayLog);
	throw error;
} finally {
	if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
		const exited = once(gateway, 'exit');
		gateway.kill('SIGTERM');
		await exited;
	}
	const runningBackend = backend;
	if (runningBackend) {
		await new Promise<void>(resolve => runningBackend.close(() => resolve()));
	}
	adapter?.dispose();
	await rm(temporary, { recursive: true, force: true });
}
