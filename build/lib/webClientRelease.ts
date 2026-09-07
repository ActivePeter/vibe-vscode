/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { create as createTar } from 'tar';
import { validateWebClientCache } from './webClientCache.ts';

const run = promisify(execFile);

async function resolveOutputDirectory(directory: string): Promise<string> {
	return fs.realpath(directory).catch(async (error: NodeJS.ErrnoException) => {
		if (error.code !== 'ENOENT') {
			throw error;
		}
		return path.join(await resolveOutputDirectory(path.dirname(directory)), path.basename(directory));
	});
}

async function validateRuntimeLinks(root: string, directory = root): Promise<void> {
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isSymbolicLink()) {
			const relative = path.relative(root, await fs.realpath(file));
			if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
				throw new Error(`A release link escapes the package: ${path.relative(root, file)}`);
			}
		} else if (entry.isDirectory()) {
			await validateRuntimeLinks(root, file);
		}
	}
}

/** Installs the one launcher contract shared by source snapshots and production archives. */
export async function installWebClientLauncher(root: string, version: string, commit: string, mode: 'development' | 'production'): Promise<void> {
	if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version) || !/^[0-9a-f]{40}$/.test(commit)) {
		throw new Error('Runtime metadata requires a safe version and a full commit hash.');
	}
	const resources = path.resolve(import.meta.dirname, '../../resources/server/vibe-vscode');
	await fs.cp(resources, path.join(root, 'resources/server/vibe-vscode'), { recursive: true });
	await fs.mkdir(path.join(root, 'bin'), { recursive: true });
	await fs.copyFile(path.join(resources, 'vibe-vscode-server.sh'), path.join(root, 'bin/vibe-vscode-server'));
	await fs.chmod(path.join(root, 'bin/vibe-vscode-server'), 0o755);
	await fs.writeFile(path.join(root, 'vibe-release.json'), `${JSON.stringify({ version, commit, platform: process.platform, arch: process.arch, mode }, null, '\t')}\n`);
}

/** Stamps and archives a verified Linux package without modifying the Gulp output or an existing release. */
export async function packageWebClientRelease(packageRoot: string, outputDirectory: string, version: string, commit: string): Promise<string> {
	if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || !/^[0-9a-f]{40}$/.test(commit)) {
		throw new Error('A release requires a vMAJOR.MINOR.PATCH tag and a full commit hash.');
	}
	if (process.platform !== 'linux' || process.arch !== 'x64') {
		throw new Error('Linux x64 release validation must run on Linux x64.');
	}
	const source = await fs.realpath(packageRoot);
	const product = JSON.parse(await fs.readFile(path.join(source, 'product.json'), 'utf8'));
	if (product.commit !== commit) {
		throw new Error('The package commit does not match the requested release.');
	}
	const output = await resolveOutputDirectory(path.resolve(outputDirectory));
	const relativeOutput = path.relative(source, output);
	if (!relativeOutput || (!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== '..' && !path.isAbsolute(relativeOutput))) {
		throw new Error('Release archives must be written outside the input package.');
	}
	await fs.mkdir(output, { recursive: true });
	const temporary = await fs.mkdtemp(path.join(output, '.web-release-'));
	const root = path.join(temporary, 'package');
	try {
		await fs.cp(source, root, { recursive: true, verbatimSymlinks: true });
		await validateRuntimeLinks(root);
		for (const file of ['node', 'package.json', 'out/server-main.js', 'out/vs/code/browser/workbench/workbench.html', 'extensions/vibe-vscode/dist/browser/extension.js']) {
			if (!(await fs.stat(path.join(root, file))).isFile()) {
				throw new Error(`The release is missing ${file}.`);
			}
		}
		await validateWebClientCache(path.join(root, 'out'));
		for (const name of ['workbench.js', 'workbench.css']) {
			const file = path.join(root, 'out/vs/code/browser/workbench', name);
			const [original, brotli, gzip] = await Promise.all([fs.readFile(file), fs.readFile(`${file}.br`), fs.readFile(`${file}.gz`)]);
			if (!brotliDecompressSync(brotli).equals(original) || !gunzipSync(gzip).equals(original)) {
				throw new Error(`The compressed release asset ${name} is corrupt.`);
			}
		}
		const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
		delete env.VSCODE_DEV;
		await run(path.join(root, 'node'), ['--input-type=module', '-e', `
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const name of ['@vscode/sqlite3', '@vscode/spdlog', '@vscode/native-watchdog', '@parcel/watcher', 'node-pty']) {
	await import(name);
	require(name);
}`], { cwd: root, env });

		await installWebClientLauncher(root, version, commit, 'production');
		await run(path.join(root, 'bin/vibe-vscode-server'), ['--version'], { cwd: root, env });

		const name = `vibe-vscode-server-${version}-linux-x64.tar.gz`;
		const candidate = path.join(temporary, name);
		await createTar({ cwd: root, file: candidate, gzip: true, portable: true }, ['.']);
		const hash = createHash('sha256');
		for await (const chunk of createReadStream(candidate)) {
			hash.update(chunk);
		}
		const checksum = path.join(temporary, `${name}.sha256`);
		await fs.writeFile(checksum, `${hash.digest('hex')}  ${name}\n`);
		const archive = path.join(output, name);
		// Exclusive links publish completed files without replacing a previously built release.
		await fs.link(candidate, archive);
		try {
			await fs.link(checksum, `${archive}.sha256`);
		} catch (error) {
			await fs.unlink(archive);
			throw error;
		}
		return archive;
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
}
