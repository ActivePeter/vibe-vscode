/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { prepareWebClientCache } from '../webClientCache.ts';
import { isWebClientCacheManifest, webClientCacheDirectory, type IWebClientCacheFile } from '../../../src/vs/platform/remote/common/webClientCache.ts';

test('prepares deterministic, portable chunks without changing source modules or retaining external CSS assets', async () => {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-cache-build-'));
	try {
		const root = path.join(temporary, 'out');
		const directory = path.join(root, 'vs/code/browser/workbench');
		await fs.mkdir(directory, { recursive: true });
		const script = `import './style.css'; globalThis.workbenchTest = ${JSON.stringify('chunk contents '.repeat(30000))}; globalThis.moduleLocation = import.meta.url;`;
		await Promise.all([
			fs.writeFile(path.join(directory, 'workbench.js'), script),
			fs.writeFile(path.join(directory, 'workbenchCache.js'), 'export const loader = true;'),
			fs.writeFile(path.join(directory, 'style.css'), '@font-face { font-family: test; src: url(./font.ttf); }'),
			fs.writeFile(path.join(directory, 'font.ttf'), 'fixture font'),
		]);
		const first = await prepareWebClientCache(root);
		const restore = async (file: IWebClientCacheFile) => Buffer.concat(await Promise.all(file.chunks.map(async chunk => {
			const compressed = await fs.readFile(path.join(root, webClientCacheDirectory, `${chunk.hash}.bin`));
			const original = gunzipSync(compressed);
			assert.deepStrictEqual({ hash: createHash('sha256').update(compressed).digest('hex'), size: compressed.byteLength, originalSize: original.byteLength }, chunk);
			return original;
		})));
		const [restoredScript, restoredStyle] = await Promise.all([restore(first.script), restore(first.style)]);
		const relocated = path.join(temporary, 'different-location');
		await fs.cp(root, relocated, { recursive: true });
		const second = await prepareWebClientCache(relocated);
		assert.deepStrictEqual({
			valid: isWebClientCacheManifest(first),
			chunked: first.script.chunks.length > 1,
			portable: JSON.stringify(first) === JSON.stringify(second),
			noMachinePath: !restoredScript.includes(temporary) && !restoredStyle.includes(temporary),
			moduleLocation: restoredScript.includes('vs/code/browser/workbench/workbench.js'),
			embeddedFont: restoredStyle.includes('data:'),
			originalUnchanged: await fs.readFile(path.join(directory, 'workbench.js'), 'utf8') === script,
		}, { valid: true, chunked: true, portable: true, noMachinePath: true, moduleLocation: true, embeddedFont: true, originalUnchanged: true });
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
});
