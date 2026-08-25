/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import { DeferredPromise } from '../../../base/common/async.js';
import { join } from '../../../base/common/path.js';
import { IStorageDatabase, IUpdateRequest } from '../../../base/parts/storage/common/storage.js';
import { SQLiteStorageDatabase } from '../../../base/parts/storage/node/storage.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { getRandomTestPath } from '../../../base/test/node/testUtils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { ILogicalWorkspaceSharedState, ILogicalWorkspaceShellLayout, LogicalWorkspaceMutationType } from '../../../workbench/services/logicalWorkspace/common/logicalWorkspace.js';
import { IRemoteLogicalWorkspaceStateResult, IRemoteLogicalWorkspaceStateSnapshot, RemoteLogicalWorkspaceStateCommand } from '../../../workbench/services/logicalWorkspace/common/logicalWorkspaceRemote.js';
import { RemoteLogicalWorkspaceStateChannel, RemoteLogicalWorkspaceStateStorage } from '../../node/logicalWorkspaceStateChannel.js';

class FailOnceStorageDatabase implements IStorageDatabase {

	readonly onDidChangeItemsExternal = this.delegate.onDidChangeItemsExternal;
	readonly whenClosed: Promise<void>;

	private readonly closed = new DeferredPromise<void>();
	private shouldFailNextUpdate = false;

	constructor(private readonly delegate: IStorageDatabase) {
		this.whenClosed = this.closed.p;
	}

	failNextUpdate(): void {
		this.shouldFailNextUpdate = true;
	}

	getItems(): Promise<Map<string, string>> {
		return this.delegate.getItems();
	}

	async updateItems(request: IUpdateRequest): Promise<void> {
		if (this.shouldFailNextUpdate) {
			this.shouldFailNextUpdate = false;
			throw new Error('Injected database update failure');
		}
		await this.delegate.updateItems(request);
	}

	optimize(): Promise<void> {
		return this.delegate.optimize();
	}

	async close(recovery?: () => Map<string, string>): Promise<void> {
		try {
			await this.delegate.close(recovery);
			await this.closed.complete();
		} catch (error) {
			await this.closed.error(error);
			throw error;
		}
	}
}

