/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { vibeLogoDataUri, vibeLogoRevision } from '../src/vs/server/node/vibeBranding.ts';

const { values } = parseArgs({ options: { 'browser-executable': { type: 'string' } } });
const resources = new URL('../resources/server/', import.meta.url);
const browser = await chromium.launch({ executablePath: values['browser-executable'] });
try {
	const page = await browser.newPage();
	const rasterize = async (size: number): Promise<Buffer> => {
		const dataUrl = await page.evaluate(async ({ source, size }) => {
			const image = new Image();
			image.src = source;
			await image.decode();
			const canvas = document.createElement('canvas');
			canvas.width = canvas.height = size;
			const context = canvas.getContext('2d');
			if (!context) {
				throw new Error('Canvas 2D context is unavailable.');
			}
			context.drawImage(image, 0, 0, size, size);
			return canvas.toDataURL('image/png');
		}, { source: vibeLogoDataUri, size });
		return Buffer.from(dataUrl.split(',')[1], 'base64');
	};

	for (const size of [192, 512]) {
		await writeFile(new URL(`code-${size}.png`, resources), await rasterize(size));
	}

	const sizes = [16, 32, 48];
	const images: Buffer[] = [];
	for (const size of sizes) {
		images.push(await rasterize(size));
	}
	const directory = Buffer.alloc(6 + sizes.length * 16);
	directory.writeUInt16LE(1, 2);
	directory.writeUInt16LE(sizes.length, 4);
	let offset = directory.length;
	for (const [index, size] of sizes.entries()) {
		const entry = 6 + index * 16;
		directory[entry] = directory[entry + 1] = size;
		directory.writeUInt16LE(1, entry + 4);
		directory.writeUInt16LE(32, entry + 6);
		directory.writeUInt32LE(images[index].length, entry + 8);
		directory.writeUInt32LE(offset, entry + 12);
		offset += images[index].length;
	}
	await writeFile(new URL('favicon.ico', resources), Buffer.concat([directory, ...images]));

	const manifestUrl = new URL('manifest.json', resources);
	const manifest: { icons: { src: string }[] } = JSON.parse(await readFile(manifestUrl, 'utf8'));
	for (const icon of manifest.icons) {
		const filename = icon.src.split('?')[0];
		if (filename === 'code-192.png' || filename === 'code-512.png') {
			icon.src = `${filename}?v=${vibeLogoRevision}`;
		}
	}
	await writeFile(manifestUrl, `${JSON.stringify(manifest, null, '\t')}\n`);
	console.log(`Updated Vibe PNGs, favicon and manifest (${vibeLogoRevision}).`);
} finally {
	await browser.close();
}
