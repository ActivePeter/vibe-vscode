/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const PICK_LOGICAL_WORKSPACE_COMMAND_ID = 'workbench.action.pickLogicalWorkspace';

export const enum LogicalWorkspaceActivationActor {
	Picker = 'picker',
	SharedState = 'sharedState',
}

export interface ILogicalWorkspaceShellPartLayout {
	readonly visible: boolean;
	readonly width: number;
	readonly height: number;
	readonly activeCompositeId: string;
}

/**
 * Workspace-owned workbench shell state. Editor groups, open editors and window geometry remain
 * outside this snapshot because they have independent lifecycle and persistence authorities.
 */
export interface ILogicalWorkspaceShellLayout {
	readonly primarySideBar: ILogicalWorkspaceShellPartLayout;
	readonly panel: ILogicalWorkspaceShellPartLayout;
	readonly auxiliaryBar: ILogicalWorkspaceShellPartLayout;
}

export interface ILogicalWorkspace {
	readonly id: string;
	readonly name: string;
	readonly terminalIds: readonly string[];
	readonly chatSessionResources: readonly string[];
	readonly shellLayout: ILogicalWorkspaceShellLayout | undefined;
}

export interface ILogicalWorkspaceActivationEvent {
	readonly actor: LogicalWorkspaceActivationActor;
	readonly sequence: number;
	readonly previousWorkspaceId: string;
	readonly workspaceId: string;
}

export const ILogicalWorkspaceService = createDecorator<ILogicalWorkspaceService>('logicalWorkspaceService');

/**
 * Owns the logical workspace registry and its resource membership. Resource lookup methods are
 * pure reads; membership can only change through the explicit bind and unbind methods.
 */
export interface ILogicalWorkspaceService {
	readonly _serviceBrand: undefined;

	readonly onWillChangeActiveWorkspace: Event<ILogicalWorkspaceActivationEvent>;
	readonly onDidChangeActiveWorkspace: Event<ILogicalWorkspaceActivationEvent>;
	readonly onDidChangeWorkspaces: Event<void>;

	readonly workspaces: readonly ILogicalWorkspace[];
	readonly activeWorkspace: ILogicalWorkspace;
	readonly activationSequence: number;

	createWorkspace(name: string): ILogicalWorkspace;
	activateWorkspace(workspaceId: string, actor: LogicalWorkspaceActivationActor): void;
	setShellLayout(workspaceId: string, layout: ILogicalWorkspaceShellLayout): void;

	bindTerminal(workspaceId: string, logicalTerminalId: string): void;
	unbindTerminal(logicalTerminalId: string): void;
	workspaceContainsTerminal(workspaceId: string, logicalTerminalId: string): boolean;

	bindChatSession(workspaceId: string, sessionResource: URI): void;
	bindChatSessions(workspaceId: string, sessionResources: readonly URI[]): void;
	unbindChatSession(sessionResource: URI): void;
	unbindChatSessions(sessionResources: readonly URI[]): void;
	workspaceContainsChatSession(workspaceId: string, sessionResource: URI): boolean;
}
