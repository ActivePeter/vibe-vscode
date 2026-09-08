/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { language } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService, MODAL_GROUP } from '../../../services/editor/common/editorService.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../services/environment/browser/environmentService.js';
import { ISimHostContext, ISimMessage, isSafeSimPath, SIM_DEFAULT_PATH, SimSurface } from '../common/sim.js';
import { SimEditorInput } from './simEditorInput.js';
import { resolveSimBaseUrl, SimFrame } from './simFrame.js';

export const ISimWorkbenchService = createDecorator<ISimWorkbenchService>('simWorkbenchService');

export interface ISimSurface extends IDisposable {
	focus(): void;
}

export interface ISimWorkbenchService {
	readonly _serviceBrand: undefined;
	mount(parent: HTMLElement, surface: SimSurface, input?: SimEditorInput): ISimSurface;
	openEditor(path?: unknown, fullscreen?: boolean): Promise<void>;
	closeFullscreen(): Promise<void>;
	updateContext(context: ISimHostContext): void;
}

/** Composes Sim surfaces and routes. The built-in extension retains VS Code API capabilities. */
export class SimWorkbenchService extends Disposable implements ISimWorkbenchService {
	declare readonly _serviceBrand: undefined;
	private static readonly routeStorageKey = 'vibe.sim.route';
	private readonly frames = new Set<SimFrame>();
	private readonly pendingInputs = new Set<SimEditorInput>();
	private context: ISimHostContext = { language };
	private contextGeneration = 0;
	private path: string;
	private pendingFullscreen: Promise<void> | undefined;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@IBrowserWorkbenchEnvironmentService private readonly environmentService: IBrowserWorkbenchEnvironmentService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		const path = storageService.get(SimWorkbenchService.routeStorageKey, StorageScope.WORKSPACE);
		this.path = isSafeSimPath(path) ? path : SIM_DEFAULT_PATH;
		this._register(toDisposable(() => {
			for (const frame of this.frames) {
				frame.dispose();
			}
			this.frames.clear();
		}));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('vibe-vscode.sim.baseUrl')) {
				for (const frame of this.frames) {
					frame.setBaseUrl(this.baseUrl());
				}
			}
		}));
	}

	mount(parent: HTMLElement, surface: SimSurface, input?: SimEditorInput): ISimSurface {
		if (input && isSafeSimPath(input.path)) {
			this.navigate(input.path);
		}
		const authPath = `${(this.environmentService.options?.serverBasePath ?? '').replace(/\/$/, '')}/auth`;
		const frame = new SimFrame(parent, surface, this.baseUrl(), this.path, this.context, authPath, message => {
			void this.handleMessage(frame, message).catch(error => this.notificationService.error(error));
		});
		this.frames.add(frame);
		void this.refreshContext();
		return {
			focus: () => frame.focus(),
			dispose: () => {
				this.frames.delete(frame);
				frame.dispose();
			},
		};
	}

	async openEditor(path?: unknown, fullscreen = false): Promise<void> {
		if (path !== undefined && !isSafeSimPath(path)) {
			return;
		}
		if (isSafeSimPath(path)) {
			this.navigate(path);
		}
		if (!fullscreen) {
			return this.doOpenEditor(false);
		}
		if (!this.pendingFullscreen) {
			this.pendingFullscreen = this.doOpenEditor(true);
		}
		const pending = this.pendingFullscreen;
		try {
			await pending;
		} finally {
			if (this.pendingFullscreen === pending) {
				this.pendingFullscreen = undefined;
			}
		}
	}

	async closeFullscreen(): Promise<void> {
		const modal = this.editorGroupsService.activeModalEditorPart;
		if (modal?.activeGroup.activeEditor instanceof SimEditorInput && modal.activeGroup.activeEditor.fullscreen) {
			await modal.close();
		}
	}

	updateContext(context: ISimHostContext): void {
		this.contextGeneration++;
		this.context = context;
		for (const frame of this.frames) {
			frame.setContext(context);
		}
	}

	private async refreshContext(): Promise<void> {
		const generation = this.contextGeneration;
		try {
			// Command activation is the extension's readiness gate. An intervening context event wins.
			const context = await this.commandService.executeCommand<ISimHostContext>('_vibe-vscode.sim.getContext');
			if (!this._store.isDisposed && generation === this.contextGeneration && context) {
				this.updateContext(context);
			}
		} catch {
			// Sim can render before the extension host connects; a later surface/context event retries.
		}
	}

	private async doOpenEditor(fullscreen: boolean): Promise<void> {
		const existing = this.editorService.editors.find((input): input is SimEditorInput => input instanceof SimEditorInput && input.fullscreen === fullscreen);
		const modal = this.editorGroupsService.activeModalEditorPart;
		if (fullscreen && modal && (!existing || modal.activeGroup.activeEditor !== existing)) {
			throw new Error(localize('sim.modalConflict', "Close the current modal editor before opening Sim fullscreen."));
		}
		const input = existing ?? new SimEditorInput(this.path, fullscreen);
		this.pendingInputs.add(input);
		try {
			await this.editorService.openEditor(input, { pinned: true, revealIfOpened: true, modal: fullscreen ? { fullscreen: true } : undefined }, fullscreen ? MODAL_GROUP : undefined);
		} finally {
			this.pendingInputs.delete(input);
			if (!existing && !this.editorService.editors.includes(input)) {
				input.dispose();
			}
		}
	}

	private baseUrl(): URL | undefined {
		return resolveSimBaseUrl(this.configurationService.getValue<string>('vibe-vscode.sim.baseUrl') ?? '', mainWindow.location.href);
	}

	private navigate(path: string, source?: SimFrame): void {
		this.path = path;
		this.storageService.store(SimWorkbenchService.routeStorageKey, path, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		for (const input of [...this.editorService.editors, ...this.pendingInputs]) {
			if (input instanceof SimEditorInput) {
				input.path = path;
			}
		}
		for (const frame of this.frames) {
			if (frame !== source) {
				frame.navigate(path);
			}
		}
	}

	private async handleMessage(frame: SimFrame, message: ISimMessage): Promise<void> {
		const path = message.payload?.path;
		if (message.type === 'openEditor' && isSafeSimPath(path)) {
			await this.openEditor(path);
		} else if (message.type === 'routeChanged' && isSafeSimPath(path)) {
			if (frame.surface === 'sidebar' && message.payload?.userInitiated) {
				await this.openEditor(path);
			} else if (frame.surface !== 'sidebar' || !this.editorService.editors.some(input => input instanceof SimEditorInput)) {
				this.navigate(path, frame);
			}
		} else {
			// Do not forward arbitrary command names or let a payload replace the validated type.
			await this.commandService.executeCommand('_vibe-vscode.sim.resource', { ...message.payload, type: message.type });
		}
	}
}
