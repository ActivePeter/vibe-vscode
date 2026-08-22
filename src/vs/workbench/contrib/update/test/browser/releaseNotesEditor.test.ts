/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { TestClipboardService } from '../../../../../platform/clipboard/test/common/testClipboardService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { IOverlayWebview } from '../../../webview/browser/webview.js';
import { WebviewInput } from '../../../webviewPanel/browser/webviewEditorInput.js';
import { IWebviewWorkbenchService } from '../../../webviewPanel/browser/webviewWorkbenchService.js';
import { ReleaseNotesManager } from '../../browser/releaseNotesEditor.js';

suite('ReleaseNotesManager', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('shares pending webview creation across concurrent show calls', async () => {
		const opened = new DeferredPromise<WebviewInput>();
		const openEntered = new DeferredPromise<void>();
		let openCount = 0;
		const webview = new class extends mock<IOverlayWebview>() {
			override readonly onDidClickLink = Event.None;
			override readonly onMessage = Event.None;
			override readonly container = mainWindow.document.createElement('div');
			override setHtml(): void { }
		};
		const willDispose = disposables.add(new Emitter<void>());
		const input = new class extends mock<WebviewInput>() {
			override get webview() { return webview; }
			override readonly onWillDispose = willDispose.event;
			override setWebviewTitle(): void { }
		};
		const webviewWorkbenchService = new class extends mock<IWebviewWorkbenchService>() {
			override readonly onDidChangeActiveWebviewEditor = Event.None;
			override openWebview(): Promise<WebviewInput> {
				openCount++;
				openEntered.complete();
				return opened.p;
			}
			override revealWebview(): void { }
		};
		const instantiationService = disposables.add(workbenchInstantiationService(undefined, disposables));
		instantiationService.stub(IClipboardService, new TestClipboardService());
		instantiationService.stub(IOpenerService, new class extends mock<IOpenerService>() { });
		instantiationService.stub(IPreferencesService, new class extends mock<IPreferencesService>() { });
		instantiationService.stub(IRequestService, new class extends mock<IRequestService>() { });
		instantiationService.stub(IWebviewWorkbenchService, webviewWorkbenchService);
		const manager = disposables.add(instantiationService.createInstance(ReleaseNotesManager));
		Reflect.set(manager, 'loadReleaseNotes', async () => 'release notes');
		Reflect.set(manager, 'getBase', async () => URI.file('/release-notes'));
		Reflect.set(manager, 'renderBody', async () => '<html></html>');

		const first = manager.show('1.0.0', false);
		const second = manager.show('1.0.1', false);
		await openEntered.p;
		opened.complete(input);
		await Promise.all([first, second]);

		assert.strictEqual(openCount, 1);
		willDispose.fire();
	});
});
