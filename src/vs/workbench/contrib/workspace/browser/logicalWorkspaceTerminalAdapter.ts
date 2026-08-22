/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILogicalWorkspaceProjection, ILogicalWorkspaceProjectionContext, LogicalWorkspaceProjectionCoordinator } from '../../../services/logicalWorkspace/browser/logicalWorkspaceProjection.js';
import { ILogicalWorkspaceService, onDidChangeLogicalWorkspaceStateSlice } from '../../../services/logicalWorkspace/common/logicalWorkspace.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';

/**
 * Projects logical workspace membership onto the terminal service's foreground/background split.
 * The registry remains the only ownership authority; this adapter stores no parallel terminal set.
 */
export class LogicalWorkspaceTerminalAdapter extends Disposable implements IWorkbenchContribution, ILogicalWorkspaceProjection {

	static readonly ID = 'workbench.contrib.logicalWorkspaceTerminalAdapter';
	readonly id = LogicalWorkspaceTerminalAdapter.ID;

	private readonly projectionCoordinator: LogicalWorkspaceProjectionCoordinator;
	private projectionDepth = 0;
	private reconcileAfterProjection = false;

	constructor(
		@ILogicalWorkspaceService private readonly logicalWorkspaceService: ILogicalWorkspaceService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IStorageService storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.projectionCoordinator = this._register(new LogicalWorkspaceProjectionCoordinator(logicalWorkspaceService, this, storageService, logService));
		this._register(this.terminalService.onDidChangeInstances(() => this.requestReconcile()));
		this._register(onDidChangeLogicalWorkspaceStateSlice(
			this.logicalWorkspaceService,
			state => state.workspaces.map(workspace => ({ id: workspace.id, terminalIds: workspace.terminalIds })),
		)(() => this.requestReconcile()));
		this._register(this.terminalService.onDidDisposeInstance(instance => this.handleDisposedTerminal(instance)));
		this.terminalService.whenConnected.then(() => this.projectionCoordinator.requestReconcile()).catch(error => this.logService.error('Logical workspace terminal reconciliation could not await terminal connection', error));
	}

	private handleDisposedTerminal(instance: ITerminalInstance): void {
		const logicalTerminalId = instance.shellLaunchConfig.logicalTerminalId;
		if (!logicalTerminalId || instance.exitReason === TerminalExitReason.Shutdown) {
			return;
		}
		this.logicalWorkspaceService.unbindTerminal(logicalTerminalId);
	}

	restore(context: ILogicalWorkspaceProjectionContext): Promise<void> {
		return this.runProjectionTransaction(context);
	}

	private requestReconcile(): void {
		if (this.projectionDepth > 0) {
			this.reconcileAfterProjection = true;
			return;
		}
		void this.projectionCoordinator.requestReconcile();
	}

	private async runProjectionTransaction(context: ILogicalWorkspaceProjectionContext): Promise<void> {
		this.projectionDepth++;
		try {
			await this.synchronizeTerminals(context);
		} finally {
			this.projectionDepth--;
			if (this.projectionDepth === 0 && this.reconcileAfterProjection) {
				this.reconcileAfterProjection = false;
				void this.projectionCoordinator.requestReconcile();
			}
		}
	}

	private async synchronizeTerminals(context: ILogicalWorkspaceProjectionContext): Promise<void> {
		const workspaceId = context.workspace.id;
		for (const instance of [...this.terminalService.foregroundInstances]) {
			if (!context.isCurrent()) {
				return;
			}
			const logicalTerminalId = instance.shellLaunchConfig.logicalTerminalId;
			if (logicalTerminalId && !this.logicalWorkspaceService.workspaceContainsTerminal(workspaceId, logicalTerminalId)) {
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
			const logicalTerminalId = instance.shellLaunchConfig.logicalTerminalId;
			if (logicalTerminalId && this.logicalWorkspaceService.workspaceContainsTerminal(workspaceId, logicalTerminalId)) {
				await this.terminalService.showBackgroundTerminal(instance, true);
			}
		}
	}
}
