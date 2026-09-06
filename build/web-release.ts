/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { prepareWebClientAssets, validateWebClientCache } from './lib/webClientCache.ts';
import { installWebClientLauncher, packageWebClientRelease } from './lib/webClientRelease.ts';
import { precompressWebAssets } from './lib/precompress.ts';

const [command, ...args] = process.argv.slice(2);
if (command === 'prepare' && (args.length === 3 || (args.length === 4 && args[3] === '--development'))) {
	const [root, version, commit] = args;
	const development = args[3] === '--development';
	await prepareWebClientAssets(path.join(root, 'out'), { source: development });
	await precompressWebAssets(path.join(root, 'extensions/vibe-vscode/dist/browser'));
	await installWebClientLauncher(root, version, commit, development ? 'development' : 'production');
	console.log(`Prepared ${development ? 'development' : 'production'} runtime ${version}.`);
} else if (command === 'verify' && args.length === 1) {
	const manifest = await validateWebClientCache(path.join(args[0], 'out'));
	console.log(`Verified Web cache ${manifest.hash}: ${manifest.script.chunks.length} script chunks, ${manifest.style.chunks.length} stylesheet chunks.`);
} else if (command === 'package' && args.length === 4) {
	console.log(await packageWebClientRelease(args[0], args[1], args[2], args[3]));
} else {
	throw new Error('Usage: node build/web-release.ts prepare <runtime-root> <version> <commit> [--development] | verify <runtime-root> | package <package-root> <output-directory> <release-tag> <commit>');
}
