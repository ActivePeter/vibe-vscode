/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { equals } from '../../../../base/common/objects.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { ILogicalWorkspaceStateStore } from './logicalWorkspaceStateStore.js';
import { ILogicalWorkspace, ILogicalWorkspaceActivationEvent, ILogicalWorkspaceService, ILogicalWorkspaceShellLayout, ILogicalWorkspaceShellPartLayout, ILogicalWorkspaceStateChangeEvent, ILogicalWorkspaceStateSnapshot, LogicalWorkspaceActivationActor, LogicalWorkspaceStateChangeKind } from '../common/logicalWorkspace.js';

const LOGICAL_WORKSPACE_SHARED_SCHEMA_VERSION = 2;
const LEGACY_LOGICAL_WORKSPACE_STORAGE_KEY = 'workbench.logicalWorkspace.state.v1';
const LEGACY_PROJECT_CONTEXT_STORAGE_KEY = 'workbench.projectContext.logicalWorkspaces.v2';
const LEGACY_LOGICAL_WORKSPACE_CONFIGURATION_KEY = 'dever.logicalWorkspaceState';
const LEGACY_LOGICAL_WORKSPACE_CONFIGURATION_MIGRATION_KEY = 'workbench.logicalWorkspace.configurationMigration.v1';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'dever',
	properties: {
		[LEGACY_LOGICAL_WORKSPACE_CONFIGURATION_KEY]: {
			type: 'object',
			scope: ConfigurationScope.WINDOW,
			included: false,
			additionalProperties: true,
		},
	},
});

interface ILogicalWorkspaceSharedState {
	readonly schemaVersion: typeof LOGICAL_WORKSPACE_SHARED_SCHEMA_VERSION;
	readonly workspaces: readonly ILogicalWorkspace[];
}

interface ILogicalWorkspaceState extends ILogicalWorkspaceSharedState {
	readonly activeWorkspaceId: string;
}

interface ILegacyLogicalWorkspaceState {
	readonly activeWorkspaceId: string;
	readonly workspaces: readonly Pick<ILogicalWorkspace, 'id' | 'name'>[];
}

interface ILegacyLogicalWorkspaceStateV1 {
	readonly schemaVersion: 1;
	readonly activeWorkspaceId: string;
	readonly workspaces: readonly ILogicalWorkspace[];
}

interface ILoadedLogicalWorkspaceState {
	readonly state: ILogicalWorkspaceState;
	readonly shouldWriteSharedState: boolean;
	readonly shouldMarkConfigurationMigrated: boolean;
}

export class LogicalWorkspaceService extends Disposable implements ILogicalWorkspaceService {

	declare readonly _serviceBrand: undefined;

	private readonly _onWillChangeActiveWorkspace = this._register(new Emitter<ILogicalWorkspaceActivationEvent>());
	readonly onWillChangeActiveWorkspace = this._onWillChangeActiveWorkspace.event;

	private readonly _onDidChangeActiveWorkspace = this._register(new Emitter<ILogicalWorkspaceActivationEvent>());
	readonly onDidChangeActiveWorkspace = this._onDidChangeActiveWorkspace.event;

	private readonly _onDidChangeWorkspaces = this._register(new Emitter<void>());
	readonly onDidChangeWorkspaces = this._onDidChangeWorkspaces.event;

	private readonly _onDidChangeState = this._register(new Emitter<ILogicalWorkspaceStateChangeEvent>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly physicalWorkspaceId: string;
	private _state: ILogicalWorkspaceState;
	private _activationSequence = 0;
	readonly whenReady: Promise<void>;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogicalWorkspaceStateStore private readonly stateStore: ILogicalWorkspaceStateStore,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.physicalWorkspaceId = workspaceContextService.getWorkspace().id;
		const configurationMigrated = this.isConfigurationMigrated();
		const configurationState = configurationMigrated ? undefined : this.readConfigurationState();
		const waitForCompleteWorkspace = !configurationMigrated && workspaceContextService.getWorkbenchState() === WorkbenchState.WORKSPACE;
		const loaded = this.loadState(configurationState);
		this._state = loaded.state;
		this.stateStore.writeActiveWorkspaceId(this.physicalWorkspaceId, this._state.activeWorkspaceId);
		this._register(stateStore.onDidChangeSharedState(() => this.acceptSharedState()));
		if (waitForCompleteWorkspace) {
			this.whenReady = this.initializeFromCompleteWorkspace(loaded);
		} else {
			this.persistLoadedState(loaded);
			this.whenReady = Promise.resolve();
		}
	}

