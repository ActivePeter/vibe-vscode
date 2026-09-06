/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { prepareWebClientCache } from './lib/webClientCache.ts';

if (process.argv.length !== 3) {
	throw new Error('Usage: node build/prepare-web-cache.ts <staged out directory>');
}

const manifest = await prepareWebClientCache(process.argv[2]);
const chunks = [...manifest.script.chunks, ...manifest.style.chunks];
console.log(`[web-client-cache] ${chunks.length} chunks, ${manifest.script.size + manifest.style.size} original bytes, ${chunks.reduce((sum, chunk) => sum + chunk.size, 0)} compressed bytes`);
