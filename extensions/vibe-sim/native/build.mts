/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

interface LockedArchive {
	readonly url: string;
	readonly integrity: string;
}

interface NativeLock {
	readonly version: 1;
	readonly bun: LockedArchive & { readonly version: string };
	readonly sim: LockedArchive & { readonly commit: string };
	readonly postgres: LockedArchive & { readonly version: string };
	readonly pgvector: LockedArchive & { readonly version: string };
	readonly redis: LockedArchive & { readonly version: string };
}

interface NativeSources {
	readonly sim: string;
	readonly bun: string;
	readonly postgres: string;
	readonly pgvector: string;
	readonly redis: string;
}

const nativeRoot = import.meta.dirname;
const extensionRoot = path.dirname(nativeRoot);
const sourceRoot = path.resolve(extensionRoot, '../..');
const buildRoot = path.join(sourceRoot, '.build/vibe-sim');

/** Integrity is checked on both cached downloads and newly fetched bytes. */
export function verifyArchive(bytes: Uint8Array, integrity: string): void {
	const match = /^(sha256|sha512)-(.+)$/.exec(integrity);
	if (!match) {
		throw new Error('Unsupported native archive integrity');
	}
	const digest = createHash(match[1]).update(bytes).digest(match[1] === 'sha256' ? 'hex' : 'base64');
	if (digest !== match[2]) {
		throw new Error('Native archive integrity mismatch');
	}
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
		return false;
	}
}

/** Runs a build tool with no shell interpretation. No runtime credentials enter a build. */
async function run(command: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { cwd, env: environment, stdio: 'inherit' });
		child.once('error', reject);
		child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)));
	});
}