	get state(): ILogicalWorkspaceStateSnapshot {
		return this._state;
	}

	get workspaces(): readonly ILogicalWorkspace[] {
		return this._state.workspaces;
	}

	get activeWorkspace(): ILogicalWorkspace {
		return this.getWorkspace(this._state.activeWorkspaceId);
	}

	get activationSequence(): number {
		return this._activationSequence;
	}

	createWorkspace(name: string): ILogicalWorkspace {
		const normalizedName = name.trim();
		if (!normalizedName) {
			throw new Error('Logical workspace name must not be empty');
		}

		const workspace: ILogicalWorkspace = {
			id: generateUuid(),
			name: normalizedName,
			terminalIds: [],
			shellLayout: undefined,
		};
		this.commitWorkspaces([...this._state.workspaces, workspace]);
		return workspace;
	}

	activateWorkspace(workspaceId: string, actor: LogicalWorkspaceActivationActor): void {
		this.getWorkspace(workspaceId);
		const previousWorkspaceId = this._state.activeWorkspaceId;
		if (previousWorkspaceId === workspaceId) {
			return;
		}

		const sequence = this._activationSequence + 1;
		const event = { actor, sequence, previousWorkspaceId, workspaceId };
		this._onWillChangeActiveWorkspace.fire(event);
		this.stateStore.writeActiveWorkspaceId(this.physicalWorkspaceId, workspaceId);
		this._activationSequence = sequence;
		this.setState({ ...this._state, activeWorkspaceId: workspaceId }, false);
		this._onDidChangeActiveWorkspace.fire(event);
	}

	setShellLayout(workspaceId: string, layout: ILogicalWorkspaceShellLayout): void {
		const workspace = this.getWorkspace(workspaceId);
		if (equals(workspace.shellLayout, layout)) {
			return;
		}

		this.commitWorkspaces(this._state.workspaces.map(workspace => workspace.id === workspaceId
			? { ...workspace, shellLayout: layout }
			: workspace));
	}

	setEditorWorkingSet(workspaceId: string, editorWorkingSet: string): void {
		const workspace = this.getWorkspace(workspaceId);
		if (workspace.editorWorkingSet === editorWorkingSet) {
			return;
		}

		this.commitWorkspaces(this._state.workspaces.map(workspace => workspace.id === workspaceId
			? { ...workspace, editorWorkingSet }
			: workspace));
	}

	bindTerminal(workspaceId: string, logicalTerminalId: string): void {
		this.getWorkspace(workspaceId);
		if (this._state.workspaces.some(workspace => workspace.terminalIds.includes(logicalTerminalId))) {
			return;
		}

		this.commitWorkspaces(this._state.workspaces.map(workspace => workspace.id === workspaceId
			? { ...workspace, terminalIds: [...workspace.terminalIds, logicalTerminalId] }
			: workspace));
	}

	unbindTerminal(logicalTerminalId: string): void {
		const owner = this._state.workspaces.find(workspace => workspace.terminalIds.includes(logicalTerminalId));
		if (!owner) {
			return;
		}

		this.commitWorkspaces(this._state.workspaces.map(workspace => workspace.id === owner.id
			? { ...workspace, terminalIds: workspace.terminalIds.filter(candidate => candidate !== logicalTerminalId) }
			: workspace));
	}

	workspaceContainsTerminal(workspaceId: string, logicalTerminalId: string): boolean {
		return this.getWorkspace(workspaceId).terminalIds.includes(logicalTerminalId);
	}

	private commitWorkspaces(workspaces: readonly ILogicalWorkspace[]): void {
		this.setState({ ...this._state, workspaces }, true);
		this._onDidChangeWorkspaces.fire();
	}

