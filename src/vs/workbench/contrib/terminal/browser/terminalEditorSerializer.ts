/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ThemeIcon } from '../../../../base/common/themables.js';
import { isNumber, isObject } from '../../../../base/common/types.js';
import { isUriComponents } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { TitleEventSource } from '../../../../platform/terminal/common/terminal.js';
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
	if (!isObject(obj)) {
		return false;
	}
	const candidate = obj as Record<string, unknown>;
	return isNonNegativeSafeInteger(candidate.id)
		&& isNonNegativeSafeInteger(candidate.pid)
		&& isOptionalNonEmptyString(candidate.logicalWorkspaceId)
		&& isOptionalNonEmptyString(candidate.logicalTerminalId)
		&& (candidate.remoteAuthority === undefined || candidate.remoteAuthority === null || isNonEmptyString(candidate.remoteAuthority))
		&& typeof candidate.title === 'string'
		&& isTitleEventSource(candidate.titleSource)
		&& typeof candidate.cwd === 'string'
		&& isOptionalTerminalIcon(candidate.icon)
		&& (candidate.color === undefined || typeof candidate.color === 'string')
		&& (candidate.hasChildProcesses === undefined || typeof candidate.hasChildProcesses === 'boolean')
		&& (candidate.type === undefined || candidate.type === 'Task' || candidate.type === 'Local')
		&& (candidate.isFeatureTerminal === undefined || typeof candidate.isFeatureTerminal === 'boolean')
		&& (candidate.hideFromUser === undefined || typeof candidate.hideFromUser === 'boolean')
		&& isOptionalReconnectionProperties(candidate.reconnectionProperties)
		&& typeof candidate.shellIntegrationNonce === 'string';
}

function isNonNegativeSafeInteger(candidate: unknown): candidate is number {
	return Number.isSafeInteger(candidate) && (candidate as number) >= 0;
}

function isOptionalNonEmptyString(candidate: unknown): candidate is string | undefined {
	return candidate === undefined || isNonEmptyString(candidate);
}

function isNonEmptyString(candidate: unknown): candidate is string {
	return typeof candidate === 'string' && candidate.length > 0;
}

function isTitleEventSource(candidate: unknown): candidate is TitleEventSource {
	return candidate === TitleEventSource.Api
		|| candidate === TitleEventSource.Process
		|| candidate === TitleEventSource.Sequence
		|| candidate === TitleEventSource.Config;
}

function isOptionalTerminalIcon(candidate: unknown): boolean {
	if (candidate === undefined || ThemeIcon.isThemeIcon(candidate) || isUriComponents(candidate)) {
		return true;
	}

	if (!isObject(candidate)) {
		return false;
	}
	const icon = candidate as Record<string, unknown>;
	return isUriComponents(icon.light) && isUriComponents(icon.dark);
}

function isOptionalReconnectionProperties(candidate: unknown): boolean {
	return candidate === undefined || (isObject(candidate) && isNonEmptyString((candidate as Record<string, unknown>).ownerId));
}
