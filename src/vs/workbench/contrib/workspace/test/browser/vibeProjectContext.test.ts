/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { VibeProjectContext } from 'vibe-vscode';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { ILogicalWorkspace, ILogicalWorkspaceService } from '../../../../services/logicalWorkspace/common/logicalWorkspace.js';
import { IProjectContextService } from '../../browser/projectContext.js';
import { VibeProjectContextService } from '../../browser/vibeProjectContext.js';

suite('VibeProjectContext plugin boundary', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function create(gates: { physical?: Promise<void>; logical?: Promise<void>; project?: Promise<void> } = {}) {
		const changes = disposables.add(new Emitter<void>());
		const uri = URI.parse('vscode-remote://runner.test/project');
		const folder: IWorkspaceFolder = { name: 'Project', uri, index: 0, toResource: path => URI.joinPath(uri, path) };
		const state = {
			workspace: { id: 'physical', folders: [folder] } as IWorkspace,
			logical: { id: 'logical', name: 'Work', terminalIds: [], shellLayout: undefined } as ILogicalWorkspace,
			project: folder as IWorkspaceFolder | undefined,
		};
		const notifications: VibeProjectContext[] = [];
		const service = disposables.add(new VibeProjectContextService(
			new class extends mock<IWorkspaceContextService>() {
				override onDidChangeWorkspaceFolders = Event.None;
				override onDidChangeWorkspaceName = changes.event;
				override getWorkspace() { return state.workspace; }
				override async getCompleteWorkspace() { await gates.physical; return state.workspace; }
			}(),
			new class extends mock<ILogicalWorkspaceService>() {
				override whenReady = gates.logical ?? Promise.resolve();
				override onDidChangeWorkspaces = changes.event;
				override onDidChangeActiveWorkspace = Event.None;
				override get activeWorkspace() { return state.logical; }
				override get workspaces() { return [state.logical]; }
			}(),
			new class extends mock<IProjectContextService>() {
				override whenReady = gates.project ?? Promise.resolve();
				override onDidChangeProjectContext = changes.event;
				override get selectedFolder() { return state.project; }
			}(),
			new class extends mock<IWorkbenchEnvironmentService>() {
				override remoteAuthority = 'runner.test';
			}(),
			new class extends mock<ICommandService>() {
				override async executeCommand<T>(id: string, snapshot: VibeProjectContext): Promise<T> {
					assert.strictEqual(id, '_vibe-vscode.projectContext.changed');
					notifications.push(snapshot);
					return undefined as T;
				}
			}(),
			new NullLogService(),
		));
		return { service, state, changes, notifications };
	}

	test('waits for physical, logical and project authorities, never publishing provisional absence', async () => {
		const physical = new DeferredPromise<void>();
		const logical = new DeferredPromise<void>();
		const project = new DeferredPromise<void>();
		const { service, state, changes, notifications } = create({ physical: physical.p, logical: logical.p, project: project.p });
		const pending = service.getSnapshot();
		state.logical = { ...state.logical, id: 'authoritative' };
		changes.fire();
		await physical.complete();
		await logical.complete();
		await timeout(0);
		assert.strictEqual(notifications.length, 0);
		await project.complete();
		const snapshot = await pending;
		assert.deepStrictEqual({ logical: snapshot.logicalWorkspace?.id, remote: snapshot.physicalWorkspace.remoteAuthority, notifications: notifications.length }, {
			logical: 'authoritative', remote: 'runner.test', notifications: 1,
		});
	});

	test('captures a ready initiating context before later switches and freezes all shared fields', async () => {
		const { service, state, changes } = create();
		await service.getSnapshot();
		const pending = service.getSnapshot();
		state.logical = { ...state.logical, id: 'later' };
		changes.fire();
		const initiating = await pending;
		const current = await service.getSnapshot();
		assert.deepStrictEqual({ initiating: initiating.logicalWorkspace?.id, current: current.logicalWorkspace?.id, frozen: Object.isFrozen(initiating.physicalWorkspace.folders[0]) }, {
			initiating: 'logical', current: 'later', frozen: true,
		});
	});

	test('notifies same-target content changes once and permits authoritative empty catalogs', async () => {
		const { service, state, changes, notifications } = create();
		await service.getSnapshot();
		state.logical = { ...state.logical, name: 'Renamed' };
		changes.fire();
		changes.fire();
		state.workspace = { ...state.workspace, folders: [] };
		state.project = undefined;
		changes.fire();
		assert.deepStrictEqual(notifications.map(snapshot => ({ generation: snapshot.generation, name: snapshot.logicalWorkspace?.name, folders: snapshot.physicalWorkspace.folders.length })), [
			{ generation: 1, name: 'Work', folders: 1 },
			{ generation: 2, name: 'Renamed', folders: 1 },
			{ generation: 3, name: 'Renamed', folders: 0 },
		]);
	});

	test('a rejected readiness read remains an error, not a persisted empty catalog', async () => {
		const gate = new DeferredPromise<void>();
		const { service, notifications } = create({ logical: gate.p });
		const pending = service.getSnapshot();
		await gate.error(new Error('Authority unavailable'));
		await assert.rejects(pending, /Authority unavailable/);
		assert.deepStrictEqual(notifications, []);
	});

	test('disposal releases subscriptions and suppresses late readiness notifications', async () => {
		const gate = new DeferredPromise<void>();
		const { service, changes, notifications } = create({ project: gate.p });
		const pending = service.getSnapshot();
		service.dispose();
		await gate.complete();
		await assert.rejects(pending, /disposed/);
		changes.fire();
		assert.deepStrictEqual(notifications, []);
	});
});
