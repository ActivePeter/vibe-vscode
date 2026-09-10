/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isRecord, protocolVersion, RuntimePackage, SimRuntimeError } from './protocol';

function isInside(directory: string, candidate: string): boolean {
	const relative = path.relative(directory, candidate);
	return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Only an immutable, extension-owned adapter can be launched. No workspace command or fallback URL. */
export async function loadRuntimePackage(extensionDirectory: string): Promise<RuntimePackage> {
	try {
		const extension = await fs.realpath(extensionDirectory);
		const runtime = await fs.realpath(path.join(extension, 'runtime'));
		if (!isInside(extension, runtime)) {
			throw new SimRuntimeError('invalidPackage');
		}
		const manifest = await fs.realpath(path.join(runtime, 'sim-runtime.json'));
		if (!isInside(runtime, manifest)) {
			throw new SimRuntimeError('invalidPackage');
		}
		const metadata = await fs.stat(manifest);
		if (!metadata.isFile() || metadata.size > 65536) {
			throw new SimRuntimeError('invalidPackage');
		}
		const value: unknown = JSON.parse(await fs.readFile(manifest, 'utf8'));
		if (!isRecord(value)) {
			throw new SimRuntimeError('invalidPackage');
		}
		if (value.protocolVersion !== protocolVersion) {
			throw new SimRuntimeError('incompatiblePackage');
		}
		if (typeof value.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version)
			|| typeof value.entrypoint !== 'string' || !value.entrypoint.endsWith('.mjs')
			|| path.isAbsolute(value.entrypoint) || path.win32.isAbsolute(value.entrypoint)
			|| value.entrypoint.includes('\0') || value.entrypoint.split(/[\\/]/).includes('..')) {
			throw new SimRuntimeError('invalidPackage');
		}
		const entrypoint = await fs.realpath(path.join(runtime, value.entrypoint));
		if (!isInside(runtime, entrypoint) || !(await fs.stat(entrypoint)).isFile()) {
			throw new SimRuntimeError('invalidPackage');
		}
		if (value.supervisor !== undefined) {
			if (process.platform !== 'linux' || process.arch !== 'x64') { throw new SimRuntimeError('unsupportedPlatform'); }
			if (value.supervisor !== './bin/process-supervisor' || value.node !== './bin/node') {
				throw new SimRuntimeError('invalidPackage');
			}
			const supervisor = await fs.realpath(path.join(runtime, value.supervisor));
			const nodeExecutable = await fs.realpath(path.join(runtime, value.node));
			for (const executable of [supervisor, nodeExecutable]) {
				const metadata = await fs.stat(executable);
				if (!isInside(runtime, executable) || !metadata.isFile() || !(metadata.mode & 0o111)) { throw new SimRuntimeError('invalidPackage'); }
			}
			return Object.freeze({ entrypoint, version: value.version, supervisor, nodeExecutable });
		}
		return Object.freeze({ entrypoint, version: value.version });
	} catch (error) {
		if (error instanceof SimRuntimeError) {
			throw error;
		}
		throw new SimRuntimeError(error?.code === 'ENOENT' ? 'runtimeNotPackaged' : 'invalidPackage');
	}
}
