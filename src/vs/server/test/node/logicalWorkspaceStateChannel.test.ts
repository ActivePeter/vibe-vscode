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
import { IRemoteLogicalWorkspaceStateResult, IRemoteLogicalWorkspaceStateSnapshot, RemoteLogicalWorkspaceStateCommand, RemoteLogicalWorkspaceStateErrorCode } from '../../../workbench/services/logicalWorkspace/common/logicalWorkspaceRemote.js';
import { RemoteLogicalWorkspaceStateChannel, RemoteLogicalWorkspaceStateStorage } from '../../node/logicalWorkspaceStateChannel.js';
import type { Database } from '@vscode/sqlite3';

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

class FailInitialReadStorageDatabase implements IStorageDatabase {

	readonly onDidChangeItemsExternal = this.delegate.onDidChangeItemsExternal;
	readonly whenClosed: Promise<boolean>;

	private readonly closed = new DeferredPromise<boolean>();

	constructor(private readonly delegate: IStorageDatabase) {
		this.whenClosed = this.closed.p;
	}

	async getItems(): Promise<Map<string, string>> {
		await this.delegate.getItems();
		throw new Error('Injected initial database read failure');
	}

	updateItems(request: IUpdateRequest): Promise<void> {
		return this.delegate.updateItems(request);
	}

	optimize(): Promise<void> {
		return this.delegate.optimize();
	}

	async close(recovery?: () => Map<string, string>): Promise<void> {
		try {
			await this.delegate.close(recovery);
			await this.closed.complete(recovery !== undefined);
		} catch (error) {
			await this.closed.error(error);
			throw error;
		}
	}
}

