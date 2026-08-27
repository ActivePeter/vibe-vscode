/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ILogicalWorkspace, ILogicalWorkspaceService, LogicalWorkspaceActivationActor, PICK_LOGICAL_WORKSPACE_COMMAND_ID } from '../../../services/logicalWorkspace/common/logicalWorkspace.js';

interface ILogicalWorkspacePick extends IQuickPickItem {
	workspace?: ILogicalWorkspace;
	isNewWorkspaceAction?: boolean;
}

export class PickLogicalWorkspaceAction extends Action2 {
	constructor() {
		super({
			id: PICK_LOGICAL_WORKSPACE_COMMAND_ID,
			title: localize2('pickLogicalWorkspace', 'Select Workbench Workspace...'),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const logicalWorkspaceService = accessor.get(ILogicalWorkspaceService);
		const quickInputService = accessor.get(IQuickInputService);
		await logicalWorkspaceService.whenReady;
		const activeWorkspace = logicalWorkspaceService.activeWorkspace;
		const picks: ILogicalWorkspacePick[] = logicalWorkspaceService.workspaces.map(workspace => ({
			label: workspace.name,
			description: workspace.id === activeWorkspace.id
				? localize('logicalWorkspaceActive', "Active workbench context")
				: localize('logicalWorkspaceInactive', "Restores this context's layout, terminals, and editors"),
			workspace,
		}));
		picks.push({
			label: localize('logicalWorkspaceNew', "New Workspace..."),
			description: localize('logicalWorkspaceNewDescription', "Creates an independent layout, terminal, and editor context"),
			alwaysShow: true,
			isNewWorkspaceAction: true,
		});

		const pick = await quickInputService.pick(picks, {
			activeItem: picks.find(pick => pick.workspace?.id === activeWorkspace.id),
			placeHolder: localize('logicalWorkspacePickPlaceholder', "Select the workbench context to restore"),
			matchOnDescription: true,
		});
		if (!pick) {
			return;
		}

		if (pick.isNewWorkspaceAction) {
			const name = await quickInputService.input({
				prompt: localize('logicalWorkspaceNamePrompt', "Workspace name"),
				placeHolder: localize('logicalWorkspaceNamePlaceholder', "For example: review, frontend, investigation"),
				validateInput: async value => value.trim() ? undefined : localize('logicalWorkspaceNameRequired', "Workspace name is required"),
			});
			if (!name?.trim()) {
				return;
			}

			const workspace = await logicalWorkspaceService.createWorkspace(name);
			logicalWorkspaceService.activateWorkspace(workspace.id, LogicalWorkspaceActivationActor.Picker);
			return;
		}

		if (pick.workspace) {
			logicalWorkspaceService.activateWorkspace(pick.workspace.id, LogicalWorkspaceActivationActor.Picker);
		}
	}
}

registerAction2(PickLogicalWorkspaceAction);
