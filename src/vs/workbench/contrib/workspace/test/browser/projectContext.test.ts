/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { isEqual, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IPickOptions, IQuickInputService, IQuickPickItem, QuickPickInput } from '../../../../../platform/quickinput/common/quickInput.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder, IWorkspaceFoldersChangeEvent } from '../../../../../platform/workspace/common/workspace.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { IExplorerService } from '../../../files/browser/files.js';
import { ISCMProvider, ISCMRepository, ISCMRepositorySelectionMode, ISCMService, ISCMViewService, ISCMViewVisibleRepositoryChangeEvent } from '../../../scm/common/scm.js';
import { ProjectContextService } from '../../browser/projectContext.js';

function createFolder(name: string, index: number): IWorkspaceFolder {
	const uri = URI.file(`/workspace/${name}`);
	return { uri, name, index, toResource: relativePath => joinPath(uri, relativePath) };
}

function createRepository(rootUri: URI): ISCMRepository {
	return new class extends mock<ISCMRepository>() {
		override readonly provider = new class extends mock<ISCMProvider>() {
			override readonly rootUri = rootUri;
		};
	};
}

class TestSCMViewService extends mock<ISCMViewService>() {

	override readonly selectionModeConfig: ISettableObservable<ISCMRepositorySelectionMode>;
	private readonly _onDidChangeVisibleRepositories = new Emitter<ISCMViewVisibleRepositoryChangeEvent>();
	override readonly onDidChangeVisibleRepositories = this._onDidChangeVisibleRepositories.event;
	private _visibleRepositories: readonly ISCMRepository[];
	private _focusedRepository: ISCMRepository | undefined;
	readonly focusedRepositories: ISCMRepository[] = [];

	constructor(selectionMode: ISCMRepositorySelectionMode, visibleRepositories: readonly ISCMRepository[] = []) {
		super();
		this.selectionModeConfig = observableValue(this, selectionMode);
		this._visibleRepositories = [...visibleRepositories];
	}

	override get visibleRepositories(): readonly ISCMRepository[] {
		return this._visibleRepositories;
	}

	override set visibleRepositories(repositories: readonly ISCMRepository[]) {
		const previous = new Set(this._visibleRepositories);
		const next = new Set(repositories);
		this._visibleRepositories = [...repositories];
		const added = repositories.filter(repository => !previous.has(repository));
		const removed = [...previous].filter(repository => !next.has(repository));
		if (added.length || removed.length) {
			this._onDidChangeVisibleRepositories.fire({ added, removed });
		}
		if (this._focusedRepository && !next.has(this._focusedRepository)) {
			this._focusedRepository = undefined;
		}
	}

	override get focusedRepository(): ISCMRepository | undefined {
		return this._focusedRepository;
	}

	override focus(repository: ISCMRepository): void {
		if (!this._visibleRepositories.includes(repository)) {
			return;
		}
		this._focusedRepository = repository;
		this.focusedRepositories.push(repository);
	}

	setSelectionMode(selectionMode: ISCMRepositorySelectionMode): void {
		this.selectionModeConfig.set(selectionMode, undefined);
	}

	setVisibleRepositoriesFromUser(repositories: readonly ISCMRepository[]): void {
		this.visibleRepositories = repositories;
	}

	resetFocus(): void {
		this._focusedRepository = undefined;
		this.focusedRepositories.length = 0;
	}

	dispose(): void {
		this._onDidChangeVisibleRepositories.dispose();
	}
}

