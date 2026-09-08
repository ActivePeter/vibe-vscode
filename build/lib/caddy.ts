/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { extract } from 'tar';
import { fetchUrl } from './fetch.ts';

// Keep the same verified upstream release as the existing hosted-development coordinator.
const caddyVersion = '2.11.4';
const caddyChecksums = {
	x64: {
		architecture: 'amd64',
		archive: '8220d1f013b6f27510247b2360c9e0ca9f018feebd82515f07635318b34ff9777ccc8fd0b6e6f2486ce3a33fe389fbb7db12d05baa474f4587509fb4f5ebf1c9',
		binary: 'b7105518e3ed1c0761f232e44fc09345535533c9cb0abf0e12809416c7ac64d9',
	},
	arm64: {
		architecture: 'arm64',
		archive: 'd5a7c423853c24a799765e0e8210d5c7c22a8f56ed37a3cae2fb9f58be138853c02b4efd6b59d576e6d8c7c0d30b9c1592deeaa6a536ff69bcca23b8c1ea709c',
		binary: 'e1f904038fc11ca897ac5a12fdacfb2a7add02a8720c426d562a37f6fdad2afe',
	},
} as const;

/** Downloads a fixed Caddy release and verifies both the archive and extracted executable. */
export async function installPinnedCaddy(root: string, architecture = process.arch, download = downloadArchive): Promise<void> {
	if (architecture !== 'x64' && architecture !== 'arm64') {
		throw new Error(`Unsupported Caddy architecture: ${architecture}`);
	}
	const expected = caddyChecksums[architecture];
	const name = `caddy_${caddyVersion}_linux_${expected.architecture}.tar.gz`;
	const contents = await download(`https://github.com/caddyserver/caddy/releases/download/v${caddyVersion}/${name}`);
	if (createHash('sha512').update(contents).digest('hex') !== expected.archive) {
		throw new Error('Caddy archive checksum mismatch.');
	}
	const temporary = await fs.mkdtemp(path.join(root, '.caddy-'));
	try {
		const archive = path.join(temporary, name);
		await fs.writeFile(archive, contents);
		await extract({ file: archive, cwd: temporary, filter: name => name === 'caddy' || name === './caddy' });
		const binary = path.join(temporary, 'caddy');
		if (createHash('sha256').update(await fs.readFile(binary)).digest('hex') !== expected.binary) {
			throw new Error('Caddy binary checksum mismatch.');
		}
		await fs.chmod(binary, 0o755);
		await fs.rename(binary, path.join(root, 'caddy'));
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
}

async function downloadArchive(url: string): Promise<Buffer> {
	const file = await fetchUrl(url, {}, 3);
	if (!file.isBuffer()) {
		throw new Error('Caddy download did not return a complete archive.');
	}
	return file.contents;
}