	private getWorkspace(workspaceId: string): ILogicalWorkspace {
		const workspace = this._state.workspaces.find(candidate => candidate.id === workspaceId);
		if (!workspace) {
			throw new Error(`Unknown logical workspace: ${workspaceId}`);
		}
		return workspace;
	}

	private loadState(configurationState: ILogicalWorkspaceSharedState | undefined): ILoadedLogicalWorkspaceState {
		const rawSharedState = this.stateStore.readSharedState();
		const sharedState = this.parseSharedState(rawSharedState);
		const sharedStateNeedsNormalization = this.containsObsoleteChatSessionOwnership(rawSharedState);
		const legacyV1 = this.parseLegacyStateV1(this.storageService.get(LEGACY_LOGICAL_WORKSPACE_STORAGE_KEY, StorageScope.WORKSPACE));
		if (configurationState) {
			const migrated = sharedState ? this.mergeSharedStates(configurationState, sharedState) : configurationState;
			const sharedStateOverlapsConfiguration = sharedState?.workspaces.some(workspace => configurationState.workspaces.some(candidate => candidate.id === workspace.id)) ?? false;
			if (!sharedState || !sharedStateOverlapsConfiguration) {
				const storedActiveWorkspaceId = this.stateStore.readActiveWorkspaceId(this.physicalWorkspaceId);
				const activeWorkspaceId = [storedActiveWorkspaceId, legacyV1?.activeWorkspaceId]
					.find(candidate => candidate && configurationState.workspaces.some(workspace => workspace.id === candidate))
					?? configurationState.workspaces[0].id;
				return {
					state: { ...migrated, activeWorkspaceId },
					shouldWriteSharedState: true,
					shouldMarkConfigurationMigrated: true,
				};
			}
			return {
				state: this.withActiveWorkspace(migrated, legacyV1?.activeWorkspaceId),
				shouldWriteSharedState: true,
				shouldMarkConfigurationMigrated: true,
			};
		}
		if (sharedState) {
			return {
				state: this.withActiveWorkspace(sharedState, legacyV1?.activeWorkspaceId),
				shouldWriteSharedState: sharedStateNeedsNormalization,
				shouldMarkConfigurationMigrated: false,
			};
		}

		if (legacyV1) {
			const migrated = this.createSharedState(legacyV1.workspaces);
			return { state: this.withActiveWorkspace(migrated, legacyV1.activeWorkspaceId), shouldWriteSharedState: true, shouldMarkConfigurationMigrated: false };
		}

		const legacy = this.parseLegacyState(this.storageService.get(LEGACY_PROJECT_CONTEXT_STORAGE_KEY, StorageScope.WORKSPACE));
		if (legacy) {
			const migrated = this.createSharedState(legacy.workspaces.map(workspace => ({ ...workspace, terminalIds: [], shellLayout: undefined })));
			return { state: this.withActiveWorkspace(migrated, legacy.activeWorkspaceId), shouldWriteSharedState: true, shouldMarkConfigurationMigrated: false };
		}

		const vscodeWorkspace = this.workspaceContextService.getWorkspace();
		const workspace: ILogicalWorkspace = {
			id: generateUuid(),
			name: vscodeWorkspace.name ?? vscodeWorkspace.folders[0]?.name ?? localize('logicalWorkspaceInitialName', "Workspace"),
			terminalIds: [],
			shellLayout: undefined,
		};
		const initial = this.createSharedState([workspace]);
		return { state: this.withActiveWorkspace(initial), shouldWriteSharedState: true, shouldMarkConfigurationMigrated: false };
	}

	private mergeSharedStates(configurationState: ILogicalWorkspaceSharedState, sharedState: ILogicalWorkspaceSharedState): ILogicalWorkspaceSharedState {
		const sharedWorkspaces = new Map(sharedState.workspaces.map(workspace => [workspace.id, workspace]));
		const configurationWorkspaceIds = new Set(configurationState.workspaces.map(workspace => workspace.id));
		return this.createSharedState([
			...configurationState.workspaces.map(workspace => {
				const sharedWorkspace = sharedWorkspaces.get(workspace.id);
				if (!sharedWorkspace) {
					return workspace;
				}
				return sharedWorkspace.editorWorkingSet === undefined && workspace.editorWorkingSet !== undefined
					? { ...sharedWorkspace, editorWorkingSet: workspace.editorWorkingSet }
					: sharedWorkspace;
			}),
			...sharedState.workspaces.filter(workspace => !configurationWorkspaceIds.has(workspace.id)),
		]);
	}

