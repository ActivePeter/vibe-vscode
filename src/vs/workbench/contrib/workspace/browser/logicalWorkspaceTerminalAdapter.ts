/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILogicalWorkspaceService } from '../../../services/logicalWorkspace/common/logicalWorkspace.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';

/**
 * Projects logical workspace membership onto the terminal service's foreground/background split.
 * The registry remains the only ownership authority; this adapter stores no parallel terminal set.
 */
export class LogicalWorkspaceTerminalAdapter extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.logicalWorkspaceTerminalAdapter';

	private reconcileRequested = false;
	private reconcileRunning = false;

	constructor(
		@ILogicalWorkspaceService private readonly logicalWorkspaceService: ILogicalWorkspaceService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.logicalWorkspaceService.onDidChangeActiveWorkspace(() => this.requestReconcile()));
		this._register(this.terminalService.onDidChangeInstances(() => this.requestReconcile()));
		this._register(this.terminalService.onDidDisposeInstance(instance => this.handleDisposedTerminal(instance)));
		this.terminalService.whenConnected.then(() => this.requestReconcile()).catch(error => this.logService.error('Logical workspace terminal reconciliation could not await terminal connection', error));
		this.requestReconcile();
	}

	private handleDisposedTerminal(instance: ITerminalInstance): void {
		const logicalTerminalId = instance.shellLaunchConfig.logicalTerminalId;
		if (!logicalTerminalId || instance.exitReason === TerminalExitReason.Shutdown) {
			return;
		}
		this.logicalWorkspaceService.unbindTerminal(logicalTerminalId);
	}

	private requestReconcile(): void {
		this.reconcileRequested = true;
		if (!this.reconcileRunning) {
			void this.reconcileLoop();
		}
	}

	private async reconcileLoop(): Promise<void> {
		this.reconcileRunning = true;
		try {
			while (this.reconcileRequested) {
				this.reconcileRequested = false;
				const workspaceId = this.logicalWorkspaceService.activeWorkspace.id;
				const sequence = this.logicalWorkspaceService.activationSequence;
				await this.synchronizeTerminals(workspaceId, sequence);
			}
		} catch (error) {
			this.logService.error('Logical workspace terminal reconciliation failed', error);
		} finally {
			this.reconcileRunning = false;
			if (this.reconcileRequested) {
				this.requestReconcile();
			}
		}
	}

	private async synchronizeTerminals(workspaceId: string, sequence: number): Promise<void> {
		for (const instance of [...this.terminalService.foregroundInstances]) {
			if (!this.isCurrentIntent(workspaceId, sequence)) {
				return;
			}
			const logicalTerminalId = instance.shellLaunchConfig.logicalTerminalId;
			if (logicalTerminalId && !this.logicalWorkspaceService.workspaceContainsTerminal(workspaceId, logicalTerminalId)) {
				this.terminalService.moveToBackground(instance);
			}
		}

		const foregroundInstances = new Set(this.terminalService.foregroundInstances);
		for (const instance of [...this.terminalService.instances]) {
			if (!this.isCurrentIntent(workspaceId, sequence)) {
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

	private isCurrentIntent(workspaceId: string, sequence: number): boolean {
		return this.logicalWorkspaceService.activeWorkspace.id === workspaceId && this.logicalWorkspaceService.activationSequence === sequence;
	}
}
