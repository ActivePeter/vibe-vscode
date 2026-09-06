/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { extract } from 'tar';
import { prepareWebClientAssets } from '../webClientCache.ts';
import { installWebClientLauncher, packageWebClientRelease } from '../webClientRelease.ts';

const run = promisify(execFile);
const commit = 'a'.repeat(40);
const linuxOnly = { skip: process.platform !== 'linux' || process.arch !== 'x64' };

test('the shared launcher uses stamped metadata for both runtime profiles, regardless of directory name or inherited environment', linuxOnly, async () => {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'web-launcher-'));
	try {
		await fs.mkdir(path.join(temporary, 'out'));
		await fs.symlink(process.execPath, path.join(temporary, 'node'));
		await fs.writeFile(path.join(temporary, 'out/server-main.js'), 'console.log(JSON.stringify({ mode: process.env.NODE_ENV, dev: process.env.VSCODE_DEV ?? null, args: process.argv.slice(2) }));');
		const results = [];
		for (const mode of ['production', 'development'] as const) {
			await installWebClientLauncher(temporary, 'v1.2.3', commit, mode);
			const result = await run(path.join(temporary, 'bin/vibe-vscode-server'), ['--socket-path', '/test/backend.sock'], { env: { ...process.env, NODE_ENV: 'test', VSCODE_DEV: 'inherited' } });
			results.push(JSON.parse(result.stdout));
		}
		assert.deepStrictEqual(results, [
			{ mode: 'production', dev: null, args: ['--web-client-cache-version', 'v1.2.3', '--socket-path', '/test/backend.sock'] },
			{ mode: 'development', dev: '1', args: ['--web-client-cache-version', 'v1.2.3', '--socket-path', '/test/backend.sock'] },
		]);
		await fs.writeFile(path.join(temporary, 'vibe-release.json'), '{"version":"v1.2.3","mode":"unknown"}');
		await assert.rejects(run(path.join(temporary, 'bin/vibe-vscode-server'), []), /Unsupported runtime mode/);
		await fs.writeFile(path.join(temporary, 'vibe-release.json'), '{"version":"v1.2.3"}');
		const legacy = await run(path.join(temporary, 'bin/vibe-vscode-server'), ['--version'], { env: { ...process.env, VSCODE_DEV: '1' } });
		assert.deepStrictEqual(JSON.parse(legacy.stdout), { mode: 'production', dev: null, args: ['--web-client-cache-version', 'v1.2.3', '--version'] });
		await assert.rejects(installWebClientLauncher(temporary, '../invalid', commit, 'development'), /safe version/);
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
});

async function createFixture(root: string): Promise<string> {
	const source = path.join(root, 'product');
	const workbench = path.join(source, 'out/vs/code/browser/workbench');
	await Promise.all([
		fs.mkdir(workbench, { recursive: true }),
		fs.mkdir(path.join(source, 'out/vs/platform/remote/common'), { recursive: true }),
		fs.mkdir(path.join(source, 'extensions/vibe-vscode/dist/browser'), { recursive: true }),
		fs.mkdir(path.join(source, 'node_modules'), { recursive: true }),
	]);
	await Promise.all([
		fs.writeFile(path.join(source, 'product.json'), JSON.stringify({ commit })),
		fs.writeFile(path.join(source, 'out/vs/platform/remote/common/workbench-startup.nls.en.json'), '{}'),
		fs.writeFile(path.join(source, 'package.json'), '{"type":"module"}'),
		// A controllable native-loading boundary keeps archive tests independent of native addons.
		fs.writeFile(path.join(source, 'node'), `#!/bin/sh\nif [ "$1" = "-p" ]; then\n  exec ${JSON.stringify(process.execPath)} "$@"\nelif [ "$1" = "--input-type=module" ]; then\n  test -z "$VSCODE_DEV" && test "$NODE_ENV" = production\nelse\n  test -z "$VSCODE_DEV" && test "$NODE_ENV" = production || exit 1\n  printf "%s\\n" "$@"\nfi\n`, { mode: 0o755 }),
		fs.writeFile(path.join(source, 'out/server-main.js'), 'export {};'),
		fs.writeFile(path.join(source, 'extensions/vibe-vscode/dist/browser/extension.js'), 'export {};'),
		fs.writeFile(path.join(workbench, 'workbench.html'), '<script type="{{WORKBENCH_MAIN_SCRIPT_TYPE}}"></script>'),
		fs.writeFile(path.join(workbench, 'workbench.js'), `globalThis.fixture = ${JSON.stringify('release fixture '.repeat(1000))};`),
		fs.writeFile(path.join(workbench, 'workbench.css'), '.fixture { color: red; }\n'.repeat(100)),
		fs.writeFile(path.join(workbench, 'workbenchCache.js'), 'export const loader = true;'),
		fs.writeFile(path.join(workbench, 'workbenchStartup.js'), 'export const startup = true;'),
	]);
	await prepareWebClientAssets(path.join(source, 'out'));
	return source;
}

