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
import { packageWebClientRelease } from '../webClientRelease.ts';

const run = promisify(execFile);
const commit = 'a'.repeat(40);
const linuxOnly = { skip: process.platform !== 'linux' || process.arch !== 'x64' };

async function createFixture(root: string): Promise<string> {
	const source = path.join(root, 'product');
	const workbench = path.join(source, 'out/vs/code/browser/workbench');
	await Promise.all([
		fs.mkdir(workbench, { recursive: true }),
		fs.mkdir(path.join(source, 'extensions/vibe-vscode/dist/browser'), { recursive: true }),
		fs.mkdir(path.join(source, 'node_modules'), { recursive: true }),
	]);
	await Promise.all([
		fs.writeFile(path.join(source, 'product.json'), JSON.stringify({ commit })),
		fs.writeFile(path.join(source, 'package.json'), '{"type":"module"}'),
		// A controllable native-loading boundary keeps archive tests independent of native addons.
		fs.writeFile(path.join(source, 'node'), '#!/bin/sh\nif [ "$1" = "-p" ]; then\n  printf "v1.2.3\\n"\nelif [ "$1" = "--input-type=module" ]; then\n  test -z "$VSCODE_DEV" && test "$NODE_ENV" = production\nelse\n  test -z "$VSCODE_DEV" && test "$NODE_ENV" = production || exit 1\n  printf "%s\\n" "$@"\nfi\n', { mode: 0o755 }),
		fs.writeFile(path.join(source, 'out/server-main.js'), 'export {};'),
		fs.writeFile(path.join(source, 'extensions/vibe-vscode/dist/browser/extension.js'), 'export {};'),
		fs.writeFile(path.join(workbench, 'workbench.html'), '<script type="{{WORKBENCH_MAIN_SCRIPT_TYPE}}"></script>'),
		fs.writeFile(path.join(workbench, 'workbench.js'), `globalThis.fixture = ${JSON.stringify('release fixture '.repeat(1000))};`),
		fs.writeFile(path.join(workbench, 'workbench.css'), '.fixture { color: red; }\n'.repeat(100)),
		fs.writeFile(path.join(workbench, 'workbenchCache.js'), 'export const loader = true;'),
	]);
	await prepareWebClientAssets(path.join(source, 'out'));
	return source;
}

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
			metadata: { version: 'v1.2.3', commit, platform: 'linux', arch: 'x64' },
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
