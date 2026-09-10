/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { run } from '../esbuild-extension-common.mts';

const srcDir = path.join(import.meta.dirname, 'src');

await run({
	platform: 'node',
	entryPoints: {
		extension: path.join(srcDir, 'extension.ts'),
		runtimeHost: path.join(srcDir, 'runtimeHost.ts'),
	},
	srcDir,
	outdir: path.join(import.meta.dirname, 'dist'),
}, process.argv);
