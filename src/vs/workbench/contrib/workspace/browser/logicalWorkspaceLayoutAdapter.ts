/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { ILogicalWorkspaceProjection, ILogicalWorkspaceProjectionContext, LogicalWorkspaceProjectionCoordinator } from '../../../services/logicalWorkspace/browser/logicalWorkspaceProjection.js';
import { ILogicalWorkspaceService, ILogicalWorkspaceShellLayout, ILogicalWorkspaceShellPartLayout, ILogicalWorkspaceStateSnapshot } from '../../../services/logicalWorkspace/common/logicalWorkspace.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';

type LogicalWorkspaceShellPart = Parts.SIDEBAR_PART | Parts.PANEL_PART | Parts.AUXILIARYBAR_PART;

interface ILogicalWorkspaceShellPartBinding {
	readonly part: LogicalWorkspaceShellPart;
	readonly location: ViewContainerLocation;
	readonly layout: ILogicalWorkspaceShellPartLayout;
}

/**
 * Saves the projected workbench shell before a logical workspace switch and restores the target
 * shell afterwards. Persistence is submitted through the logical workspace service to the remote
 * authority; this adapter keeps no parallel layout state.
 */
export class LogicalWorkspaceLayoutAdapter extends Disposable implements IWorkbenchContribution, ILogicalWorkspaceProjection {

	static readonly ID = 'workbench.contrib.logicalWorkspaceLayoutAdapter';
	readonly id = LogicalWorkspaceLayoutAdapter.ID;

	constructor(
		@ILogicalWorkspaceService private readonly logicalWorkspaceService: ILogicalWorkspaceService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IPaneCompositePartService private readonly paneCompositePartService: IPaneCompositePartService,
		@IStorageService storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(new LogicalWorkspaceProjectionCoordinator(logicalWorkspaceService, this, storageService, logService));
	}

	stateSlice(state: ILogicalWorkspaceStateSnapshot): unknown {
		return {
			activeWorkspaceId: state.activeWorkspaceId,
			shellLayout: state.workspaces.find(workspace => workspace.id === state.activeWorkspaceId)?.shellLayout,
		};
	}

	capture(workspaceId: string): void {
		this.logicalWorkspaceService.setShellLayout(workspaceId, this.captureShellLayout());
	}

	async restore(context: ILogicalWorkspaceProjectionContext): Promise<void> {
		if (context.workspace.shellLayout) {
			await this.restoreShellLayout(context, context.workspace.shellLayout);
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

	private async restoreShellLayout(context: ILogicalWorkspaceProjectionContext, layout: ILogicalWorkspaceShellLayout): Promise<void> {
		const bindings = this.getShellPartBindings(layout);
		for (const binding of bindings) {
			if (!context.isCurrent()) {
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

		if (!context.isCurrent()) {
			return;
		}

		// Materialize every part that must become visible or whose geometry must change. Geometry is
		// always applied before final visibility, so hidden state cannot inherit another Workspace's size.
		for (const binding of bindings) {
			const currentSize = this.layoutService.getSize(binding.part);
			const needsResize = currentSize.width !== binding.layout.width || currentSize.height !== binding.layout.height;
			if ((binding.layout.visible || needsResize) && !this.layoutService.isVisible(binding.part)) {
				this.layoutService.setPartHidden(false, binding.part);
			}
		}

		for (const binding of bindings) {
			if (!context.isCurrent()) {
				return;
			}
			if (!this.layoutService.isVisible(binding.part)) {
				continue;
			}
			const currentSize = this.layoutService.getSize(binding.part);
			if (currentSize.width !== binding.layout.width || currentSize.height !== binding.layout.height) {
				this.layoutService.resizePart(binding.part, binding.layout.width - currentSize.width, binding.layout.height - currentSize.height);
			}
		}

		for (const binding of bindings) {
			if (!context.isCurrent()) {
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
}
