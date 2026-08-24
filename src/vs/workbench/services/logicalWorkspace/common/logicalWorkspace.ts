/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { equals } from '../../../../base/common/objects.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const PICK_LOGICAL_WORKSPACE_COMMAND_ID = 'workbench.action.pickLogicalWorkspace';
export const LOGICAL_WORKSPACE_SHARED_SCHEMA_VERSION = 2;

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

export interface ILogicalWorkspaceSharedState {
	readonly schemaVersion: typeof LOGICAL_WORKSPACE_SHARED_SCHEMA_VERSION;
	readonly workspaces: readonly ILogicalWorkspace[];
}

export const enum LogicalWorkspaceMutationType {
	CreateWorkspace = 'createWorkspace',
	SetShellLayout = 'setShellLayout',
	SetEditorWorkingSet = 'setEditorWorkingSet',
	BindTerminal = 'bindTerminal',
	UnbindTerminal = 'unbindTerminal',
}

/**
 * Semantic mutations accepted by the authoritative Logical Workspace store. Mutations are
 * deliberately idempotent so a client can retry after losing a remote response.
 */
export type ILogicalWorkspaceMutation =
	| { readonly type: LogicalWorkspaceMutationType.CreateWorkspace; readonly workspace: ILogicalWorkspace }
	| { readonly type: LogicalWorkspaceMutationType.SetShellLayout; readonly workspaceId: string; readonly shellLayout: ILogicalWorkspaceShellLayout }
	| { readonly type: LogicalWorkspaceMutationType.SetEditorWorkingSet; readonly workspaceId: string; readonly editorWorkingSet: string }
	| { readonly type: LogicalWorkspaceMutationType.BindTerminal; readonly workspaceId: string; readonly logicalTerminalId: string }
	| { readonly type: LogicalWorkspaceMutationType.UnbindTerminal; readonly logicalTerminalId: string };

export function createLogicalWorkspaceSharedState(workspaces: readonly ILogicalWorkspace[]): ILogicalWorkspaceSharedState {
	return {
		schemaVersion: LOGICAL_WORKSPACE_SHARED_SCHEMA_VERSION,
		workspaces: workspaces.map(workspace => ({
			id: workspace.id,
			name: workspace.name,
			terminalIds: [...workspace.terminalIds],
			shellLayout: workspace.shellLayout,
			...(workspace.editorWorkingSet !== undefined ? { editorWorkingSet: workspace.editorWorkingSet } : undefined),
		})),
	};
}

export function parseLogicalWorkspaceSharedState(raw: unknown): ILogicalWorkspaceSharedState | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const candidate = raw as Record<string, unknown>;
	if (candidate.schemaVersion !== LOGICAL_WORKSPACE_SHARED_SCHEMA_VERSION || !Array.isArray(candidate.workspaces) || candidate.workspaces.length === 0 || !areValidLogicalWorkspaces(candidate.workspaces)) {
		return undefined;
	}
	return createLogicalWorkspaceSharedState(candidate.workspaces);
}

export function parseLogicalWorkspaceMutation(raw: unknown): ILogicalWorkspaceMutation | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const candidate = raw as Record<string, unknown>;
	switch (candidate.type) {
		case LogicalWorkspaceMutationType.CreateWorkspace: {
			const state = parseLogicalWorkspaceSharedState({ schemaVersion: LOGICAL_WORKSPACE_SHARED_SCHEMA_VERSION, workspaces: [candidate.workspace] });
			return state ? { type: candidate.type, workspace: state.workspaces[0] } : undefined;
		}
		case LogicalWorkspaceMutationType.SetShellLayout:
			return typeof candidate.workspaceId === 'string' && candidate.workspaceId && candidate.shellLayout !== undefined && isLogicalWorkspaceShellLayout(candidate.shellLayout)
				? { type: candidate.type, workspaceId: candidate.workspaceId, shellLayout: candidate.shellLayout }
				: undefined;
		case LogicalWorkspaceMutationType.SetEditorWorkingSet:
			return typeof candidate.workspaceId === 'string' && candidate.workspaceId && typeof candidate.editorWorkingSet === 'string' && candidate.editorWorkingSet
				? { type: candidate.type, workspaceId: candidate.workspaceId, editorWorkingSet: candidate.editorWorkingSet }
				: undefined;
		case LogicalWorkspaceMutationType.BindTerminal:
			return typeof candidate.workspaceId === 'string' && candidate.workspaceId && typeof candidate.logicalTerminalId === 'string' && candidate.logicalTerminalId
				? { type: candidate.type, workspaceId: candidate.workspaceId, logicalTerminalId: candidate.logicalTerminalId }
				: undefined;
		case LogicalWorkspaceMutationType.UnbindTerminal:
			return typeof candidate.logicalTerminalId === 'string' && candidate.logicalTerminalId
				? { type: candidate.type, logicalTerminalId: candidate.logicalTerminalId }
				: undefined;
	}
	return undefined;
}

