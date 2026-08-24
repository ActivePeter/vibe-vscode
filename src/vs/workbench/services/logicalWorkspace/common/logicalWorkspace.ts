/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { equals } from '../../../../base/common/objects.js';
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
 * Workspace-owned workbench shell state.
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
	readonly shellLayout: ILogicalWorkspaceShellLayout | undefined;
	readonly editorWorkingSet?: string;
}

export interface ILogicalWorkspaceActivationEvent {
	readonly actor: LogicalWorkspaceActivationActor;
	readonly sequence: number;
	readonly previousWorkspaceId: string;
	readonly workspaceId: string;
}

/**
 * Immutable state exposed to projections and state-slice observers.
 */
export interface ILogicalWorkspaceStateSnapshot {
	readonly activeWorkspaceId: string;
	readonly workspaces: readonly ILogicalWorkspace[];
}

export const enum LogicalWorkspaceStateChangeKind {
	None = 0,
	ActiveWorkspace = 1 << 0,
	Workspaces = 1 << 1,
}

export interface ILogicalWorkspaceStateChangeEvent {
	readonly changed: LogicalWorkspaceStateChangeKind;
	readonly previousState: ILogicalWorkspaceStateSnapshot;
	readonly state: ILogicalWorkspaceStateSnapshot;
}

export const ILogicalWorkspaceService = createDecorator<ILogicalWorkspaceService>('logicalWorkspaceService');

/**
 * Owns the logical workspace registry, terminal ownership and projected workbench snapshots.
 * The global Chat / Agent Session catalog remains outside this service.
 */
export interface ILogicalWorkspaceService {
	readonly _serviceBrand: undefined;

	readonly onWillChangeActiveWorkspace: Event<ILogicalWorkspaceActivationEvent>;
	readonly onDidChangeActiveWorkspace: Event<ILogicalWorkspaceActivationEvent>;
	readonly onDidChangeWorkspaces: Event<void>;
	readonly onDidChangeState: Event<ILogicalWorkspaceStateChangeEvent>;

	readonly state: ILogicalWorkspaceStateSnapshot;
	readonly workspaces: readonly ILogicalWorkspace[];
	readonly activeWorkspace: ILogicalWorkspace;
	readonly activationSequence: number;
	readonly whenReady: Promise<void>;

	createWorkspace(name: string): ILogicalWorkspace;
	activateWorkspace(workspaceId: string, actor: LogicalWorkspaceActivationActor): void;
	setShellLayout(workspaceId: string, layout: ILogicalWorkspaceShellLayout): void;
	setEditorWorkingSet(workspaceId: string, editorWorkingSet: string): void;

	bindTerminal(workspaceId: string, logicalTerminalId: string): void;
	unbindTerminal(logicalTerminalId: string): void;
	workspaceContainsTerminal(workspaceId: string, logicalTerminalId: string): boolean;
}

/**
 * Creates an event for a semantic slice of Logical Workspace state. Consumers select the complete
 * state they depend on once; unrelated mutations are suppressed by structural equality.
 */
export function onDidChangeLogicalWorkspaceStateSlice<T>(
	service: ILogicalWorkspaceService,
	selector: (state: ILogicalWorkspaceStateSnapshot) => T,
	isEqual: (current: T, next: T) => boolean = equals,
): Event<T> {
	return (listener, thisArgs, disposables) => {
		let current = selector(service.state);
		return service.onDidChangeState(event => {
			const next = selector(event.state);
			if (!isEqual(current, next)) {
				current = next;
				listener.call(thisArgs, next);
			}
		}, undefined, disposables);
	};
}
