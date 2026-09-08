/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService, IModalEditorPart } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService, MODAL_GROUP, PreferredGroup } from '../../../../services/editor/common/editorService.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../../services/environment/browser/environmentService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { SimEditorInput, SimEditorSerializer } from '../../browser/simEditorInput.js';
import { SimWorkbenchService } from '../../browser/simWorkbenchService.js';

suite('SimWorkbenchService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function create(openGate: Promise<void> = Promise.resolve()) {
		const instantiation = workbenchInstantiationService(undefined, disposables);
		const editors: EditorInput[] = [];
		const opens: { input: SimEditorInput; options?: IEditorOptions; group?: PreferredGroup }[] = [];
		const groups = { activeModalEditorPart: undefined as IModalEditorPart | undefined };
		instantiation.stub(IBrowserWorkbenchEnvironmentService, { options: {} });
		instantiation.stub(ICommandService, new class extends mock<ICommandService>() {
			override async executeCommand<T>(): Promise<T> { throw new Error('No surface requested context in this test.'); }
		}());
		instantiation.stub(IEditorGroupsService, groups);
		instantiation.stub(IEditorService, { editors });
		instantiation.stub(IEditorService, 'openEditor', async (input: SimEditorInput, options?: IEditorOptions, group?: PreferredGroup) => {
			opens.push({ input, options, group });
			await openGate;
			if (!editors.includes(input)) {
				editors.push(disposables.add(input));
			}
		});
		const service = disposables.add(instantiation.createInstance(SimWorkbenchService));
		return { service, instantiation, editors, opens, groups };
	}

	test('keeps a single native editor and stores only its rebuildable route', async () => {
		const { service, instantiation, opens } = create();
		await service.openEditor('/workspace/one');
		await service.openEditor('/workspace/two?tab=agent');
		await service.openEditor('//attacker.invalid');
		const serializer = new SimEditorSerializer();
		const serialized = serializer.serialize(opens[0].input)!;
		const restored = disposables.add(serializer.deserialize(instantiation, serialized)!);
		assert.deepStrictEqual({
			count: opens.length,
			same: opens[0].input === opens[1].input,
			serialized,
			restored: { path: restored.path, fullscreen: restored.fullscreen },
			unsafeRestore: serializer.deserialize(instantiation, '{"path":"/../escape"}'),
		}, { count: 2, same: true, serialized: '{"path":"/workspace/two?tab=agent"}', restored: { path: '/workspace/two?tab=agent', fullscreen: false }, unsafeRestore: undefined });
	});

	test('a route change while fullscreen opens updates the pending input and shares its completion', async () => {
		const gate = new DeferredPromise<void>();
		const { service, opens } = create(gate.p);
		const first = service.openEditor('/workspace/one', true);
		const second = service.openEditor('/workspace/two', true);
		assert.deepStrictEqual(opens.map(open => ({ path: open.input.path, modal: open.options?.modal, group: open.group })), [
			{ path: '/workspace/two', modal: { fullscreen: true }, group: MODAL_GROUP },
		]);
		await gate.complete();
		await Promise.all([first, second]);
		assert.strictEqual(new SimEditorSerializer().canSerialize(opens[0].input), false);
	});

	test('never replaces or closes another modal editor', async () => {
		const { service, groups, opens } = create();
		let closes = 0;
		groups.activeModalEditorPart = new class extends mock<IModalEditorPart>() {
			override readonly activeGroup = new class extends mock<IEditorGroup>() { override readonly activeEditor = null; }();
			override async close(): Promise<boolean> { closes++; return true; }
		}();
		await assert.rejects(service.openEditor(undefined, true), /Close the current modal editor/);
		await service.closeFullscreen();
		assert.deepStrictEqual({ opens: opens.length, closes }, { opens: 0, closes: 0 });
	});

	test('closes the owned fullscreen without disposing the regular editor', async () => {
		const { service, groups, opens } = create();
		await service.openEditor();
		await service.openEditor(undefined, true);
		const fullscreen = opens[1].input;
		let closes = 0;
		groups.activeModalEditorPart = new class extends mock<IModalEditorPart>() {
			override readonly activeGroup = new class extends mock<IEditorGroup>() { override readonly activeEditor = fullscreen; }();
			override async close(): Promise<boolean> { closes++; return true; }
		}();
		await service.closeFullscreen();
		assert.deepStrictEqual({ closes, editorDisposed: opens[0].input.isDisposed() }, { closes: 1, editorDisposed: false });
	});
});
