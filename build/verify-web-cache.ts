/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { validateWebClientCache } from './lib/webClientCache.ts';

if (process.argv.length !== 3) {
	throw new Error('Usage: node build/verify-web-cache.ts <out-directory>');
}

const manifest = await validateWebClientCache(process.argv[2]);
console.log(`Verified Web cache ${manifest.hash}: ${manifest.script.chunks.length} script chunks, ${manifest.style.chunks.length} stylesheet chunks.`);