	private isConfigurationMigrated(): boolean {
		return this.storageService.getBoolean(LEGACY_LOGICAL_WORKSPACE_CONFIGURATION_MIGRATION_KEY, StorageScope.WORKSPACE, false);
	}

	private readConfigurationState(): ILogicalWorkspaceSharedState | undefined {
		const inspected = this.configurationService.inspect<unknown>(LEGACY_LOGICAL_WORKSPACE_CONFIGURATION_KEY);
		return this.parseSharedState(inspected.workspaceValue ?? inspected.value);
	}

	private async initializeFromCompleteWorkspace(initial: ILoadedLogicalWorkspaceState): Promise<void> {
		await this.workspaceContextService.getCompleteWorkspace();
		if (this._store.isDisposed) {
			return;
		}

		const configurationState = this.isConfigurationMigrated() ? undefined : this.readConfigurationState();
		const sharedState = this.parseSharedState(this.stateStore.readSharedState());
		const loaded = configurationState || sharedState ? this.loadState(configurationState) : initial;
		this.applyLoadedState(loaded);
	}

	private applyLoadedState(loaded: ILoadedLogicalWorkspaceState): void {
		const previousWorkspaceId = this._state.activeWorkspaceId;
		const workspacesChanged = !equals(this._state.workspaces, loaded.state.workspaces);
		let activationEvent: ILogicalWorkspaceActivationEvent | undefined;
		if (previousWorkspaceId !== loaded.state.activeWorkspaceId) {
			activationEvent = {
				actor: LogicalWorkspaceActivationActor.SharedState,
				sequence: this._activationSequence + 1,
				previousWorkspaceId,
				workspaceId: loaded.state.activeWorkspaceId,
			};
			this._onWillChangeActiveWorkspace.fire(activationEvent);
			this._activationSequence = activationEvent.sequence;
		}

		this.stateStore.writeActiveWorkspaceId(this.physicalWorkspaceId, loaded.state.activeWorkspaceId);
		this.setState(loaded.state, false);
		this.persistLoadedState(loaded);
		if (workspacesChanged) {
			this._onDidChangeWorkspaces.fire();
		}
		if (activationEvent) {
			this._onDidChangeActiveWorkspace.fire(activationEvent);
		}
	}

