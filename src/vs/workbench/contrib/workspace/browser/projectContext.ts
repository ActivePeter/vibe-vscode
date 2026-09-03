/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { runOnChange } from '../../../../base/common/observable.js';
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
import { ISCMRepository, ISCMRepositorySelectionMode, ISCMService, ISCMViewService } from '../../scm/common/scm.js';

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
 * Selects the project whose Explorer root and Source Control repository set are projected within
 * the current VS Code workbench. It never changes or reloads the VS Code workspace itself.
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
	private readonly whenWorkspaceComplete: Promise<void>;
	private selectedFolderUri: URI | undefined;
	private pendingRevealFolderUri: URI | undefined;
	private applyingSCMProjection = false;
	private workspaceCatalogComplete = false;

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IStorageService private readonly storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IPaneCompositePartService private readonly paneCompositePartService: IPaneCompositePartService,
		@IExplorerService private readonly explorerService: IExplorerService,
		@ISCMService private readonly scmService: ISCMService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const storedFolderUri = this.storageService.get(PROJECT_CONTEXT_STORAGE_KEY, StorageScope.WORKSPACE);
		// The synchronous workspace can be a partial remote .code-workspace catalog. Preserve the
		// stored URI as intent and only accept a match that is already present; absence is not yet an
		// authoritative reason to fall back to the first folder.
		this.selectedFolderUri = this.resolveFolder(storedFolderUri)?.uri;
		this.projectionCoordinator = this._register(new AsyncProjectionCoordinator(
			context => this.applyProjectContext(context),
			(current, next) => current.folderUri === next.folderUri
				|| (current.folderUri !== undefined && next.folderUri !== undefined && isEqual(current.folderUri, next.folderUri)),
		));

		const updateProjectContext = () => {
			if (this.workspaceCatalogComplete) {
				this.synchronizeAvailableFolders();
			}
		};
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(updateProjectContext));
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(updateProjectContext));
		this._register(this.workspaceContextService.onDidChangeWorkspaceName(() => this._onDidChangeProjectContext.fire()));
		const requestSCMProjection = () => {
			if (!this.workspaceCatalogComplete) {
				return;
			}
			// An empty Project is also an authoritative target. Keep reprojecting its empty SCM set
			// when repository discovery or a user visibility change tries to repopulate the view.
			this.requestProjectContextProjectionFromEvent(this.selectedFolder);
		};
		// SCM adds every newly discovered repository to the visible set in multiple mode.
		// Reproject for every catalog change, including repositories outside this Project.
		this._register(this.scmService.onDidAddRepository(requestSCMProjection));
		this._register(this.scmService.onDidRemoveRepository(requestSCMProjection));
		this._register(runOnChange(this.scmViewService.selectionModeConfig, requestSCMProjection));
		this._register(this.scmViewService.onDidChangeVisibleRepositories(() => {
			if (!this.applyingSCMProjection) {
				requestSCMProjection();
			}
		}));
		this.whenWorkspaceComplete = this.initializeProjectContext(storedFolderUri);
		// Keep readiness rejection-bearing for callers such as the picker, but attach an owner now so
		// a failed remote workspace load cannot become an unhandled rejection.
		void this.whenWorkspaceComplete.catch(error => this.logService.error('Project Context could not await the complete workspace catalog', error));
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
		await this.whenWorkspaceComplete;
		if (this._store.isDisposed) {
			return;
		}
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

		// Quick Pick items are a snapshot. Resolve the selected URI against the current
		// Physical Workspace so a folder removed while the picker was open cannot be committed.
		const selectedFolderUri = pick.folder.uri;
		const currentFolder = this.workspace.folders.find(folder => isEqual(folder.uri, selectedFolderUri));
		if (!currentFolder) {
			return;
		}
		await this.selectFolder(currentFolder, true);
	}

	private async initializeProjectContext(storedFolderUri: string | undefined): Promise<void> {
		await this.workspaceContextService.getCompleteWorkspace();
		if (this._store.isDisposed) {
			return;
		}
		this.workspaceCatalogComplete = true;
		this.synchronizeAvailableFolders(storedFolderUri);
	}

	private resolveFolder(folderUri: string | undefined): IWorkspaceFolder | undefined {
		return folderUri ? this.workspace.folders.find(folder => folder.uri.toString() === folderUri) : undefined;
	}

	private synchronizeAvailableFolders(preferredFolderUri?: string): void {
		const selectedFolder = this.selectedFolder ?? this.resolveFolder(preferredFolderUri) ?? this.workspace.folders[0];
		if (!selectedFolder) {
			const changed = this.selectedFolderUri !== undefined;
			this.selectedFolderUri = undefined;
			this.pendingRevealFolderUri = undefined;
			this.storageService.remove(PROJECT_CONTEXT_STORAGE_KEY, StorageScope.WORKSPACE);
			if (changed) {
				this._onDidChangeProjectContext.fire();
			}
			this.requestProjectContextProjectionFromEvent(undefined);
			return;
		}

		const changed = !this.selectedFolderUri || !isEqual(this.selectedFolderUri, selectedFolder.uri);
		this.selectedFolderUri = selectedFolder.uri;
		this.storageService.store(PROJECT_CONTEXT_STORAGE_KEY, selectedFolder.uri.toString(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		if (changed) {
			this._onDidChangeProjectContext.fire();
		}
		this.requestProjectContextProjectionFromEvent(selectedFolder);
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

	private requestProjectContextProjectionFromEvent(folder: IWorkspaceFolder | undefined): void {
		void this.requestProjectContextProjection(folder).catch(error => this.logService.error('Project Context projection failed', error));
	}

	private async applyProjectContext(context: IAsyncProjectionContext<IProjectContextProjectionIntent>): Promise<void> {
		const folderUri = context.value.folderUri;
		const folder = folderUri ? this.workspace.folders.find(folder => isEqual(folder.uri, folderUri)) : undefined;
		if (folderUri && !folder) {
			return;
		}
		try {
			await this.explorerService.setActiveRoot(folder?.uri);
		} finally {
			// Explorer and SCM are independent projections of the same Project authority. A failed
			// Find/tree cleanup must not prevent the current SCM repository set from converging.
			if (context.isCurrent()) {
				this.applySCMProjection(folder);
			}
		}
		if (!context.isCurrent() || !folder) {
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

	}

	private applySCMProjection(folder: IWorkspaceFolder | undefined): void {
		const projectRepositories = folder
			? Array.from(this.scmService.repositories).filter(repository => repository.provider.isHidden !== true && this.belongsToProject(repository, folder))
			: [];
		const primaryRepository = [...projectRepositories]
			.sort((left, right) => left.provider.rootUri!.path.length - right.provider.rootUri!.path.length)[0];
		const visibleRepositories = this.scmViewService.selectionModeConfig.get() === ISCMRepositorySelectionMode.Single
			? primaryRepository ? [primaryRepository] : []
			: projectRepositories;

		// This setter is the SCM selection model's atomic transaction. Using toggleVisibility()
		// would only add the target in multiple mode and leave other Projects visible.
		this.applyingSCMProjection = true;
		try {
			this.scmViewService.visibleRepositories = visibleRepositories;
		} finally {
			this.applyingSCMProjection = false;
		}

		if (primaryRepository && this.scmViewService.focusedRepository !== primaryRepository) {
			this.scmViewService.focus(primaryRepository);
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
