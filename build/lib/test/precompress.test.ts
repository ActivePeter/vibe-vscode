/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'zlib';
import { precompressWebAssets } from '../precompress.ts';

test('prepares deterministic compressed modules, skips non-web resources and removes obsolete representations', async () => {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'web-precompress-'));
	try {
		const root = path.join(temporary, 'assets');
		await fs.mkdir(path.join(root, 'node'), { recursive: true });
		const contents = Buffer.from('export const message = "A reusable browser module";\n'.repeat(100));
		await fs.writeFile(path.join(root, 'module.js'), contents);
		await fs.writeFile(path.join(root, 'module.js.map'), contents);
		await fs.writeFile(path.join(root, 'node', 'server.js'), contents);
		await fs.writeFile(path.join(temporary, 'outside.js'), contents);
		await fs.symlink(path.join(temporary, 'outside.js'), path.join(root, 'linked.js'));
		const first = await precompressWebAssets(root);
		const brotli = await fs.readFile(path.join(root, 'module.js.br'));
		const gzip = await fs.readFile(path.join(root, 'module.js.gz'));
		const second = await precompressWebAssets(root);
		assert.deepStrictEqual({
			files: first.files,
			brotli: brotliDecompressSync(brotli),
			gzip: gunzipSync(gzip),
			original: await fs.readFile(path.join(root, 'module.js')),
			deterministic: first.brotliBytes === second.brotliBytes && first.gzipBytes === second.gzipBytes,
			compressedFiles: (await fs.readdir(root)).filter(file => /\.(br|gz)$/.test(file)).sort(),
		}, {
			files: 1,
			brotli: contents,
			gzip: contents,
			original: contents,
			deterministic: true,
			compressedFiles: ['module.js.br', 'module.js.gz'],
		});
		await fs.writeFile(path.join(root, 'module.js'), 'export {};');
		await precompressWebAssets(root);
		assert.deepStrictEqual((await fs.readdir(root)).filter(file => /\.(br|gz)$/.test(file)), []);
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
});