async function download(archive: LockedArchive): Promise<string> {
	const cache = path.join(buildRoot, 'downloads');
	await fs.mkdir(cache, { recursive: true });
	const key = createHash('sha256').update(archive.integrity).digest('hex');
	const destination = path.join(cache, `${key}.tar.gz`);
	if (await exists(destination)) {
		verifyArchive(await fs.readFile(destination), archive.integrity);
		return destination;
	}
	if (new URL(archive.url).protocol !== 'https:') {
		throw new Error('Native source archives must use HTTPS');
	}
	const response = await fetch(archive.url, { signal: AbortSignal.timeout(180_000) });
	if (!response.ok) {
		throw new Error(`Native archive download failed (${response.status})`);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	verifyArchive(bytes, archive.integrity);
	const temporary = `${destination}.${randomUUID()}`;
	try {
		await fs.writeFile(temporary, bytes, { flag: 'wx' });
		await fs.rename(temporary, destination);
	} finally {
		await fs.rm(temporary, { force: true });
	}
	return destination;
}

async function unpack(archive: LockedArchive, destination: string): Promise<void> {
	if (await exists(path.join(destination, '.archive-integrity'))) {
		if (await fs.readFile(path.join(destination, '.archive-integrity'), 'utf8') !== archive.integrity) {
			throw new Error('Prepared native source has a different version');
		}
		return;
	}
	if (await exists(destination)) {
		throw new Error('An incomplete native source directory already exists; inspect it before retrying');
	}
	const archivePath = await download(archive);
	const temporary = `${destination}.staging-${randomUUID()}`;
	await fs.mkdir(temporary, { recursive: true });
	try {
		await run('tar', ['-xzf', archivePath, '--strip-components=1', '--no-same-owner', '-C', temporary], buildRoot);
		await fs.writeFile(path.join(temporary, '.archive-integrity'), archive.integrity, { flag: 'wx' });
		await fs.rename(temporary, destination);
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
}

/** PostgreSQL and Redis are packaged dependencies, not system-wide services or shared databases. */
async function buildServices(sources: NativeSources, lock: NativeLock, environment: NodeJS.ProcessEnv): Promise<string> {
	const compilerSource = await fs.readFile(path.join(nativeRoot, 'process-supervisor.c'));
	const key = createHash('sha256').update(JSON.stringify([lock.postgres, lock.pgvector, lock.redis])).update(compilerSource).digest('hex').slice(0, 20);
	const destination = path.join(buildRoot, `services-${key}`);
	if (await exists(path.join(destination, 'complete'))) {
		return destination;
	}
	const temporary = `${destination}.staging-${randomUUID()}`;
	await fs.mkdir(path.join(temporary, 'bin'), { recursive: true });
	try {
		await run('./configure', ['--prefix=/sim-postgres', '--without-readline', '--without-zlib', '--without-icu', '--without-lz4', '--without-zstd'], sources.postgres, environment);
		await run('make', ['-s', '-j8'], sources.postgres, environment);
		await run('make', ['-s', 'install', `DESTDIR=${temporary}`], sources.postgres, environment);
		await run('make', ['-s', '-j8', 'install', `DESTDIR=${temporary}`], path.join(sources.postgres, 'contrib/btree_gin'), environment);
		const pgConfig = path.join(temporary, 'sim-postgres/bin/pg_config');
		await run('make', ['-s', '-j8', `PG_CONFIG=${pgConfig}`, 'OPTFLAGS='], sources.pgvector, environment);
		await run('make', ['-s', 'install', `PG_CONFIG=${pgConfig}`, 'OPTFLAGS='], sources.pgvector, environment);
		await run('make', ['-s', '-j8', 'MALLOC=libc', 'BUILD_TLS=no', 'OPTIMIZATION=-O2'], sources.redis, environment);
		await fs.copyFile(path.join(sources.redis, 'src/redis-server'), path.join(temporary, 'bin/redis-server'));
		await fs.copyFile(path.join(sources.redis, 'src/redis-cli'), path.join(temporary, 'bin/redis-cli'));
		await run(environment.CC ?? 'cc', ['-Wall', '-Wextra', '-Werror', '-O2', path.join(nativeRoot, 'process-supervisor.c'), '-o', path.join(temporary, 'bin/process-supervisor')], sourceRoot, environment);
		await fs.mkdir(path.join(temporary, 'licenses'));
		for (const [name, source] of [['postgres', path.join(sources.postgres, 'COPYRIGHT')], ['pgvector', path.join(sources.pgvector, 'LICENSE')], ['redis', path.join(sources.redis, 'LICENSE.txt')]]) {
			await fs.copyFile(source, path.join(temporary, 'licenses', name));
		}
		await fs.writeFile(path.join(temporary, 'complete'), key, { flag: 'wx' });
		await fs.rename(temporary, destination);
		return destination;
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
}

/** Matches Sim's own standalone packaging additions; no source checkout or global dependency is used at runtime. */
export async function assembleNativeRuntime(simSource: string, services: string, destination: string, bun: string, environment: NodeJS.ProcessEnv): Promise<void> {
	await fs.mkdir(destination, { recursive: true });
	const copy = async (source: string, target: string) => {
		await fs.mkdir(target, { recursive: true });
		await run('rsync', ['--archive', '--copy-links', `${source}/`, `${target}/`], sourceRoot, environment);
	};
	const application = path.join(destination, 'application');
	const app = path.join(application, 'apps/sim');
	await Promise.all([
		copy(path.join(simSource, 'apps/sim/.next/standalone'), application),
		copy(path.join(services, 'sim-postgres'), path.join(destination, 'postgres')),
		copy(path.join(services, 'bin'), path.join(destination, 'bin')),
		copy(path.join(services, 'licenses'), path.join(destination, 'licenses')),
		copy(path.join(simSource, 'packages/db/migrations'), path.join(destination, 'db/migrations')),
	]);
	await fs.copyFile(process.execPath, path.join(destination, 'bin/node'));
	await Promise.all([
		copy(path.join(simSource, 'apps/sim/.next/static'), path.join(app, '.next/static')),
		copy(path.join(simSource, 'apps/sim/public'), path.join(app, 'public')),
		copy(path.join(simSource, 'apps/sim/content'), path.join(app, 'content')),
		copy(path.join(simSource, 'apps/sim/lib/execution/sandbox/bundles'), path.join(app, 'lib/execution/sandbox/bundles')),
		...['lib0', 'yjs', 'y-protocols', 'sharp', '@img', 'isolated-vm'].map(name => copy(path.join(simSource, 'node_modules', name), path.join(application, 'node_modules', name))),
	]);
	await fs.copyFile(path.join(simSource, 'apps/sim/.next/required-server-files.json'), path.join(app, '.next/required-server-files.json'));
	await fs.copyFile(path.join(simSource, 'apps/sim/lib/execution/isolated-vm-worker.cjs'), path.join(app, 'lib/execution/isolated-vm-worker.cjs'));
	await fs.copyFile(path.join(simSource, 'LICENSE'), path.join(destination, 'licenses/sim'));
	await Promise.all([
		run(bun, ['build', 'packages/db/scripts/migrate.ts', '--target=node', '--format=esm', `--outfile=${path.join(destination, 'db/migrate.mjs')}`], simSource, environment),
		run(bun, ['build', 'apps/realtime/src/index.ts', '--target=node', '--format=esm', `--outfile=${path.join(destination, 'realtime.mjs')}`], simSource, environment),
		build({
			entryPoints: [path.join(nativeRoot, 'applicationServer.mts')], bundle: true, platform: 'node', format: 'esm',
			outfile: path.join(destination, 'application.mjs'),
		}),
		build({
			entryPoints: [path.join(extensionRoot, 'src/native/nativeAdapter.ts')], bundle: true, platform: 'node', format: 'esm',
			outfile: path.join(destination, 'adapter.mjs'),
			banner: { js: "import { fileURLToPath as runtimeFileURLToPath } from 'node:url'; import { dirname as runtimeDirname } from 'node:path'; const __dirname = runtimeDirname(runtimeFileURLToPath(import.meta.url));" },
		}),
	]);
}

/** A clean temporary source materialization avoids half-installed caches becoming build authority. */
async function buildNativeRuntime(sources: NativeSources, lock: NativeLock, environment: NodeJS.ProcessEnv): Promise<string> {
	const hash = createHash('sha256').update(JSON.stringify(lock)).update(process.versions.node).update(process.versions.modules);
	for (const folder of [nativeRoot, path.join(extensionRoot, 'src')]) {
		const files = (await fs.readdir(folder, { recursive: true })).filter(file => /\.(ts|mts|c|json|sh)$/.test(file)).sort();
		for (const file of files) {
			hash.update(path.relative(extensionRoot, path.join(folder, file))).update(await fs.readFile(path.join(folder, file)));
		}
	}
	const key = hash.digest('hex').slice(0, 20);
	const destination = path.join(buildRoot, `runtime-${key}`);
	if (await exists(path.join(destination, 'complete'))) {
		return destination;
	}
	const work = await fs.mkdtemp(path.join(tmpdir(), 'vibe-sim-build-'));
	const temporary = `${destination}.staging-${randomUUID()}`;
	try {
		const source = path.join(work, 'source');
		await unpack(lock.sim, source);
		const home = path.join(work, 'home');
		await fs.mkdir(home);
		const buildEnvironment = { ...environment, HOME: home, BUN_INSTALL_CACHE_DIR: path.join(work, 'bun-cache') };
		const bun = path.join(sources.bun, 'bin/bun');
		const [services] = await Promise.all([
			buildServices(sources, lock, environment),
			run(bun, ['install', '--frozen-lockfile', '--ignore-scripts', '--backend=hardlink', '--no-progress'], source, buildEnvironment),
		]);
		await run(process.execPath, [path.join(source, 'node_modules/node-gyp/bin/node-gyp.js'), 'rebuild', '--release'], path.join(source, 'node_modules/isolated-vm'), { ...buildEnvironment, JOBS: '4' });
		await run(bun, ['run', '--cwd', 'apps/sim', 'build'], source, {
			...buildEnvironment, DOCKER_BUILD: 'true', SIM_VSCODE_PLUGIN_BUILD: 'true',
			NEXT_PUBLIC_APP_URL: 'https://sim.vscode.invalid', DISABLE_AUTH: 'true',
			// Matches Sim's Docker build: evaluation needs a URL, never a live database or credentials.
			DATABASE_URL: 'postgresql://build:build@127.0.0.1:1/build',
			BETTER_AUTH_SECRET: randomUUID(),
		});
		await assembleNativeRuntime(source, services, temporary, bun, buildEnvironment);
		await fs.writeFile(path.join(temporary, 'sim-runtime.json'), JSON.stringify({
			protocolVersion: 1, version: `0.1.0-${lock.sim.commit.slice(0, 12)}`, entrypoint: './adapter.mjs', supervisor: './bin/process-supervisor', node: './bin/node',
		}));
		await fs.writeFile(path.join(temporary, 'complete'), key, { flag: 'wx' });
		await fs.rename(temporary, destination);
		return destination;
	} finally {
		await Promise.all([fs.rm(work, { recursive: true, force: true }), fs.rm(temporary, { recursive: true, force: true })]);
	}
}

async function main(): Promise<void> {
	if (process.platform !== 'linux' || process.arch !== 'x64') {
		throw new Error('The initial native package targets Linux x64 Extension Hosts');
	}
	if (Number(process.versions.node.split('.')[0]) !== 24) { throw new Error('The native Sim package must be built with Node.js 24'); }
	const lock: NativeLock = JSON.parse(await fs.readFile(path.join(nativeRoot, 'lock.json'), 'utf8'));
	if (lock.version !== 1 || !/^[0-9a-f]{40}$/.test(lock.sim.commit)) {
		throw new Error('Invalid native source lock');
	}
	await fs.mkdir(buildRoot, { recursive: true });
	const sources: NativeSources = {
		sim: path.join(buildRoot, `sim-${lock.sim.commit}-${createHash('sha256').update(lock.sim.integrity).digest('hex').slice(0, 8)}`),
		bun: path.join(buildRoot, `bun-${lock.bun.version}`),
		postgres: path.join(buildRoot, `postgres-${lock.postgres.version}`),
		pgvector: path.join(buildRoot, `pgvector-${lock.pgvector.version}`),
		redis: path.join(buildRoot, `redis-${lock.redis.version}`),
	};
	await Promise.all(Object.entries(sources).map(([name, destination]) => unpack(lock[name as keyof typeof sources], destination)));
	process.stdout.write('Pinned native sources are ready in the canonical checkout.\n');
	if (process.argv.includes('--prepare')) {
		return;
	}
	const environment: NodeJS.ProcessEnv = { HUSKY: '0', NEXT_TELEMETRY_DISABLED: '1' };
	for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'CC', 'BISON_PKGDATADIR']) {
		if (process.env[key] !== undefined) {
			environment[key] = process.env[key];
		}
	}
	environment.PATH = `${path.join(sources.bun, 'bin')}${path.delimiter}${environment.PATH ?? ''}`;
	if (process.argv.includes('--build-services')) {
		await buildServices(sources, lock, environment);
		return;
	}
	if (process.argv.includes('--bootstrap')) {
		await Promise.all([
			buildServices(sources, lock, environment),
			run(path.join(sources.bun, 'bin/bun'), ['install', '--frozen-lockfile'], sources.sim, environment),
		]);
		return;
	}
	if (process.argv.includes('--install')) {
		await run(path.join(sources.bun, 'bin/bun'), ['install', '--frozen-lockfile'], sources.sim, environment);
		return;
	}
	const runtime = await buildNativeRuntime(sources, lock, environment);
	const target = path.join(extensionRoot, 'runtime');
	if (await exists(path.join(target, 'complete')) && await fs.readFile(path.join(target, 'complete'), 'utf8') === await fs.readFile(path.join(runtime, 'complete'), 'utf8')) {
		process.stdout.write('The extension already contains this locked native Sim build.\n');
		return;
	}
	const staging = `${target}.staging-${randomUUID()}`;
	const previous = `${target}.previous-${randomUUID()}`;
	await fs.mkdir(staging);
	try {
		await run('rsync', ['--archive', `${runtime}/`, `${staging}/`], sourceRoot, environment);
		if (await exists(target)) { await fs.rename(target, previous); }
		try {
			await fs.rename(staging, target);
		} catch (error) {
			if (await exists(previous)) { await fs.rename(previous, target); }
			throw error;
		}
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}
	await fs.rm(previous, { recursive: true, force: true });
	process.stdout.write('The immutable native Sim package is ready in the extension.\n');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
	await main();
}