test('the consolidated CLI prepares and verifies a runtime and rejects unknown commands', linuxOnly, async () => {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'web-release-cli-'));
	const cli = path.resolve(import.meta.dirname, '../../web-release.ts');
	try {
		const source = await createFixture(temporary);
		await run(process.execPath, [cli, 'prepare', source, 'v1.2.3', commit]);
		const verified = await run(process.execPath, [cli, 'verify', source]);
		assert.match(verified.stdout, /Verified Web cache/);
		assert.strictEqual(JSON.parse(await fs.readFile(path.join(source, 'vibe-release.json'), 'utf8')).mode, 'production');
		await assert.rejects(run(process.execPath, [cli, 'unknown', source]), /Usage:/);
		await assert.rejects(run(process.execPath, [cli, 'prepare', source, 'v1.2.3', commit, '--unknown']), /Usage:/);
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
});

test('packages an immutable, checksummed release with a production launcher and preserves its input', linuxOnly, async () => {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'web-release-'));
	try {
		const source = await createFixture(temporary);
		const output = path.join(temporary, 'artifacts');
		const archive = await packageWebClientRelease(source, output, 'v1.2.3', commit);
		const contents = await fs.readFile(archive);
		const destination = path.join(temporary, 'installed');
		await fs.mkdir(destination);
		await extract({ cwd: destination, file: archive });
		const launch = await run('bash', [path.join(destination, 'bin/vibe-vscode-server'), '--port', '8080'], { env: { ...process.env, VSCODE_DEV: '1' } });
		assert.deepStrictEqual({
			metadata: JSON.parse(await fs.readFile(path.join(destination, 'vibe-release.json'), 'utf8')),
			checksum: await fs.readFile(`${archive}.sha256`, 'utf8'),
			arguments: launch.stdout.trim().split('\n').slice(1),
			inputUnchanged: !(await fs.readdir(source)).includes('vibe-release.json'),
			files: (await fs.readdir(output)).sort(),
		}, {
			metadata: { version: 'v1.2.3', commit, platform: 'linux', arch: 'x64', mode: 'production' },
			checksum: `${createHash('sha256').update(contents).digest('hex')}  ${path.basename(archive)}\n`,
			arguments: ['--web-client-cache-version', 'v1.2.3', '--port', '8080'],
			inputUnchanged: true,
			files: [path.basename(archive), `${path.basename(archive)}.sha256`],
		});
		await assert.rejects(packageWebClientRelease(source, output, 'v1.2.3', commit), /EEXIST/);
		assert.deepStrictEqual(await fs.readFile(archive), contents);
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
});

test('rejects mismatched identity and non-self-contained packages before publishing an archive', linuxOnly, async () => {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'web-release-invalid-'));
	try {
		const source = await createFixture(temporary);
		const output = path.join(temporary, 'artifacts');
		await assert.rejects(packageWebClientRelease(source, output, '../v1.2.3', commit), /release requires/);
		await assert.rejects(packageWebClientRelease(source, output, 'v1.2.3', 'b'.repeat(40)), /commit does not match/);
		await assert.rejects(packageWebClientRelease(source, path.join(source, 'artifacts'), 'v1.2.3', commit), /outside the input package/);
		const alias = path.join(temporary, 'source-alias');
		await fs.symlink(source, alias);
		await assert.rejects(packageWebClientRelease(source, path.join(alias, 'new/artifacts'), 'v1.2.3', commit), /outside the input package/);
		assert.ok(!(await fs.readdir(source)).includes('new'));
		await fs.writeFile(path.join(temporary, 'external.js'), 'export {};');
		await fs.symlink(path.join(temporary, 'external.js'), path.join(source, 'node_modules/external.js'));
		await assert.rejects(packageWebClientRelease(source, output, 'v1.2.3', commit), /link escapes/);
		assert.deepStrictEqual(await fs.readdir(output), []);
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
});

test('rejects broken compression and native loading without publishing partial releases', linuxOnly, async () => {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'web-release-preflight-'));
	try {
		const source = await createFixture(temporary);
		const output = path.join(temporary, 'artifacts');
		const gzipPath = path.join(source, 'out/vs/code/browser/workbench/workbench.js.gz');
		const gzip = await fs.readFile(gzipPath);
		await fs.writeFile(gzipPath, 'corrupt');
		await assert.rejects(packageWebClientRelease(source, output, 'v1.2.3', commit));
		assert.deepStrictEqual(await fs.readdir(output), []);
		await fs.writeFile(gzipPath, gzip);
		await fs.writeFile(path.join(source, 'node'), '#!/bin/sh\nexit 23\n');
		await assert.rejects(packageWebClientRelease(source, output, 'v1.2.3', commit), /Command failed/);
		assert.deepStrictEqual(await fs.readdir(output), []);
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
});
