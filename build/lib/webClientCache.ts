/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { isWebClientCacheManifest, webClientCacheDirectory, type IWebClientCacheFile, type IWebClientCacheManifest } from '../../src/vs/platform/remote/common/webClientCache.ts';
import { precompressWebAssets } from './precompress.ts';

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
		loader: { '.ttf': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.sh': 'dataurl' },
	};
	const [workbench, loader] = await Promise.all([
		esbuild.build({
			...options,
			entryPoints: ['vs/code/browser/workbench/workbench.js'],
			outdir: cacheDirectory,
			plugins: [preserveModuleLocations],
		}),
		esbuild.build({ ...options, entryPoints: ['vs/code/browser/workbench/workbenchCache.js'], outfile: path.join(cacheDirectory, 'loader.js') }),
	]);
	// Production bundlers extract CSS and remove its import from the JavaScript.
	// Include that sibling stylesheet as well as the CSS imported by source builds.
	let style = workbench.outputFiles!.find(file => file.path.endsWith('.css'));
	const stylesheetPath = path.join(root, 'vs/code/browser/workbench/workbench.css');
	let stylesheet: esbuild.BuildResult | undefined;
	if (!style && await fs.stat(stylesheetPath).then(stat => stat.isFile(), error => {
		if (error.code === 'ENOENT') {
			return false;
		}
		throw error;
	})) {
		stylesheet = await esbuild.build({ ...options, entryPoints: [stylesheetPath], outfile: path.join(cacheDirectory, 'workbench.css') });
		style = stylesheet.outputFiles!.find(file => file.path.endsWith('.css'));
	}
	for (const output of [...Object.values(workbench.metafile!.outputs), ...Object.values(stylesheet?.metafile?.outputs ?? {})]) {
		if (output.imports.some(entry => entry.kind !== 'dynamic-import' && !entry.path.startsWith('data:'))) {
			throw new Error('Prepared workbench resources must not have external static dependencies.');
		}
	}
	const script = workbench.outputFiles!.find(file => file.path.endsWith('.js'));
	if (!script) {
		throw new Error('The workbench bundle is missing.');
	}
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

/** Finalizes the same cache and compressed representations for every packaged Web target. */
export async function prepareWebClientAssets(outDirectory: string): Promise<void> {
	await prepareWebClientCache(outDirectory);
	await precompressWebAssets(outDirectory);
}

/** Checks the complete cache payload before a package is published or promoted. */
export async function validateWebClientCache(outDirectory: string): Promise<IWebClientCacheManifest> {
	const directory = path.join(outDirectory, webClientCacheDirectory);
	const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
	if (!isWebClientCacheManifest(manifest)) {
		throw new Error('The packaged Web cache manifest is invalid.');
	}
	const { version, script, style } = manifest;
	if (hash(Buffer.from(JSON.stringify({ version, script, style }))) !== manifest.hash) {
		throw new Error('The packaged Web cache manifest hash does not match its content.');
	}
	if (!(await fs.stat(path.join(directory, 'loader.js'))).isFile()) {
		throw new Error('The packaged Web cache loader is missing.');
	}
	const verified = new Set<string>();
	for (const file of [script, style]) {
		for (const chunk of file.chunks) {
			if (verified.has(chunk.hash)) {
				continue;
			}
			const compressed = await fs.readFile(path.join(directory, `${chunk.hash}.bin`));
			if (compressed.byteLength !== chunk.size || hash(compressed) !== chunk.hash) {
				throw new Error(`The packaged Web cache chunk ${chunk.hash} is incomplete or corrupt.`);
			}
			if (gunzipSync(compressed, { maxOutputLength: chunk.originalSize + 1 }).byteLength !== chunk.originalSize) {
				throw new Error(`The packaged Web cache chunk ${chunk.hash} has an invalid original size.`);
			}
			verified.add(chunk.hash);
		}
	}
	return manifest;
}
