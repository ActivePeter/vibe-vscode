/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILogicalWorkspaceProjection, ILogicalWorkspaceProjectionContext, LogicalWorkspaceProjectionCoordinator } from '../../../services/logicalWorkspace/browser/logicalWorkspaceProjection.js';
import { ILogicalWorkspaceService } from '../../../services/logicalWorkspace/common/logicalWorkspace.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';

/**
 * Projects logical workspace membership onto the terminal service's foreground/background split.
 * Terminal process metadata is the ownership authority. Legacy Workspace terminal IDs are read
 * only as a migration fallback for processes created by older builds.
 */
export class LogicalWorkspaceTerminalAdapter extends Disposable implements IWorkbenchContribution, ILogicalWorkspaceProjection {

	static readonly ID = 'workbench.contrib.logicalWorkspaceTerminalAdapter';
	readonly id = LogicalWorkspaceTerminalAdapter.ID;

	private readonly projectionCoordinator: LogicalWorkspaceProjectionCoordinator;

	constructor(
		@ILogicalWorkspaceService private readonly logicalWorkspaceService: ILogicalWorkspaceService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IStorageService storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.projectionCoordinator = this._register(new LogicalWorkspaceProjectionCoordinator(logicalWorkspaceService, this, storageService, logService));
		this._register(this.terminalService.onDidChangeInstances(() => void this.projectionCoordinator.requestReconcile()));
		this.terminalService.whenConnected.then(() => this.projectionCoordinator.requestReconcile()).catch(error => this.logService.error('Logical workspace terminal reconciliation could not await terminal connection', error));
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
}
