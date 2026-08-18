/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isEqual, isEqualOrParent } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { IExplorerService } from '../../files/browser/files.js';
import { VIEWLET_ID } from '../../files/common/files.js';
import { ISCMRepository, ISCMService, ISCMViewService } from '../../scm/common/scm.js';

const PROJECT_CONTEXT_STORAGE_KEY = 'workbench.projectContext.selectedFolderUri';
export const PICK_PROJECT_CONTEXT_COMMAND_ID = 'workbench.action.pickProjectContext';

interface IProjectContextPick extends IQuickPickItem {
	folder?: IWorkspaceFolder;
	isAddProjectAction?: boolean;
}

export const IProjectContextService = createDecorator<IProjectContextService>('projectContextService');

/**
 * Selects the project that Explorer and Source Control should focus within the current VS Code
 * workbench. It never changes or reloads the VS Code workspace itself.
 */
export interface IProjectContextService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeProjectContext: Event<void>;
	readonly workspace: IWorkspace;
	readonly selectedFolder: IWorkspaceFolder | undefined;
	pickProjectContext(): Promise<void>;
}

export class ProjectContextService extends Disposable implements IProjectContextService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeProjectContext = this._register(new Emitter<void>());
	readonly onDidChangeProjectContext = this._onDidChangeProjectContext.event;

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IStorageService private readonly storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IPaneCompositePartService private readonly paneCompositePartService: IPaneCompositePartService,
		@IExplorerService private readonly explorerService: IExplorerService,
		@ISCMService private readonly scmService: ISCMService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
	) {
		super();

		const updateProjectContext = () => {
			void this.explorerService.setActiveRoot(this.selectedFolder?.uri);
			this._onDidChangeProjectContext.fire();
		};
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(updateProjectContext));
		this._register(this.workspaceContextService.onDidChangeWorkspaceName(updateProjectContext));
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(updateProjectContext));
		void this.explorerService.setActiveRoot(this.selectedFolder?.uri);
	}

	get workspace(): IWorkspace {
		return this.workspaceContextService.getWorkspace();
	}

	get selectedFolder(): IWorkspaceFolder | undefined {
		const selectedUri = this.storageService.get(PROJECT_CONTEXT_STORAGE_KEY, StorageScope.WORKSPACE);
		const folders = this.workspace.folders;
		return folders.find(folder => folder.uri.toString() === selectedUri) ?? folders[0];
	}

	async pickProjectContext(): Promise<void> {
		const folders = this.workspace.folders;
		const selectedFolder = this.selectedFolder;
		const picks: IProjectContextPick[] = folders.map(folder => ({
			label: folder.name,
			description: folder.uri.fsPath,
			picked: folder.uri.toString() === selectedFolder?.uri.toString(),
			folder,
		}));
		picks.push({
			label: localize('projectContextAddProject', "Add Project Directory..."),
			description: localize('projectContextAddProjectDescription', "Keeps terminals and editors in this workbench"),
			alwaysShow: true,
			isAddProjectAction: true,
		});

		const pick = await this.quickInputService.pick(picks, {
			placeHolder: localize('projectContextPickPlaceholder', "Select the project context to inspect"),
			matchOnDescription: true,
		});
		if (!pick) {
			return;
		}
		if (pick.isAddProjectAction) {
			await this.commandService.executeCommand('workbench.action.addRootFolder');
			return;
		}
		if (!pick.folder) {
			return;
		}

		this.storageService.store(PROJECT_CONTEXT_STORAGE_KEY, pick.folder.uri.toString(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		await this.explorerService.setActiveRoot(pick.folder.uri);
		this._onDidChangeProjectContext.fire();
		await this.revealProject(pick.folder);
	}

	private async revealProject(folder: IWorkspaceFolder): Promise<void> {
		await this.paneCompositePartService.openPaneComposite(VIEWLET_ID, ViewContainerLocation.Sidebar, true);
		await this.explorerService.select(folder.uri, 'force');

		const repository = Array.from(this.scmService.repositories).find(candidate => this.belongsToProject(candidate, folder));
		if (repository) {
			this.scmViewService.focus(repository);
		}
	}

	private belongsToProject(repository: ISCMRepository, folder: IWorkspaceFolder): boolean {
		const rootUri = repository.provider.rootUri;
		return !!rootUri && (isEqual(rootUri, folder.uri) || isEqualOrParent(folder.uri, rootUri));
	}
}

registerSingleton(IProjectContextService, ProjectContextService, InstantiationType.Delayed);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PICK_PROJECT_CONTEXT_COMMAND_ID,
			title: localize2('pickProjectContext', 'Select Project Context...'),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IProjectContextService).pickProjectContext();
	}
});
