/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { ILogicalWorkspaceService, ILogicalWorkspaceShellLayout, ILogicalWorkspaceShellPartLayout } from '../../../services/logicalWorkspace/common/logicalWorkspace.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';

type LogicalWorkspaceShellPart = Parts.SIDEBAR_PART | Parts.PANEL_PART | Parts.AUXILIARYBAR_PART;

interface ILogicalWorkspaceShellPartBinding {
	readonly part: LogicalWorkspaceShellPart;
	readonly location: ViewContainerLocation;
	readonly layout: ILogicalWorkspaceShellPartLayout;
}

/**
 * Saves the projected workbench shell before a logical workspace switch and restores the target
 * shell afterwards. The logical workspace service remains the only persistence authority.
 */
export class LogicalWorkspaceLayoutAdapter extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.logicalWorkspaceLayoutAdapter';

	private reconcileRequested = false;
	private reconcileRunning = false;
	private projectedWorkspaceId: string;

	constructor(
		@ILogicalWorkspaceService private readonly logicalWorkspaceService: ILogicalWorkspaceService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IPaneCompositePartService private readonly paneCompositePartService: IPaneCompositePartService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.projectedWorkspaceId = this.logicalWorkspaceService.activeWorkspace.id;

		this._register(this.logicalWorkspaceService.onWillChangeActiveWorkspace(event => {
			if (this.projectedWorkspaceId === event.previousWorkspaceId) {
				this.logicalWorkspaceService.setShellLayout(event.previousWorkspaceId, this.captureShellLayout());
			}
		}));
		this._register(this.logicalWorkspaceService.onDidChangeActiveWorkspace(() => this.requestReconcile()));
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
				const workspace = this.logicalWorkspaceService.activeWorkspace;
				const sequence = this.logicalWorkspaceService.activationSequence;
				if (workspace.shellLayout) {
					await this.restoreShellLayout(workspace.id, sequence, workspace.shellLayout);
				}
				if (this.isCurrentIntent(workspace.id, sequence)) {
					this.projectedWorkspaceId = workspace.id;
				}
			}
		} catch (error) {
			this.logService.error('Logical workspace layout reconciliation failed', error);
		} finally {
			this.reconcileRunning = false;
			if (this.reconcileRequested) {
				this.requestReconcile();
			}
		}
	}

	private captureShellLayout(): ILogicalWorkspaceShellLayout {
		return {
			primarySideBar: this.captureShellPart(Parts.SIDEBAR_PART, ViewContainerLocation.Sidebar),
			panel: this.captureShellPart(Parts.PANEL_PART, ViewContainerLocation.Panel),
			auxiliaryBar: this.captureShellPart(Parts.AUXILIARYBAR_PART, ViewContainerLocation.AuxiliaryBar),
		};
	}

	private captureShellPart(part: LogicalWorkspaceShellPart, location: ViewContainerLocation): ILogicalWorkspaceShellPartLayout {
		const size = this.layoutService.getSize(part);
		return {
			visible: this.layoutService.isVisible(part),
			width: size.width,
			height: size.height,
			activeCompositeId: this.paneCompositePartService.getActivePaneComposite(location)?.getId()
				?? this.paneCompositePartService.getLastActivePaneCompositeId(location),
		};
	}

	private async restoreShellLayout(workspaceId: string, sequence: number, layout: ILogicalWorkspaceShellLayout): Promise<void> {
		const bindings = this.getShellPartBindings(layout);
		for (const binding of bindings) {
			if (!this.isCurrentIntent(workspaceId, sequence)) {
				return;
			}
			if (!binding.layout.activeCompositeId) {
				continue;
			}
			const activeCompositeId = this.paneCompositePartService.getActivePaneComposite(binding.location)?.getId();
			const lastActiveCompositeId = this.paneCompositePartService.getLastActivePaneCompositeId(binding.location);
			const shouldOpen = binding.layout.visible
				? activeCompositeId !== binding.layout.activeCompositeId
				: lastActiveCompositeId !== binding.layout.activeCompositeId;
			if (shouldOpen) {
				const composite = await this.paneCompositePartService.openPaneComposite(binding.layout.activeCompositeId, binding.location, false);
				if (!composite) {
					this.logService.warn(`Logical workspace layout could not restore pane composite: ${binding.layout.activeCompositeId}`);
				}
			}
		}

		if (!this.isCurrentIntent(workspaceId, sequence)) {
			return;
		}
		for (const binding of bindings) {
			if (binding.layout.visible && !this.layoutService.isVisible(binding.part)) {
				this.layoutService.setPartHidden(false, binding.part);
			}
		}

		for (const binding of bindings) {
			if (!binding.layout.visible || !this.layoutService.isVisible(binding.part)) {
				continue;
			}
			const currentSize = this.layoutService.getSize(binding.part);
			if (currentSize.width !== binding.layout.width || currentSize.height !== binding.layout.height) {
				this.layoutService.resizePart(binding.part, binding.layout.width - currentSize.width, binding.layout.height - currentSize.height);
			}
		}

		for (const binding of bindings) {
			if (!this.isCurrentIntent(workspaceId, sequence)) {
				return;
			}
			if (!binding.layout.visible && this.layoutService.isVisible(binding.part)) {
				this.layoutService.setPartHidden(true, binding.part);
			}
		}
	}

	private getShellPartBindings(layout: ILogicalWorkspaceShellLayout): readonly ILogicalWorkspaceShellPartBinding[] {
		return [
			{ part: Parts.SIDEBAR_PART, location: ViewContainerLocation.Sidebar, layout: layout.primarySideBar },
			{ part: Parts.PANEL_PART, location: ViewContainerLocation.Panel, layout: layout.panel },
			{ part: Parts.AUXILIARYBAR_PART, location: ViewContainerLocation.AuxiliaryBar, layout: layout.auxiliaryBar },
		];
	}

	private isCurrentIntent(workspaceId: string, sequence: number): boolean {
		return this.logicalWorkspaceService.activeWorkspace.id === workspaceId && this.logicalWorkspaceService.activationSequence === sequence;
	}
}
