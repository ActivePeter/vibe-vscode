/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { Sequencer } from '../../base/common/async.js';
import { toErrorMessage } from '../../base/common/errorMessage.js';
import { Event } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { dirname } from '../../base/common/path.js';
import { InMemoryStorageDatabase, IStorageDatabase } from '../../base/parts/storage/common/storage.js';
import { SQLiteStorageDatabase } from '../../base/parts/storage/node/storage.js';
import { IServerChannel } from '../../base/parts/ipc/common/ipc.js';
import { ILogService, LogLevel } from '../../platform/log/common/log.js';
import { applyLogicalWorkspaceMutation, ILogicalWorkspaceMutation, ILogicalWorkspaceSharedState, parseLogicalWorkspaceMutation, parseLogicalWorkspaceSharedState } from '../../workbench/services/logicalWorkspace/common/logicalWorkspace.js';
import { IRemoteLogicalWorkspaceStateResult, IRemoteLogicalWorkspaceStateSnapshot, RemoteLogicalWorkspaceStateCommand, RemoteLogicalWorkspaceStateErrorCode } from '../../workbench/services/logicalWorkspace/common/logicalWorkspaceRemote.js';

interface IStoredLogicalWorkspaceState {
	readonly storageVersion: 1;
	readonly revision: number;
	readonly state: ILogicalWorkspaceSharedState;
}

class CorruptLogicalWorkspaceStateError extends Error { }
class UninitializedLogicalWorkspaceStateError extends Error { }
class UnavailableLogicalWorkspaceStateStorageError extends Error { }

/**
 * Owns the server-side Logical Workspace database. A single sequencer establishes one mutation
 * order for every renderer connected to this remote agent.
 */
export class RemoteLogicalWorkspaceStateStorage extends Disposable {

	private readonly sequencer = new Sequencer();
	private readonly confirmedItems = new Map<string, string>();
	private readonly whenReady: Promise<IStorageDatabase>;
	private database: IStorageDatabase | undefined;

	constructor(
		private readonly storagePath: string | undefined,
		private readonly logService: ILogService,
		private readonly databaseFactory?: (storagePath: string | undefined) => IStorageDatabase,
	) {
		super();
		this.whenReady = this.createDatabase();
		void this.whenReady.catch(error => this.logService.error('The remote Logical Workspace state database is unavailable', error));
	}

	read(physicalWorkspaceId: string): Promise<IRemoteLogicalWorkspaceStateSnapshot | undefined> {
		return this.sequencer.queue(() => this.doRead(physicalWorkspaceId));
	}

	initialize(physicalWorkspaceId: string, state: ILogicalWorkspaceSharedState): Promise<IRemoteLogicalWorkspaceStateSnapshot> {
		return this.sequencer.queue(async () => {
			const current = await this.doRead(physicalWorkspaceId);
			if (current) {
				return current;
			}

			const snapshot: IRemoteLogicalWorkspaceStateSnapshot = { revision: 1, state };
			await this.write(physicalWorkspaceId, snapshot);
			return snapshot;
		});
	}

	mutate(physicalWorkspaceId: string, mutation: ILogicalWorkspaceMutation): Promise<IRemoteLogicalWorkspaceStateSnapshot> {
		return this.sequencer.queue(async () => {
			const current = await this.doRead(physicalWorkspaceId);
			if (!current) {
				throw new UninitializedLogicalWorkspaceStateError(`Logical Workspace state '${physicalWorkspaceId}' has not been initialized`);
			}

			const state = applyLogicalWorkspaceMutation(current.state, mutation);
			if (state === current.state) {
				return current;
			}
			if (current.revision === Number.MAX_SAFE_INTEGER) {
				throw new Error(`Logical Workspace state '${physicalWorkspaceId}' exhausted its revision range`);
			}

			const snapshot: IRemoteLogicalWorkspaceStateSnapshot = { revision: current.revision + 1, state };
			await this.write(physicalWorkspaceId, snapshot);
			return snapshot;
		});
	}

	private async createDatabase(): Promise<IStorageDatabase> {
		try {
			if (this.storagePath) {
				await fs.promises.mkdir(dirname(this.storagePath), { recursive: true });
			}
			const database = this.databaseFactory?.(this.storagePath) ?? (this.storagePath
				? new SQLiteStorageDatabase(this.storagePath, {
					failOnOpenError: true,
					logging: {
						logTrace: this.logService.getLevel() === LogLevel.Trace ? message => this.logService.trace(message) : undefined,
						logError: error => this.logService.error(error),
					},
				})
				: new InMemoryStorageDatabase());
			this.database = database;
			for (const [key, value] of await database.getItems()) {
				this.confirmedItems.set(key, value);
			}
			return database;
		} catch (error) {
			throw new UnavailableLogicalWorkspaceStateStorageError(`The Logical Workspace state database is unavailable. No automatic recovery was attempted: ${toErrorMessage(error)}`);
		}
	}

