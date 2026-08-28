/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../platform/configuration/test/common/testConfigurationService.js';
import { ExtensionIdentifier, IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { TestInstantiationService } from '../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { TestThemeService } from '../../../../platform/theme/test/common/testThemeService.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IEditorGroup, IEditorGroupsService, IModalEditorPart } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService, MODAL_GROUP } from '../../../services/editor/common/editorService.js';
import { IOverlayWebview, IWebviewService } from '../../../contrib/webview/browser/webview.js';
import { WebviewInput } from '../../../contrib/webviewPanel/browser/webviewEditorInput.js';
import { IWebViewShowOptions, IWebviewWorkbenchService, WebviewEditorService } from '../../../contrib/webviewPanel/browser/webviewWorkbenchService.js';
import { TestStorageService } from '../../../test/common/workbenchTestServices.js';
import { MainThreadWebviewPanels } from '../../browser/mainThreadWebviewPanels.js';
import { MainThreadWebviewManager } from '../../browser/mainThreadWebviewManager.js';
import { MainThreadWebviews } from '../../browser/mainThreadWebviews.js';
import { ExtHostWebview, ExtHostWebviews } from '../../common/extHostWebview.js';
import { ExtHostWebviewPanels } from '../../common/extHostWebviewPanels.js';
import { ExtHostWebviewPanelsShape, IWebviewInitData, WebviewExtensionDescription } from '../../common/extHost.protocol.js';
import { SingleProxyRPCProtocol } from '../common/testRPCProtocol.js';

