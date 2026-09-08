/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInputCapabilities, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { isSafeSimPath } from '../common/sim.js';

/** Editor working sets persist only this rebuildable route, never Sim Session data. */
export class SimEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.sim';

	constructor(public path: string, readonly fullscreen = false) {
		super();
	}

	override get typeId(): string { return SimEditorInput.ID; }
	override get editorId(): string { return 'workbench.editor.sim'; }
	override get resource(): URI { return URI.from({ scheme: 'vscode-sim', path: this.fullscreen ? '/fullscreen' : '/editor' }); }
	override get capabilities(): EditorInputCapabilities { return EditorInputCapabilities.Singleton | EditorInputCapabilities.Readonly; }
	override getName(): string { return localize('sim.editorTitle', "Sim Development Orchestration"); }
	override matches(other: EditorInput | unknown): boolean {
		return other instanceof SimEditorInput && this.fullscreen === other.fullscreen;
	}
}

export class SimEditorSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof SimEditorInput && !input.fullscreen && isSafeSimPath(input.path);
	}

	serialize(input: EditorInput): string | undefined {
		return this.canSerialize(input) && input instanceof SimEditorInput ? JSON.stringify({ path: input.path }) : undefined;
	}

	deserialize(_instantiationService: IInstantiationService, serialized: string): SimEditorInput | undefined {
		try {
			const state: { path?: string } | null = JSON.parse(serialized);
			return isSafeSimPath(state?.path) ? new SimEditorInput(state.path) : undefined;
		} catch {
			return undefined;
		}
	}
}