	private persistLoadedState(loaded: ILoadedLogicalWorkspaceState): void {
		if (loaded.shouldWriteSharedState) {
			this.saveSharedState();
		}
		if (loaded.shouldMarkConfigurationMigrated) {
			this.storageService.store(LEGACY_LOGICAL_WORKSPACE_CONFIGURATION_MIGRATION_KEY, true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
	}

	private withActiveWorkspace(sharedState: ILogicalWorkspaceSharedState, legacyActiveWorkspaceId?: string): ILogicalWorkspaceState {
		const storedActiveWorkspaceId = this.stateStore.readActiveWorkspaceId(this.physicalWorkspaceId);
		const activeWorkspaceId = [storedActiveWorkspaceId, legacyActiveWorkspaceId]
			.find(candidate => candidate && sharedState.workspaces.some(workspace => workspace.id === candidate))
			?? sharedState.workspaces[0].id;
		return { ...sharedState, activeWorkspaceId };
	}

	private createSharedState(workspaces: readonly ILogicalWorkspace[]): ILogicalWorkspaceSharedState {
		return {
			schemaVersion: LOGICAL_WORKSPACE_SHARED_SCHEMA_VERSION,
			workspaces: workspaces.map(workspace => ({
				id: workspace.id,
				name: workspace.name,
				terminalIds: workspace.terminalIds,
				shellLayout: workspace.shellLayout,
				...(workspace.editorWorkingSet !== undefined ? { editorWorkingSet: workspace.editorWorkingSet } : undefined),
			})),
		};
	}

	private acceptSharedState(): void {
		const rawSharedState = this.stateStore.readSharedState();
		const incoming = this.parseSharedState(rawSharedState);
		if (!incoming) {
			return;
		}
		if (equals(this._state.workspaces, incoming.workspaces)) {
			if (this.containsObsoleteChatSessionOwnership(rawSharedState)) {
				this.saveSharedState();
			}
			return;
		}

		const previousWorkspaceId = this._state.activeWorkspaceId;
		const activeWorkspaceId = incoming.workspaces.some(workspace => workspace.id === previousWorkspaceId)
			? previousWorkspaceId
			: incoming.workspaces[0].id;
		let activationEvent: ILogicalWorkspaceActivationEvent | undefined;
		if (activeWorkspaceId !== previousWorkspaceId) {
			const sequence = this._activationSequence + 1;
			activationEvent = { actor: LogicalWorkspaceActivationActor.SharedState, sequence, previousWorkspaceId, workspaceId: activeWorkspaceId };
			this._onWillChangeActiveWorkspace.fire(activationEvent);
		}
		// Shared snapshots deliberately use whole-document last-write-wins. The active selection is
		// page-local and is therefore preserved unless the winning snapshot removed that Workspace.
		if (activationEvent) {
			this.stateStore.writeActiveWorkspaceId(this.physicalWorkspaceId, activeWorkspaceId);
			this._activationSequence = activationEvent.sequence;
		}
		this.setState({ ...incoming, activeWorkspaceId }, false);
		this._onDidChangeWorkspaces.fire();
		if (this.containsObsoleteChatSessionOwnership(rawSharedState)) {
			this.saveSharedState();
		}

		if (activationEvent) {
			this._onDidChangeActiveWorkspace.fire(activationEvent);
		}
	}

	private parseSharedState(raw: unknown): ILogicalWorkspaceSharedState | undefined {
		if (!raw || typeof raw !== 'object') {
			return undefined;
		}
		const parsed = raw as Record<string, unknown>;
		if (parsed.schemaVersion !== LOGICAL_WORKSPACE_SHARED_SCHEMA_VERSION || !Array.isArray(parsed.workspaces) || parsed.workspaces.length === 0) {
			return undefined;
		}
		if (!this.areValidWorkspaces(parsed.workspaces)) {
			return undefined;
		}
		return this.createSharedState(parsed.workspaces);
	}

	private containsObsoleteChatSessionOwnership(raw: unknown): boolean {
		if (!raw || typeof raw !== 'object') {
			return false;
		}
		const workspaces = (raw as Record<string, unknown>).workspaces;
		return Array.isArray(workspaces) && workspaces.some(workspace =>
			!!workspace && typeof workspace === 'object' && 'chatSessionResources' in workspace
		);
	}

	private parseLegacyStateV1(raw: string | undefined): ILegacyLogicalWorkspaceStateV1 | undefined {
		if (!raw) {
			return undefined;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== 'object') {
				return undefined;
			}
			const candidate = parsed as Record<string, unknown>;
			if (candidate.schemaVersion !== 1 || typeof candidate.activeWorkspaceId !== 'string' || !Array.isArray(candidate.workspaces) || !this.areValidWorkspaces(candidate.workspaces) || !candidate.workspaces.some(workspace => workspace.id === candidate.activeWorkspaceId)) {
				return undefined;
			}
			return {
				schemaVersion: 1,
				activeWorkspaceId: candidate.activeWorkspaceId,
				workspaces: this.createSharedState(candidate.workspaces).workspaces,
			};
		} catch {
			return undefined;
		}
	}

	private parseLegacyState(raw: string | undefined): ILegacyLogicalWorkspaceState | undefined {
		if (!raw) {
			return undefined;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== 'object') {
				return undefined;
			}
			const candidate = parsed as Record<string, unknown>;
			if (!Array.isArray(candidate.workspaces) || candidate.workspaces.length === 0 || typeof candidate.activeWorkspaceId !== 'string') {
				return undefined;
			}
			const workspaceIds = new Set<string>();
			const workspaces: Pick<ILogicalWorkspace, 'id' | 'name'>[] = [];
			for (const rawWorkspace of candidate.workspaces) {
				if (!rawWorkspace || typeof rawWorkspace !== 'object') {
					return undefined;
				}
				const workspace = rawWorkspace as Record<string, unknown>;
				if (typeof workspace.id !== 'string' || !workspace.id || workspaceIds.has(workspace.id) || typeof workspace.name !== 'string' || !workspace.name.trim()) {
					return undefined;
				}
				workspaceIds.add(workspace.id);
				workspaces.push({ id: workspace.id, name: workspace.name });
			}
			if (!workspaceIds.has(candidate.activeWorkspaceId)) {
				return undefined;
			}
			return { activeWorkspaceId: candidate.activeWorkspaceId, workspaces };
		} catch {
			return undefined;
		}
	}

