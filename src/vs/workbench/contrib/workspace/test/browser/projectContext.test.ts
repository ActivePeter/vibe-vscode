/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IPickOptions, IQuickInputService, IQuickPickItem, QuickPickInput } from '../../../../../platform/quickinput/common/quickInput.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { IExplorerService } from '../../../files/browser/files.js';
import { ISCMProvider, ISCMRepository, ISCMService, ISCMViewService } from '../../../scm/common/scm.js';
import { ProjectContextService } from '../../browser/projectContext.js';

function createFolder(name: string, index: number): IWorkspaceFolder {
	const uri = URI.file(`/workspace/${name}`);
	return { uri, name, index, toResource: relativePath => joinPath(uri, relativePath) };
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

		const repositories: ISCMRepository[] = [];
		const onDidAddRepository = store.add(new Emitter<ISCMRepository>());
		const scmService = new class extends mock<ISCMService>() {
			override readonly onDidAddRepository = onDidAddRepository.event;
			override get repositories(): Iterable<ISCMRepository> { return repositories; }
		};
		const focusedRepositories: ISCMRepository[] = [];
		const scmViewService = new class extends mock<ISCMViewService>() {
			override focus(repository: ISCMRepository): void {
				focusedRepositories.push(repository);
			}
		};

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

		const repository = new class extends mock<ISCMRepository>() {
			override readonly provider = new class extends mock<ISCMProvider>() {
				override readonly rootUri = joinPath(addedFolder.uri, 'nested-repository');
			};
		};
		repositories.push(repository);
		onDidAddRepository.fire(repository);
		await timeout(0);

		assert.deepStrictEqual({
			activeItemLabels,
			selectedFolder: service.selectedFolder?.uri.toString(),
			lastActiveRoot: activeRoots.at(-1)?.toString(),
			selectedResources: selectedResources.map(resource => resource.toString()),
			focusedRepositories,
		}, {
			activeItemLabels: ['first', 'current'],
			selectedFolder: addedFolder.uri.toString(),
			lastActiveRoot: addedFolder.uri.toString(),
			selectedResources: [currentFolder.uri.toString(), addedFolder.uri.toString()],
			focusedRepositories: [repository],
		});
		store.dispose();
	});
});
