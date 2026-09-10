/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { run } from '../esbuild-extension-common.mts';

const srcDir = path.join(import.meta.dirname, 'src');

await Promise.all([run({
	platform: 'node',
	entryPoints: {
		extension: path.join(srcDir, 'extension.ts'),
		runtimeHost: path.join(srcDir, 'runtimeHost.ts'),
		verifyRuntime: path.join(srcDir, 'verifyRuntime.ts'),
	},
	srcDir,
	outdir: path.join(import.meta.dirname, 'dist'),
}, process.argv), run({
	platform: 'browser',
	entryPoints: { webviewTransportClient: path.join(srcDir, 'webviewTransportClient.ts') },
	srcDir,
	outdir: path.join(import.meta.dirname, 'dist'),
	additionalOptions: { format: 'iife', globalName: 'simNative' },
}, process.argv)]);
