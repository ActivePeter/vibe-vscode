/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { Layout } from '../../browser/layout.js';

interface IRestorePartsTestHarness {
	readonly editorGroupService: {
		readonly whenReady: Promise<void>;
		readonly whenRestored: Promise<void>;
		readonly mainPart: {
			applyLayout(layout: object): void;
			getGroups(): readonly { readonly id: number }[];
		};
	};
	readonly logicalWorkspaceEditorProjectionService: { readonly whenReady: Promise<void> };
	readonly editorService: {
		readonly editors: readonly object[];
		openEditors(editors: readonly object[], groupId: number): Promise<void>;
	};
	readonly logService: { error(message: string, error: unknown): void };
	readonly configurationService: { getValue(): { readonly restore: boolean } };
	readonly state: {
		readonly initialization: {
			readonly layout: undefined;
			readonly editor: { readonly editorsToOpen: Promise<readonly { readonly editor: object; readonly viewColumn: number }[]> };
			readonly views: {
				readonly defaults: undefined;
				readonly containerToRestore: { sideBar?: string; panel?: string; auxiliaryBar?: string };
			};
		};
	};
	readonly stateModel: { getRuntimeValue(): false };
	readonly whenReadyPromise: DeferredPromise<void>;
	readonly whenRestoredPromise: DeferredPromise<void>;
	restored: boolean;
	isZenModeActive(): false;
	isPanelMaximized(): false;
	isAuxiliaryBarMaximized(): false;
	isVisible(): false;
	hasFocus(): false;
	focusPart(): void;
}

suite('Workbench Layout', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const restoreParts = Reflect.get(Layout.prototype, 'restoreParts') as (this: IRestorePartsTestHarness) => void;

	/*
	 * Initial editor restore failure policy:
	 *
	 * | Projection readiness | Native startup editors | Result                         |
	 * | pending              | present                | wait                           |
	 * | fulfilled            | present                | open editors                   |
	 * | rejected             | present                | log, then open editors         |
	 * | rejected             | absent                 | log, then complete restoration |
	 */
	test('continues native startup editor restore after Logical Workspace projection fails', async () => {
		const projectionReadiness = new DeferredPromise<void>();
		const layoutReadiness = new DeferredPromise<void>();
		const layoutRestored = new DeferredPromise<void>();
		const projectionError = new Error('projection failed');
		const events: string[] = [];
		const harness: IRestorePartsTestHarness = {
			editorGroupService: {
				whenReady: Promise.resolve(),
				whenRestored: Promise.resolve(),
				mainPart: {
					applyLayout: () => { },
					getGroups: () => [{ id: 1 }],
				},
			},
			logicalWorkspaceEditorProjectionService: { whenReady: projectionReadiness.p },
			editorService: {
				editors: [],
				openEditors: async () => { events.push('startup-editors'); },
			},
			logService: {
				error: (_message, error) => events.push(error === projectionError ? 'projection-error' : 'unexpected-error'),
			},
			configurationService: { getValue: () => ({ restore: false }) },
			state: {
				initialization: {
					layout: undefined,
					editor: { editorsToOpen: Promise.resolve([{ editor: {}, viewColumn: 1 }]) },
					views: { defaults: undefined, containerToRestore: {} },
				},
			},
			stateModel: { getRuntimeValue: () => false },
			whenReadyPromise: layoutReadiness,
			whenRestoredPromise: layoutRestored,
			restored: false,
			isZenModeActive: () => false,
			isPanelMaximized: () => false,
			isAuxiliaryBarMaximized: () => false,
			isVisible: () => false,
			hasFocus: () => false,
			focusPart: () => { },
		};

		restoreParts.call(harness);
		await timeout(0);
		const beforeReadiness = [...events];
		await projectionReadiness.error(projectionError);
		await Promise.all([layoutReadiness.p, layoutRestored.p]);

		assert.deepStrictEqual({ beforeReadiness, events }, {
			beforeReadiness: [],
			events: ['projection-error', 'startup-editors'],
		});
	});
});
