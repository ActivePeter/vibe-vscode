/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { EditorsOrder } from '../../../common/editor.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILogicalWorkspaceProjection, ILogicalWorkspaceProjectionContext, LogicalWorkspaceProjectionCoordinator } from '../../../services/logicalWorkspace/browser/logicalWorkspaceProjection.js';
import { ILogicalWorkspaceService } from '../../../services/logicalWorkspace/common/logicalWorkspace.js';

/**
 * Keeps each Logical Workspace's editor groups and open editors in its shared snapshot.
 */
export class LogicalWorkspaceEditorAdapter extends Disposable implements IWorkbenchContribution, ILogicalWorkspaceProjection {

	static readonly ID = 'workbench.contrib.logicalWorkspaceEditorAdapter';
	readonly id = LogicalWorkspaceEditorAdapter.ID;

	private readonly captureScheduler = this._register(new RunOnceScheduler(() => this.captureProjectedWorkspace(), 250));
	private readonly webviewStateListeners = this._register(new MutableDisposable<DisposableStore>());
	private projectedWorkspaceId: string | undefined;
	private restoring = false;

	constructor(
		@ILogicalWorkspaceService private readonly logicalWorkspaceService: ILogicalWorkspaceService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IStorageService storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(editorService.onDidEditorsChange(() => {
			this.refreshWebviewStateListeners();
			this.scheduleCapture();
		}));
		this._register(new LogicalWorkspaceProjectionCoordinator(logicalWorkspaceService, this, storageService, logService));
	}

	capture(workspaceId: string): void {
		if (this.restoring || this.projectedWorkspaceId !== workspaceId) {
			return;
		}
		this.logicalWorkspaceService.setEditorWorkingSet(workspaceId, this.editorGroupsService.serializeWorkingSet());
	}

	async restore(context: ILogicalWorkspaceProjectionContext): Promise<void> {
		this.captureScheduler.cancel();
		this.restoring = true;
		try {
			let applied = true;
			if (context.workspace.editorWorkingSet) {
				applied = await this.editorGroupsService.applySerializedWorkingSet(context.workspace.editorWorkingSet);
			} else if (context.activationSequence > 0) {
				applied = await this.editorGroupsService.applyWorkingSet('empty');
			}
			if (!context.isCurrent()) {
				return;
			}
			if (!applied) {
				this.logService.warn(`Logical workspace editor working set could not be restored: ${context.workspace.id}`);
				return;
			}
			this.projectedWorkspaceId = context.workspace.id;
			this.refreshWebviewStateListeners();
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
			this.capture(workspaceId);
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
