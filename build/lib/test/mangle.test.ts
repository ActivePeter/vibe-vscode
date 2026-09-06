/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { afterEach, beforeEach, suite, test } from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import ts from 'typescript';
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

	test('type-checks the workbench cache loader contract after export mangling', async () => {
		writeFileSync(join(rootPath, 'package.json'), JSON.stringify({ type: 'module' }));
		const controllerPath = new URL('../../../src/vs/code/browser/workbench/workbenchStartupController.ts', import.meta.url);
		const controller = ts.createSourceFile(controllerPath.pathname, readFileSync(controllerPath, 'utf8'), ts.ScriptTarget.Latest, true);
		const host = controller.statements.find(statement => ts.isInterfaceDeclaration(statement) && statement.name.text === 'IWorkbenchStartupHost');
		assert.ok(host && ts.isInterfaceDeclaration(host));
		const loadCache = host.members.find(member => ts.isMethodSignature(member) && member.name.getText(controller) === 'loadCache');
		assert.ok(loadCache);
		const cacheImport = controller.statements.find(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === './workbenchCache.js');
		assert.ok(cacheImport);

		// Use the production return type: literal Pick keys are not rewritten by the
		// TypeScript rename service even though the module's exports and calls are.
		writeFileSync(sourcePath, `
			${cacheImport.getText(controller)}
			interface Host { ${loadCache.getText(controller)} }
			export async function start(host: Host): Promise<void> {
				const loader = await host.loadCache();
				try {
					loader.assertWorkbenchCacheSupported();
					await loader.prepareWorkbenchCache('manifest.json', value => value.completedBytes);
				} catch (error) {
					if (!(error instanceof loader.WorkbenchCacheUnsupportedError)) { throw error; }
				}
			}
		`);
		const cachePath = join(rootPath, 'workbenchCache.ts');
		writeFileSync(cachePath, `
			export class WorkbenchCacheUnsupportedError extends Error { }
			export function assertWorkbenchCacheSupported(): void { }
			export async function prepareWorkbenchCache(url: string, progress: (value: { completedBytes: number }) => void): Promise<void> {
				progress({ completedBytes: url.length });
			}
		`);
		const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
		config.config.files.push('workbenchCache.ts');
		writeFileSync(tsconfigPath, JSON.stringify(config.config));
		const mangler = new Mangler(tsconfigPath, () => { }, { mangleExports: true, manglePrivateFields: true });
		const output = await mangler.computeNewFileContents();
		assert.ok(output.has(sourcePath) && output.has(cachePath));
		assert.doesNotMatch(output.get(cachePath)!.out, /assertWorkbenchCacheSupported|prepareWorkbenchCache|WorkbenchCacheUnsupportedError/);
		for (const path of [sourcePath, cachePath]) {
			writeFileSync(path, output.get(path)!.out);
		}
		const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, rootPath);
		const program = ts.createProgram(parsed.fileNames, parsed.options);
		assert.deepStrictEqual(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), [], output.get(sourcePath)!.out);
	});
});
