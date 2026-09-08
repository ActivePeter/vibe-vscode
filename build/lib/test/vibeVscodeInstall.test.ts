/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { create as createTar } from 'tar';
import { installPinnedCaddy } from '../caddy.ts';
import { installWebClientLauncher } from '../webClientRelease.ts';

const run = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '../../..');
const installer = path.join(repository, 'install.sh');
const linuxOnly = { skip: process.platform !== 'linux' || process.arch !== 'x64' };

async function fixture() {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-install-'));
	const root = path.join(temporary, 'installation with spaces');
	const assets = path.join(temporary, 'assets');
	const commands = path.join(temporary, 'commands');
	await fs.mkdir(assets);
	await fs.mkdir(commands);
	// Only the download I/O is fake. The installer still validates checksums, tar paths and metadata.
	await fs.writeFile(path.join(commands, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --output ]]; then output="$2"; shift 2; else url="$1"; shift; fi
done
cp -- "$FIXTURE_ASSETS/\${url##*/}" "$output"
`, { mode: 0o755 });
	const env = { ...process.env, PATH: `${commands}${path.delimiter}${process.env.PATH}`, FIXTURE_ASSETS: assets };
	const install = (...args: string[]) => run('bash', [installer, '--root', root, ...args], { env });
	const archive = async (tag: string, modify?: (source: string) => Promise<void>) => {
		const source = path.join(temporary, tag);
		await fs.mkdir(path.join(source, 'out'), { recursive: true });
		await fs.writeFile(path.join(source, 'node'), '#!/bin/sh\nexec node "$@"\n', { mode: 0o755 });
		await fs.writeFile(path.join(source, 'caddy'), '#!/bin/sh\n[ "$1" = version ]\n', { mode: 0o755 });
		await fs.writeFile(path.join(source, 'out/server-main.js'), 'console.log("fixture server");');
		await installWebClientLauncher(source, tag, 'a'.repeat(40), 'production');
		await modify?.(source);
		const name = `vibe-vscode-server-${tag}-linux-x64.tar.gz`;
		const file = path.join(assets, name);
		await createTar({ cwd: source, file, gzip: true, portable: true }, ['.']);
		await fs.writeFile(`${file}.sha256`, `${createHash('sha256').update(await fs.readFile(file)).digest('hex')}  ${name}\n`);
		return file;
	};
	return { temporary, root, assets, env, install, archive, dispose: () => fs.rm(temporary, { recursive: true, force: true }) };
}

test('installs without system directories, reuses immutable tags, upgrades and rolls back in either direction', linuxOnly, async () => {
	const f = await fixture();
	try {
		await f.archive('v1.2.3');
		await f.archive('v1.2.4');
		await f.install('--tag', 'v1.2.3');
		const release = path.join(f.root, 'releases/v1.2.3');
		const before = await fs.stat(path.join(release, 'vibe-release.json'));
		await fs.mkdir(path.join(f.root, 'state/auth'), { recursive: true });
		await fs.writeFile(path.join(f.root, 'state/auth/keep'), 'account and session state');
		await f.install('--tag', 'v1.2.3');
		await f.install('--tag', 'v1.2.4');
		const upgraded = await fs.readlink(path.join(f.root, 'current'));
		// The embedded installer discovers a custom root through the current symlink.
		await run('bash', [path.join(f.root, 'current/bin/install.sh'), '--rollback'], { env: f.env });
		const rolledBack = await fs.readlink(path.join(f.root, 'current'));
		await f.install('--rollback');
		assert.deepStrictEqual({
			upgraded, rolledBack, restored: await fs.readlink(path.join(f.root, 'current')),
			unchanged: before.mtimeMs === (await fs.stat(path.join(release, 'vibe-release.json'))).mtimeMs,
			state: await fs.readFile(path.join(f.root, 'state/auth/keep'), 'utf8'),
			releases: (await fs.readdir(path.join(f.root, 'releases'))).sort(),
		}, { upgraded: 'releases/v1.2.4', rolledBack: 'releases/v1.2.3', restored: 'releases/v1.2.4', unchanged: true, state: 'account and session state', releases: ['v1.2.3', 'v1.2.4'] });
	} finally {
		await f.dispose();
	}
});

test('checksum, metadata and escaping-link failures preserve the selected release and remove staging', linuxOnly, async () => {
	const f = await fixture();
	try {
		await f.archive('v1.2.3');
		await f.install('--tag', 'v1.2.3');
		const corrupt = await f.archive('v1.2.4');
		await fs.appendFile(corrupt, 'corrupted after checksum');
		await assert.rejects(f.install('--tag', 'v1.2.4'), /checksum mismatch/);
		await f.archive('v1.2.5', async source => {
			await fs.writeFile(path.join(source, 'vibe-release.json'), '{"version":"wrong"}');
		});
		await assert.rejects(f.install('--tag', 'v1.2.5'), /metadata does not match/);
		await f.archive('v1.2.6', async source => {
			await fs.symlink(process.execPath, path.join(source, 'external'));
		});
		await assert.rejects(f.install('--tag', 'v1.2.6'), /link escapes/);
		assert.deepStrictEqual({
			current: await fs.readlink(path.join(f.root, 'current')),
			releases: await fs.readdir(path.join(f.root, 'releases')),
			staging: (await fs.readdir(f.root)).filter(name => name.startsWith('.install.')),
		}, { current: 'releases/v1.2.3', releases: ['v1.2.3'], staging: [] });
	} finally {
		await f.dispose();
	}
});

test('installation lock contention has no download or activation side effects', linuxOnly, async () => {
	const f = await fixture();
	let holder: ReturnType<typeof spawn> | undefined;
	try {
		await fs.mkdir(f.root);
		holder = spawn('bash', ['-c', 'exec 9>"$1"; flock -n 9; printf locked; read -r finish', 'lock-holder', path.join(f.root, 'install.lock')], { stdio: ['pipe', 'pipe', 'pipe'] });
		await once(holder.stdout!, 'data');
		await assert.rejects(f.install('--tag', 'v1.2.3'), /another installation/);
		assert.deepStrictEqual(await fs.readdir(f.root), ['install.lock']);
	} finally {
		if (holder) {
			const closed = once(holder, 'close');
			holder.stdin!.end('finished\n');
			await closed;
		}
		await f.dispose();
	}
});

test('the generated user unit preserves CLI overrides, escapes paths and documents linger', linuxOnly, async () => {
	const f = await fixture();
	try {
		await f.archive('v1.2.3');
		await f.install('--tag', 'v1.2.3');
		const state = path.join(f.temporary, 'state with % and $ signs');
		await fs.mkdir(state);
		await fs.writeFile(path.join(state, 'vibe-vscode.env'), 'VIBE_VSCODE_ORIGIN="https://env.example:18080"\nVIBE_VSCODE_PORT=18080\nVIBE_VSCODE_SESSION_TTL=600\n');
		const cli = path.join(f.root, 'current/bin/vibe-vscode');
		const generated = await run(cli, ['systemd', '--state-dir', state, '--origin', 'https://localhost:18443', '--origin', 'https://127.0.0.1:18443', '--port', '18443'], { env: f.env });
		assert.ok(generated.stdout.includes('loginctl enable-linger'));
		assert.ok(generated.stdout.includes('"--origin" "https://localhost:18443" "--origin" "https://127.0.0.1:18443" "--port" "18443"'));
		assert.ok(generated.stdout.includes('state with %% and $$ signs'));
		assert.ok(generated.stdout.includes('WantedBy=default.target'));
		assert.ok(!generated.stdout.includes('env.example'));
		const unit = path.join(f.temporary, 'vibe-vscode.service');
		await fs.writeFile(unit, generated.stdout);
		await run('systemd-analyze', ['verify', unit]);
		const system = await run(cli, ['systemd', '--state-dir', state, '--user', 'vibe-vscode'], { env: f.env });
		assert.ok(system.stdout.includes('User=vibe-vscode\n'));
		assert.ok(system.stdout.includes('WantedBy=multi-user.target'));
		await assert.rejects(run(cli, ['systemd', '--state-dir', state, '--origin', 'http://localhost'], { env: f.env }), /HTTPS origins/);
		await assert.rejects(run(cli, ['systemd', '--state-dir', state, '--tls-cert', '/test/cert'], { env: f.env }), /Supply both/);
		await fs.writeFile(path.join(state, 'vibe-vscode.env'), 'VIBE_VSCODE_ORIGIN=$(touch SHOULD_NOT_EXIST)\n');
		await assert.rejects(run(cli, ['systemd', '--state-dir', state], { cwd: f.temporary, env: f.env }), /Invalid URL/);
		await assert.rejects(fs.stat(path.join(f.temporary, 'SHOULD_NOT_EXIST')), { code: 'ENOENT' });
		assert.deepStrictEqual(await fs.readdir(state), ['vibe-vscode.env']);
	} finally {
		await f.dispose();
	}
});

test('systemd --install creates the unit directory, writes the unit, and fails clearly without permission', linuxOnly, async () => {
	const f = await fixture();
	try {
		await f.archive('v1.2.3');
		await f.install('--tag', 'v1.2.3');
		const cli = path.join(f.root, 'current/bin/vibe-vscode');
		const configHome = path.join(f.temporary, 'xdg config');
		const installed = await run(cli, ['systemd', '--install', '--origin', 'https://localhost:18443'], { env: { ...f.env, XDG_CONFIG_HOME: configHome } });
		const unit = path.join(configHome, 'systemd/user/vibe-vscode.service');
		assert.deepStrictEqual({
			wrote: installed.stdout.includes(`Wrote ${unit}`),
			next: installed.stdout.includes('systemctl --user daemon-reload && systemctl --user enable --now vibe-vscode'),
			execStart: (await fs.readFile(unit, 'utf8')).includes('"--origin" "https://localhost:18443"'),
		}, { wrote: true, next: true, execStart: true });
		if (process.getuid?.() !== 0) {
			const readOnly = path.join(f.temporary, 'read-only');
			await fs.mkdir(readOnly, { mode: 0o500 });
			await assert.rejects(run(cli, ['systemd', '--install'], { env: { ...f.env, XDG_CONFIG_HOME: path.join(readOnly, 'config') } }), /cannot create .*then rerun/);
		}
	} finally {
		await f.dispose();
	}
});

test('configuration resolves certificate files relative to state and rejects unsupported options before starting', linuxOnly, async () => {
	const f = await fixture();
	try {
		await f.archive('v1.2.3');
		await f.install('--tag', 'v1.2.3');
		const runtime = await fs.realpath(path.join(f.root, 'current'));
		const state = path.join(f.temporary, 'state');
		await fs.mkdir(path.join(state, 'tls'), { recursive: true });
		await fs.writeFile(path.join(state, 'tls/certificate.pem'), 'certificate fixture');
		await fs.writeFile(path.join(state, 'tls/key.pem'), 'key fixture');
		await fs.writeFile(path.join(state, 'vibe-vscode.env'), 'VIBE_VSCODE_ORIGIN=https://localhost:8443,https://localhost:9443\nVIBE_VSCODE_TLS_CERT=tls/certificate.pem\nVIBE_VSCODE_TLS_KEY=tls/key.pem\n');
		const configuration = await run(process.execPath, [path.join(runtime, 'resources/server/vibe-vscode/cli-config.ts'), runtime, 'start', '--state-dir', state], { cwd: f.temporary, env: f.env });
		const lines = configuration.stdout.trimEnd().split('\n');
		const caddyfile = Buffer.from(lines[4], 'base64').toString();
		assert.deepStrictEqual({
			state: lines[0], origins: lines[2],
			sites: caddyfile.match(/https:\/\/localhost:18080/g)?.length,
			certificate: caddyfile.includes(JSON.stringify(path.join(state, 'tls/certificate.pem'))),
			key: caddyfile.includes(JSON.stringify(path.join(state, 'tls/key.pem'))),
		}, { state, origins: 'https://localhost:8443,https://localhost:9443', sites: 1, certificate: true, key: true });
		const cli = path.join(runtime, 'bin/vibe-vscode');
		for (const option of ['--workspace', '--base-path']) {
			await assert.rejects(run(cli, ['start', '--state-dir', state, option, '/'], { env: f.env }), /Unknown option/);
		}
		await assert.rejects(run(cli, ['start', '--state-dir', path.join(runtime, 'state')], { env: f.env }), /outside the runtime/);
		await fs.writeFile(path.join(state, 'vibe-vscode.env'), 'VIBE_VSCODE_STATE_DIR=/somewhere/else\n');
		await assert.rejects(run(cli, ['start', '--state-dir', state], { env: f.env }), /--state-dir selects/);
		assert.deepStrictEqual((await fs.readdir(state)).sort(), ['tls', 'vibe-vscode.env']);
	} finally {
		await f.dispose();
	}
});

test('Caddy acquisition rejects unverified bytes before extracting or publishing', linuxOnly, async () => {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'caddy-checksum-'));
	try {
		await assert.rejects(installPinnedCaddy(temporary, 'x64', async () => Buffer.from('untrusted archive')), /archive checksum mismatch/);
		await assert.rejects(installPinnedCaddy(temporary, 'ia32'), /Unsupported Caddy architecture/);
		assert.deepStrictEqual(await fs.readdir(temporary), []);
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
});
