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
import { createLogicalWorkspaceSharedState, ILogicalWorkspace, ILogicalWorkspaceActivationEvent, ILogicalWorkspaceService, ILogicalWorkspaceSharedState, ILogicalWorkspaceShellLayout, ILogicalWorkspaceStateChangeEvent, ILogicalWorkspaceStateSnapshot, ILogicalWorkspaceViewMutation, LogicalWorkspaceActivationActor, LogicalWorkspaceMutationType, LogicalWorkspaceStateChangeKind, parseLogicalWorkspaceSharedState } from '../common/logicalWorkspace.js';

const LEGACY_LOGICAL_WORKSPACE_STORAGE_KEY = 'workbench.logicalWorkspace.state.v1';
const LEGACY_PROJECT_CONTEXT_STORAGE_KEY = 'workbench.projectContext.logicalWorkspaces.v2';
// Compatibility-only key from builds that predate the vibe-vscode identity. New state must never be written here.
const LEGACY_LOGICAL_WORKSPACE_CONFIGURATION_KEY = 'dever.logicalWorkspaceState';
const LEGACY_LOGICAL_WORKSPACE_CONFIGURATION_MIGRATION_KEY = 'workbench.logicalWorkspace.configurationMigration.v1';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibe-vscode',
	properties: {
		[LEGACY_LOGICAL_WORKSPACE_CONFIGURATION_KEY]: {
			type: 'object',
			scope: ConfigurationScope.WINDOW,
			included: false,
			additionalProperties: true,
		},
	},
});

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
	private _isReady = false;
	private acceptSharedStateAfterInitialization = false;
	get isReady(): boolean { return this._isReady; }
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
		this._register(stateStore.onDidChangeSharedState(() => {
			if (!this._isReady) {
				this.acceptSharedStateAfterInitialization = true;
				return;
			}
			this.acceptSharedState();
		}));
		this.whenReady = this.initializeAuthoritativeState(loaded, waitForCompleteWorkspace);
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

	async createWorkspace(name: string): Promise<ILogicalWorkspace> {
		const normalizedName = name.trim();
		if (!normalizedName) {
			throw new Error('Logical workspace name must not be empty');
		}
		await this.whenReady;
		if (this._store.isDisposed) {
			throw new Error('Logical workspace service was disposed');
		}

		const workspace: ILogicalWorkspace = {
			id: generateUuid(),
			name: normalizedName,
			terminalIds: [],
			shellLayout: undefined,
		};
		await this.stateStore.createWorkspace(workspace);
		return this.getWorkspace(workspace.id);
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
		this.setState({ ...this._state, activeWorkspaceId: workspaceId });
		this._onDidChangeActiveWorkspace.fire(event);
	}

	setShellLayout(workspaceId: string, layout: ILogicalWorkspaceShellLayout): void {
		const workspace = this.getWorkspace(workspaceId);
		if (equals(workspace.shellLayout, layout)) {
			return;
		}

		this.commitWorkspaces(this._state.workspaces.map(workspace => workspace.id === workspaceId
			? { ...workspace, shellLayout: layout }
			: workspace), { type: LogicalWorkspaceMutationType.SetShellLayout, workspaceId, shellLayout: layout });
	}

	setEditorWorkingSet(workspaceId: string, editorWorkingSet: string): void {
		const workspace = this.getWorkspace(workspaceId);
		if (workspace.editorWorkingSet === editorWorkingSet) {
			return;
		}

		this.commitWorkspaces(this._state.workspaces.map(workspace => workspace.id === workspaceId
			? { ...workspace, editorWorkingSet }
			: workspace), { type: LogicalWorkspaceMutationType.SetEditorWorkingSet, workspaceId, editorWorkingSet });
	}

	private commitWorkspaces(workspaces: readonly ILogicalWorkspace[], mutation: ILogicalWorkspaceViewMutation): void {
		this.setState({ ...this._state, workspaces });
		this.stateStore.applyMutation(mutation);
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
					shouldMarkConfigurationMigrated: true,
				};
			}
			return {
				state: this.withActiveWorkspace(migrated, legacyV1?.activeWorkspaceId),
				shouldMarkConfigurationMigrated: true,
			};
		}
		if (sharedState) {
			return {
				state: this.withActiveWorkspace(sharedState, legacyV1?.activeWorkspaceId),
				shouldMarkConfigurationMigrated: false,
			};
		}

		if (legacyV1) {
			const migrated = this.createSharedState(legacyV1.workspaces);
			return { state: this.withActiveWorkspace(migrated, legacyV1.activeWorkspaceId), shouldMarkConfigurationMigrated: false };
		}

		const legacy = this.parseLegacyState(this.storageService.get(LEGACY_PROJECT_CONTEXT_STORAGE_KEY, StorageScope.WORKSPACE));
		if (legacy) {
			const migrated = this.createSharedState(legacy.workspaces.map(workspace => ({ ...workspace, terminalIds: [], shellLayout: undefined })));
			return { state: this.withActiveWorkspace(migrated, legacy.activeWorkspaceId), shouldMarkConfigurationMigrated: false };
		}

		const vscodeWorkspace = this.workspaceContextService.getWorkspace();
		const workspace: ILogicalWorkspace = {
			id: generateUuid(),
			name: vscodeWorkspace.name ?? vscodeWorkspace.folders[0]?.name ?? localize('logicalWorkspaceInitialName', "Workspace"),
			terminalIds: [],
			shellLayout: undefined,
		};
		const initial = this.createSharedState([workspace]);
		return { state: this.withActiveWorkspace(initial), shouldMarkConfigurationMigrated: false };
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

	private async initializeAuthoritativeState(initial: ILoadedLogicalWorkspaceState, waitForCompleteWorkspace: boolean): Promise<void> {
		let candidate = initial;
		if (waitForCompleteWorkspace) {
			await this.workspaceContextService.getCompleteWorkspace();
			if (this._store.isDisposed) {
				return;
			}
			const configurationState = this.isConfigurationMigrated() ? undefined : this.readConfigurationState();
			const sharedState = this.parseSharedState(this.stateStore.readSharedState());
			candidate = configurationState || sharedState ? this.loadState(configurationState) : initial;
		}

		const initializedState = await this.stateStore.initializeSharedState(this.createSharedState(candidate.state.workspaces));
		if (this._store.isDisposed) {
			return;
		}
		// A reconnect or reentrant store event can publish a newer authoritative snapshot after the
		// initialize result was captured. Validate the page-local selection against the latest store
		// truth before writing it back, never against that now-obsolete result.
		const authoritativeState = this.parseSharedState(this.stateStore.readSharedState()) ?? initializedState;
		this.acceptSharedStateAfterInitialization = false;
		// Keep the candidate selection only as an intent. The authoritative catalog below decides
		// whether that identity is real, so a generated provisional ID is ignored while a valid
		// legacy/page-local selection survives initialization.
		const preferredActiveWorkspaceId = candidate.state.activeWorkspaceId;
		this.applyLoadedState({
			state: this.withActiveWorkspace(authoritativeState, undefined, preferredActiveWorkspaceId),
			shouldMarkConfigurationMigrated: candidate.shouldMarkConfigurationMigrated,
		});
		this._isReady = true;
		if (this.acceptSharedStateAfterInitialization) {
			this.acceptSharedStateAfterInitialization = false;
			this.acceptSharedState();
		}
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
		this.setState(loaded.state);
		if (loaded.shouldMarkConfigurationMigrated) {
			this.storageService.store(LEGACY_LOGICAL_WORKSPACE_CONFIGURATION_MIGRATION_KEY, true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
		if (workspacesChanged) {
			this._onDidChangeWorkspaces.fire();
		}
		if (activationEvent) {
			this._onDidChangeActiveWorkspace.fire(activationEvent);
		}
	}

	private withActiveWorkspace(sharedState: ILogicalWorkspaceSharedState, legacyActiveWorkspaceId?: string, preferredActiveWorkspaceId?: string): ILogicalWorkspaceState {
		const storedActiveWorkspaceId = this.stateStore.readActiveWorkspaceId(this.physicalWorkspaceId);
		const activeWorkspaceId = [preferredActiveWorkspaceId, storedActiveWorkspaceId, legacyActiveWorkspaceId]
			.find(candidate => candidate && sharedState.workspaces.some(workspace => workspace.id === candidate))
			?? sharedState.workspaces[0].id;
		return { ...sharedState, activeWorkspaceId };
	}

	private createSharedState(workspaces: readonly ILogicalWorkspace[]): ILogicalWorkspaceSharedState {
		return createLogicalWorkspaceSharedState(workspaces);
	}

	private acceptSharedState(): void {
		const rawSharedState = this.stateStore.readSharedState();
		const incoming = this.parseSharedState(rawSharedState);
		if (!incoming) {
			return;
		}
		if (equals(this._state.workspaces, incoming.workspaces)) {
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
		// The remote backend orders semantic mutations. The active selection remains page-local and
		// is preserved unless the authoritative catalog no longer contains that Workspace.
		if (activationEvent) {
			this.stateStore.writeActiveWorkspaceId(this.physicalWorkspaceId, activeWorkspaceId);
			this._activationSequence = activationEvent.sequence;
		}
		this.setState({ ...incoming, activeWorkspaceId });
		this._onDidChangeWorkspaces.fire();

		if (activationEvent) {
			this._onDidChangeActiveWorkspace.fire(activationEvent);
		}
	}

	private parseSharedState(raw: unknown): ILogicalWorkspaceSharedState | undefined {
		return parseLogicalWorkspaceSharedState(raw);
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
			const sharedState = parseLogicalWorkspaceSharedState({ schemaVersion: 2, workspaces: candidate.workspaces });
			if (candidate.schemaVersion !== 1 || typeof candidate.activeWorkspaceId !== 'string' || !sharedState || !sharedState.workspaces.some(workspace => workspace.id === candidate.activeWorkspaceId)) {
				return undefined;
			}
			return {
				schemaVersion: 1,
				activeWorkspaceId: candidate.activeWorkspaceId,
				workspaces: sharedState.workspaces,
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

	private setState(state: ILogicalWorkspaceState): void {
		const previousState = this._state;
		this._state = state;

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

}

registerSingleton(ILogicalWorkspaceService, LogicalWorkspaceService, InstantiationType.Delayed);
