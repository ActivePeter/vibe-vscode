/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { equals } from '../../../../base/common/objects.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogicalWorkspace, ILogicalWorkspaceActivationEvent, ILogicalWorkspaceService, ILogicalWorkspaceShellLayout, ILogicalWorkspaceShellPartLayout, LogicalWorkspaceActivationActor } from '../common/logicalWorkspace.js';

const LOGICAL_WORKSPACE_SCHEMA_VERSION = 1;
const LOGICAL_WORKSPACE_STORAGE_KEY = 'workbench.logicalWorkspace.state.v1';
const LEGACY_PROJECT_CONTEXT_STORAGE_KEY = 'workbench.projectContext.logicalWorkspaces.v2';

interface ILogicalWorkspaceState {
	readonly schemaVersion: typeof LOGICAL_WORKSPACE_SCHEMA_VERSION;
	readonly activeWorkspaceId: string;
	readonly workspaces: readonly ILogicalWorkspace[];
}

interface ILegacyLogicalWorkspaceState {
	readonly activeWorkspaceId: string;
	readonly workspaces: readonly Pick<ILogicalWorkspace, 'id' | 'name'>[];
}

export class LogicalWorkspaceService extends Disposable implements ILogicalWorkspaceService {

	declare readonly _serviceBrand: undefined;

	private readonly _onWillChangeActiveWorkspace = this._register(new Emitter<ILogicalWorkspaceActivationEvent>());
	readonly onWillChangeActiveWorkspace = this._onWillChangeActiveWorkspace.event;

	private readonly _onDidChangeActiveWorkspace = this._register(new Emitter<ILogicalWorkspaceActivationEvent>());
	readonly onDidChangeActiveWorkspace = this._onDidChangeActiveWorkspace.event;

	private readonly _onDidChangeWorkspaces = this._register(new Emitter<void>());
	readonly onDidChangeWorkspaces = this._onDidChangeWorkspaces.event;

