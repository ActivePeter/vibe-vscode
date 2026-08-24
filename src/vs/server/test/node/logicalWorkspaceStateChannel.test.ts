/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { ILogicalWorkspaceSharedState, ILogicalWorkspaceShellLayout, LogicalWorkspaceMutationType } from '../../../workbench/services/logicalWorkspace/common/logicalWorkspace.js';
import { IRemoteLogicalWorkspaceStateResult, IRemoteLogicalWorkspaceStateSnapshot, RemoteLogicalWorkspaceStateCommand } from '../../../workbench/services/logicalWorkspace/common/logicalWorkspaceRemote.js';
import { RemoteLogicalWorkspaceStateChannel, RemoteLogicalWorkspaceStateStorage } from '../../node/logicalWorkspaceStateChannel.js';

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
});
