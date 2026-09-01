/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { EditorsOrder } from '../../../common/editor.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILogicalWorkspaceProjection, ILogicalWorkspaceProjectionContext, LogicalWorkspaceProjectionCoordinator } from '../../../services/logicalWorkspace/browser/logicalWorkspaceProjection.js';
import { ILogicalWorkspaceEditorProjectionService, ILogicalWorkspaceService, ILogicalWorkspaceStateSnapshot, ILogicalWorkspaceTerminalProjectionService } from '../../../services/logicalWorkspace/common/logicalWorkspace.js';

/**
 * Keeps each Logical Workspace's editor groups and open editors in its shared snapshot.
 */
export class LogicalWorkspaceEditorAdapter extends Disposable implements ILogicalWorkspaceEditorProjectionService, ILogicalWorkspaceProjection {

	static readonly ID = 'workbench.contrib.logicalWorkspaceEditorAdapter';
	declare readonly _serviceBrand: undefined;
	readonly id = LogicalWorkspaceEditorAdapter.ID;
	readonly whenReady: Promise<void>;

	private readonly captureScheduler = this._register(new RunOnceScheduler(() => this.captureProjectedWorkspace(), 250));
	private readonly webviewStateListeners = this._register(new MutableDisposable<DisposableStore>());
	private readonly projectionCoordinator: LogicalWorkspaceProjectionCoordinator;
	private projectedWorkspaceId: string | undefined;
	private restoring = false;

	constructor(
		@ILogicalWorkspaceService private readonly logicalWorkspaceService: ILogicalWorkspaceService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@ILogicalWorkspaceTerminalProjectionService private readonly terminalProjectionService: ILogicalWorkspaceTerminalProjectionService,
		@IStorageService storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(editorService.onDidEditorsChange(() => {
			this.refreshWebviewStateListeners();
			this.scheduleCapture();
		}));
		this.projectionCoordinator = this._register(new LogicalWorkspaceProjectionCoordinator(logicalWorkspaceService, this, storageService, logService));
		this.whenReady = this.projectionCoordinator.whenReady;
	}

	stateSlice(state: ILogicalWorkspaceStateSnapshot): unknown {
		return {
			activeWorkspaceId: state.activeWorkspaceId,
			editorWorkingSet: state.workspaces.find(workspace => workspace.id === state.activeWorkspaceId)?.editorWorkingSet,
		};
	}

	capture(workspaceId: string): void {
		if (this.restoring || this.projectedWorkspaceId !== workspaceId) {
			return;
		}
		this.logicalWorkspaceService.setEditorWorkingSet(workspaceId, this.editorGroupsService.serializeWorkingSet());
	}

	async restore(context: ILogicalWorkspaceProjectionContext): Promise<boolean> {
		await this.editorGroupsService.whenReady;
		await this.terminalProjectionService.requestReconcile();
		if (!context.isCurrent()) {
			return false;
		}
		this.captureScheduler.cancel();
		this.restoring = true;
		try {
			let applied = true;
			if (context.workspace.editorWorkingSet || context.activationSequence > 0) {
				this.terminalProjectionService.prepareEditorTerminalsForWorkingSet(context.workspace.id, context.activationSequence);
				if (!context.isCurrent()) {
					return false;
				}
			}
			if (context.workspace.editorWorkingSet) {
				applied = await this.editorGroupsService.applySerializedWorkingSet(context.workspace.editorWorkingSet);
			} else if (context.activationSequence > 0) {
				applied = await this.editorGroupsService.applyWorkingSet('empty');
			}
			if (!context.isCurrent()) {
				return false;
			}
			if (!applied) {
				this.projectedWorkspaceId = undefined;
				this.logService.warn(`Logical workspace editor working set could not be restored: ${context.workspace.id}`);
				return false;
			}
			const restoredUnclaimedEditorTerminals = await this.terminalProjectionService.restoreUnclaimedEditorTerminals(context.workspace.id, context.activationSequence);
			if (!context.isCurrent()) {
				return false;
			}
			this.projectedWorkspaceId = context.workspace.id;
			this.refreshWebviewStateListeners();
			if (restoredUnclaimedEditorTerminals) {
				// Persist the fallback placement on the next guarded capture so reload can adopt the
				// same PTY through the normal editor working-set serializer.
				this.captureScheduler.schedule();
			}
			return true;
		} catch (error) {
			this.projectedWorkspaceId = undefined;
			throw error;
		} finally {
			this.restoring = false;
		}
	}

	private scheduleCapture(): void {
		if (!this.restoring && this.projectedWorkspaceId === this.logicalWorkspaceService.activeWorkspace.id) {
			this.captureScheduler.schedule();
		}
	}

	private captureProjectedWorkspace(): void {
		const workspaceId = this.projectedWorkspaceId;
		if (workspaceId && workspaceId === this.logicalWorkspaceService.activeWorkspace.id) {
			this.projectionCoordinator.captureProjectedState(workspaceId);
		}
	}

	private refreshWebviewStateListeners(): void {
		const listeners = new DisposableStore();
		for (const { editor } of this.editorService.getEditors(EditorsOrder.SEQUENTIAL)) {
			if (editor instanceof WebviewInput) {
				listeners.add(editor.webview.onDidUpdateState(() => this.scheduleCapture()));
			}
		}
		this.webviewStateListeners.value = listeners;
	}
}

registerSingleton(ILogicalWorkspaceEditorProjectionService, LogicalWorkspaceEditorAdapter, InstantiationType.Delayed);
