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
	/**
	 * Compatibility-only ownership metadata from builds that predate terminal-owned Logical
	 * Workspace identity. New terminal ownership must not be written here.
	 */
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
}

/**
 * Mutations accepted by the Logical Workspace authority. Replaceable view-state writes are sent
 * once and reconciled with a read after an unknown outcome. UUID-based creation is additive and
 * may be retried until the new catalog identity is confirmed.
 */
export type ILogicalWorkspaceMutation =
	| { readonly type: LogicalWorkspaceMutationType.CreateWorkspace; readonly workspace: ILogicalWorkspace }
	| { readonly type: LogicalWorkspaceMutationType.SetShellLayout; readonly workspaceId: string; readonly shellLayout: ILogicalWorkspaceShellLayout }
	| { readonly type: LogicalWorkspaceMutationType.SetEditorWorkingSet; readonly workspaceId: string; readonly editorWorkingSet: string };

export type ILogicalWorkspaceViewMutation = Exclude<ILogicalWorkspaceMutation, { readonly type: LogicalWorkspaceMutationType.CreateWorkspace }>;

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
 * Readiness boundary for the initial Logical Workspace editor working-set projection. Workbench
 * editor startup awaits this service before it opens later startup inputs.
 */
export const ILogicalWorkspaceEditorProjectionService = createDecorator<ILogicalWorkspaceEditorProjectionService>('logicalWorkspaceEditorProjectionService');

export interface ILogicalWorkspaceEditorProjectionService {
	readonly _serviceBrand: undefined;
	readonly whenReady: Promise<void>;
}

/** Orders Terminal foreground/background projection before destructive editor working-set apply. */
export const ILogicalWorkspaceTerminalProjectionService = createDecorator<ILogicalWorkspaceTerminalProjectionService>('logicalWorkspaceTerminalProjectionService');

export interface ILogicalWorkspaceTerminalProjectionService {
	readonly _serviceBrand: undefined;
	readonly whenReady: Promise<void>;
	requestReconcile(): Promise<void>;
}

/**
 * Exposes the current page's projection of the remote Logical Workspace registry and workbench
 * snapshots. Terminal process identity and ownership remain in the terminal layer. The global
 * Chat / Agent Session catalog remains outside.
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
	/** Whether the authoritative catalog has been applied. Prefer `whenReady` when waiting is possible. */
	readonly isReady: boolean;
	readonly whenReady: Promise<void>;

	createWorkspace(name: string): Promise<ILogicalWorkspace>;
	activateWorkspace(workspaceId: string, actor: LogicalWorkspaceActivationActor): void;
	setShellLayout(workspaceId: string, layout: ILogicalWorkspaceShellLayout): void;
	setEditorWorkingSet(workspaceId: string, editorWorkingSet: string): void;
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