	private async doRead(physicalWorkspaceId: string): Promise<IRemoteLogicalWorkspaceStateSnapshot | undefined> {
		await this.whenReady;
		const raw = this.confirmedItems.get(this.storageKey(physicalWorkspaceId));
		if (raw === undefined) {
			return undefined;
		}

		try {
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== 'object') {
				throw new Error('record is not an object');
			}
			const candidate = parsed as Record<string, unknown>;
			const state = parseLogicalWorkspaceSharedState(candidate.state);
			if (candidate.storageVersion !== 1 || !Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 1 || !state) {
				throw new Error('record has an unsupported shape');
			}
			return { revision: candidate.revision as number, state };
		} catch (error) {
			throw new CorruptLogicalWorkspaceStateError(`Remote Logical Workspace state '${physicalWorkspaceId}' is corrupt: ${toErrorMessage(error)}`);
		}
	}

	private async write(physicalWorkspaceId: string, snapshot: IRemoteLogicalWorkspaceStateSnapshot): Promise<void> {
		const database = await this.whenReady;
		const storedState: IStoredLogicalWorkspaceState = {
			storageVersion: 1,
			revision: snapshot.revision,
			state: snapshot.state,
		};
		const key = this.storageKey(physicalWorkspaceId);
		const raw = JSON.stringify(storedState);
		await database.updateItems({ insert: new Map([[key, raw]]) });
		this.confirmedItems.set(key, raw);
	}

	private storageKey(physicalWorkspaceId: string): string {
		return `workspace.${physicalWorkspaceId}`;
	}

	override dispose(): void {
		const database = this.database;
		this.database = undefined;
		if (database) {
			void database.close(() => new Map(this.confirmedItems)).catch(error => this.logService.error('Failed to close the remote Logical Workspace state database', error));
		}
		super.dispose();
	}
}

export class RemoteLogicalWorkspaceStateChannel implements IServerChannel {

	constructor(private readonly storage: RemoteLogicalWorkspaceStateStorage) { }

	listen<T>(_context: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_context: unknown, command: string, arg: unknown): Promise<T> {
		const physicalWorkspaceId = this.parsePhysicalWorkspaceId(arg);
		if (!physicalWorkspaceId) {
			return this.error(RemoteLogicalWorkspaceStateErrorCode.InvalidRequest, 'A valid physical Workspace ID is required') as T;
		}

		try {
			switch (command) {
				case RemoteLogicalWorkspaceStateCommand.Read:
					return this.ok(await this.storage.read(physicalWorkspaceId)) as T;
				case RemoteLogicalWorkspaceStateCommand.Initialize: {
					const state = parseLogicalWorkspaceSharedState((arg as Record<string, unknown>).state);
					return (state
						? this.ok(await this.storage.initialize(physicalWorkspaceId, state))
						: this.error(RemoteLogicalWorkspaceStateErrorCode.InvalidRequest, 'A valid initial Logical Workspace state is required')) as T;
				}
				case RemoteLogicalWorkspaceStateCommand.Mutate: {
					const mutation = parseLogicalWorkspaceMutation((arg as Record<string, unknown>).mutation);
					return (mutation
						? this.ok(await this.storage.mutate(physicalWorkspaceId, mutation))
						: this.error(RemoteLogicalWorkspaceStateErrorCode.InvalidRequest, 'A valid Logical Workspace mutation is required')) as T;
				}
				default:
					return this.error(RemoteLogicalWorkspaceStateErrorCode.InvalidRequest, `Call not found: ${command}`) as T;
			}
		} catch (error) {
			if (error instanceof UnavailableLogicalWorkspaceStateStorageError) {
				return this.error(RemoteLogicalWorkspaceStateErrorCode.StorageUnavailable, error.message) as T;
			}
			if (error instanceof CorruptLogicalWorkspaceStateError) {
				return this.error(RemoteLogicalWorkspaceStateErrorCode.CorruptState, error.message) as T;
			}
			if (error instanceof UninitializedLogicalWorkspaceStateError) {
				return this.error(RemoteLogicalWorkspaceStateErrorCode.NotInitialized, error.message) as T;
			}
			throw error;
		}
	}

	private parsePhysicalWorkspaceId(arg: unknown): string | undefined {
		if (!arg || typeof arg !== 'object') {
			return undefined;
		}
		const physicalWorkspaceId = (arg as Record<string, unknown>).physicalWorkspaceId;
		return typeof physicalWorkspaceId === 'string' && physicalWorkspaceId.length > 0 && physicalWorkspaceId.length <= 1024
			? physicalWorkspaceId
			: undefined;
	}

	private ok<T>(value: T): IRemoteLogicalWorkspaceStateResult<T> {
		return { status: 'ok', value };
	}

	private error(code: RemoteLogicalWorkspaceStateErrorCode, message: string): IRemoteLogicalWorkspaceStateResult<never> {
		return { status: 'error', code, message };
	}
}
