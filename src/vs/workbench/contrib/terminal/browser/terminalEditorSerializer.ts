/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isNumber, isObject } from '../../../../base/common/types.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { ISerializedTerminalEditorInput, ITerminalInstance, ITerminalService, type IDeserializedTerminalEditorInput } from './terminal.js';
import { TerminalEditorInput } from './terminalEditorInput.js';

export class TerminalInputSerializer implements IEditorSerializer {
	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService
	) { }

	public canSerialize(editorInput: TerminalEditorInput): editorInput is TerminalEditorInput & { readonly terminalInstance: ITerminalInstance } {
		return isNumber(editorInput.terminalInstance?.persistentProcessId) && editorInput.terminalInstance.shouldPersist;
	}

	public serialize(editorInput: TerminalEditorInput): string | undefined {
		if (!this.canSerialize(editorInput)) {
			return;
		}
		return JSON.stringify(this._toJson(editorInput.terminalInstance));
	}

	public canDeserialize(serializedEditorInput: string): boolean {
		try {
			return isDeserializedTerminalEditorInput(JSON.parse(serializedEditorInput) as unknown);
		} catch {
			return false;
		}
	}

	public deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
		const editorInput = JSON.parse(serializedEditorInput) as unknown;
		if (!isDeserializedTerminalEditorInput(editorInput)) {
			throw new Error(`Could not revive terminal editor input, ${editorInput}`);
		}
		return this._terminalService.reviveTerminalEditorInput(editorInput);
	}

	private _toJson(instance: ITerminalInstance): ISerializedTerminalEditorInput {
		return {
			id: instance.persistentProcessId!,
			logicalWorkspaceId: instance.shellLaunchConfig.logicalWorkspaceId,
			logicalTerminalId: instance.shellLaunchConfig.logicalTerminalId,
			remoteAuthority: instance.remoteAuthority ?? null,
			pid: instance.processId || 0,
			title: instance.title,
			titleSource: instance.titleSource,
			cwd: '',
			icon: instance.icon,
			color: instance.color,
			hasChildProcesses: instance.hasChildProcesses,
			isFeatureTerminal: instance.shellLaunchConfig.isFeatureTerminal,
			hideFromUser: instance.shellLaunchConfig.hideFromUser,
			reconnectionProperties: instance.shellLaunchConfig.reconnectionProperties,
			shellIntegrationNonce: instance.shellIntegrationNonce
		};
	}
}

function isDeserializedTerminalEditorInput(obj: unknown): obj is IDeserializedTerminalEditorInput {
	return isObject(obj) && 'id' in obj && isNumber(obj.id) && 'pid' in obj && isNumber(obj.pid)
		&& (!('logicalWorkspaceId' in obj) || obj.logicalWorkspaceId === undefined || typeof obj.logicalWorkspaceId === 'string')
		&& (!('logicalTerminalId' in obj) || obj.logicalTerminalId === undefined || typeof obj.logicalTerminalId === 'string')
		&& (!('remoteAuthority' in obj) || obj.remoteAuthority === undefined || obj.remoteAuthority === null || (typeof obj.remoteAuthority === 'string' && obj.remoteAuthority.length > 0));
}
