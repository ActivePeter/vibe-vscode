/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { promises } from 'fs';
import { builtinExtensionsPath, FileAccess } from '../../../../base/common/network.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { MainThreadLocalizationShape } from '../../common/extHost.protocol.js';
import { IExtHostInitDataService } from '../../common/extHostInitDataService.js';
import { ExtHostLocalizationService } from '../../common/extHostLocalizationService.js';
import { SingleProxyRPCProtocol } from '../common/testRPCProtocol.js';

suite('ExtHostLocalizationService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const extensionId = 'vibe-vscode.project-switcher';
	const extensionLocation = FileAccess.asFileUri(`${builtinExtensionsPath}/vibe-vscode`);

	function createService(mainThread: MainThreadLocalizationShape): ExtHostLocalizationService {
		const initData = new class extends mock<IExtHostInitDataService>() {
			override readonly environment = { appLanguage: 'zh-cn' } as IExtHostInitDataService['environment'];
		};
		return new ExtHostLocalizationService(initData, SingleProxyRPCProtocol(mainThread), new NullLogService());
	}

	function createBuiltInExtension(): IExtensionDescription {
		return {
			identifier: { value: extensionId },
			extensionLocation,
			isBuiltin: true,
			l10n: './l10n',
		} as IExtensionDescription;
	}

	test('prefers the language pack for built-in extensions', async () => {
		const languagePackUri = URI.file('/language-pack/vibe-vscode.i18n.json');
		const fetchedUris: string[] = [];
		const mainThread = new class extends mock<MainThreadLocalizationShape>() {
			override async $fetchBuiltInBundleUri(): Promise<UriComponents | undefined> {
				return languagePackUri;
			}
			override async $fetchBundleContents(uri: UriComponents): Promise<string> {
				fetchedUris.push(URI.revive(uri).toString());
				return JSON.stringify({ contents: { bundle: { Close: '语言包关闭' } } });
			}
		};
		const service = createService(mainThread);

		await service.initializeLocalizedMessages(createBuiltInExtension());

		assert.deepStrictEqual({
			message: service.getMessage(extensionId, { message: 'Close' }),
			bundleUri: service.getBundleUri(extensionId)?.toString(),
			fetchedUris,
		}, {
			message: '语言包关闭',
			bundleUri: languagePackUri.toString(),
			fetchedUris: [languagePackUri.toString()],
		});
	});

	test('falls back to the extension bundle when the language pack has no built-in translation', async () => {
		const fetchedUris: string[] = [];
		const mainThread = new class extends mock<MainThreadLocalizationShape>() {
			override async $fetchBuiltInBundleUri(): Promise<UriComponents | undefined> {
				return undefined;
			}
			override async $fetchBundleContents(uri: UriComponents): Promise<string> {
				const revived = URI.revive(uri);
				fetchedUris.push(revived.toString());
				return promises.readFile(revived.fsPath, 'utf8');
			}
		};
		const service = createService(mainThread);

		await service.initializeLocalizedMessages(createBuiltInExtension());

		assert.deepStrictEqual({
			title: service.getMessage(extensionId, { message: 'vibe vscode fullscreen panel' }),
			description: service.getMessage(extensionId, { message: 'The privileged fullscreen host is active. vibe vscode interfaces can now be mounted in this surface.' }),
			close: service.getMessage(extensionId, { message: 'Close' }),
			fetchedUris,
		}, {
			title: 'vibe vscode 全屏面板',
			description: '受信任的全屏宿主已激活。现在可以在此界面中挂载 vibe vscode 功能。',
			close: '关闭',
			fetchedUris: [URI.joinPath(extensionLocation, 'l10n', 'bundle.l10n.zh-cn.json').toString()],
		});
	});
});
