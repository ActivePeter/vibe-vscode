/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { precompressWebAssets } from './lib/precompress.ts';

if (process.argv.length < 3) {
	throw new Error('Usage: node build/precompress-web.ts <staged asset directory> [...]');
}

for (const directory of process.argv.slice(2)) {
	const totals = await precompressWebAssets(directory);
	console.log(`[precompress] ${directory}: ${JSON.stringify(totals)}`);
}