	private areValidWorkspaces(workspaces: readonly unknown[]): workspaces is readonly ILogicalWorkspace[] {
		const workspaceIds = new Set<string>();
		const terminalIds = new Set<string>();
		const addUniqueTerminalIds = (values: readonly string[]): boolean => {
			for (const value of values) {
				if (typeof value !== 'string' || !value || terminalIds.has(value)) {
					return false;
				}
				terminalIds.add(value);
			}
			return true;
		};
		for (const rawWorkspace of workspaces) {
			if (!rawWorkspace || typeof rawWorkspace !== 'object') {
				return false;
			}
			const workspace = rawWorkspace as Record<string, unknown>;
			if (
				typeof workspace.id !== 'string' || !workspace.id || workspaceIds.has(workspace.id) ||
				typeof workspace.name !== 'string' || !workspace.name.trim() ||
				!Array.isArray(workspace.terminalIds) || !addUniqueTerminalIds(workspace.terminalIds) ||
				!this.isShellLayout(workspace.shellLayout) ||
				(workspace.editorWorkingSet !== undefined && (typeof workspace.editorWorkingSet !== 'string' || !workspace.editorWorkingSet))
			) {
				return false;
			}
			workspaceIds.add(workspace.id);
		}
		return true;
	}

	private isShellLayout(layout: unknown): layout is ILogicalWorkspaceShellLayout | undefined {
		if (layout === undefined) {
			return true;
		}
		if (!layout || typeof layout !== 'object') {
			return false;
		}
		const candidate = layout as Record<string, unknown>;
		return this.isShellPartLayout(candidate.primarySideBar)
			&& this.isShellPartLayout(candidate.panel)
			&& this.isShellPartLayout(candidate.auxiliaryBar);
	}

	private isShellPartLayout(part: unknown): part is ILogicalWorkspaceShellPartLayout {
		if (!part || typeof part !== 'object') {
			return false;
		}
		const candidate = part as Record<string, unknown>;
		return typeof candidate.visible === 'boolean'
			&& typeof candidate.width === 'number' && Number.isFinite(candidate.width) && candidate.width >= 0
			&& typeof candidate.height === 'number' && Number.isFinite(candidate.height) && candidate.height >= 0
			&& typeof candidate.activeCompositeId === 'string';
	}

	private setState(state: ILogicalWorkspaceState, persistSharedState: boolean): void {
		const previousState = this._state;
		this._state = state;
		if (persistSharedState) {
			this.saveSharedState();
		}

		let changed = LogicalWorkspaceStateChangeKind.None;
		if (previousState.activeWorkspaceId !== state.activeWorkspaceId) {
			changed |= LogicalWorkspaceStateChangeKind.ActiveWorkspace;
		}
		if (!equals(previousState.workspaces, state.workspaces)) {
			changed |= LogicalWorkspaceStateChangeKind.Workspaces;
		}
		if (changed !== LogicalWorkspaceStateChangeKind.None) {
			this._onDidChangeState.fire({ changed, previousState, state });
		}
	}

	private saveSharedState(): void {
		this.stateStore.writeSharedState({
			schemaVersion: LOGICAL_WORKSPACE_SHARED_SCHEMA_VERSION,
			workspaces: this._state.workspaces,
		});
	}
}

registerSingleton(ILogicalWorkspaceService, LogicalWorkspaceService, InstantiationType.Delayed);
