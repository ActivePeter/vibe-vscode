/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../services/environment/browser/environmentService.js';

const accountMenu = new MenuId('VibeAuthenticationAccount');

export class VibeAuthenticationContribution extends Disposable {
	static readonly ID = 'workbench.contrib.vibeAuthentication';
	readonly ready: Promise<void>;

	constructor(@IBrowserWorkbenchEnvironmentService environmentService: IBrowserWorkbenchEnvironmentService) {
		super();
		const authPath = `${(environmentService.options?.serverBasePath ?? '').replace(/\/$/, '')}/auth`;
		this.ready = this.initialize(authPath);
	}

	protected requestStatus(url: string, signal: AbortSignal): Promise<Response> {
		return mainWindow.fetch(url, { credentials: 'same-origin', cache: 'no-store', signal });
	}

	protected navigate(url: string): void {
		mainWindow.location.assign(url);
	}

	private async initialize(authPath: string): Promise<void> {
		const controller = new AbortController();
		this._register(toDisposable(() => controller.abort()));
		try {
			const response = await this.requestStatus(`${authPath}/api/status`, controller.signal);
			if (!response.ok) {
				return;
			}
			const status: { authenticated?: boolean; username?: string } | null = await response.json();
			if (this._store.isDisposed || status?.authenticated !== true || typeof status.username !== 'string' || !status.username) {
				return;
			}

			const signOut = () => this.navigate(`${authPath}/logout`);
			this._register(registerAction2(class extends Action2 {
				constructor() {
					super({
						id: 'workbench.action.vibeAuthentication.signOut',
						title: localize2('signOut', "Sign Out"),
						category: { value: 'vibe-vscode', original: 'vibe-vscode' },
						f1: true,
						menu: { id: accountMenu },
					});
				}
				run(): void { signOut(); }
			}));
			this._register(MenuRegistry.appendMenuItem(MenuId.AccountsContext, {
				submenu: accountMenu,
				title: localize('instanceAccount', "{0} (vibe-vscode)", status.username),
				group: '0_vibe_account',
			}));
		} catch {
			// Authentication is optional in other web deployments; an unavailable status
			// endpoint or a disposed workbench must not add an account or interrupt startup.
		}
	}
}
