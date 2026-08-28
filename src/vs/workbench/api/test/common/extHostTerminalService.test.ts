/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type * as vscode from 'vscode';
import { DeferredPromise } from '../../../../base/common/async.js';
import { mock, upcastPartial } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ExtensionIdentifier, IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { ICreateContributedTerminalProfileOptions, IShellLaunchConfigDto } from '../../../../platform/terminal/common/terminal.js';
import { MainContext, MainThreadTerminalServiceShape } from '../../common/extHost.protocol.js';
import { ArgumentProcessor, ExtHostCommands } from '../../common/extHostCommands.js';
import { WorkerExtHostTerminalService } from '../../common/extHostTerminalService.js';
import { TerminalExitReason } from '../../common/extHostTypes.js';
import { IExtHostInitDataService } from '../../common/extHostInitDataService.js';
import { TestRPCProtocol } from './testRPCProtocol.js';

suite('ExtHostTerminalService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('$createContributedProfileTerminal waits for the nested terminal creation', async () => {
		const rpcProtocol = new TestRPCProtocol();
		const creationStarted = new DeferredPromise<void>();
		const releaseCreation = new DeferredPromise<void>();
		let launchConfig: Parameters<MainThreadTerminalServiceShape['$createTerminal']>[1] | undefined;
		rpcProtocol.set(MainContext.MainThreadTerminalService, new class extends mock<MainThreadTerminalServiceShape>() {
			override async $registerProcessSupport(): Promise<void> { }
			override $registerProfileProvider(): void { }
			override $unregisterProfileProvider(): void { }
			override async $createTerminal(extHostTerminalId: string, value: Parameters<MainThreadTerminalServiceShape['$createTerminal']>[1]): Promise<void> {
				launchConfig = value;
				await creationStarted.complete();
				await releaseCreation.p;
				service.$acceptTerminalOpened(42, extHostTerminalId, 'Profile Terminal', {} as IShellLaunchConfigDto);
			}
		}());

		const commands = new class extends mock<ExtHostCommands>() {
			override registerArgumentProcessor(_processor: ArgumentProcessor): void { }
		};
		const initData = new class extends mock<IExtHostInitDataService>() {
			override readonly remote = { authority: 'test+remote', isRemote: true, connectionData: null };
		};
		const service = store.add(new WorkerExtHostTerminalService(commands, rpcProtocol, initData));
		const extension = upcastPartial<IExtensionDescription>({
			identifier: new ExtensionIdentifier('test.contributed-terminal'),
			enabledApiProposals: [],
		});
		store.add(service.registerProfileProvider(extension, 'test-profile', {
			provideTerminalProfile: () => ({ options: { name: 'Profile Terminal' } }),
		}));
		const creationContext = { logicalWorkspaceId: 'workspace', logicalTerminalId: 'terminal' };
		let completed = false;
		const creation = service.$createContributedProfileTerminal('test-profile', {
			creationContext,
		} satisfies ICreateContributedTerminalProfileOptions).then(() => completed = true);

		await creationStarted.p;
		assert.strictEqual(completed, false);
		await releaseCreation.complete();
		await creation;
		store.add(service.getTerminalById(42)!);

		assert.deepStrictEqual({ completed, creationContext: launchConfig?.creationContext }, {
			completed: true,
			creationContext,
		});
	});

	test('$createContributedProfileTerminal removes provisional terminals after creation failure', async () => {
		const expectedError = new Error('terminal creation failed');
		const rpcProtocol = new TestRPCProtocol();
		rpcProtocol.set(MainContext.MainThreadTerminalService, new class extends mock<MainThreadTerminalServiceShape>() {
			override async $registerProcessSupport(): Promise<void> { }
			override $registerProfileProvider(): void { }
			override $unregisterProfileProvider(): void { }
			override async $createTerminal(): Promise<void> { throw expectedError; }
		}());

		const commands = new class extends mock<ExtHostCommands>() {
			override registerArgumentProcessor(_processor: ArgumentProcessor): void { }
		};
		const initData = new class extends mock<IExtHostInitDataService>() {
			override readonly remote = { authority: 'test+remote', isRemote: true, connectionData: null };
		};
		const service = store.add(new WorkerExtHostTerminalService(commands, rpcProtocol, initData));
		const extension = upcastPartial<IExtensionDescription>({
			identifier: new ExtensionIdentifier('test.failed-contributed-terminal'),
			enabledApiProposals: [],
		});
		store.add(service.registerProfileProvider(extension, 'failed-profile', {
			provideTerminalProfile: () => ({ options: { name: 'Failed Profile Terminal' } }),
		}));

		await assert.rejects(service.$createContributedProfileTerminal('failed-profile', {
			creationContext: { logicalWorkspaceId: 'workspace', logicalTerminalId: 'terminal' },
		}), error => error === expectedError);

		assert.deepStrictEqual(service.terminals, []);
	});

	test('$acceptTerminalClosed cancels in-flight link providers and clears the link cache', async () => {
		const rpcProtocol = new TestRPCProtocol();
		rpcProtocol.set(MainContext.MainThreadTerminalService, new class extends mock<MainThreadTerminalServiceShape>() {
			override async $registerProcessSupport(): Promise<void> { }
			override async $sendProcessExit(): Promise<void> { }
			override $startLinkProvider(): void { }
			override $stopLinkProvider(): void { }
		});

		const commands = new class extends mock<ExtHostCommands>() {
			override registerArgumentProcessor(_processor: ArgumentProcessor): void { }
		};
		const initData = new class extends mock<IExtHostInitDataService>() {
			override readonly remote = { authority: 'test+remote', isRemote: true, connectionData: null };
		};

		const service = store.add(new WorkerExtHostTerminalService(commands, rpcProtocol, initData));

		const terminalId = 42;
		service.$acceptTerminalOpened(terminalId, undefined, 'test', {} as IShellLaunchConfigDto);
		// $acceptTerminalClosed splices the terminal out of `_terminals` but doesn't dispose it,
		// so register it with the test store to keep the leak detector quiet.
		const terminal = service.getTerminalById(terminalId)!;
		store.add(terminal);

		// Link provider that only resolves when the cancellation token fires, so we can observe
		// cancellation as the externally-visible effect of $acceptTerminalClosed.
		let providerTokenCancelled = false;
		let handledAfterClose = false;
		const provider: vscode.TerminalLinkProvider = {
			provideTerminalLinks(_ctx, token) {
				return new Promise(resolve => {
					store.add(token.onCancellationRequested(() => {
						providerTokenCancelled = true;
						resolve([{ startIndex: 0, length: 5, tooltip: 'x' }]);
					}));
				});
			},
			handleTerminalLink() {
				handledAfterClose = true;
			}
		};
		store.add(service.registerLinkProvider(provider));

		const inFlight = service.$provideLinks(terminalId, 'hello');
		await service.$acceptTerminalClosed(terminalId, undefined, TerminalExitReason.Unknown);
		const firstLinks = await inFlight;

		// Any cached links that might have been written before close should have been cleared, so
		// $activateLink for a closed terminal is a no-op.
		service.$activateLink(terminalId, 0);

		// A subsequent $provideLinks for the same id sees a clean slate (terminal is gone -> []).
		const linksAfterClose = await service.$provideLinks(terminalId, 'hello');

		assert.deepStrictEqual(
			{ providerTokenCancelled, firstLinks, linksAfterClose, handledAfterClose },
			{ providerTokenCancelled: true, firstLinks: [], linksAfterClose: [], handledAfterClose: false }
		);
	});
});
