/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ILogicalWorkspaceProjection, ILogicalWorkspaceProjectionContext, LogicalWorkspaceProjectionCoordinator } from '../../../services/logicalWorkspace/browser/logicalWorkspaceProjection.js';
import { ILogicalWorkspaceService, ILogicalWorkspaceStateSnapshot, ILogicalWorkspaceTerminalProjectionService } from '../../../services/logicalWorkspace/common/logicalWorkspace.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';

/**
 * Projects logical workspace membership onto the terminal service's foreground/background split.
 * Terminal process metadata is the ownership authority. Legacy Workspace terminal IDs are read
 * only as a migration fallback for processes created by older builds.
 */
export class LogicalWorkspaceTerminalAdapter extends Disposable implements ILogicalWorkspaceTerminalProjectionService, ILogicalWorkspaceProjection {

	static readonly ID = 'workbench.contrib.logicalWorkspaceTerminalAdapter';
	declare readonly _serviceBrand: undefined;
	readonly id = LogicalWorkspaceTerminalAdapter.ID;
	readonly whenReady: Promise<void>;

	private readonly projectionCoordinator: LogicalWorkspaceProjectionCoordinator;

	constructor(
		@ILogicalWorkspaceService private readonly logicalWorkspaceService: ILogicalWorkspaceService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IStorageService storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.projectionCoordinator = this._register(new LogicalWorkspaceProjectionCoordinator(logicalWorkspaceService, this, storageService, logService));
		this.whenReady = this.projectionCoordinator.whenReady;
		this._register(this.terminalService.onDidChangeInstances(() => this.projectionCoordinator.requestReconcileFromEvent()));
		this.terminalService.whenConnected.then(() => this.projectionCoordinator.requestReconcile()).catch(error => this.logService.error('Logical workspace terminal reconciliation could not await terminal connection', error));
	}

	requestReconcile(): Promise<void> {
		return this.projectionCoordinator.requestReconcile();
	}

	prepareEditorTerminalsForWorkingSet(workspaceId: string, activationSequence: number): void {
		for (const instance of [...this.terminalService.foregroundInstances]) {
			if (!this.isCurrent(workspaceId, activationSequence)) {
				return;
			}
			if (instance.target === TerminalLocation.Editor && this.getLogicalWorkspaceId(instance) === workspaceId) {
				this.terminalService.moveToBackground(instance);
			}
		}
	}

	async restoreUnclaimedEditorTerminals(workspaceId: string, activationSequence: number): Promise<boolean> {
		let restored = false;
		const foregroundInstances = new Set(this.terminalService.foregroundInstances);
		for (const instance of [...this.terminalService.instances]) {
			if (!this.isCurrent(workspaceId, activationSequence)) {
				return false;
			}
			if (foregroundInstances.has(instance) || instance.target !== TerminalLocation.Editor || instance.shellLaunchConfig.hideFromUser) {
				continue;
			}
			if (this.getLogicalWorkspaceId(instance) === workspaceId) {
				await this.terminalService.showBackgroundTerminal(instance, true);
				if (!this.isCurrent(workspaceId, activationSequence)) {
					return false;
				}
				restored = true;
			}
		}

		return restored;
	}

	stateSlice(state: ILogicalWorkspaceStateSnapshot): unknown {
		return {
			activeWorkspaceId: state.activeWorkspaceId,
			legacyTerminalOwners: state.workspaces.map(workspace => ({ id: workspace.id, terminalIds: workspace.terminalIds })),
		};
	}

	restore(context: ILogicalWorkspaceProjectionContext): Promise<void> {
		return this.synchronizeTerminals(context);
	}

	private async synchronizeTerminals(context: ILogicalWorkspaceProjectionContext): Promise<void> {
		const workspaceId = context.workspace.id;
		for (const instance of [...this.terminalService.foregroundInstances]) {
			if (!context.isCurrent()) {
				return;
			}
			const logicalWorkspaceId = this.getLogicalWorkspaceId(instance);
			if (logicalWorkspaceId && logicalWorkspaceId !== workspaceId) {
				this.terminalService.moveToBackground(instance);
			}
		}

		const foregroundInstances = new Set(this.terminalService.foregroundInstances);
		for (const instance of [...this.terminalService.instances]) {
			if (!context.isCurrent()) {
				return;
			}
			if (foregroundInstances.has(instance)) {
				continue;
			}
			// Editor Terminal placement belongs first to the serialized editor working set. Its
			// serializer adopts retained instances; the editor adapter finalizes only those left
			// unclaimed after that apply, so this preparation phase must not attach them early.
			if (instance.target === TerminalLocation.Editor) {
				continue;
			}
			if (this.getLogicalWorkspaceId(instance) === workspaceId) {
				await this.terminalService.showBackgroundTerminal(instance, true);
				if (!context.isCurrent()) {
					return;
				}
			}
		}
	}

	private getLogicalWorkspaceId(instance: ITerminalInstance): string | undefined {
		if (instance.shellLaunchConfig.logicalWorkspaceId) {
			return instance.shellLaunchConfig.logicalWorkspaceId;
		}
		const logicalTerminalId = instance.shellLaunchConfig.logicalTerminalId;
		return logicalTerminalId
			? this.logicalWorkspaceService.workspaces.find(workspace => workspace.terminalIds.includes(logicalTerminalId))?.id
			: undefined;
	}

	private isCurrent(workspaceId: string, activationSequence: number): boolean {
		return this.logicalWorkspaceService.activeWorkspace.id === workspaceId
			&& this.logicalWorkspaceService.activationSequence === activationSequence;
	}
}

registerSingleton(ILogicalWorkspaceTerminalProjectionService, LogicalWorkspaceTerminalAdapter, InstantiationType.Delayed);
