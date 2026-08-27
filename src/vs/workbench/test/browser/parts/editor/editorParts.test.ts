/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorExtensions, EditorsOrder, IEditorFactoryRegistry } from '../../../../common/editor.js';
import { FileEditorInput } from '../../../../contrib/files/browser/editors/fileEditorInput.js';
import { FileEditorInputSerializer } from '../../../../contrib/files/browser/editors/fileEditorHandler.js';
import { FILE_EDITOR_INPUT_ID } from '../../../../contrib/files/common/files.js';
import { ITerminalInstance, ITerminalService } from '../../../../contrib/terminal/browser/terminal.js';
import { TerminalEditorInput } from '../../../../contrib/terminal/browser/terminalEditorInput.js';
import { TerminalInputSerializer } from '../../../../contrib/terminal/browser/terminalEditorSerializer.js';
import { TerminalLocation, TitleEventSource } from '../../../../../platform/terminal/common/terminal.js';
import { IAuxiliaryWindowService } from '../../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { GroupDirection } from '../../../../services/editor/common/editorGroupsService.js';
import { ITextEditorService } from '../../../../services/textfile/common/textEditorService.js';
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

	test('does not reuse a live cached file input across working set disposal', async () => {
		const instantiationService = createInstantiationService();
		disposables.add(Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(FILE_EDITOR_INPUT_ID, FileEditorInputSerializer));
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, disposables);
		const resource = URI.file('/cached-working-set.txt');
		const input = disposables.add(instantiationService.invokeFunction(accessor => accessor.get(ITextEditorService).createTextEditor({ resource, forceFile: true })) as FileEditorInput);
		await parts.activeGroup.openEditor(input, { pinned: true });
		const workingSet = parts.serializeWorkingSet();

		const applied = await parts.applySerializedWorkingSet(workingSet, { preserveFocus: true });
		const restoredInput = parts.activeGroup.activeEditor;
		if (restoredInput && restoredInput !== input) {
			disposables.add(restoredInput);
		}

		assert.deepStrictEqual({
			applied,
			type: restoredInput?.typeId,
			resource: restoredInput?.resource?.toString(),
			disposed: restoredInput?.isDisposed(),
		}, {
			applied: true,
			type: FILE_EDITOR_INPUT_ID,
			resource: resource.toString(),
			disposed: false,
		});
	});

	test('restores a retained Terminal editor once in its serialized group', async () => {
		const instantiationService = createInstantiationService();
		const resource = URI.parse('vscode-terminal://physical/1');
		const instance = {
			instanceId: 1,
			persistentProcessId: 17,
			processId: 42,
			remoteAuthority: 'test-remote',
			target: TerminalLocation.Editor,
			resource,
			shouldPersist: true,
			title: 'Terminal',
			titleSource: TitleEventSource.Process,
			icon: undefined,
			color: undefined,
			hasChildProcesses: false,
			shellIntegrationNonce: '',
			shellLaunchConfig: { logicalWorkspaceId: 'workspace', logicalTerminalId: 'terminal' },
			onDidFocus: Event.None,
			onDidBlur: Event.None,
			onExit: Event.None,
			onDisposed: Event.None,
			onTitleChanged: Event.None,
			onIconChanged: Event.None,
			statusList: { onDidChangePrimaryStatus: Event.None } as ITerminalInstance['statusList'],
			setParentContextKeyService: () => { },
			detachFromElement: () => { },
			dispose: () => { },
		} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
		let adoptedInputs = 0;
		const terminalService = new class extends mock<ITerminalService>() {
			override reviveTerminalEditorInput(): TerminalEditorInput {
				adoptedInputs++;
				return disposables.add(instantiationService.createInstance(TerminalEditorInput, resource, instance));
			}
		};
		class TestTerminalInputSerializer extends TerminalInputSerializer {
			constructor() {
				super(terminalService);
			}
		}
		disposables.add(Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(TerminalEditorInput.ID, TestTerminalInputSerializer));
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, disposables);
		const terminalGroup = parts.addGroup(parts.activeGroup, GroupDirection.RIGHT);
		const originalInput = disposables.add(instantiationService.createInstance(TerminalEditorInput, resource, instance));
		await terminalGroup.openEditor(originalInput, { pinned: true });
		const terminalGroupId = terminalGroup.id;
		const workingSet = parts.serializeWorkingSet();
		originalInput.detachInstance();

		const applied = await parts.applySerializedWorkingSet(workingSet, { preserveFocus: true });
		const restoredGroup = parts.groups.find(group => group.id === terminalGroupId);

		assert.deepStrictEqual({
			applied,
			adoptedInputs,
			restoredGroupId: restoredGroup?.id,
			restoredTerminalCount: restoredGroup?.getEditors(EditorsOrder.SEQUENTIAL).filter(editor => editor instanceof TerminalEditorInput).length,
		}, {
			applied: true,
			adoptedInputs: 1,
			restoredGroupId: terminalGroupId,
			restoredTerminalCount: 1,
		});
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