async function createRawSQLiteDatabase(storagePath: string, sql: string): Promise<void> {
	const sqlite3 = (await import('@vscode/sqlite3')).default;
	const database = await new Promise<Database>((resolve, reject) => {
		const candidate = new sqlite3.Database(storagePath, error => error ? reject(error) : resolve(candidate));
	});
	try {
		await new Promise<void>((resolve, reject) => database.exec(sql, error => error ? reject(error) : resolve()));
	} finally {
		await new Promise<void>((resolve, reject) => database.close(error => error ? reject(error) : resolve()));
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
				mutation: { type: LogicalWorkspaceMutationType.SetEditorWorkingSet, workspaceId: 'workspace', editorWorkingSet: 'editor-state' },
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
				workspaces: [{ id: 'workspace', name: 'workspace', terminalIds: [], shellLayout, editorWorkingSet: 'editor-state' }],
			},
		});
	});

	test('does not increment revision for an unchanged view mutation', async () => {
		const channel = createChannel();
		const physicalWorkspaceId = 'physical';
		const mutation = { type: LogicalWorkspaceMutationType.SetEditorWorkingSet, workspaceId: 'workspace', editorWorkingSet: 'editor-state' } as const;
		await callForSnapshot(channel, RemoteLogicalWorkspaceStateCommand.Initialize, { physicalWorkspaceId, state: state('workspace') });

		const first = await callForSnapshot(channel, RemoteLogicalWorkspaceStateCommand.Mutate, { physicalWorkspaceId, mutation });
		const retried = await callForSnapshot(channel, RemoteLogicalWorkspaceStateCommand.Mutate, { physicalWorkspaceId, mutation });

		assert.deepStrictEqual({ first, retried }, {
			first: { revision: 2, state: { schemaVersion: 2, workspaces: [{ id: 'workspace', name: 'workspace', terminalIds: [], shellLayout: undefined, editorWorkingSet: 'editor-state' }] } },
			retried: { revision: 2, state: { schemaVersion: 2, workspaces: [{ id: 'workspace', name: 'workspace', terminalIds: [], shellLayout: undefined, editorWorkingSet: 'editor-state' }] } },
		});
	});

	test('rejects new Workspace mutations that write migration-only Terminal ownership', async () => {
		const channel = createChannel();
		const physicalWorkspaceId = 'physical';
		const initial: ILogicalWorkspaceSharedState = {
			schemaVersion: 2,
			workspaces: [{ id: 'existing', name: 'existing', terminalIds: ['legacy-terminal'], shellLayout: undefined }],
		};
		await callForSnapshot(channel, RemoteLogicalWorkspaceStateCommand.Initialize, { physicalWorkspaceId, state: initial });

		const rejected = await channel.call<IRemoteLogicalWorkspaceStateResult<IRemoteLogicalWorkspaceStateSnapshot>>(undefined, RemoteLogicalWorkspaceStateCommand.Mutate, {
			physicalWorkspaceId,
			mutation: {
				type: LogicalWorkspaceMutationType.CreateWorkspace,
				workspace: { id: 'new', name: 'new', terminalIds: ['legacy-terminal'], shellLayout: undefined },
			},
		});
		const afterRejectedMutation = await callForSnapshot(channel, RemoteLogicalWorkspaceStateCommand.Read, { physicalWorkspaceId });

		assert.deepStrictEqual({ rejected, afterRejectedMutation }, {
			rejected: {
				status: 'error',
				code: 'invalidRequest',
				message: 'A valid Logical Workspace mutation is required',
			},
			afterRejectedMutation: { revision: 1, state: initial },
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
		const physicalWorkspaceId = 'physical';
		const mutation = { type: LogicalWorkspaceMutationType.SetEditorWorkingSet, workspaceId: 'workspace', editorWorkingSet: 'editor-state' } as const;

		try {
			const initial = await callForSnapshot(firstChannel, RemoteLogicalWorkspaceStateCommand.Initialize, { physicalWorkspaceId, state: state('workspace') });
			firstDatabase.failNextUpdate();
			await assert.rejects(
				callForSnapshot(firstChannel, RemoteLogicalWorkspaceStateCommand.Mutate, { physicalWorkspaceId, mutation }),
				/Injected database update failure/,
			);
			const afterFailure = await callForSnapshot(firstChannel, RemoteLogicalWorkspaceStateCommand.Read, { physicalWorkspaceId });

			assert.deepStrictEqual({ initial, afterFailure }, {
				initial: { revision: 1, state: state('workspace') },
				afterFailure: { revision: 1, state: state('workspace') },
			});

			const retried = await callForSnapshot(firstChannel, RemoteLogicalWorkspaceStateCommand.Mutate, { physicalWorkspaceId, mutation });
			firstStorage.dispose();
			await firstDatabase.whenClosed;

			const reopenedDatabase = new FailOnceStorageDatabase(new SQLiteStorageDatabase(storagePath));
			const reopenedStorage = disposables.add(new RemoteLogicalWorkspaceStateStorage(storagePath, new NullLogService(), () => reopenedDatabase));
			const reopenedChannel = new RemoteLogicalWorkspaceStateChannel(reopenedStorage);
			try {
				const reopened = await callForSnapshot(reopenedChannel, RemoteLogicalWorkspaceStateCommand.Read, { physicalWorkspaceId });
				assert.deepStrictEqual({ retried, reopened }, {
					retried: { revision: 2, state: { schemaVersion: 2, workspaces: [{ id: 'workspace', name: 'workspace', terminalIds: [], shellLayout: undefined, editorWorkingSet: 'editor-state' }] } },
					reopened: { revision: 2, state: { schemaVersion: 2, workspaces: [{ id: 'workspace', name: 'workspace', terminalIds: [], shellLayout: undefined, editorWorkingSet: 'editor-state' }] } },
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

	test('fails closed when the Logical Workspace database cannot be opened', async function () {
		this.timeout(10000);
		const testDir = getRandomTestPath(os.tmpdir(), 'vsctests', 'logical-workspace-open-failure');
		const storagePath = join(testDir, 'logical-workspaces.vscdb');
		const originalContents = 'not a sqlite database';
		fs.mkdirSync(testDir, { recursive: true });
		fs.writeFileSync(storagePath, originalContents);
		const firstStorage = new RemoteLogicalWorkspaceStateStorage(storagePath, new NullLogService());
		const firstChannel = new RemoteLogicalWorkspaceStateChannel(firstStorage);
		let reopenedStorage: RemoteLogicalWorkspaceStateStorage | undefined;

		try {
			const initialize = await firstChannel.call<IRemoteLogicalWorkspaceStateResult<IRemoteLogicalWorkspaceStateSnapshot>>(
				undefined,
				RemoteLogicalWorkspaceStateCommand.Initialize,
				{ physicalWorkspaceId: 'physical', state: state('workspace') },
			);
			const mutate = await firstChannel.call<IRemoteLogicalWorkspaceStateResult<IRemoteLogicalWorkspaceStateSnapshot>>(
				undefined,
				RemoteLogicalWorkspaceStateCommand.Mutate,
				{
					physicalWorkspaceId: 'physical',
					mutation: { type: LogicalWorkspaceMutationType.SetEditorWorkingSet, workspaceId: 'workspace', editorWorkingSet: 'editor-state' },
				},
			);
			const read = await firstChannel.call<IRemoteLogicalWorkspaceStateResult<IRemoteLogicalWorkspaceStateSnapshot | undefined>>(
				undefined,
				RemoteLogicalWorkspaceStateCommand.Read,
				{ physicalWorkspaceId: 'physical' },
			);
			firstStorage.dispose();

			reopenedStorage = new RemoteLogicalWorkspaceStateStorage(storagePath, new NullLogService());
			const reopenedChannel = new RemoteLogicalWorkspaceStateChannel(reopenedStorage);
			const reopenedRead = await reopenedChannel.call<IRemoteLogicalWorkspaceStateResult<IRemoteLogicalWorkspaceStateSnapshot | undefined>>(
				undefined,
				RemoteLogicalWorkspaceStateCommand.Read,
				{ physicalWorkspaceId: 'physical' },
			);

			assert.deepStrictEqual({
				initialize: initialize.status === 'error' ? {
					status: initialize.status,
					code: initialize.code,
					noAutomaticRecovery: initialize.message.includes('No automatic recovery was attempted'),
				} : initialize,
				mutate: mutate.status === 'error' ? { status: mutate.status, code: mutate.code } : mutate,
				read: read.status === 'error' ? { status: read.status, code: read.code } : read,
				reopenedRead: reopenedRead.status === 'error' ? { status: reopenedRead.status, code: reopenedRead.code } : reopenedRead,
				storageContents: fs.readFileSync(storagePath, 'utf8'),
			}, {
				initialize: {
					status: 'error',
					code: RemoteLogicalWorkspaceStateErrorCode.StorageUnavailable,
					noAutomaticRecovery: true,
				},
				mutate: { status: 'error', code: RemoteLogicalWorkspaceStateErrorCode.StorageUnavailable },
				read: { status: 'error', code: RemoteLogicalWorkspaceStateErrorCode.StorageUnavailable },
				reopenedRead: { status: 'error', code: RemoteLogicalWorkspaceStateErrorCode.StorageUnavailable },
				storageContents: originalContents,
			});
		} finally {
			firstStorage.dispose();
			reopenedStorage?.dispose();
			fs.rmSync(testDir, { recursive: true, force: true });
		}
	});

	test('fails closed without modifying an unsupported SQLite schema', async function () {
		this.timeout(10000);
		const testDir = getRandomTestPath(os.tmpdir(), 'vsctests', 'logical-workspace-schema-failure');
		const storagePath = join(testDir, 'logical-workspaces.vscdb');
		fs.mkdirSync(testDir, { recursive: true });
		await createRawSQLiteDatabase(storagePath, 'CREATE TABLE Preserved(value TEXT); INSERT INTO Preserved VALUES (\'must-survive\'); CREATE TABLE ItemTable(foo TEXT);');
		const originalContents = fs.readFileSync(storagePath);
		const storage = new RemoteLogicalWorkspaceStateStorage(storagePath, new NullLogService());
		const channel = new RemoteLogicalWorkspaceStateChannel(storage);

		try {
			const initialize = await channel.call<IRemoteLogicalWorkspaceStateResult<IRemoteLogicalWorkspaceStateSnapshot>>(
				undefined,
				RemoteLogicalWorkspaceStateCommand.Initialize,
				{ physicalWorkspaceId: 'physical', state: state('workspace') },
			);
			storage.dispose();

			assert.deepStrictEqual({
				initialize: initialize.status === 'error' ? { status: initialize.status, code: initialize.code } : initialize,
				storageUnchanged: fs.readFileSync(storagePath).equals(originalContents),
				backupCreated: fs.existsSync(`${storagePath}.backup`),
			}, {
				initialize: { status: 'error', code: RemoteLogicalWorkspaceStateErrorCode.StorageUnavailable },
				storageUnchanged: true,
				backupCreated: false,
			});
		} finally {
			storage.dispose();
			fs.rmSync(testDir, { recursive: true, force: true });
		}
	});

	test('does not offer recovery when the initial database read fails', async function () {
		this.timeout(10000);
		const testDir = getRandomTestPath(os.tmpdir(), 'vsctests', 'logical-workspace-read-failure');
		const storagePath = join(testDir, 'logical-workspaces.vscdb');
		fs.mkdirSync(testDir, { recursive: true });
		const database = new FailInitialReadStorageDatabase(new SQLiteStorageDatabase(storagePath));
		const storage = new RemoteLogicalWorkspaceStateStorage(storagePath, new NullLogService(), () => database);
		const channel = new RemoteLogicalWorkspaceStateChannel(storage);

		try {
			const read = await channel.call<IRemoteLogicalWorkspaceStateResult<IRemoteLogicalWorkspaceStateSnapshot | undefined>>(
				undefined,
				RemoteLogicalWorkspaceStateCommand.Read,
				{ physicalWorkspaceId: 'physical' },
			);
			storage.dispose();
			const recoveryProvided = await database.whenClosed;

			assert.deepStrictEqual({
				read: read.status === 'error' ? { status: read.status, code: read.code } : read,
				recoveryProvided,
			}, {
				read: { status: 'error', code: RemoteLogicalWorkspaceStateErrorCode.StorageUnavailable },
				recoveryProvided: false,
			});
		} finally {
			storage.dispose();
			fs.rmSync(testDir, { recursive: true, force: true });
		}
	});
});
