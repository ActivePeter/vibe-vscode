/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MenuId, MenuRegistry, isIMenuItem, isISubmenuItem } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../../services/environment/browser/environmentService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { VibeAuthenticationContribution } from '../../browser/vibeAuthenticationAccount.js';

suite('VibeAuthenticationContribution', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const commandId = 'workbench.action.vibeAuthentication.signOut';

	function create(requestStatus: (url: string, signal: AbortSignal) => Promise<Response>, basePath: string, navigate: (url: string) => void = () => { }) {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.stub(IBrowserWorkbenchEnvironmentService, { options: { serverBasePath: basePath } });
		return {
			instantiationService,
			contribution: disposables.add(instantiationService.createInstance(class extends VibeAuthenticationContribution {
				protected override requestStatus(url: string, signal: AbortSignal): Promise<Response> { return requestStatus(url, signal); }
				protected override navigate(url: string): void { navigate(url); }
			})),
		};
	}

	test('adds an independent account submenu and palette command, then navigates to confirmation', async () => {
		let providerSignOutCalls = 0;
		const providerCommandId = 'test.signOutOfProvider';
		disposables.add(CommandsRegistry.registerCommand(providerCommandId, () => providerSignOutCalls++));
		disposables.add(MenuRegistry.appendMenuItem(MenuId.AccountsContext, { command: { id: providerCommandId, title: 'Provider account' } }));
		const previousAccounts = [...MenuRegistry.getMenuItems(MenuId.AccountsContext)];
		const requests: string[] = [];
		const navigations: string[] = [];
		const { contribution, instantiationService } = create(async url => {
			requests.push(url);
			return Response.json({ authenticated: true, username: 'review-admin' });
		}, '/code', url => navigations.push(url));
		await contribution.ready;
		const account = MenuRegistry.getMenuItems(MenuId.AccountsContext).find(item => isISubmenuItem(item) && item.submenu.id === 'VibeAuthenticationAccount');
		assert.ok(account && isISubmenuItem(account));
		const command = CommandsRegistry.getCommand(commandId);
		assert.ok(command);
		const paletteCommand = MenuRegistry.getMenuItems(MenuId.CommandPalette).filter(isIMenuItem).find(item => item.command.id === commandId)?.command;
		instantiationService.invokeFunction(accessor => command.handler(accessor));
		assert.deepStrictEqual({
			requests,
			account: account.title,
			commands: MenuRegistry.getMenuItems(account.submenu).filter(isIMenuItem).map(item => item.command.id),
			palette: { title: paletteCommand?.title, category: paletteCommand?.category },
			navigations,
			previousAccountsPreserved: previousAccounts.every(item => MenuRegistry.getMenuItems(MenuId.AccountsContext).includes(item)),
			providerSignOutCalls,
		}, {
			requests: ['/code/auth/api/status'], account: 'review-admin (vibe-vscode)',
			commands: [commandId],
			palette: { title: { value: 'Sign Out', original: 'Sign Out' }, category: { value: 'vibe-vscode', original: 'vibe-vscode' } },
			navigations: ['/code/auth/logout'], previousAccountsPreserved: true, providerSignOutCalls: 0,
		});
		contribution.dispose();
		assert.deepStrictEqual(MenuRegistry.getMenuItems(MenuId.AccountsContext), previousAccounts);
		assert.strictEqual(CommandsRegistry.getCommand(commandId), undefined);
	});

	for (const [name, response] of [
		['missing endpoint', () => new Response('', { status: 404 })],
		['expired session', () => Response.json({ authenticated: false })],
		['missing username', () => Response.json({ authenticated: true })],
		['invalid JSON', () => new Response('<html>login</html>')],
		['null response', () => Response.json(null)],
	] as const) {
		test(`does not contribute an account for ${name}`, async () => {
			const { contribution } = create(async () => response(), '/');
			await contribution.ready;
			assert.strictEqual(CommandsRegistry.getCommand(commandId), undefined);
		});
	}

	test('ignores network failures', async () => {
		const { contribution } = create(async () => { throw new Error('offline'); }, '');
		await contribution.ready;
		assert.strictEqual(CommandsRegistry.getCommand(commandId), undefined);
	});

	test('aborts on disposal and cannot register after a late response', async () => {
		const pending = new DeferredPromise<Response>();
		let signal: AbortSignal | undefined;
		const { contribution } = create((url, requestSignal) => {
			assert.strictEqual(url, '/auth/api/status');
			signal = requestSignal;
			return pending.p;
		}, '/');
		contribution.dispose();
		await pending.complete(Response.json({ authenticated: true, username: 'late' }));
		await contribution.ready;
		assert.deepStrictEqual({ aborted: signal?.aborted, command: CommandsRegistry.getCommand(commandId) }, { aborted: true, command: undefined });
	});
});
