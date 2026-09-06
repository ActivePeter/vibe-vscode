/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { webClientCacheDirectory, type IWebClientCacheFile, type IWebClientCacheManifest } from '../../src/vs/platform/remote/common/webClientCache.ts';

const chunkSize = 256 * 1024;
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** Bundles an immutable snapshot into independently compressed, integrity-checked startup chunks. */
export async function prepareWebClientCache(outDirectory: string): Promise<IWebClientCacheManifest> {
	const root = path.resolve(outDirectory);
	const cacheDirectory = path.join(root, webClientCacheDirectory);
	const preserveModuleLocations: esbuild.Plugin = {
		name: 'preserve-module-locations',
		setup(build) {
			build.onLoad({ filter: /\.js$/ }, async ({ path: file }) => {
				const contents = await fs.readFile(file, 'utf8');
				if (!contents.includes('import.meta.url')) {
					return { contents, loader: 'js' };
				}
				// A blob is not a hierarchical module URL. Preserve each original location for
				// worker/iframe descriptors without embedding a host, port or build-machine path.
				const transformed = await esbuild.transform(contents, { define: { 'import.meta.url': '__vscodeCachedModuleUrl' }, target: 'es2024' });
				const relativePath = path.relative(root, file).split(path.sep).join('/');
				return {
					contents: `const __vscodeCachedModuleUrl = new URL(${JSON.stringify(relativePath)}, globalThis._VSCODE_FILE_ROOT).href;\n${transformed.code}`,
					loader: 'js',
				};
			});
		},
	};
	const options: esbuild.BuildOptions = {
		absWorkingDir: root,
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2024',
		minify: true,
		sourcemap: false,
		write: false,
		metafile: true,
	};
	const [workbench, loader] = await Promise.all([
		esbuild.build({
			...options,
			entryPoints: ['vs/code/browser/workbench/workbench.js'],
			outdir: cacheDirectory,
			plugins: [preserveModuleLocations],
			loader: { '.ttf': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.sh': 'dataurl' },
		}),
		esbuild.build({ ...options, entryPoints: ['vs/code/browser/workbench/workbenchCache.js'], outfile: path.join(cacheDirectory, 'loader.js') }),
	]);
	for (const output of Object.values(workbench.metafile!.outputs)) {
		if (output.imports.some(entry => entry.kind !== 'dynamic-import' && !entry.path.startsWith('data:'))) {
			throw new Error('Prepared workbench resources must not have external static dependencies.');
		}
	}
	const script = workbench.outputFiles!.find(file => file.path.endsWith('.js'));
	if (!script) {
		throw new Error('The workbench bundle is missing.');
	}
	const style = workbench.outputFiles!.find(file => file.path.endsWith('.css'));
	// Only generated files in the caller's staging directory are replaced. Source modules stay intact.
	await fs.rm(cacheDirectory, { recursive: true, force: true });
	await fs.mkdir(cacheDirectory, { recursive: true });
	const prepareFile = async (contents: Uint8Array): Promise<IWebClientCacheFile> => {
		const chunks: IWebClientCacheFile['chunks'][number][] = [];
		for (let offset = 0; offset < Math.max(contents.byteLength, 1); offset += chunkSize) {
			const original = contents.subarray(offset, offset + chunkSize);
			const compressed = gzipSync(original, { level: 9 });
			const chunk = { hash: hash(compressed), size: compressed.byteLength, originalSize: original.byteLength };
			await fs.writeFile(path.join(cacheDirectory, `${chunk.hash}.bin`), compressed);
			chunks.push(chunk);
		}
		return { size: contents.byteLength, chunks };
	};
	const [preparedScript, preparedStyle] = await Promise.all([prepareFile(script.contents), prepareFile(style?.contents ?? new Uint8Array())]);
	const content = { version: 1 as const, script: preparedScript, style: preparedStyle };
	const manifest = { ...content, hash: hash(Buffer.from(JSON.stringify(content))) };
	await Promise.all([
		fs.writeFile(path.join(cacheDirectory, 'manifest.json'), JSON.stringify(manifest)),
		fs.writeFile(path.join(cacheDirectory, 'loader.js'), loader.outputFiles![0].contents),
	]);
	return manifest;
}
