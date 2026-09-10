/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VibeProjectContext } from 'vibe-vscode';
import { deepFreeze, equals } from '../../../../base/common/objects.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { ILogicalWorkspaceService } from '../../../services/logicalWorkspace/common/logicalWorkspace.js';
import { IProjectContextService } from './projectContext.js';

export const IVibeProjectContextService = createDecorator<IVibeProjectContextService>('vibeProjectContextService');

export interface IVibeProjectContextService {
	readonly _serviceBrand: undefined;
	getSnapshot(): Promise<VibeProjectContext>;
}

/** The plugin boundary owns readiness and immutable projections, never project persistence or selection. */
export class VibeProjectContextService extends Disposable implements IVibeProjectContextService {
	declare readonly _serviceBrand: undefined;
	private readonly whenReady: Promise<void>;
	private ready = false;
	private snapshot: VibeProjectContext | undefined;

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogicalWorkspaceService private readonly logicalWorkspaceService: ILogicalWorkspaceService,
		@IProjectContextService private readonly projectContextService: IProjectContextService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.whenReady = Promise.all([
			workspaceContextService.getCompleteWorkspace(), logicalWorkspaceService.whenReady, projectContextService.whenReady,
		]).then(() => {
			this.ready = true;
			this.publish();
		});
		void this.whenReady.catch(error => this.logService.error('Vibe project context is unavailable', error));
		this._register(workspaceContextService.onDidChangeWorkspaceFolders(() => this.publish()));
		this._register(workspaceContextService.onDidChangeWorkspaceName(() => this.publish()));
		this._register(logicalWorkspaceService.onDidChangeWorkspaces(() => this.publish()));
		this._register(logicalWorkspaceService.onDidChangeActiveWorkspace(() => this.publish()));
		this._register(projectContextService.onDidChangeProjectContext(() => this.publish()));
	}

	async getSnapshot(): Promise<VibeProjectContext> {
		if (!this.ready) {
			await this.whenReady;
		}
		if (this._store.isDisposed) {
			throw new Error(localize('vibeProjectContextDisposed', "Vibe project context has been disposed."));
		}
		// No await after readiness: the public command captures the initiating context now.
		this.publish();
		return this.snapshot!;
	}

	private publish(): void {
		if (!this.ready || this._store.isDisposed) {
			return;
		}
		const workspace = this.workspaceContextService.getWorkspace();
		const logical = this.logicalWorkspaceService.activeWorkspace;
		const project = this.projectContextService.selectedFolder;
		const next: VibeProjectContext = {
			version: 1,
			generation: this.snapshot?.generation ?? 0,
			physicalWorkspace: {
				id: workspace.id,
				name: workspace.configuration?.path.split('/').pop() ?? workspace.folders[0]?.name ?? workspace.id,
				remoteAuthority: this.environmentService.remoteAuthority ?? '',
				folders: workspace.folders.map(folder => ({ name: folder.name, uri: folder.uri.toString(), index: folder.index })),
			},
			logicalWorkspaces: this.logicalWorkspaceService.workspaces.map(({ id, name }) => ({ id, name })),
			logicalWorkspace: logical ? { id: logical.id, name: logical.name } : undefined,
			project: project ? { name: project.name, uri: project.uri.toString() } : undefined,
		};
		if (equals(this.snapshot, next)) {
			return;
		}
		this.snapshot = deepFreeze({ ...next, generation: next.generation + 1 });
		// This is a state notification to the extension's exported Event, not a control-flow bus.
		void this.commandService.executeCommand('_vibe-vscode.projectContext.changed', this.snapshot).catch(error => {
			this.logService.debug('Vibe project context subscriber unavailable', error);
		});
	}
}

registerSingleton(IVibeProjectContextService, VibeProjectContextService, InstantiationType.Delayed);

/** Command access also works between extensions running in different Extension Hosts. */
CommandsRegistry.registerCommand('vibe-vscode.getProjectContext', accessor => accessor.get(IVibeProjectContextService).getSnapshot());
