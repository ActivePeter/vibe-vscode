/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILogicalWorkspaceService, PICK_LOGICAL_WORKSPACE_COMMAND_ID } from '../../../services/logicalWorkspace/common/logicalWorkspace.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IProjectContextService, PICK_PROJECT_CONTEXT_COMMAND_ID } from './projectContext.js';

export class WorkspaceProjectStatusbar extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.workspaceProjectStatusbar';

	private readonly workspaceEntry: IStatusbarEntryAccessor;
	private readonly projectEntry: IStatusbarEntryAccessor;

	constructor(
		@ILogicalWorkspaceService private readonly logicalWorkspaceService: ILogicalWorkspaceService,
		@IProjectContextService private readonly projectContextService: IProjectContextService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
	) {
		super();

		this.workspaceEntry = this._register(this.statusbarService.addEntry(this.getWorkspaceEntry(), 'status.workspaceContext', StatusbarAlignment.LEFT, Number.MAX_SAFE_INTEGER));
		this.projectEntry = this._register(this.statusbarService.addEntry(this.getProjectEntry(), 'status.projectContext', StatusbarAlignment.LEFT, Number.MAX_SAFE_INTEGER - 1));
		this._register(this.logicalWorkspaceService.onDidChangeActiveWorkspace(() => this.workspaceEntry.update(this.getWorkspaceEntry())));
		this._register(this.logicalWorkspaceService.onDidChangeWorkspaces(() => this.workspaceEntry.update(this.getWorkspaceEntry())));
		this._register(this.projectContextService.onDidChangeProjectContext(() => this.projectEntry.update(this.getProjectEntry())));
	}

	private getWorkspaceEntry(): IStatusbarEntry {
		const label = this.logicalWorkspaceService.activeWorkspace.name;
		return {
			name: localize('workspaceContextStatusName', "Workspace Context"),
			text: `$(window) ${localize('workspaceContextStatusLabel', "Workspace: {0}", label)}`,
			ariaLabel: localize('workspaceContextStatusAria', "Workspace: {0}", label),
			tooltip: localize('workspaceContextStatusTooltip', "The persistent workbench container. Select it to switch its layout, terminals, and editors without reloading this workbench."),
			command: PICK_LOGICAL_WORKSPACE_COMMAND_ID,
		};
	}

	private getProjectEntry(): IStatusbarEntry {
		const folder = this.projectContextService.selectedFolder;
		const label = folder?.name ?? localize('projectContextNoProject', "Add Project");
		return {
			name: localize('projectContextStatusName', "Project Context"),
			text: `$(folder-library) ${localize('projectContextStatusLabel', "Project: {0}", label)}`,
			ariaLabel: localize('projectContextStatusAria', "Project context: {0}", label),
			tooltip: folder
				? localize('projectContextStatusTooltip', "Project Context: {0}\nSelect to switch the Explorer and Git focus without reloading this workbench.", folder.uri.fsPath)
				: localize('projectContextStatusNoProjectTooltip', "Add a project directory to this workbench"),
			command: PICK_PROJECT_CONTEXT_COMMAND_ID,
		};
	}
}
