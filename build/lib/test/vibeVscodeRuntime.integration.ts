/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

// Run against the archive that will be published, not against mutable source output.
const artifacts = path.resolve(process.argv[2]);
const archive = (await fs.readdir(artifacts)).find(name => /^vibe-vscode-server-v.+-linux-x64\.tar\.gz$/.test(name));
assert.ok(archive, 'expected a Linux x64 release archive');
const tag = archive.slice('vibe-vscode-server-'.length, -'-linux-x64.tar.gz'.length);
const run = promisify(execFile);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-runtime-smoke-'));
const installRoot = path.join(temporary, 'install with spaces');
const state = path.join(temporary, 'state with spaces');
let active: { child: ChildProcess; closed: Promise<void>; output: () => string } | undefined;
let occupied: net.Server | undefined;

try {
	const commands = path.join(temporary, 'download');
	await fs.mkdir(commands);
	// Substitute only the network download: the real installer checks and extracts the real archive.
	await fs.writeFile(path.join(commands, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --output ]]; then output="$2"; shift 2; else url="$1"; shift; fi
done
cp -- "$VIBE_TEST_ARTIFACTS/\${url##*/}" "$output"
`, { mode: 0o755 });
	await run('bash', [path.join(artifacts, 'install.sh'), '--tag', tag, '--root', installRoot], {
		env: { ...process.env, PATH: `${commands}${path.delimiter}${process.env.PATH}`, VIBE_TEST_ARTIFACTS: artifacts },
		maxBuffer: 1024 * 1024,
	});
	const runtime = await fs.realpath(path.join(installRoot, 'current'));
	assert.deepStrictEqual(await fs.readFile(path.join(runtime, 'bin/install.sh')), await fs.readFile(path.join(artifacts, 'install.sh')));
	// Isolate this disposable test from the network. Only the bind address changes; binaries,
	// startup commands, TLS, origin selection and all authorization rules remain the shipped ones.
	const template = path.join(runtime, 'resources/server/vibe-vscode/Caddyfile');
	await fs.writeFile(template, (await fs.readFile(template, 'utf8')).replace('bind 0.0.0.0', 'bind 127.0.0.1'));
	const cli = path.join(runtime, 'bin/vibe-vscode');
	const port = await reservePort();
	const arguments_ = ['--state-dir', state, '--port', String(port), '--origin', `https://localhost:${port}`, '--origin', `https://127.0.0.1:${port}`];
	await start(cli, arguments_);
	const socket = await fs.readlink(path.join(state, 'backend.sock'));
	assert.equal((await fs.stat(path.dirname(socket))).mode & 0o777, 0o700);
	assert.ok((await run(cli, ['status', ...arguments_])).stdout.includes('is healthy'));
	assert.ok((await fs.stat(path.join(state, 'caddy/pki/authorities/local/root.crt'))).isFile());
	assert.ok(active!.output().includes('TLS uses Caddy\'s local CA; trust '));
	await assert.rejects(run(cli, ['start', ...arguments_]), /another instance/);
	const workspace = path.join(state, 'vibe-vscode.code-workspace');
	assert.deepStrictEqual(JSON.parse(await fs.readFile(workspace, 'utf8')).folders, []);
	const project = path.join(temporary, 'project');
	await fs.mkdir(project);
	const workspaceContents = JSON.stringify({ folders: [{ path: project }], settings: {} });
	await fs.writeFile(workspace, workspaceContents);
	await stop('SIGINT');
	await assert.rejects(fs.stat(socket), { code: 'ENOENT' });
	await assert.rejects(fs.lstat(path.join(state, 'backend.sock')), { code: 'ENOENT' });
	await assert.rejects(run(cli, ['status', ...arguments_]), /no running instance/);

	const certificate = path.join(temporary, 'custom certificate.pem');
	const key = path.join(temporary, 'custom key.pem');
	await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', certificate]);
	const withCertificate = [...arguments_, '--tls-cert', certificate, '--tls-key', key];
	for (const component of ['caddy', 'node']) {
		await start(cli, withCertificate);
		assert.ok(!active!.output().includes('TLS uses Caddy\'s local CA; trust '), 'provided certificates must not be described as the local CA');
		const childIds = (await fs.readFile(`/proc/${active!.child.pid}/task/${active!.child.pid}/children`, 'utf8')).trim().split(/\s+/).map(Number);
		const childCommands = await Promise.all(childIds.map(async pid => ({ pid, command: (await fs.readFile(`/proc/${pid}/cmdline`)).toString().split('\0')[0] })));
		const target = childCommands.find(child => child.command === path.join(runtime, component));
		assert.ok(target, `expected an owned ${component} process`);
		process.kill(target.pid, 'SIGTERM');
		await deadline(active!.closed, 20_000);
		assert.equal(active!.child.exitCode, 1);
		active = undefined;
		await assert.rejects(fs.lstat(path.join(state, 'backend.sock')), { code: 'ENOENT' });
		assert.equal(await fs.readFile(workspace, 'utf8'), workspaceContents, 'restarts must preserve the physical workspace');
	}

	occupied = net.createServer();
	await new Promise<void>(resolve => occupied!.listen(0, '127.0.0.1', resolve));
	const address = occupied.address();
	assert.ok(address && typeof address !== 'string');
	await assert.rejects(run(cli, ['start', '--state-dir', path.join(temporary, 'port-conflict'), '--port', String(address.port), '--origin', `https://localhost:${address.port}`], { timeout: 20_000, maxBuffer: 1024 * 1024 }), /component exited/);
	assert.equal(occupied.listening, true, 'an unrelated listener must not be signalled');
	console.log('Installed runtime passed: real archive/installer; local-CA and provided TLS; two origins; four health boundaries; single writer; Ctrl-C and either-child exit cleanup; persistent workspace; unrelated listener preserved.');
} finally {
	if (active) {
		await stop('SIGTERM');
	}
	if (occupied) {
		await new Promise<void>(resolve => occupied!.close(() => resolve()));
	}
	await fs.rm(temporary, { recursive: true, force: true });
}

async function start(cli: string, args: string[]): Promise<void> {
	const child = spawn(cli, ['start', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
	let output = '';
	const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-100_000); };
	child.stdout!.on('data', append);
	child.stderr!.on('data', append);
	const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
	active = { child, closed, output: () => output };
	const end = Date.now() + 70_000;
	while (Date.now() < end) {
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(`Installed runtime exited during startup:\n${output}`);
		}
		if (output.includes('vibe vscode is ready: open ')) {
			return;
		}
		await delay(100);
	}
	throw new Error(`Installed runtime did not become ready:\n${output}`);
}

async function stop(signal: NodeJS.Signals): Promise<void> {
	const instance = active!;
	if (instance.child.exitCode === null && instance.child.signalCode === null) {
		instance.child.kill(signal);
	}
	await deadline(instance.closed, 20_000);
	active = undefined;
}

async function deadline(promise: Promise<void>, milliseconds: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout>;
	try {
		await Promise.race([promise, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('Runtime cleanup timed out')), milliseconds); })]);
	} finally {
		clearTimeout(timer!);
	}
}

async function reservePort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	await new Promise<void>(resolve => server.close(() => resolve()));
	return address.port;
}