suite('MainThreadWebviewPanels', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('publishes the initial inactive state after a preserve-focus panel is mounted', async () => {
		const webviewDidDispose = disposables.add(new Emitter<void>());
		const webview = new class extends mock<IOverlayWebview>() {
			override readonly onDidDispose = webviewDidDispose.event;
			override dispose(): void { webviewDidDispose.fire(); }
		}();
		const input = disposables.add(new WebviewInput({
			viewType: 'mainThreadWebview-test.view',
			providedId: 'test.view',
			name: 'Test',
			iconPath: undefined,
		}, webview, new TestThemeService()));
		const activeEditor = disposables.add(new class extends EditorInput {
			override readonly typeId = 'test.activeEditor';
			override readonly resource = undefined;
		}());
		const group = new class extends mock<IEditorGroup>() {
			override readonly id = 1;
			override readonly editors = [activeEditor, input];
			override readonly activeEditor = activeEditor;
		}();
		const editorGroupsService = new class extends mock<IEditorGroupsService>() {
			override readonly onDidAddGroup = Event.None;
			override readonly onDidRemoveGroup = Event.None;
			override readonly onDidMoveGroup = Event.None;
			override readonly groups = [group];
			override readonly activeGroup = group;
			override getGroups(): readonly IEditorGroup[] { return [group]; }
			override getGroup(identifier: number): IEditorGroup | undefined { return identifier === group.id ? group : undefined; }
		}();
		const editorService = new class extends mock<IEditorService>() {
			override readonly onDidActiveEditorChange = Event.None;
			override readonly onDidVisibleEditorsChange = Event.None;
			override readonly activeEditor = activeEditor;
		}();
		const webviewWorkbenchService = new class extends mock<IWebviewWorkbenchService>() {
			override readonly onDidChangeActiveWebviewEditor = Event.None;
			override async openWebview(): Promise<WebviewInput> { return input; }
			override registerResolver(): IDisposable { return Disposable.None; }
		}();
		const extensionService = new class extends mock<IExtensionService>() {
			override readonly extensions = [];
			override async activateByEvent(): Promise<void> { }
		}();
		const mainThreadWebviews = new class extends mock<MainThreadWebviews>() {
			override addWebview(): void { }
		}();
		const viewStates: unknown[] = [];
		const extHostWebviewPanels = new class extends mock<ExtHostWebviewPanelsShape>() {
			override async $onDidDisposeWebviewPanel(): Promise<void> { }
			override $onDidChangeWebviewPanelViewStates(states: unknown): void { viewStates.push(states); }
		}();
		const panels = disposables.add(new MainThreadWebviewPanels(
			SingleProxyRPCProtocol(extHostWebviewPanels),
			mainThreadWebviews,
			new TestConfigurationService(),
			editorGroupsService,
			editorService,
			extensionService,
			disposables.add(new TestStorageService()),
			webviewWorkbenchService,
		));

		await panels.$createWebviewPanel(
			{ id: new ExtensionIdentifier('test.extension'), location: URI.file('/test-extension') },
			'preserve-focus-handle',
			'test.view',
			{ title: 'Test', webviewOptions: {}, panelOptions: {}, serializeBuffersForPostMessage: false },
			{ preserveFocus: true },
		);

		assert.deepStrictEqual(viewStates, [{
			'preserve-focus-handle': { visible: false, active: false, position: 0 },
		}]);
		input.dispose();
		await Promise.resolve();
	});

	test('keeps fullscreen modal presentation options when revealing a panel', async () => {
		const extensionLocation = URI.file('/builtin/vibe-vscode');
		const extensionId = new ExtensionIdentifier('vibe-vscode.project-switcher');
		const registeredExtension = upcastPartial<IExtensionDescription>({
			identifier: extensionId,
			extensionLocation,
			isBuiltin: true,
		});
		const extensionService = new class extends mock<IExtensionService>() {
			override readonly extensions = [registeredExtension];
			override async activateByEvent(): Promise<void> { }
		}();
		const editorGroupsService = new class extends mock<IEditorGroupsService>() {
			override readonly activeModalEditorPart = undefined;
			override readonly onDidAddGroup = Event.None;
			override readonly onDidRemoveGroup = Event.None;
			override readonly onDidMoveGroup = Event.None;
			override readonly groups = [];
			override registerContextKeyProvider(): IDisposable { return Disposable.None; }
		}();
		const webviewDidDispose = disposables.add(new Emitter<void>());
		const webview = new class extends mock<IOverlayWebview>() {
			override readonly onDidDispose = webviewDidDispose.event;
		}();
		const input = new class extends mock<WebviewInput>() {
			override get webview(): IOverlayWebview { return webview; }
			override isDisposed(): boolean { return false; }
		}();
		const editorOpenCalls: unknown[][] = [];
		const editorService = new class extends mock<IEditorService>() {
			override readonly onDidActiveEditorChange = Event.None;
			override readonly onDidVisibleEditorsChange = Event.None;
			override get editors(): readonly WebviewInput[] { return [input]; }
			override async openEditor(...args: unknown[]): Promise<undefined> {
				editorOpenCalls.push(args);
				return undefined;
			}
		}();
		let openOptions: IWebViewShowOptions | undefined;
		const webviewService = new class extends mock<IWebviewService>() {
			override readonly onDidChangeActiveWebview = Event.None;
		}();
		const webviewWorkbenchService = disposables.add(new class extends WebviewEditorService {
			override async openWebview(...args: Parameters<IWebviewWorkbenchService['openWebview']>): Promise<WebviewInput> {
				openOptions = args[4];
				return input;
			}
		}(
			editorGroupsService,
			editorService,
			new class extends mock<IInstantiationService>() { }(),
			webviewService,
		));
		const mainThreadWebviews = new class extends mock<MainThreadWebviews>() {
			override addWebview(): void { }
		}();
		const extHostWebviewPanels = new class extends mock<ExtHostWebviewPanelsShape>() {
			override async $onDidDisposeWebviewPanel(): Promise<void> { }
		}();
		const panels = disposables.add(new MainThreadWebviewPanels(
			SingleProxyRPCProtocol(extHostWebviewPanels),
			mainThreadWebviews,
			new TestConfigurationService(),
			editorGroupsService,
			editorService,
			extensionService,
			disposables.add(new TestStorageService()),
			webviewWorkbenchService,
		));
		const extension: WebviewExtensionDescription = { id: extensionId, location: extensionLocation };
		const initData: IWebviewInitData = {
			title: 'Sessions',
			webviewOptions: {},
			panelOptions: { vibeVscodeFullscreen: true },
			serializeBuffersForPostMessage: false,
		};

		await panels.$createWebviewPanel(extension, 'fullscreen-handle', 'vibe-vscode.projectSwitcher.fullscreen', initData, { preserveFocus: true });
		const mainThreadProxy = new class extends mock<MainThreadWebviewManager>() {
			$reveal(handle: string, showOptions: { viewColumn?: number; preserveFocus?: boolean }): void {
				panels.$reveal(handle, showOptions);
			}
			$disposeWebview(handle: string): void { panels.$disposeWebview(handle); }
			$setTitle(): void { }
			$setIconPath(): void { }
		}();
		const extHostPanels = disposables.add(new ExtHostWebviewPanels(
			SingleProxyRPCProtocol(mainThreadProxy),
			new class extends mock<ExtHostWebviews>() { }(),
			undefined,
		));
		const extHostWebview = new class extends mock<ExtHostWebview>() {
			override dispose(): void { }
		}();
		const panel = extHostPanels.createNewWebviewPanel('fullscreen-handle', 'vibe-vscode.projectSwitcher.fullscreen', 'Sessions', 1, { vibeVscodeFullscreen: true }, extHostWebview, true);
		panel.reveal(9, true);

		const expected = {
			preserveFocus: false,
			group: MODAL_GROUP,
			modal: { fullscreen: true },
		};
		const revealCall = editorOpenCalls.at(-1);
		const revealedEditorOptions = revealCall?.[1] as { preserveFocus?: boolean; modal?: { fullscreen?: boolean } } | undefined;
		assert.deepStrictEqual({
			openOptions,
			revealOptions: {
				preserveFocus: revealedEditorOptions?.preserveFocus,
				group: revealCall?.[2],
				modal: revealedEditorOptions?.modal,
			},
		}, { openOptions: expected, revealOptions: expected });

		webviewDidDispose.fire();
		await Promise.resolve();
	});

	test('propagates fullscreen editor open failures and disposes the unowned input', async () => {
		const extensionLocation = URI.file('/builtin/vibe-vscode');
		const extensionId = new ExtensionIdentifier('vibe-vscode.project-switcher');
		const registeredExtension = upcastPartial<IExtensionDescription>({
			identifier: extensionId,
			extensionLocation,
			isBuiltin: true,
		});
		const extensionService = new class extends mock<IExtensionService>() {
			override readonly extensions = [registeredExtension];
			override async activateByEvent(): Promise<void> { }
		}();
		const editorGroupsService = new class extends mock<IEditorGroupsService>() {
			override readonly activeModalEditorPart = undefined;
			override readonly onDidAddGroup = Event.None;
			override readonly onDidRemoveGroup = Event.None;
			override readonly onDidMoveGroup = Event.None;
			override registerContextKeyProvider(): IDisposable { return Disposable.None; }
		}();
		const expectedError = new Error('editor open failed');
		const editorService = new class extends mock<IEditorService>() {
			override readonly onDidActiveEditorChange = Event.None;
			override readonly onDidVisibleEditorsChange = Event.None;
			override async openEditor(): Promise<undefined> { throw expectedError; }
		}();
		const webviewDidDispose = disposables.add(new Emitter<void>());
		const webview = new class extends mock<IOverlayWebview>() {
			override readonly onDidDispose = webviewDidDispose.event;
		}();
		let inputDisposed = false;
		const input = new class extends mock<WebviewInput>() {
			override get webview(): IOverlayWebview { return webview; }
			override dispose(): void { inputDisposed = true; }
		}();
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stubInstance(WebviewInput, input);
		const webviewService = new class extends mock<IWebviewService>() {
			override readonly onDidChangeActiveWebview = Event.None;
			override createWebviewOverlay(): IOverlayWebview { return webview; }
		}();
		const webviewWorkbenchService = disposables.add(new WebviewEditorService(
			editorGroupsService,
			editorService,
			instantiationService,
			webviewService,
		));
		const mainThreadWebviews = new class extends mock<MainThreadWebviews>() {
			override addWebview(): void { }
		}();
		const extHostWebviewPanels = new class extends mock<ExtHostWebviewPanelsShape>() {
			override async $onDidDisposeWebviewPanel(): Promise<void> { }
		}();
		const panels = disposables.add(new MainThreadWebviewPanels(
			SingleProxyRPCProtocol(extHostWebviewPanels),
			mainThreadWebviews,
			new TestConfigurationService(),
			editorGroupsService,
			editorService,
			extensionService,
			disposables.add(new TestStorageService()),
			webviewWorkbenchService,
		));
		const initData: IWebviewInitData = {
			title: 'Sessions',
			webviewOptions: {},
			panelOptions: { vibeVscodeFullscreen: true },
			serializeBuffersForPostMessage: false,
		};

		await assert.rejects(
			panels.$createWebviewPanel(
				{ id: extensionId, location: extensionLocation },
				'fullscreen-rejected-handle',
				'vibe-vscode.projectSwitcher.fullscreen',
				initData,
				{ preserveFocus: false },
			),
			error => error === expectedError,
		);
		assert.strictEqual(inputDisposed, true);
	});

	test('reserves the fullscreen host while its first panel is still opening', async () => {
		const extensionLocation = URI.file('/builtin/vibe-vscode');
		const extensionId = new ExtensionIdentifier('vibe-vscode.project-switcher');
		const extensionService = new class extends mock<IExtensionService>() {
			override readonly extensions = [upcastPartial<IExtensionDescription>({
				identifier: extensionId,
				extensionLocation,
				isBuiltin: true,
			})];
			override async activateByEvent(): Promise<void> { }
		}();
		const editorGroupsService = new class extends mock<IEditorGroupsService>() {
			override readonly activeModalEditorPart = undefined;
			override readonly onDidAddGroup = Event.None;
			override readonly onDidRemoveGroup = Event.None;
			override readonly onDidMoveGroup = Event.None;
			override readonly groups = [];
			override registerContextKeyProvider(): IDisposable { return Disposable.None; }
		}();
		const editorService = new class extends mock<IEditorService>() {
			override readonly onDidActiveEditorChange = Event.None;
			override readonly onDidVisibleEditorsChange = Event.None;
		}();
		const webviewDidDispose = disposables.add(new Emitter<void>());
		const webview = new class extends mock<IOverlayWebview>() {
			override readonly onDidDispose = webviewDidDispose.event;
		}();
		const input = new class extends mock<WebviewInput>() {
			override get webview(): IOverlayWebview { return webview; }
		}();
		const openStarted = new DeferredPromise<void>();
		const releaseOpen = new DeferredPromise<void>();
		let openCount = 0;
		const webviewWorkbenchService = new class extends mock<IWebviewWorkbenchService>() {
			override readonly onDidChangeActiveWebviewEditor = Event.None;
			override registerResolver(): IDisposable { return Disposable.None; }
			override async openWebview(): Promise<WebviewInput> {
				openCount++;
				await openStarted.complete();
				await releaseOpen.p;
				return input;
			}
		}();
		const panels = disposables.add(new MainThreadWebviewPanels(
			SingleProxyRPCProtocol(new class extends mock<ExtHostWebviewPanelsShape>() {
				override async $onDidDisposeWebviewPanel(): Promise<void> { }
			}()),
			new class extends mock<MainThreadWebviews>() { override addWebview(): void { } }(),
			new TestConfigurationService(),
			editorGroupsService,
			editorService,
			extensionService,
			disposables.add(new TestStorageService()),
			webviewWorkbenchService,
		));
		const initData: IWebviewInitData = {
			title: 'Sessions',
			webviewOptions: {},
			panelOptions: { vibeVscodeFullscreen: true },
			serializeBuffersForPostMessage: false,
		};
		const createFirst = panels.$createWebviewPanel(
			{ id: extensionId, location: extensionLocation },
			'fullscreen-first',
			'vibe-vscode.projectSwitcher.fullscreen',
			initData,
			{ preserveFocus: false },
		);
		await openStarted.p;

		await assert.rejects(panels.$createWebviewPanel(
			{ id: extensionId, location: extensionLocation },
			'fullscreen-second',
			'vibe-vscode.projectSwitcher.fullscreen',
			initData,
			{ preserveFocus: false },
		), /Close the current modal editor/);
		await releaseOpen.complete();
		await createFirst;

		assert.strictEqual(openCount, 1);
		webviewDidDispose.fire();
		await Promise.resolve();
	});

	test('rejects a fullscreen webview that resolves without mounting an editor', async () => {
		let activeModalEditorPart: IModalEditorPart | undefined;
		let modalClosed = false;
		const modalGroup = new class extends mock<IEditorGroup>() {
			override readonly isEmpty = true;
		}();
		const modalEditorPart = new class extends mock<IModalEditorPart>() {
			override readonly activeGroup = modalGroup;
			override async close(): Promise<boolean> {
				modalClosed = true;
				activeModalEditorPart = undefined;
				return true;
			}
		}();
		const editorGroupsService = new class extends mock<IEditorGroupsService>() {
			override get activeModalEditorPart(): IModalEditorPart | undefined { return activeModalEditorPart; }
			override readonly onDidAddGroup = Event.None;
			override readonly onDidRemoveGroup = Event.None;
			override readonly onDidMoveGroup = Event.None;
			override registerContextKeyProvider(): IDisposable { return Disposable.None; }
		}();
		const editorService = new class extends mock<IEditorService>() {
			override readonly onDidActiveEditorChange = Event.None;
			override readonly onDidVisibleEditorsChange = Event.None;
			override readonly editors = [];
			override async openEditor(): Promise<undefined> {
				activeModalEditorPart = modalEditorPart;
				return undefined;
			}
		}();
		const webviewDidDispose = disposables.add(new Emitter<void>());
		const webview = new class extends mock<IOverlayWebview>() {
			override readonly onDidDispose = webviewDidDispose.event;
		}();
		let inputDisposed = false;
		const input = new class extends mock<WebviewInput>() {
			override get webview(): IOverlayWebview { return webview; }
			override dispose(): void { inputDisposed = true; }
		}();
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stubInstance(WebviewInput, input);
		const webviewService = new class extends mock<IWebviewService>() {
			override readonly onDidChangeActiveWebview = Event.None;
			override createWebviewOverlay(): IOverlayWebview { return webview; }
		}();
		const webviewWorkbenchService = disposables.add(new WebviewEditorService(
			editorGroupsService,
			editorService,
			instantiationService,
			webviewService,
		));

		await assert.rejects(webviewWorkbenchService.openWebview({
			providedViewType: 'vibe-vscode.projectSwitcher.fullscreen',
			title: 'Sessions',
			options: {},
			contentOptions: {},
			extension: undefined,
		}, 'mainThreadWebview-vibe-vscode.projectSwitcher.fullscreen', 'Sessions', undefined, {
			group: MODAL_GROUP,
			preserveFocus: false,
			modal: { fullscreen: true },
		}), /could not be opened/);
		assert.deepStrictEqual({ inputDisposed, modalClosed }, { inputDisposed: true, modalClosed: true });
	});

	test('accepts a preserve-focus webview mounted without an active editor pane', async () => {
		const editorGroupsService = new class extends mock<IEditorGroupsService>() {
			override readonly onDidAddGroup = Event.None;
			override readonly onDidRemoveGroup = Event.None;
			override readonly onDidMoveGroup = Event.None;
			override registerContextKeyProvider(): IDisposable { return Disposable.None; }
		}();
		const webviewDidDispose = disposables.add(new Emitter<void>());
		const webview = new class extends mock<IOverlayWebview>() {
			override readonly onDidDispose = webviewDidDispose.event;
		}();
		const input = new class extends mock<WebviewInput>() {
			override get webview(): IOverlayWebview { return webview; }
		}();
		const editorService = new class extends mock<IEditorService>() {
			override readonly onDidActiveEditorChange = Event.None;
			override readonly onDidVisibleEditorsChange = Event.None;
			override readonly editors = [input];
			override async openEditor(): Promise<undefined> { return undefined; }
		}();
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stubInstance(WebviewInput, input);
		const webviewService = new class extends mock<IWebviewService>() {
			override readonly onDidChangeActiveWebview = Event.None;
			override createWebviewOverlay(): IOverlayWebview { return webview; }
		}();
		const webviewWorkbenchService = disposables.add(new WebviewEditorService(
			editorGroupsService,
			editorService,
			instantiationService,
			webviewService,
		));

		const opened = await webviewWorkbenchService.openWebview({
			providedViewType: 'test.preserveFocus',
			title: 'Preserved',
			options: {},
			contentOptions: {},
			extension: undefined,
		}, 'mainThreadWebview-test.preserveFocus', 'Preserved', undefined, {
			group: 1,
			preserveFocus: true,
		});

		assert.strictEqual(opened, input);
	});
});
