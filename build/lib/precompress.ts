/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { brotliCompress, constants, gzip } from 'zlib';
import { mapWithConcurrency } from '../next/transpile.ts';

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const compressibleExtensions = new Set(['.js', '.css', '.html', '.json', '.svg', '.wasm', '.ttf']);
const excludedDirectories = new Set(['test', 'tests', 'node', 'electron-browser', 'electron-main', 'electron-utility']);

/** Prepares immutable, independently cacheable representations without changing the original files. */
export async function precompressWebAssets(root: string): Promise<{ files: number; originalBytes: number; brotliBytes: number; gzipBytes: number }> {
	const files: string[] = [];
	const collect = async (directory: string): Promise<void> => {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory() && !excludedDirectories.has(entry.name)) {
				await collect(entryPath);
			} else if (entry.isFile() && compressibleExtensions.has(path.extname(entry.name))) {
				files.push(entryPath);
			}
		}
	};
	await collect(root);

	const totals = { files: 0, originalBytes: 0, brotliBytes: 0, gzipBytes: 0 };
	await mapWithConcurrency(files, 8, async file => {
		const original = await fs.readFile(file);
		const [brotli, gzipped] = original.length >= 512 ? await Promise.all([
			compressBrotli(original, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }),
			compressGzip(original, { level: 9 }),
		]) : [undefined, undefined];
		const writeRepresentation = async (extension: string, content: Buffer | undefined): Promise<number> => {
			const target = `${file}.${extension}`;
			if (!content || content.length >= original.length) {
				await fs.rm(target, { force: true });
				return original.length;
			}
			// Replace atomically: a staged release can share unchanged files with its predecessor.
			const temporary = `${target}.tmp`;
			await fs.writeFile(temporary, content);
			await fs.rename(temporary, target);
			return content.length;
		};
		const [brotliBytes, gzipBytes] = await Promise.all([
			writeRepresentation('br', brotli),
			writeRepresentation('gz', gzipped),
		]);
		totals.files++;
		totals.originalBytes += original.length;
		totals.brotliBytes += brotliBytes;
		totals.gzipBytes += gzipBytes;
	});
	return totals;
}