suite('ProjectContextService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('focuses a non-first current folder, selects an added folder, and follows a repository registered later', async () => {
		const store = disposables.add(new DisposableStore());
		const firstFolder = createFolder('first', 0);
		const currentFolder = createFolder('current', 1);
		const addedFolder = createFolder('added', 2);
		let folders: IWorkspaceFolder[] = [firstFolder, currentFolder];
		const workspaceContextService = new class extends mock<IWorkspaceContextService>() {
			override readonly onDidChangeWorkspaceFolders = Event.None;
			override readonly onDidChangeWorkspaceName = Event.None;
			override readonly onDidChangeWorkbenchState = Event.None;
			override getWorkspace(): IWorkspace {
				return { id: 'physical', folders };
			}
		};

		const activeItemLabels: Array<string | undefined> = [];
		let pickCount = 0;
		const quickInputService = new class extends mock<IQuickInputService>() {
			override pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: IPickOptions<T> & { canPickMany: true }, token?: CancellationToken): Promise<T[] | undefined>;
			override pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: IPickOptions<T> & { canPickMany: false }, token?: CancellationToken): Promise<T | undefined>;
			override async pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: Omit<IPickOptions<T>, 'canPickMany'>, _token?: CancellationToken): Promise<T | undefined> {
				activeItemLabels.push((await options?.activeItem)?.label);
				const resolvedPicks = await picks;
				const item = pickCount++ === 0 ? resolvedPicks[1] : resolvedPicks.at(-1);
				return item?.type === 'separator' ? undefined : item;
			}
		};
		const commandService = new class extends mock<ICommandService>() {
			override async executeCommand<R = unknown>(): Promise<R | undefined> {
				folders = [firstFolder, currentFolder, addedFolder];
				return undefined;
			}
		};

		const activeRoots: Array<URI | undefined> = [];
		const selectedResources: URI[] = [];
		const explorerService = new class extends mock<IExplorerService>() {
			override async setActiveRoot(resource: URI | undefined): Promise<void> {
				activeRoots.push(resource);
			}
			override async select(resource: URI): Promise<void> {
				selectedResources.push(resource);
			}
		};
		const paneCompositePartService = new class extends mock<IPaneCompositePartService>() {
			override async openPaneComposite() { return undefined; }
		};

		const currentNestedRepository = createRepository(joinPath(currentFolder.uri, 'nested-repository'));
		const currentRootRepository = createRepository(currentFolder.uri);
		const repositories: ISCMRepository[] = [currentNestedRepository, currentRootRepository];
		const onDidAddRepository = store.add(new Emitter<ISCMRepository>());
		const scmService = new class extends mock<ISCMService>() {
			override readonly onDidAddRepository = onDidAddRepository.event;
			override readonly onDidRemoveRepository = Event.None;
			override get repositories(): Iterable<ISCMRepository> { return repositories; }
		};
		const scmViewService = store.add(new TestSCMViewService(ISCMRepositorySelectionMode.Multiple, repositories));

		const service = store.add(new ProjectContextService(
			workspaceContextService,
			quickInputService,
			store.add(new TestStorageService()),
			commandService,
			paneCompositePartService,
			explorerService,
			scmService,
			scmViewService,
			new NullLogService(),
		));
		await service.pickProjectContext();
		await service.pickProjectContext();

		const repository = createRepository(joinPath(addedFolder.uri, 'nested-repository'));
		repositories.push(repository);
		onDidAddRepository.fire(repository);
		await timeout(0);
		const unrelatedRepository = createRepository(firstFolder.uri);
		repositories.push(unrelatedRepository);
		onDidAddRepository.fire(unrelatedRepository);
		await timeout(0);

		assert.deepStrictEqual({
			activeItemLabels,
			selectedFolder: service.selectedFolder?.uri.toString(),
			lastActiveRoot: activeRoots.at(-1)?.toString(),
			selectedResources: selectedResources.map(resource => resource.toString()),
			visibleRepositories: scmViewService.visibleRepositories,
			focusedRepositories: scmViewService.focusedRepositories,
		}, {
			activeItemLabels: ['first', 'current'],
			selectedFolder: addedFolder.uri.toString(),
			lastActiveRoot: addedFolder.uri.toString(),
			selectedResources: [currentFolder.uri.toString(), addedFolder.uri.toString()],
			visibleRepositories: [repository],
			focusedRepositories: [currentRootRepository, repository],
		});
		store.dispose();
	});

	test('does not commit a folder removed while the Project picker is open', async () => {
		const store = disposables.add(new DisposableStore());
		const firstFolder = createFolder('first', 0);
		const removedFolder = createFolder('removed', 1);
		let folders: IWorkspaceFolder[] = [firstFolder, removedFolder];
		const foldersChanged = store.add(new Emitter<IWorkspaceFoldersChangeEvent>());
		const workspaceContextService = new class extends mock<IWorkspaceContextService>() {
			override readonly onDidChangeWorkspaceFolders = foldersChanged.event;
			override readonly onDidChangeWorkspaceName = Event.None;
			override readonly onDidChangeWorkbenchState = Event.None;
			override getWorkspace(): IWorkspace { return { id: 'physical', folders }; }
		};
		const pickerOpened = new DeferredPromise<void>();
		const picked = new DeferredPromise<IQuickPickItem | undefined>();
		const quickInputService = new class extends mock<IQuickInputService>() {
			override pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: IPickOptions<T> & { canPickMany: true }, token?: CancellationToken): Promise<T[] | undefined>;
			override pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: IPickOptions<T> & { canPickMany: false }, token?: CancellationToken): Promise<T | undefined>;
			override async pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[]): Promise<T | undefined> {
				const items = await picks;
				await pickerOpened.complete();
				const item = await picked.p;
				return items.find(candidate => candidate.type !== 'separator' && candidate.label === item?.label) as T | undefined;
			}
		};
		const activeRoots: Array<URI | undefined> = [];
		const selectedResources: URI[] = [];
		const explorerService = new class extends mock<IExplorerService>() {
			override async setActiveRoot(resource: URI | undefined): Promise<void> { activeRoots.push(resource); }
			override async select(resource: URI): Promise<void> { selectedResources.push(resource); }
		};
		const scmService = new class extends mock<ISCMService>() {
			override readonly onDidAddRepository = Event.None;
			override readonly onDidRemoveRepository = Event.None;
			override get repositories(): Iterable<ISCMRepository> { return []; }
		};
		const service = store.add(new ProjectContextService(
			workspaceContextService,
			quickInputService,
			store.add(new TestStorageService()),
			new class extends mock<ICommandService>() { },
			new class extends mock<IPaneCompositePartService>() { },
			explorerService,
			scmService,
			store.add(new TestSCMViewService(ISCMRepositorySelectionMode.Multiple)),
			new NullLogService(),
		));

		const selection = service.pickProjectContext();
		await pickerOpened.p;
		folders = [firstFolder];
		foldersChanged.fire({ added: [], removed: [removedFolder], changed: [] });
		await picked.complete({ label: removedFolder.name });
		await selection;
		await timeout(0);

		assert.deepStrictEqual({
			selectedFolder: service.selectedFolder?.uri.toString(),
			lastActiveRoot: activeRoots.at(-1)?.toString(),
			selectedResources: selectedResources.map(resource => resource.toString()),
		}, {
			selectedFolder: firstFolder.uri.toString(),
			lastActiveRoot: firstFolder.uri.toString(),
			selectedResources: [],
		});
		store.dispose();
	});

	test('clears Explorer and SCM projections when the last Project folder is removed', async () => {
		const store = disposables.add(new DisposableStore());
		const projectFolder = createFolder('project', 0);
		let folders: IWorkspaceFolder[] = [projectFolder];
		const foldersChanged = store.add(new Emitter<IWorkspaceFoldersChangeEvent>());
		const workspaceContextService = new class extends mock<IWorkspaceContextService>() {
			override readonly onDidChangeWorkspaceFolders = foldersChanged.event;
			override readonly onDidChangeWorkspaceName = Event.None;
			override readonly onDidChangeWorkbenchState = Event.None;
			override getWorkspace(): IWorkspace { return { id: 'physical', folders }; }
		};
		const activeRoots: Array<URI | undefined> = [];
		const explorerService = new class extends mock<IExplorerService>() {
			override async setActiveRoot(resource: URI | undefined): Promise<void> { activeRoots.push(resource); }
		};
		const repository = createRepository(projectFolder.uri);
		const scmService = new class extends mock<ISCMService>() {
			override readonly onDidAddRepository = Event.None;
			override readonly onDidRemoveRepository = Event.None;
			override get repositories(): Iterable<ISCMRepository> { return [repository]; }
		};
		const scmViewService = store.add(new TestSCMViewService(ISCMRepositorySelectionMode.Multiple, [repository]));
		const service = store.add(new ProjectContextService(
			workspaceContextService,
			new class extends mock<IQuickInputService>() { },
			store.add(new TestStorageService()),
			new class extends mock<ICommandService>() { },
			new class extends mock<IPaneCompositePartService>() { },
			explorerService,
			scmService,
			scmViewService,
			new NullLogService(),
		));
		await timeout(0);

		folders = [];
		foldersChanged.fire({ added: [], removed: [projectFolder], changed: [] });
		await timeout(0);

		assert.deepStrictEqual({
			selectedFolder: service.selectedFolder,
			activeRoots,
			visibleRepositories: scmViewService.visibleRepositories,
			focusedRepository: scmViewService.focusedRepository,
		}, {
			selectedFolder: undefined,
			activeRoots: [projectFolder.uri, undefined],
			visibleRepositories: [],
			focusedRepository: undefined,
		});

		scmViewService.setVisibleRepositoriesFromUser([repository]);
		await timeout(0);
		assert.deepStrictEqual({
			visibleRepositories: scmViewService.visibleRepositories,
			focusedRepository: scmViewService.focusedRepository,
		}, {
			visibleRepositories: [],
			focusedRepository: undefined,
		});
		store.dispose();
	});

	test('a stale Project projection cannot reveal or focus after a newer selection', async () => {
		const store = disposables.add(new DisposableStore());
		const firstFolder = createFolder('first', 0);
		const secondFolder = createFolder('second', 1);
		const workspaceContextService = new class extends mock<IWorkspaceContextService>() {
			override readonly onDidChangeWorkspaceFolders = Event.None;
			override readonly onDidChangeWorkspaceName = Event.None;
			override readonly onDidChangeWorkbenchState = Event.None;
			override getWorkspace(): IWorkspace {
				return { id: 'physical', folders: [firstFolder, secondFolder] };
			}
		};

		const activeItemLabels: Array<string | undefined> = [];
		let pickCount = 0;
		const quickInputService = new class extends mock<IQuickInputService>() {
			override pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: IPickOptions<T> & { canPickMany: true }, token?: CancellationToken): Promise<T[] | undefined>;
			override pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: IPickOptions<T> & { canPickMany: false }, token?: CancellationToken): Promise<T | undefined>;
			override async pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: Omit<IPickOptions<T>, 'canPickMany'>, _token?: CancellationToken): Promise<T | undefined> {
				activeItemLabels.push((await options?.activeItem)?.label);
				const resolvedPicks = await picks;
				const item = resolvedPicks[pickCount++ === 0 ? 1 : 0];
				return item?.type === 'separator' ? undefined : item;
			}
		};

		const secondProjectionStarted = new DeferredPromise<void>();
		const releaseSecondProjection = new DeferredPromise<void>();
		const activeRoots: Array<URI | undefined> = [];
		const selectedResources: URI[] = [];
		let shouldBlockSecondProjection = true;
		const explorerService = new class extends mock<IExplorerService>() {
			override async setActiveRoot(resource: URI | undefined): Promise<void> {
				activeRoots.push(resource);
				if (shouldBlockSecondProjection && resource?.toString() === secondFolder.uri.toString()) {
					secondProjectionStarted.complete();
					await releaseSecondProjection.p;
					shouldBlockSecondProjection = false;
				}
			}
			override async select(resource: URI): Promise<void> {
				selectedResources.push(resource);
			}
		};
		let openedExplorerCount = 0;
		const paneCompositePartService = new class extends mock<IPaneCompositePartService>() {
			override async openPaneComposite() {
				openedExplorerCount++;
				return undefined;
			}
		};

		const firstRepository = createRepository(firstFolder.uri);
		const secondRepository = createRepository(secondFolder.uri);
		const scmService = new class extends mock<ISCMService>() {
			override readonly onDidAddRepository = Event.None;
			override readonly onDidRemoveRepository = Event.None;
			override get repositories(): Iterable<ISCMRepository> { return [firstRepository, secondRepository]; }
		};
		const scmViewService = store.add(new TestSCMViewService(ISCMRepositorySelectionMode.Multiple, [firstRepository, secondRepository]));

		const service = store.add(new ProjectContextService(
			workspaceContextService,
			quickInputService,
			store.add(new TestStorageService()),
			new class extends mock<ICommandService>() { },
			paneCompositePartService,
			explorerService,
			scmService,
			scmViewService,
			new NullLogService(),
		));
		await timeout(0);
		activeRoots.length = 0;
		scmViewService.resetFocus();

		const selectSecond = service.pickProjectContext();
		await secondProjectionStarted.p;
		const firstSelectionCommitted = new DeferredPromise<void>();
		store.add(service.onDidChangeProjectContext(() => {
			if (service.selectedFolder?.uri.toString() === firstFolder.uri.toString()) {
				firstSelectionCommitted.complete();
			}
		}));
		const selectFirst = service.pickProjectContext();
		await firstSelectionCommitted.p;
		releaseSecondProjection.complete();
		await Promise.all([selectSecond, selectFirst]);

		assert.deepStrictEqual({
			activeItemLabels,
			selectedFolder: service.selectedFolder?.uri.toString(),
			activeRoots: activeRoots.map(resource => resource?.toString()),
			selectedResources: selectedResources.map(resource => resource.toString()),
			openedExplorerCount,
			visibleRepositories: scmViewService.visibleRepositories,
			focusedRepositories: scmViewService.focusedRepositories,
		}, {
			activeItemLabels: ['first', 'second'],
			selectedFolder: firstFolder.uri.toString(),
			activeRoots: [secondFolder.uri.toString(), firstFolder.uri.toString()],
			selectedResources: [firstFolder.uri.toString()],
			openedExplorerCount: 1,
			visibleRepositories: [firstRepository],
			focusedRepositories: [firstRepository],
		});

		store.dispose();
	});

	test('same-Project SCM changes do not invalidate an in-flight selection', async () => {
		const store = disposables.add(new DisposableStore());
		const firstFolder = createFolder('first', 0);
		const secondFolder = createFolder('second', 1);
		const workspaceContextService = new class extends mock<IWorkspaceContextService>() {
			override readonly onDidChangeWorkspaceFolders = Event.None;
			override readonly onDidChangeWorkspaceName = Event.None;
			override readonly onDidChangeWorkbenchState = Event.None;
			override getWorkspace(): IWorkspace { return { id: 'physical', folders: [firstFolder, secondFolder] }; }
		};
		const quickInputService = new class extends mock<IQuickInputService>() {
			override pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: IPickOptions<T> & { canPickMany: true }, token?: CancellationToken): Promise<T[] | undefined>;
			override pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: IPickOptions<T> & { canPickMany: false }, token?: CancellationToken): Promise<T | undefined>;
			override async pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[]): Promise<T | undefined> {
				const item = (await picks)[1];
				return item?.type === 'separator' ? undefined : item;
			}
		};

		const firstProjectionStarted = new DeferredPromise<void>();
		const releaseFirstProjection = new DeferredPromise<void>();
		const refreshProjectionStarted = new DeferredPromise<void>();
		const releaseRefreshProjection = new DeferredPromise<void>();
		let secondProjectionCount = 0;
		const selectedResources: URI[] = [];
		const explorerService = new class extends mock<IExplorerService>() {
			override async setActiveRoot(resource: URI | undefined): Promise<void> {
				if (!resource || !isEqual(resource, secondFolder.uri)) {
					return;
				}
				secondProjectionCount++;
				if (secondProjectionCount === 1) {
					await firstProjectionStarted.complete();
					await releaseFirstProjection.p;
				} else {
					await refreshProjectionStarted.complete();
					await releaseRefreshProjection.p;
				}
			}
			override async select(resource: URI): Promise<void> { selectedResources.push(resource); }
		};
		let openedExplorerCount = 0;
		const paneCompositePartService = new class extends mock<IPaneCompositePartService>() {
			override async openPaneComposite() {
				openedExplorerCount++;
				return undefined;
			}
		};

		const firstRepository = createRepository(firstFolder.uri);
		const secondRepository = createRepository(secondFolder.uri);
		const repositories: ISCMRepository[] = [firstRepository];
		const onDidAddRepository = store.add(new Emitter<ISCMRepository>());
		const scmService = new class extends mock<ISCMService>() {
			override readonly onDidAddRepository = onDidAddRepository.event;
			override readonly onDidRemoveRepository = Event.None;
			override get repositories(): Iterable<ISCMRepository> { return repositories; }
		};
		const scmViewService = store.add(new TestSCMViewService(ISCMRepositorySelectionMode.Multiple, [firstRepository]));
		const service = store.add(new ProjectContextService(
			workspaceContextService,
			quickInputService,
			store.add(new TestStorageService()),
			new class extends mock<ICommandService>() { },
			paneCompositePartService,
			explorerService,
			scmService,
			scmViewService,
			new NullLogService(),
		));
		await timeout(0);

		const selection = service.pickProjectContext();
		await firstProjectionStarted.p;
		repositories.push(secondRepository);
		onDidAddRepository.fire(secondRepository);
		await releaseFirstProjection.complete();
		await selection;

		assert.deepStrictEqual({
			selectedFolder: service.selectedFolder?.uri.toString(),
			selectedResources: selectedResources.map(resource => resource.toString()),
			openedExplorerCount,
			visibleRepositories: scmViewService.visibleRepositories,
			focusedRepository: scmViewService.focusedRepository,
		}, {
			selectedFolder: secondFolder.uri.toString(),
			selectedResources: [secondFolder.uri.toString()],
			openedExplorerCount: 1,
			visibleRepositories: [secondRepository],
			focusedRepository: secondRepository,
		});

		await refreshProjectionStarted.p;
		await releaseRefreshProjection.complete();
		await timeout(0);
		store.dispose();
	});

	test('projects an exact SCM repository set across Explorer failures, selection modes, and catalog changes', async () => {
		const store = disposables.add(new DisposableStore());
		const projectFolder = createFolder('project', 0);
		const otherFolder = createFolder('other', 1);
		const workspaceContextService = new class extends mock<IWorkspaceContextService>() {
			override readonly onDidChangeWorkspaceFolders = Event.None;
			override readonly onDidChangeWorkspaceName = Event.None;
			override readonly onDidChangeWorkbenchState = Event.None;
			override getWorkspace(): IWorkspace {
				return { id: 'physical', folders: [projectFolder, otherFolder] };
			}
		};

		const rootRepository = createRepository(projectFolder.uri);
		const nestedRepository = createRepository(joinPath(projectFolder.uri, 'nested'));
		const otherRepository = createRepository(otherFolder.uri);
		let repositories: ISCMRepository[] = [nestedRepository, otherRepository, rootRepository];
		const onDidAddRepository = store.add(new Emitter<ISCMRepository>());
		const onDidRemoveRepository = store.add(new Emitter<ISCMRepository>());
		const scmService = new class extends mock<ISCMService>() {
			override readonly onDidAddRepository = onDidAddRepository.event;
			override readonly onDidRemoveRepository = onDidRemoveRepository.event;
			override get repositories(): Iterable<ISCMRepository> { return repositories; }
		};
		const scmViewService = store.add(new TestSCMViewService(ISCMRepositorySelectionMode.Multiple, repositories));

		let failExplorerProjection = true;
		store.add(new ProjectContextService(
			workspaceContextService,
			new class extends mock<IQuickInputService>() { },
			store.add(new TestStorageService()),
			new class extends mock<ICommandService>() { },
			new class extends mock<IPaneCompositePartService>() { },
			new class extends mock<IExplorerService>() {
				override async setActiveRoot(): Promise<void> {
					if (failExplorerProjection) {
						failExplorerProjection = false;
						throw new Error('Explorer cleanup failed');
					}
				}
			},
			scmService,
			scmViewService,
			new NullLogService(),
		));
		await timeout(0);

		assert.deepStrictEqual(scmViewService.visibleRepositories, [nestedRepository, rootRepository]);
		assert.strictEqual(scmViewService.focusedRepository, rootRepository);

		scmViewService.setSelectionMode(ISCMRepositorySelectionMode.Single);
		await timeout(0);
		assert.deepStrictEqual(scmViewService.visibleRepositories, [rootRepository]);

		scmViewService.setSelectionMode(ISCMRepositorySelectionMode.Multiple);
		await timeout(0);
		assert.deepStrictEqual(scmViewService.visibleRepositories, [nestedRepository, rootRepository]);

		scmViewService.setVisibleRepositoriesFromUser([otherRepository]);
		await timeout(0);
		assert.deepStrictEqual(scmViewService.visibleRepositories, [nestedRepository, rootRepository]);

		repositories = [nestedRepository, otherRepository];
		onDidRemoveRepository.fire(rootRepository);
		await timeout(0);
		assert.deepStrictEqual(scmViewService.visibleRepositories, [nestedRepository]);

		repositories = [otherRepository];
		onDidRemoveRepository.fire(nestedRepository);
		await timeout(0);
		assert.deepStrictEqual(scmViewService.visibleRepositories, []);

		store.dispose();
	});
});
