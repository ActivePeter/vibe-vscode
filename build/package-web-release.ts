/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { packageWebClientRelease } from './lib/webClientRelease.ts';

if (process.argv.length !== 6) {
	throw new Error('Usage: node build/package-web-release.ts <package-root> <output-directory> <release-tag> <commit>');
}

console.log(await packageWebClientRelease(process.argv[2], process.argv[3], process.argv[4], process.argv[5]));