	private state: ILogicalWorkspaceState;
	private _activationSequence = 0;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this.state = this.loadState();
	}

	get workspaces(): readonly ILogicalWorkspace[] {
		return this.state.workspaces;
	}

	get activeWorkspace(): ILogicalWorkspace {
		return this.getWorkspace(this.state.activeWorkspaceId);
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
			chatSessionResources: [],
			shellLayout: undefined,
		};
		this.state = {
			...this.state,
			workspaces: [...this.state.workspaces, workspace],
		};
		this.saveState();
		this._onDidChangeWorkspaces.fire();
		return workspace;
	}

	activateWorkspace(workspaceId: string, actor: LogicalWorkspaceActivationActor): void {
		this.getWorkspace(workspaceId);
		const previousWorkspaceId = this.state.activeWorkspaceId;
		if (previousWorkspaceId === workspaceId) {
			return;
		}

		const sequence = this._activationSequence + 1;
		const event = { actor, sequence, previousWorkspaceId, workspaceId };
		this._onWillChangeActiveWorkspace.fire(event);
		this.state = { ...this.state, activeWorkspaceId: workspaceId };
		this.saveState();
		this._activationSequence = sequence;
		this._onDidChangeActiveWorkspace.fire(event);
	}

	setShellLayout(workspaceId: string, layout: ILogicalWorkspaceShellLayout): void {
		const workspace = this.getWorkspace(workspaceId);
		if (equals(workspace.shellLayout, layout)) {
			return;
		}

		this.state = {
			...this.state,
			workspaces: this.state.workspaces.map(workspace => workspace.id === workspaceId
				? { ...workspace, shellLayout: layout }
				: workspace),
		};
		this.saveState();
	}

	bindTerminal(workspaceId: string, logicalTerminalId: string): void {
		this.bindResources(workspaceId, [logicalTerminalId], 'terminalIds');
	}

	unbindTerminal(logicalTerminalId: string): void {
		this.unbindResource(logicalTerminalId, 'terminalIds');
	}

	workspaceContainsTerminal(workspaceId: string, logicalTerminalId: string): boolean {
		return this.getWorkspace(workspaceId).terminalIds.includes(logicalTerminalId);
	}

	bindChatSession(workspaceId: string, sessionResource: URI): void {
		this.bindChatSessions(workspaceId, [sessionResource]);
	}

	bindChatSessions(workspaceId: string, sessionResources: readonly URI[]): void {
		this.bindResources(workspaceId, sessionResources.map(resource => resource.toString()), 'chatSessionResources');
	}

	unbindChatSession(sessionResource: URI): void {
		this.unbindResource(sessionResource.toString(), 'chatSessionResources');
	}

	workspaceContainsChatSession(workspaceId: string, sessionResource: URI): boolean {
		return this.getWorkspace(workspaceId).chatSessionResources.includes(sessionResource.toString());
	}

	private bindResources(workspaceId: string, resourceIds: readonly string[], key: 'terminalIds' | 'chatSessionResources'): void {
		this.getWorkspace(workspaceId);
		const ownedResourceIds = new Set(this.state.workspaces.flatMap(workspace => workspace[key]));
		const resourceIdsToBind = [...new Set(resourceIds)].filter(resourceId => !ownedResourceIds.has(resourceId));
		if (resourceIdsToBind.length === 0) {
			return;
		}

		this.state = {
			...this.state,
			workspaces: this.state.workspaces.map(workspace => workspace.id === workspaceId
				? { ...workspace, [key]: [...workspace[key], ...resourceIdsToBind] }
				: workspace),
		};
		this.saveState();
	}

	private unbindResource(resourceId: string, key: 'terminalIds' | 'chatSessionResources'): void {
		if (!this.state.workspaces.some(workspace => workspace[key].includes(resourceId))) {
			return;
		}

		this.state = {
			...this.state,
			workspaces: this.state.workspaces.map(workspace => workspace[key].includes(resourceId)
				? { ...workspace, [key]: workspace[key].filter(candidate => candidate !== resourceId) }
				: workspace),
		};
		this.saveState();
	}

	private getWorkspace(workspaceId: string): ILogicalWorkspace {
		const workspace = this.state.workspaces.find(candidate => candidate.id === workspaceId);
		if (!workspace) {
			throw new Error(`Unknown logical workspace: ${workspaceId}`);
		}
		return workspace;
	}

	private loadState(): ILogicalWorkspaceState {
		const stored = this.parseState(this.storageService.get(LOGICAL_WORKSPACE_STORAGE_KEY, StorageScope.WORKSPACE));
		if (stored) {
			return stored;
		}
		const legacy = this.parseLegacyState(this.storageService.get(LEGACY_PROJECT_CONTEXT_STORAGE_KEY, StorageScope.WORKSPACE));
		if (legacy) {
			// Preserve the user's registry, but deliberately discard the prototype's ambiguous owner maps.
			const migratedState: ILogicalWorkspaceState = {
				schemaVersion: LOGICAL_WORKSPACE_SCHEMA_VERSION,
				activeWorkspaceId: legacy.activeWorkspaceId,
				workspaces: legacy.workspaces.map(workspace => ({ ...workspace, terminalIds: [], chatSessionResources: [], shellLayout: undefined })),
			};
			this.storageService.store(LOGICAL_WORKSPACE_STORAGE_KEY, JSON.stringify(migratedState), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			return migratedState;
		}

		const vscodeWorkspace = this.workspaceContextService.getWorkspace();
		const workspace: ILogicalWorkspace = {
			id: generateUuid(),
			name: vscodeWorkspace.name ?? vscodeWorkspace.folders[0]?.name ?? localize('logicalWorkspaceInitialName', "Workspace"),
			terminalIds: [],
			chatSessionResources: [],
			shellLayout: undefined,
		};
		const initialState: ILogicalWorkspaceState = {
			schemaVersion: LOGICAL_WORKSPACE_SCHEMA_VERSION,
			activeWorkspaceId: workspace.id,
			workspaces: [workspace],
		};
		this.storageService.store(LOGICAL_WORKSPACE_STORAGE_KEY, JSON.stringify(initialState), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		return initialState;
	}

	private parseLegacyState(raw: string | undefined): ILegacyLogicalWorkspaceState | undefined {
		if (!raw) {
			return undefined;
		}

		try {
			const parsed = JSON.parse(raw) as Partial<ILegacyLogicalWorkspaceState>;
			if (!Array.isArray(parsed.workspaces) || parsed.workspaces.length === 0 || typeof parsed.activeWorkspaceId !== 'string') {
				return undefined;
			}
			const workspaceIds = new Set<string>();
			for (const workspace of parsed.workspaces) {
				if (typeof workspace.id !== 'string' || !workspace.id || workspaceIds.has(workspace.id) || typeof workspace.name !== 'string' || !workspace.name.trim()) {
					return undefined;
				}
				workspaceIds.add(workspace.id);
			}
			if (!workspaceIds.has(parsed.activeWorkspaceId)) {
				return undefined;
			}
			return { activeWorkspaceId: parsed.activeWorkspaceId, workspaces: parsed.workspaces };
		} catch {
			return undefined;
		}
	}

	private parseState(raw: string | undefined): ILogicalWorkspaceState | undefined {
		if (!raw) {
			return undefined;
		}

		try {
			const parsed = JSON.parse(raw) as Partial<ILogicalWorkspaceState>;
			if (parsed.schemaVersion !== LOGICAL_WORKSPACE_SCHEMA_VERSION || !Array.isArray(parsed.workspaces) || parsed.workspaces.length === 0 || typeof parsed.activeWorkspaceId !== 'string') {
				return undefined;
			}

			const workspaceIds = new Set<string>();
			const terminalIds = new Set<string>();
			const chatSessionResources = new Set<string>();
			const addUniqueValues = (values: readonly string[], seen: Set<string>): boolean => {
				for (const value of values) {
					if (typeof value !== 'string' || !value || seen.has(value)) {
						return false;
					}
					seen.add(value);
				}
				return true;
			};
			for (const workspace of parsed.workspaces) {
				if (
					typeof workspace.id !== 'string' || !workspace.id || workspaceIds.has(workspace.id) ||
					typeof workspace.name !== 'string' || !workspace.name.trim() ||
					!Array.isArray(workspace.terminalIds) || !addUniqueValues(workspace.terminalIds, terminalIds) ||
					!Array.isArray(workspace.chatSessionResources) || !addUniqueValues(workspace.chatSessionResources, chatSessionResources) ||
					!this.isShellLayout(workspace.shellLayout)
				) {
					return undefined;
				}
				workspaceIds.add(workspace.id);
			}
			if (!workspaceIds.has(parsed.activeWorkspaceId)) {
				return undefined;
			}

			return {
				schemaVersion: LOGICAL_WORKSPACE_SCHEMA_VERSION,
				activeWorkspaceId: parsed.activeWorkspaceId,
				workspaces: parsed.workspaces,
			};
		} catch {
			return undefined;
		}
	}

	private isShellLayout(layout: ILogicalWorkspaceShellLayout | undefined): boolean {
		return layout === undefined || (
			this.isShellPartLayout(layout.primarySideBar) &&
			this.isShellPartLayout(layout.panel) &&
			this.isShellPartLayout(layout.auxiliaryBar)
		);
	}

	private isShellPartLayout(part: ILogicalWorkspaceShellPartLayout | undefined): boolean {
		return !!part &&
			typeof part.visible === 'boolean' &&
			Number.isFinite(part.width) && part.width >= 0 &&
			Number.isFinite(part.height) && part.height >= 0 &&
			typeof part.activeCompositeId === 'string';
	}

	private saveState(): void {
		this.storageService.store(LOGICAL_WORKSPACE_STORAGE_KEY, JSON.stringify(this.state), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}

registerSingleton(ILogicalWorkspaceService, LogicalWorkspaceService, InstantiationType.Delayed);
