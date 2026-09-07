/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MenuId, MenuRegistry, isIMenuItem, isISubmenuItem } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../../services/environment/browser/environmentService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { VibeAuthenticationContribution } from '../../browser/vibeAuthentication.contribution.js';

declare const __readFileInTests: (path: string) => Promise<string>;

suite('VibeAuthenticationContribution', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const commandId = 'workbench.action.vibeAuthentication.signOut';

	function create(requestResource: (url: string, signal: AbortSignal) => Promise<Response>, basePath: string, navigate: (url: string) => void = () => { }, uiLanguage = 'en') {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.stub(IBrowserWorkbenchEnvironmentService, { options: { serverBasePath: basePath } });
		return {
			instantiationService,
			contribution: disposables.add(instantiationService.createInstance(class extends VibeAuthenticationContribution {
				protected override get uiLanguage(): string { return uiLanguage; }
				protected override requestResource(url: string, signal: AbortSignal): Promise<Response> { return requestResource(url, signal); }
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
		instantiationService.invokeFunction(accessor => command.handler(accessor));
		assert.deepStrictEqual({
			requests,
			account: account.title,
			commands: MenuRegistry.getMenuItems(account.submenu).filter(isIMenuItem).map(item => item.command.id),
			palette: MenuRegistry.getMenuItems(MenuId.CommandPalette).filter(isIMenuItem).some(item => item.command.id === commandId),
			navigations,
			previousAccountsPreserved: previousAccounts.every(item => MenuRegistry.getMenuItems(MenuId.AccountsContext).includes(item)),
			providerSignOutCalls,
		}, {
			requests: ['/code/auth/api/status'], account: 'review-admin (vibe-vscode)',
			commands: [commandId], palette: true, navigations: ['/code/auth/logout'], previousAccountsPreserved: true, providerSignOutCalls: 0,
		});
		contribution.dispose();
		assert.deepStrictEqual(MenuRegistry.getMenuItems(MenuId.AccountsContext), previousAccounts);
		assert.strictEqual(CommandsRegistry.getCommand(commandId), undefined);
	});

	for (const locale of ['en', 'zh-cn']) {
		test(`ships the ${locale} command label with an English search alias`, async () => {
			const { contribution } = create(async url => url.endsWith('/auth/api/status')
				? Response.json({ authenticated: true, username: 'review-admin' })
				: new Response(await __readFileInTests(FileAccess.asFileUri('vs/workbench/contrib/vibeAuthentication/browser/vibeAuthentication.nls.zh-cn.json').fsPath)), '', undefined, locale);
			await contribution.ready;
			const command = MenuRegistry.getMenuItems(MenuId.CommandPalette).filter(isIMenuItem).find(item => item.command.id === commandId)?.command;
			assert.deepStrictEqual({ title: command?.title, category: command?.category }, {
				title: { value: locale === 'en' ? 'Sign Out' : '退出登录', original: 'Sign Out' },
				category: { value: 'vibe-vscode', original: 'vibe-vscode' },
			});
		});
	}

	test('keeps the account entry if its optional translation is unavailable', async () => {
		const { contribution } = create(async url => {
			if (url.endsWith('/auth/api/status')) {
				return Response.json({ authenticated: true, username: 'review-admin' });
			}
			throw new Error('offline');
		}, '', undefined, 'zh-cn');
		await contribution.ready;
		assert.ok(CommandsRegistry.getCommand(commandId));
	});

	test('cannot register after disposal while a translation is loading', async () => {
		const started = new DeferredPromise<void>();
		const translation = new DeferredPromise<Response>();
		let signal: AbortSignal | undefined;
		const { contribution } = create(async (url, requestSignal) => {
			if (url.endsWith('/auth/api/status')) {
				return Response.json({ authenticated: true, username: 'review-admin' });
			}
			signal = requestSignal;
			await started.complete();
			return translation.p;
		}, '', undefined, 'zh-cn');
		await started.p;
		contribution.dispose();
		await translation.complete(Response.json({ signOut: '退出登录' }));
		await contribution.ready;
		assert.deepStrictEqual({ aborted: signal?.aborted, command: CommandsRegistry.getCommand(commandId) }, { aborted: true, command: undefined });
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
