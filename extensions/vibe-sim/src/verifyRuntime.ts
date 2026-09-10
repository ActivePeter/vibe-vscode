/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { loadRuntimePackage } from './runtimePackage';

/** Packaging and deployment share a read-only gate; no database or user profile is opened. */
export async function verifyNativeRuntime(extensionDirectory: string): Promise<void> {
	const runtime = await loadRuntimePackage(extensionDirectory);
	if (!runtime.supervisor || !runtime.nodeExecutable) { throw new Error('The full native Sim runtime must be packaged, not a fixture adapter.'); }
	const root = await fs.realpath(path.join(extensionDirectory, 'runtime'));
	for (const file of [
		'complete', 'application.mjs', 'realtime.mjs', 'application/apps/sim/server.js',
		'application/apps/sim/.next/BUILD_ID', 'application/apps/sim/.next/required-server-files.json',
		'application/node_modules/next/package.json', 'db/migrate.mjs', 'db/migrations/meta/_journal.json',
		'postgres/bin/postgres', 'postgres/bin/initdb', 'postgres/bin/psql', 'postgres/bin/createdb', 'bin/redis-server', 'bin/redis-cli', 'licenses/sim',
	]) {
		const resolved = await fs.realpath(path.join(root, file));
		const relative = path.relative(root, resolved);
		const metadata = await fs.stat(resolved);
		if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !metadata.isFile() || metadata.size === 0
			|| (file.startsWith('postgres/bin/') || file.startsWith('bin/redis-')) && !(metadata.mode & 0o111)) {
			throw new Error(`Invalid native Sim package resource: ${file}`);
		}
	}
	const { stdout } = await promisify(execFile)(runtime.nodeExecutable, ['--version'], { env: {}, timeout: 10000 });
	if (!/^v24\./.test(stdout.trim())) { throw new Error('Native Sim requires its packaged Node.js 24 runtime.'); }
}

if (require.main === module) {
	void verifyNativeRuntime(path.resolve(process.argv[2] ?? path.join(__dirname, '..'))).then(() => {
		process.stdout.write('The complete native Sim package passed validation.\n');
	}, () => {
		process.stderr.write('The native Sim package is missing, incomplete or incompatible. Build the complete extension before deployment.\n');
		process.exitCode = 1;
	});
}
