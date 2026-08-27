/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { SimpleSettingRenderer } from '../../../markdown/browser/markdownSettingRenderer.js';
import { IOverlayWebview } from '../../../webview/browser/webview.js';
import { WebviewInput } from '../../../webviewPanel/browser/webviewEditorInput.js';
import { IWebviewWorkbenchService } from '../../../webviewPanel/browser/webviewWorkbenchService.js';
import { ReleaseNotesManager } from '../../browser/releaseNotesEditor.js';

suite('ReleaseNotesManager', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('coalesces concurrent creation before and after the current webview closes', async () => {
		const inputs = Array.from({ length: 2 }, () => {
			const onWillDispose = disposables.add(new Emitter<void>());
			const html: string[] = [];
			const titles: string[] = [];
			const webview = new class extends mock<IOverlayWebview>() {
				override readonly onDidClickLink = Event.None;
				override readonly onMessage = Event.None;
				override setHtml(value: string): void { html.push(value); }
			}();
			const input = new class extends mock<WebviewInput>() {
				override readonly onWillDispose = onWillDispose.event;
				override get webview(): IOverlayWebview { return webview; }
				override setWebviewTitle(value: string): void { titles.push(value); }
			}();
			return { input, html, titles, dispose: () => onWillDispose.fire() };
		});
		const openGates = [new DeferredPromise<void>(), new DeferredPromise<void>()];
		let openCount = 0;
		const webviewWorkbenchService = new class extends mock<IWebviewWorkbenchService>() {
			override readonly onDidChangeActiveWebviewEditor = Event.None;
			override async openWebview(): Promise<WebviewInput> {
				const index = openCount++;
				await openGates[index].p;
				return inputs[index].input;
			}
			override revealWebview(): void { }
		}();
		const activeGroup = new class extends mock<IEditorGroup>() { }();
		const configurationService = new TestConfigurationService();
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(IEnvironmentService, new class extends mock<IEnvironmentService>() { }());
		instantiationService.stub(IKeybindingService, new class extends mock<IKeybindingService>() { }());
		instantiationService.stub(ILanguageService, new class extends mock<ILanguageService>() { }());
		instantiationService.stub(IOpenerService, new class extends mock<IOpenerService>() { }());
		instantiationService.stub(IRequestService, new class extends mock<IRequestService>() { }());
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(IEditorService, new class extends mock<IEditorService>() { }());
		instantiationService.stub(IEditorGroupsService, new class extends mock<IEditorGroupsService>() {
			override readonly activeGroup = activeGroup;
		}());
		instantiationService.stub(ICodeEditorService, new class extends mock<ICodeEditorService>() { }());
		instantiationService.stub(IWebviewWorkbenchService, webviewWorkbenchService);
		instantiationService.stub(IExtensionService, new class extends mock<IExtensionService>() { }());
		instantiationService.stub(IProductService, new class extends mock<IProductService>() { }());
		instantiationService.stubInstance(SimpleSettingRenderer, { updateSetting: async () => { } });
		const manager = disposables.add(instantiationService.createInstance(ReleaseNotesManager));
		const internals = manager as unknown as {
			loadReleaseNotes(version: string, useCurrentFile: boolean): Promise<string>;
			getBase(useCurrentFile: boolean): Promise<URI>;
			renderBody(meta: { text: string; base: URI }): Promise<string>;
		};
		internals.loadReleaseNotes = async version => version;
		internals.getBase = async () => URI.file('/release-notes');
		internals.renderBody = async meta => `<html>${meta.text}</html>`;

		const firstWave = [manager.show('1.2.3', false), manager.show('1.2.4', false)];
		await timeout(0);
		assert.strictEqual(openCount, 1);
		await openGates[0].complete();
		await Promise.all(firstWave);
		assert.deepStrictEqual({ htmlWrites: inputs[0].html.length, titleWrites: inputs[0].titles.length }, { htmlWrites: 2, titleWrites: 2 });

		inputs[0].dispose();
		const secondWave = [manager.show('1.3.0', false), manager.show('1.3.1', false)];
		await timeout(0);
		assert.strictEqual(openCount, 2);
		await openGates[1].complete();
		await Promise.all(secondWave);

		assert.deepStrictEqual({
			openCount,
			htmlWrites: inputs[1].html.length,
			titleWrites: inputs[1].titles.length,
		}, {
			openCount: 2,
			htmlWrites: 2,
			titleWrites: 2,
		});
		inputs[1].dispose();
	});
});
