/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { afterEach, beforeEach, suite, test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMangleWorkerCount, Mangler } from '../mangle/index.ts';

suite('Mangler', () => {
	let rootPath: string;
	let sourcePath: string;
	let tsconfigPath: string;

	beforeEach(() => {
		rootPath = realpathSync(mkdtempSync(join(tmpdir(), 'vscode-mangler-')));
		sourcePath = join(rootPath, 'fixture.ts');
		tsconfigPath = join(rootPath, 'tsconfig.json');
		writeFileSync(tsconfigPath, JSON.stringify({
			compilerOptions: {
				module: 'nodenext',
				moduleResolution: 'nodenext',
				strict: true,
				target: 'es2024',
			},
			files: ['fixture.ts'],
		}));
	});

	afterEach(() => {
		rmSync(rootPath, { recursive: true, force: true });
	});

	test('uses a bounded configurable rename worker count', () => {
		assert.deepStrictEqual({
			defaultWorkerCount: getMangleWorkerCount(undefined),
			configuredWorkerCount: getMangleWorkerCount('1'),
		}, {
			defaultWorkerCount: 4,
			configuredWorkerCount: 1,
		});

		for (const value of ['', '0', '-1', '1.5', 'not-a-number']) {
			assert.throws(() => getMangleWorkerCount(value), /VSCODE_MANGLE_WORKERS must be a positive integer/);
		}
	});

	test('preserves runtime-observable and explicitly skipped class members', async () => {
		writeFileSync(sourcePath, `
			class Reflected {
				private reflectedValue = 1;
			}
			const reflected = new Reflected();
			reflected['reflectedValue'] = 2;

			class Ordinary {
				private ordinaryValue = 1;
				read(): number { return this.ordinaryValue; }
			}

			function createMixin(Base: typeof Ordinary) {
				return /** @skipMangle */ class RuntimeMixin extends Base {
					private mixinValue = 2;
					readMixin(): number { return this.mixinValue; }
				};
			}
			createMixin(Ordinary);
		`);

		const mangler = new Mangler(tsconfigPath, () => { }, { mangleExports: false, manglePrivateFields: true });
		const output = (await mangler.computeNewFileContents()).get(sourcePath)?.out;

		assert.deepStrictEqual({
			reflectedDeclarationPreserved: output?.includes('private reflectedValue'),
			reflectedAccessPreserved: output?.includes('reflected[\'reflectedValue\']'),
			ordinaryMemberMangled: !output?.includes('ordinaryValue'),
			mixinMemberPreserved: output?.includes('private mixinValue'),
		}, {
			reflectedDeclarationPreserved: true,
			reflectedAccessPreserved: true,
			ordinaryMemberMangled: true,
			mixinMemberPreserved: true,
		});
	});
});
