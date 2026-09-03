/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { ITerminalEditorService, ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../contrib/terminal/browser/terminal.js';
import { MainThreadTerminalService } from '../../browser/mainThreadTerminalService.js';

suite('MainThreadTerminalService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('$show waits for hidden editor and panel Terminals to enter their foreground host', async () => {
		for (const target of [TerminalLocation.Editor, TerminalLocation.Panel]) {
			const restoreStarted = new DeferredPromise<void>();
			const releaseRestore = new DeferredPromise<void>();
			const events: string[] = [];
			const instance = {
				instanceId: 1,
				target,
				shellLaunchConfig: { hideFromUser: true },
			} satisfies Partial<ITerminalInstance> as ITerminalInstance;
			const terminalService = new class extends mock<ITerminalService>() {
				override async showBackgroundTerminal(candidate: ITerminalInstance): Promise<void> {
					assert.strictEqual(candidate, instance);
					events.push('restore:start');
					await restoreStarted.complete();
					await releaseRestore.p;
					events.push('restore:end');
				}
				override setActiveInstance(candidate: ITerminalInstance): void {
					assert.strictEqual(candidate, instance);
					events.push('active');
				}
			};
			const terminalEditorService = new class extends mock<ITerminalEditorService>() {
				override async revealActiveEditor(preserveFocus?: boolean): Promise<void> {
					events.push(`editor:reveal:${preserveFocus}`);
				}
			};
			const terminalGroupService = new class extends mock<ITerminalGroupService>() {
				override async showPanel(focus?: boolean): Promise<void> {
					events.push(`panel:show:${focus}`);
				}
			};
			const mainThread = {
				_getTerminalInstance: async () => instance,
				_terminalService: terminalService,
				_terminalEditorService: terminalEditorService,
				_terminalGroupService: terminalGroupService,
			} as unknown as MainThreadTerminalService;

			const showing = MainThreadTerminalService.prototype.$show.call(mainThread, instance.instanceId, true);
			await restoreStarted.p;
			assert.deepStrictEqual(events, ['restore:start']);

			await releaseRestore.complete();
			await showing;
			assert.deepStrictEqual(events, target === TerminalLocation.Editor
				? ['restore:start', 'restore:end', 'active', 'editor:reveal:true']
				: ['restore:start', 'restore:end', 'active', 'panel:show:false']);
		}
	});

	test('$show propagates hidden editor and panel restoration failures without activating', async () => {
		for (const target of [TerminalLocation.Editor, TerminalLocation.Panel]) {
			const expectedError = new Error(`${target} restore failed`);
			const events: string[] = [];
			const instance = {
				instanceId: 1,
				target,
				shellLaunchConfig: { hideFromUser: true },
			} satisfies Partial<ITerminalInstance> as ITerminalInstance;
			const terminalService = new class extends mock<ITerminalService>() {
				override async showBackgroundTerminal(): Promise<void> {
					events.push('restore');
					throw expectedError;
				}
				override setActiveInstance(): void { events.push('active'); }
			};
			const terminalEditorService = new class extends mock<ITerminalEditorService>() {
				override async revealActiveEditor(): Promise<void> { events.push('editor:reveal'); }
			};
			const terminalGroupService = new class extends mock<ITerminalGroupService>() {
				override async showPanel(): Promise<void> { events.push('panel:show'); }
			};
			const mainThread = {
				_getTerminalInstance: async () => instance,
				_terminalService: terminalService,
				_terminalEditorService: terminalEditorService,
				_terminalGroupService: terminalGroupService,
			} as unknown as MainThreadTerminalService;

			await assert.rejects(MainThreadTerminalService.prototype.$show.call(mainThread, instance.instanceId, false), error => error === expectedError);
			assert.deepStrictEqual(events, ['restore']);
		}
	});
});
