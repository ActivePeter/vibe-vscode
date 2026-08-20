/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

export const LOGICAL_WORKSPACE_SHARED_STATE_KEY = 'vibe.logicalWorkspaceState';
const LOGICAL_WORKSPACE_ACTIVE_SESSION_KEY = 'vibe.logicalWorkspace.activeWorkspaceId';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibe.logicalWorkspace',
	title: localize('vibeLogicalWorkspaceConfigurationTitle', "vibe vscode Logical Workspace"),
	type: 'object',
	properties: {
		[LOGICAL_WORKSPACE_SHARED_STATE_KEY]: {
			type: 'object',
			additionalProperties: true,
			included: false,
			scope: ConfigurationScope.WINDOW,
			description: localize('vibeLogicalWorkspaceStateDescription', "Stores the shared vibe vscode Logical Workspace catalog and resource snapshots."),
		},
	},
});

export const ILogicalWorkspaceStateStore = createDecorator<ILogicalWorkspaceStateStore>('logicalWorkspaceStateStore');

/**
 * Separates shared Workspace state from the current page's active Workspace selection.
 */
export interface ILogicalWorkspaceStateStore {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSharedState: Event<void>;

	readSharedState(): unknown;
	writeSharedState(state: object): void;
	readActiveWorkspaceId(physicalWorkspaceId: string): string | undefined;
	writeActiveWorkspaceId(physicalWorkspaceId: string, workspaceId: string): void;
}

export class LogicalWorkspaceStateStore extends Disposable implements ILogicalWorkspaceStateStore {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSharedState = this._register(new Emitter<void>());
	readonly onDidChangeSharedState = this._onDidChangeSharedState.event;

	private readonly fallbackSessionState = new Map<string, string>();
	private writeQueue = Promise.resolve();
	private pendingSharedState: object | undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(LOGICAL_WORKSPACE_SHARED_STATE_KEY)) {
				this._onDidChangeSharedState.fire();
			}
		}));
	}

	readSharedState(): unknown {
		// While local writes are queued, that newest requested value is the eventual LWW winner.
		// Returning it also prevents an earlier write's change event from rolling memory back.
		return this.pendingSharedState ?? this.configurationService.getValue<unknown>(LOGICAL_WORKSPACE_SHARED_STATE_KEY);
	}

	writeSharedState(state: object): void {
		this.pendingSharedState = state;
		this.writeQueue = this.writeQueue
			.then(() => this.configurationService.updateValue(LOGICAL_WORKSPACE_SHARED_STATE_KEY, state, ConfigurationTarget.WORKSPACE))
			.catch(error => this.logService.error('Logical Workspace shared state could not be saved', error))
			.finally(() => {
				if (this.pendingSharedState === state) {
					this.pendingSharedState = undefined;
				}
			});
	}

	readActiveWorkspaceId(physicalWorkspaceId: string): string | undefined {
		const key = this.activeWorkspaceKey(physicalWorkspaceId);
		try {
			return mainWindow.sessionStorage.getItem(key) ?? this.fallbackSessionState.get(key);
		} catch {
			return this.fallbackSessionState.get(key);
		}
	}

	writeActiveWorkspaceId(physicalWorkspaceId: string, workspaceId: string): void {
		const key = this.activeWorkspaceKey(physicalWorkspaceId);
		this.fallbackSessionState.set(key, workspaceId);
		try {
			mainWindow.sessionStorage.setItem(key, workspaceId);
		} catch {
			// The in-memory fallback keeps this page coherent when browser storage is unavailable.
		}
	}

	private activeWorkspaceKey(physicalWorkspaceId: string): string {
		return `${LOGICAL_WORKSPACE_ACTIVE_SESSION_KEY}.${physicalWorkspaceId}`;
	}
}

registerSingleton(ILogicalWorkspaceStateStore, LogicalWorkspaceStateStore, InstantiationType.Delayed);