suite('RemoteLogicalWorkspaceStateChannel', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createChannel(): RemoteLogicalWorkspaceStateChannel {
		const storage = disposables.add(new RemoteLogicalWorkspaceStateStorage(undefined, new NullLogService()));
		return new RemoteLogicalWorkspaceStateChannel(storage);
	}

	function state(id: string): ILogicalWorkspaceSharedState {
		return {
			schemaVersion: 2,
			workspaces: [{ id, name: id, terminalIds: [], shellLayout: undefined }],
		};
	}

	async function callForSnapshot(channel: RemoteLogicalWorkspaceStateChannel, command: RemoteLogicalWorkspaceStateCommand, arg: object): Promise<IRemoteLogicalWorkspaceStateSnapshot> {
		const result = await channel.call<IRemoteLogicalWorkspaceStateResult<IRemoteLogicalWorkspaceStateSnapshot>>(undefined, command, arg);
		if (result.status === 'error') {
			throw new Error(result.message);
		}
		return result.value;
	}

	test('initializes one authoritative state for concurrent clients', async () => {
		const channel = createChannel();
		const physicalWorkspaceId = 'physical';
		const [first, second] = await Promise.all([
			callForSnapshot(channel, RemoteLogicalWorkspaceStateCommand.Initialize, { physicalWorkspaceId, state: state('first') }),
			callForSnapshot(channel, RemoteLogicalWorkspaceStateCommand.Initialize, { physicalWorkspaceId, state: state('second') }),
		]);

		assert.deepStrictEqual({ first, second }, {
			first: { revision: 1, state: state('first') },
			second: { revision: 1, state: state('first') },
		});
	});

	test('serializes semantic mutations without losing independent fields', async () => {
		const channel = createChannel();
		const physicalWorkspaceId = 'physical';
		const shellLayout: ILogicalWorkspaceShellLayout = {
			primarySideBar: { visible: true, width: 280, height: 800, activeCompositeId: 'workbench.view.explorer' },
			panel: { visible: true, width: 1200, height: 260, activeCompositeId: 'workbench.panel.terminal' },
			auxiliaryBar: { visible: false, width: 300, height: 800, activeCompositeId: '' },
		};
		await callForSnapshot(channel, RemoteLogicalWorkspaceStateCommand.Initialize, { physicalWorkspaceId, state: state('workspace') });

		await Promise.all([
			callForSnapshot(channel, RemoteLogicalWorkspaceStateCommand.Mutate, {
				physicalWorkspaceId,
				mutation: { type: LogicalWorkspaceMutationType.BindTerminal, workspaceId: 'workspace', logicalTerminalId: 'terminal' },
			}),
			callForSnapshot(channel, RemoteLogicalWorkspaceStateCommand.Mutate, {
				physicalWorkspaceId,
				mutation: { type: LogicalWorkspaceMutationType.SetShellLayout, workspaceId: 'workspace', shellLayout },
			}),
		]);
		const final = await callForSnapshot(channel, RemoteLogicalWorkspaceStateCommand.Read, { physicalWorkspaceId });

		assert.deepStrictEqual(final, {
			revision: 3,
			state: {
				schemaVersion: 2,
				workspaces: [{ id: 'workspace', name: 'workspace', terminalIds: ['terminal'], shellLayout }],
			},
		});
	});

	test('keeps retried idempotent mutations on one revision', async () => {
		const channel = createChannel();
		const physicalWorkspaceId = 'physical';
		const mutation = { type: LogicalWorkspaceMutationType.BindTerminal, workspaceId: 'workspace', logicalTerminalId: 'terminal' } as const;
		await callForSnapshot(channel, RemoteLogicalWorkspaceStateCommand.Initialize, { physicalWorkspaceId, state: state('workspace') });

		const first = await callForSnapshot(channel, RemoteLogicalWorkspaceStateCommand.Mutate, { physicalWorkspaceId, mutation });
		const retried = await callForSnapshot(channel, RemoteLogicalWorkspaceStateCommand.Mutate, { physicalWorkspaceId, mutation });

		assert.deepStrictEqual({ first, retried }, {
			first: { revision: 2, state: { schemaVersion: 2, workspaces: [{ id: 'workspace', name: 'workspace', terminalIds: ['terminal'], shellLayout: undefined }] } },
			retried: { revision: 2, state: { schemaVersion: 2, workspaces: [{ id: 'workspace', name: 'workspace', terminalIds: ['terminal'], shellLayout: undefined }] } },
		});
	});

	test('does not confirm a failed database update', async function () {
		this.timeout(10000);
		const testDir = getRandomTestPath(os.tmpdir(), 'vsctests', 'logical-workspace-state');
		const storagePath = join(testDir, 'logical-workspaces.vscdb');
		fs.mkdirSync(testDir, { recursive: true });

		const firstDatabase = new FailOnceStorageDatabase(new SQLiteStorageDatabase(storagePath));
		const firstStorage = disposables.add(new RemoteLogicalWorkspaceStateStorage(storagePath, new NullLogService(), () => firstDatabase));
		const firstChannel = new RemoteLogicalWorkspaceStateChannel(firstStorage);
		const revisions: number[] = [];
		disposables.add(firstStorage.onDidChange(event => revisions.push(event.snapshot.revision)));
		const physicalWorkspaceId = 'physical';
		const mutation = { type: LogicalWorkspaceMutationType.BindTerminal, workspaceId: 'workspace', logicalTerminalId: 'terminal' } as const;

		try {
			const initial = await callForSnapshot(firstChannel, RemoteLogicalWorkspaceStateCommand.Initialize, { physicalWorkspaceId, state: state('workspace') });
			firstDatabase.failNextUpdate();
			await assert.rejects(
				callForSnapshot(firstChannel, RemoteLogicalWorkspaceStateCommand.Mutate, { physicalWorkspaceId, mutation }),
				/Injected database update failure/,
			);
			const afterFailure = await callForSnapshot(firstChannel, RemoteLogicalWorkspaceStateCommand.Read, { physicalWorkspaceId });

			assert.deepStrictEqual({ initial, afterFailure, revisions }, {
				initial: { revision: 1, state: state('workspace') },
				afterFailure: { revision: 1, state: state('workspace') },
				revisions: [1],
			});

			const retried = await callForSnapshot(firstChannel, RemoteLogicalWorkspaceStateCommand.Mutate, { physicalWorkspaceId, mutation });
			firstStorage.dispose();
			await firstDatabase.whenClosed;

			const reopenedDatabase = new FailOnceStorageDatabase(new SQLiteStorageDatabase(storagePath));
			const reopenedStorage = disposables.add(new RemoteLogicalWorkspaceStateStorage(storagePath, new NullLogService(), () => reopenedDatabase));
			const reopenedChannel = new RemoteLogicalWorkspaceStateChannel(reopenedStorage);
			try {
				const reopened = await callForSnapshot(reopenedChannel, RemoteLogicalWorkspaceStateCommand.Read, { physicalWorkspaceId });
				assert.deepStrictEqual({ retried, reopened, revisions }, {
					retried: { revision: 2, state: { schemaVersion: 2, workspaces: [{ id: 'workspace', name: 'workspace', terminalIds: ['terminal'], shellLayout: undefined }] } },
					reopened: { revision: 2, state: { schemaVersion: 2, workspaces: [{ id: 'workspace', name: 'workspace', terminalIds: ['terminal'], shellLayout: undefined }] } },
					revisions: [1, 2],
				});
			} finally {
				reopenedStorage.dispose();
				await reopenedDatabase.whenClosed;
			}
		} finally {
			firstStorage.dispose();
			await firstDatabase.whenClosed;
			fs.rmSync(testDir, { recursive: true, force: true });
		}
	});
});