export function applyLogicalWorkspaceMutation(state: ILogicalWorkspaceSharedState, mutation: ILogicalWorkspaceMutation): ILogicalWorkspaceSharedState {
	switch (mutation.type) {
		case LogicalWorkspaceMutationType.CreateWorkspace:
			return state.workspaces.some(workspace => workspace.id === mutation.workspace.id)
				? state
				: createLogicalWorkspaceSharedState([...state.workspaces, mutation.workspace]);
		case LogicalWorkspaceMutationType.SetShellLayout:
			return updateLogicalWorkspace(state, mutation.workspaceId, workspace => equals(workspace.shellLayout, mutation.shellLayout)
				? workspace
				: { ...workspace, shellLayout: mutation.shellLayout });
		case LogicalWorkspaceMutationType.SetEditorWorkingSet:
			return updateLogicalWorkspace(state, mutation.workspaceId, workspace => workspace.editorWorkingSet === mutation.editorWorkingSet
				? workspace
				: { ...workspace, editorWorkingSet: mutation.editorWorkingSet });
		case LogicalWorkspaceMutationType.BindTerminal: {
			if (state.workspaces.some(workspace => workspace.terminalIds.includes(mutation.logicalTerminalId))) {
				return state;
			}
			return updateLogicalWorkspace(state, mutation.workspaceId, workspace => ({ ...workspace, terminalIds: [...workspace.terminalIds, mutation.logicalTerminalId] }));
		}
		case LogicalWorkspaceMutationType.UnbindTerminal: {
			const owner = state.workspaces.find(workspace => workspace.terminalIds.includes(mutation.logicalTerminalId));
			return owner
				? updateLogicalWorkspace(state, owner.id, workspace => ({ ...workspace, terminalIds: workspace.terminalIds.filter(id => id !== mutation.logicalTerminalId) }))
				: state;
		}
	}
}

function updateLogicalWorkspace(state: ILogicalWorkspaceSharedState, workspaceId: string, update: (workspace: ILogicalWorkspace) => ILogicalWorkspace): ILogicalWorkspaceSharedState {
	const index = state.workspaces.findIndex(workspace => workspace.id === workspaceId);
	if (index === -1) {
		return state;
	}
	const current = state.workspaces[index];
	const updated = update(current);
	if (updated === current) {
		return state;
	}
	const workspaces = [...state.workspaces];
	workspaces[index] = updated;
	return createLogicalWorkspaceSharedState(workspaces);
}

function areValidLogicalWorkspaces(workspaces: readonly unknown[]): workspaces is readonly ILogicalWorkspace[] {
	const workspaceIds = new Set<string>();
	const terminalIds = new Set<string>();
	for (const rawWorkspace of workspaces) {
		if (!rawWorkspace || typeof rawWorkspace !== 'object') {
			return false;
		}
		const workspace = rawWorkspace as Record<string, unknown>;
		if (
			typeof workspace.id !== 'string' || !workspace.id || workspaceIds.has(workspace.id) ||
			typeof workspace.name !== 'string' || !workspace.name.trim() ||
			!Array.isArray(workspace.terminalIds) || !addUniqueLogicalTerminalIds(workspace.terminalIds, terminalIds) ||
			!isLogicalWorkspaceShellLayout(workspace.shellLayout) ||
			(workspace.editorWorkingSet !== undefined && (typeof workspace.editorWorkingSet !== 'string' || !workspace.editorWorkingSet))
		) {
			return false;
		}
		workspaceIds.add(workspace.id);
	}
	return true;
}

function addUniqueLogicalTerminalIds(values: readonly unknown[], terminalIds: Set<string>): boolean {
	for (const value of values) {
		if (typeof value !== 'string' || !value || terminalIds.has(value)) {
			return false;
		}
		terminalIds.add(value);
	}
	return true;
}

function isLogicalWorkspaceShellLayout(layout: unknown): layout is ILogicalWorkspaceShellLayout | undefined {
	if (layout === undefined) {
		return true;
	}
	if (!layout || typeof layout !== 'object') {
		return false;
	}
	const candidate = layout as Record<string, unknown>;
	return isLogicalWorkspaceShellPartLayout(candidate.primarySideBar)
		&& isLogicalWorkspaceShellPartLayout(candidate.panel)
		&& isLogicalWorkspaceShellPartLayout(candidate.auxiliaryBar);
}

function isLogicalWorkspaceShellPartLayout(part: unknown): part is ILogicalWorkspaceShellPartLayout {
	if (!part || typeof part !== 'object') {
		return false;
	}
	const candidate = part as Record<string, unknown>;
	return typeof candidate.visible === 'boolean'
		&& typeof candidate.width === 'number' && Number.isFinite(candidate.width) && candidate.width >= 0
		&& typeof candidate.height === 'number' && Number.isFinite(candidate.height) && candidate.height >= 0
		&& typeof candidate.activeCompositeId === 'string';
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
 * Exposes the current page's projection of the remote Logical Workspace registry, terminal
 * ownership and workbench snapshots. The global Chat / Agent Session catalog remains outside.
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
