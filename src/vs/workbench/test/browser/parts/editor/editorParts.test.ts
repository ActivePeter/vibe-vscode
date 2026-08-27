/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../common/editor.js';
import { IAuxiliaryWindowService } from '../../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { createEditorParts, registerTestEditor, TestFileEditorInput, workbenchInstantiationService } from '../../workbenchTestServices.js';

suite('Editor Parts', () => {

	const disposables = new DisposableStore();
	const testEditorId = 'workbench.test.editorParts';

	teardown(() => disposables.clear());

	function createInstantiationService() {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.stub(IAuxiliaryWindowService, {
			_serviceBrand: undefined,
			onDidOpenAuxiliaryWindow: Event.None,
			open: async () => { throw new Error('Unexpected auxiliary window'); },
			getWindow: () => undefined,
		});

		return instantiationService;
	}

	test('applies a serialized working set created by the editor parts', async () => {
		const parts = await createEditorParts(createInstantiationService(), disposables);

		assert.strictEqual(await parts.applySerializedWorkingSet(parts.serializeWorkingSet(), { preserveFocus: true }), true);
	});

	test('rejects malformed serialized working sets without changing existing editors', async () => {
		const instantiationService = createInstantiationService();
		disposables.add(registerTestEditor(testEditorId, [new SyncDescriptor(TestFileEditorInput)], testEditorId));
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, disposables);
		const editor = disposables.add(new TestFileEditorInput(URI.file('/working-set.txt'), testEditorId));
		await parts.activeGroup.openEditor(editor, { pinned: true });

		const workingSet = JSON.parse(parts.serializeWorkingSet()) as { readonly main: Record<string, unknown>; readonly auxiliary: Record<string, unknown> };
		type SerializedNode = { type: 'branch'; data: SerializedNode[] } | { type: 'leaf'; data: { editors: { id: string; value: string }[]; mru: number[] } };
		const malformedEditorPayload = JSON.parse(JSON.stringify(workingSet)) as { main: { serializedGrid: { root: SerializedNode } }; auxiliary: Record<string, unknown> };
		const corruptFirstEditor = (node: SerializedNode): boolean => {
			if (node.type === 'branch') {
				return node.data.some(corruptFirstEditor);
			}
			if (node.data.editors.length) {
				node.data.editors[0].value = '{';
			} else {
				node.data.editors.push({ id: testEditorId, value: '{' });
				node.data.mru = [0];
			}
			return true;
		};
		assert.strictEqual(corruptFirstEditor(malformedEditorPayload.main.serializedGrid.root), true);
		const malformedWorkingSets = [
			{ ...workingSet, main: { ...workingSet.main, serializedGrid: {} } },
			{ ...workingSet, main: { ...workingSet.main, mostRecentActiveGroups: 'invalid' } },
			{ ...workingSet, auxiliary: { ...workingSet.auxiliary, mru: [0, 0] } },
			{ ...workingSet, auxiliary: { auxiliary: [{ state: {} }], mru: [0, 1] } },
			malformedEditorPayload,
		];

		const results = [];
		for (const malformedWorkingSet of malformedWorkingSets) {
			results.push({
				applied: await parts.applySerializedWorkingSet(JSON.stringify(malformedWorkingSet), { preserveFocus: true }),
				groupCount: parts.groups.length,
				editorCount: parts.activeGroup.count,
				containsEditor: parts.activeGroup.contains(editor),
				activeEditorUnchanged: parts.activeGroup.activeEditor === editor,
			});
		}

		assert.deepStrictEqual(results, malformedWorkingSets.map(() => ({
			applied: false,
			groupCount: 1,
			editorCount: 1,
			containsEditor: true,
			activeEditorUnchanged: true,
		})));
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
