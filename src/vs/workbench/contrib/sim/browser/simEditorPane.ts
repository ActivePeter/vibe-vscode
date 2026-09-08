/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { SimEditorInput } from './simEditorInput.js';
import { ISimSurface, ISimWorkbenchService } from './simWorkbenchService.js';

export class SimEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.sim';
	private container: HTMLElement | undefined;
	private readonly surface = this._register(new MutableDisposable<ISimSurface>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ISimWorkbenchService private readonly simService: ISimWorkbenchService,
	) {
		super(SimEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = parent;
	}

	override async setInput(input: SimEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested || this.input !== input || !this.container) {
			return;
		}
		this.surface.clear();
		this.surface.value = this.simService.mount(this.container, input.fullscreen ? 'fullscreen' : 'editor', input);
	}

	override clearInput(): void {
		this.surface.clear();
		super.clearInput();
	}

	override focus(): void {
		super.focus();
		this.surface.value?.focus();
	}

	override layout(): void {
		// The iframe fills the editor container.
	}
}
