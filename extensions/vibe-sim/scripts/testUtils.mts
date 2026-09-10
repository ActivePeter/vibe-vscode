/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import type { ManagedSimRuntime } from '../src/managedRuntime.ts';

const require = createRequire(import.meta.url);
const extensionSource = fileURLToPath(new URL('..', import.meta.url));

export function bundle(entry: string): string {
	return buildSync({
		entryPoints: [path.join(extensionSource, 'src', entry + '.ts')],
		bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false,
	}).outputFiles[0].text;
}

const hostBundle = bundle('runtimeHost');
const managerBundle = bundle('managedRuntime');
const packageBundle = bundle('runtimePackage');

export async function waitFor(condition: () => boolean | Promise<boolean>, description: string, timeout = 5000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!await condition()) {
		assert.ok(Date.now() < deadline, `Timed out: ${description}`);
		await setTimeout(10);
	}
}

export async function exists(file: string): Promise<boolean> {
	return fs.access(file).then(() => true, () => false);
}

export async function processExited(pid: number): Promise<boolean> {
	try {
		const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
		// Orphans may briefly be zombies pending their new parent's waitpid; execution has ended.
		return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return true;
		}
		throw error;
	}
}

export async function createFixture(t: TestContext) {
	const root = await fs.mkdtemp(path.join(tmpdir(), 'vibe-sim-test-'));
	const extensionDirectory = path.join(root, 'relocated extension #1');
	const runtimeDirectory = path.join(extensionDirectory, 'runtime');
	const distDirectory = path.join(extensionDirectory, 'dist');
	const runtimes: ManagedSimRuntime[] = [];
	const cleanup: (() => Promise<void>)[] = [];
	t.after(async () => {
		await Promise.all(cleanup.map(dispose => dispose()));
		await Promise.all(runtimes.map(runtime => runtime.dispose()));
		await fs.rm(root, { recursive: true, force: true });
	});
	await fs.mkdir(runtimeDirectory, { recursive: true });
	await fs.mkdir(distDirectory);
	await Promise.all([
		fs.writeFile(path.join(runtimeDirectory, 'sim-runtime.json'), JSON.stringify({ protocolVersion: 1, version: '0.0.1-test', entrypoint: './adapter.mjs' })),
		fs.copyFile(new URL('./fixtures/adapter.mjs', import.meta.url), path.join(runtimeDirectory, 'adapter.mjs')),
		fs.writeFile(path.join(distDirectory, 'runtimeHost.js'), hostBundle),
		fs.writeFile(path.join(distDirectory, 'manager.cjs'), managerBundle),
		fs.writeFile(path.join(distDirectory, 'package.cjs'), packageBundle),
	]);
	const { ManagedSimRuntime: Manager, createRuntimeEnvironment } = require(path.join(distDirectory, 'manager.cjs')) as typeof import('../src/managedRuntime.ts');
	const { loadRuntimePackage } = require(path.join(distDirectory, 'package.cjs')) as typeof import('../src/runtimePackage.ts');
	return {
		root, extensionDirectory, runtimeDirectory, distDirectory, loadRuntimePackage, createRuntimeEnvironment,
		async createRuntime(name = 'workspace-a', mode = 'ready', options: ConstructorParameters<typeof Manager>[2] = {}) {
			const stateDirectory = path.join(root, name);
			await fs.mkdir(stateDirectory, { recursive: true });
			await fs.writeFile(path.join(stateDirectory, 'control.json'), JSON.stringify({ mode }));
			const runtime = new Manager(extensionDirectory, stateDirectory, options);
			runtimes.push(runtime);
			return { runtime, stateDirectory };
		},
		track(runtime: ManagedSimRuntime) { runtimes.push(runtime); },
		beforeCleanup(dispose: () => Promise<void>) { cleanup.push(dispose); },
		Manager,
	};
}

export async function starts(stateDirectory: string): Promise<{ pid: number; instanceId: string; execArgv: string[]; ambientConfiguration: string[] }[]> {
	const value = await fs.readFile(path.join(stateDirectory, 'starts.jsonl'), 'utf8');
	return value.trim().split('\n').map(line => JSON.parse(line));
}
