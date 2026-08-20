/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isEqual, isEqualOrParent } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { AsyncProjectionCoordinator, IAsyncProjectionContext } from '../../../services/logicalWorkspace/browser/logicalWorkspaceProjection.js';
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

interface IProjectContextProjectionIntent {
	readonly folderUri: URI | undefined;
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
	private readonly projectionCoordinator: AsyncProjectionCoordinator<IProjectContextProjectionIntent>;
	private selectedFolderUri: URI | undefined;
	private pendingRevealFolderUri: URI | undefined;

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IStorageService private readonly storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IPaneCompositePartService private readonly paneCompositePartService: IPaneCompositePartService,
		@IExplorerService private readonly explorerService: IExplorerService,
		@ISCMService private readonly scmService: ISCMService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@ILogService logService: ILogService,
	) {
		super();
		this.selectedFolderUri = this.resolveStoredFolder()?.uri;
		this.projectionCoordinator = this._register(new AsyncProjectionCoordinator(
			'Project Context',
			context => this.applyProjectContext(context),
			logService,
		));

		const updateProjectContext = () => this.synchronizeAvailableFolders();
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(updateProjectContext));
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(updateProjectContext));
		this._register(this.workspaceContextService.onDidChangeWorkspaceName(() => this._onDidChangeProjectContext.fire()));
		this._register(this.scmService.onDidAddRepository(repository => {
			const folder = this.selectedFolder;
			if (folder && this.belongsToProject(repository, folder)) {
				void this.requestProjectContextProjection(folder);
			}
		}));
		this.synchronizeAvailableFolders();
	}

	get workspace(): IWorkspace {
		return this.workspaceContextService.getWorkspace();
	}

	get selectedFolder(): IWorkspaceFolder | undefined {
		return this.selectedFolderUri
			? this.workspace.folders.find(folder => isEqual(folder.uri, this.selectedFolderUri))
			: undefined;
	}

	async pickProjectContext(): Promise<void> {
		const folders = this.workspace.folders;
		const selectedFolder = this.selectedFolder;
		const picks: IProjectContextPick[] = folders.map(folder => ({
			label: folder.name,
			description: folder.uri.fsPath,
			folder,
		}));
		picks.push({
			label: localize('projectContextAddProject', "Add Project Directory..."),
			description: localize('projectContextAddProjectDescription', "Keeps terminals and editors in this workbench"),
			alwaysShow: true,
			isAddProjectAction: true,
		});

		const pick = await this.quickInputService.pick(picks, {
			activeItem: picks.find(pick => pick.folder && isEqual(pick.folder.uri, selectedFolder?.uri)),
			placeHolder: localize('projectContextPickPlaceholder', "Select the project context to inspect"),
			matchOnDescription: true,
		});
		if (!pick) {
			return;
		}
		if (pick.isAddProjectAction) {
			const existingFolders = new Set(this.workspace.folders.map(folder => folder.uri.toString()));
			await this.commandService.executeCommand('workbench.action.addRootFolder');
			const addedFolders = this.workspace.folders.filter(folder => !existingFolders.has(folder.uri.toString()));
			const addedFolder = addedFolders.at(-1);
			if (addedFolder) {
				await this.selectFolder(addedFolder, true);
			}
			return;
		}
		if (!pick.folder) {
			return;
		}

		await this.selectFolder(pick.folder, true);
	}

	private resolveStoredFolder(): IWorkspaceFolder | undefined {
		const selectedUri = this.storageService.get(PROJECT_CONTEXT_STORAGE_KEY, StorageScope.WORKSPACE);
		return this.workspace.folders.find(folder => folder.uri.toString() === selectedUri) ?? this.workspace.folders[0];
	}

	private synchronizeAvailableFolders(): void {
		const selectedFolder = this.selectedFolder ?? this.workspace.folders[0];
		if (!selectedFolder) {
			const changed = this.selectedFolderUri !== undefined;
			this.selectedFolderUri = undefined;
			this.pendingRevealFolderUri = undefined;
			this.storageService.remove(PROJECT_CONTEXT_STORAGE_KEY, StorageScope.WORKSPACE);
			if (changed) {
				this._onDidChangeProjectContext.fire();
			}
			void this.requestProjectContextProjection(undefined);
			return;
		}

		const changed = !this.selectedFolderUri || !isEqual(this.selectedFolderUri, selectedFolder.uri);
		this.selectedFolderUri = selectedFolder.uri;
		this.storageService.store(PROJECT_CONTEXT_STORAGE_KEY, selectedFolder.uri.toString(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		if (changed) {
			this._onDidChangeProjectContext.fire();
		}
		void this.requestProjectContextProjection(selectedFolder);
	}

	private selectFolder(folder: IWorkspaceFolder, reveal: boolean): Promise<void> {
		const changed = !this.selectedFolderUri || !isEqual(this.selectedFolderUri, folder.uri);
		this.selectedFolderUri = folder.uri;
		if (reveal) {
			this.pendingRevealFolderUri = folder.uri;
		}
		this.storageService.store(PROJECT_CONTEXT_STORAGE_KEY, folder.uri.toString(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		if (changed) {
			this._onDidChangeProjectContext.fire();
		}
		return this.requestProjectContextProjection(folder);
	}

	private requestProjectContextProjection(folder: IWorkspaceFolder | undefined): Promise<void> {
		const folderUri = folder?.uri;
		return this.projectionCoordinator.request({ folderUri }, () => folderUri
			? !!this.selectedFolder && isEqual(this.selectedFolder.uri, folderUri)
			: this.selectedFolderUri === undefined);
	}

	private async applyProjectContext(context: IAsyncProjectionContext<IProjectContextProjectionIntent>): Promise<void> {
		const folderUri = context.value.folderUri;
		if (!folderUri) {
			await this.explorerService.setActiveRoot(undefined);
			return;
		}
		const folder = this.workspace.folders.find(folder => isEqual(folder.uri, folderUri));
		if (!folder) {
			return;
		}
		await this.explorerService.setActiveRoot(folder.uri);
		if (!context.isCurrent()) {
			return;
		}

		if (this.pendingRevealFolderUri && isEqual(this.pendingRevealFolderUri, folder.uri)) {
			await this.paneCompositePartService.openPaneComposite(VIEWLET_ID, ViewContainerLocation.Sidebar, true);
			if (!context.isCurrent()) {
				return;
			}
			await this.explorerService.select(folder.uri, 'force');
			if (!context.isCurrent()) {
				return;
			}
			this.pendingRevealFolderUri = undefined;
		}

		const repository = Array.from(this.scmService.repositories).find(candidate => this.belongsToProject(candidate, folder));
		if (repository) {
			this.scmViewService.focus(repository);
		}
	}

	private belongsToProject(repository: ISCMRepository, folder: IWorkspaceFolder): boolean {
		const rootUri = repository.provider.rootUri;
		return !!rootUri && isEqualOrParent(rootUri, folder.uri);
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
