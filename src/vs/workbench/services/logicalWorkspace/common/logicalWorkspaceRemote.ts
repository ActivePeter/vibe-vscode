/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogicalWorkspaceMutation, ILogicalWorkspaceSharedState, parseLogicalWorkspaceSharedState } from './logicalWorkspace.js';

export const REMOTE_LOGICAL_WORKSPACE_STATE_CHANNEL_NAME = 'logicalWorkspaceState';

export const enum RemoteLogicalWorkspaceStateCommand {
	Initialize = 'initialize',
	Read = 'read',
	Mutate = 'mutate',
}

export interface IRemoteLogicalWorkspaceStateRequest {
	readonly physicalWorkspaceId: string;
}

export interface IRemoteLogicalWorkspaceStateInitializeRequest extends IRemoteLogicalWorkspaceStateRequest {
	readonly state: ILogicalWorkspaceSharedState;
}

export interface IRemoteLogicalWorkspaceStateMutationRequest extends IRemoteLogicalWorkspaceStateRequest {
	readonly mutation: ILogicalWorkspaceMutation;
}

export interface IRemoteLogicalWorkspaceStateSnapshot {
	readonly revision: number;
	readonly state: ILogicalWorkspaceSharedState;
}

export const enum RemoteLogicalWorkspaceStateErrorCode {
	CorruptState = 'corruptState',
	InvalidRequest = 'invalidRequest',
	NotInitialized = 'notInitialized',
}

export type IRemoteLogicalWorkspaceStateResult<T> =
	| { readonly status: 'ok'; readonly value: T }
	| { readonly status: 'error'; readonly code: RemoteLogicalWorkspaceStateErrorCode; readonly message: string };

export function parseRemoteLogicalWorkspaceStateSnapshot(raw: unknown): IRemoteLogicalWorkspaceStateSnapshot | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const candidate = raw as Record<string, unknown>;
	const state = parseLogicalWorkspaceSharedState(candidate.state);
	if (!Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 1 || !state) {
		return undefined;
	}
	return { revision: candidate.revision as number, state };
}
