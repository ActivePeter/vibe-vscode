/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { dirname, join } from '../../common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';

suite('Development node module lookup', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'vscode-bootstrap #'));
		const files: Record<string, string> = {
			'package.json': JSON.stringify({ type: 'module', dependencies: { fixture: '*' } }),
			'remote/package.json': JSON.stringify({ dependencies: { fixture: '*', '@fixture/conditional': '*' } }),
			'node_modules/fixture/package.json': JSON.stringify({ main: 'index.js' }),
			'node_modules/fixture/index.js': `module.exports = 'desktop';`,
			'remote/node_modules/fixture/package.json': JSON.stringify({ main: 'index.js' }),
			'remote/node_modules/fixture/index.js': `module.exports = 'remote';`,
			'remote/node_modules/fixture/subpath.js': `module.exports = 'remote subpath';`,
			'remote/node_modules/@fixture/conditional/package.json': JSON.stringify({ exports: { '.': { import: { default: './import.mjs' }, require: './require.cjs' } } }),
			'remote/node_modules/@fixture/conditional/import.mjs': `export default 'remote import';`,
			'remote/node_modules/@fixture/conditional/require.cjs': `module.exports = 'remote require';`,
			'node_modules/root-only/index.js': `module.exports = 'root only';`,
			'extensions/private/node_modules/fixture/index.js': `module.exports = 'extension private';`,
		};
		await Promise.all(Object.entries(files).map(async ([name, contents]) => {
			const file = join(root, name);
			await fs.mkdir(dirname(file), { recursive: true });
			await fs.writeFile(file, contents);
		}));
		await fs.mkdir(join(root, 'out'));
		await Promise.all(['bootstrap-node.js', 'bootstrap-import.js'].map(name =>
			fs.copyFile(new URL(`../../../../${name}`, import.meta.url), join(root, 'out', name))));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	for (const trailingSlash of ['', '/']) {
		test(`redirects ESM and CommonJS with${trailingSlash ? '' : 'out'} a trailing separator`, async () => {
			const script = `
				import { createRequire } from 'node:module';
				import { devInjectNodeModuleLookupPath } from './bootstrap-node.js';
				const root = ${JSON.stringify(root)};
				devInjectNodeModuleLookupPath(root + '/remote/node_modules' + ${JSON.stringify(trailingSlash)});
				const require = createRequire(import.meta.url);
				const extensionRequire = createRequire(root + '/extensions/private/main.js');
				const result = {
					esm: (await import('fixture')).default,
					commonjs: require('fixture'),
					subpath: require('fixture/subpath'),
					conditionalImport: (await import('@fixture/conditional')).default,
					conditionalRequire: require('@fixture/conditional'),
					fallback: require('root-only'),
					privateDependency: extensionRequire('fixture'),
					builtin: require('node:fs') === require('fs'),
				};
				console.log('BOOTSTRAP_TEST_RESULT:' + JSON.stringify(result));
			`;
			const entrypoint = join(root, 'out', 'test.mjs');
			await fs.writeFile(entrypoint, script);
			const { stdout } = await promisify(execFile)(process.execPath, [entrypoint], {
				env: { ...process.env, VSCODE_DEV: '1', ELECTRON_RUN_AS_NODE: '1' },
			});
			const result = stdout.split('\n').find(line => line.startsWith('BOOTSTRAP_TEST_RESULT:'));
			assert.ok(result, stdout);
			assert.deepStrictEqual(JSON.parse(result.slice('BOOTSTRAP_TEST_RESULT:'.length)), {
				esm: 'remote', commonjs: 'remote', subpath: 'remote subpath',
				conditionalImport: 'remote import', conditionalRequire: 'remote require',
				fallback: 'root only', privateDependency: 'extension private', builtin: true,
			});
		});
	}
});
