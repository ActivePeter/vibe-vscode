/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentConnection } from '../../../../../platform/agentHost/common/agentService.js';
import { ICreateContributedTerminalProfileOptions, ITerminalCreationContext } from '../../../../../platform/terminal/common/terminal.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { AgentHostTerminalService } from '../../browser/agentHostTerminalService.js';
import { ICreateTerminalOptions, ITerminalChatService, ITerminalInstance, ITerminalService } from '../../browser/terminal.js';
import { ITerminalProfileProvider, ITerminalProfileService } from '../../common/terminal.js';

suite('AgentHostTerminalService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('forwards contributed profile creation identity to the terminal instance', async () => {
		const store = disposables.add(new DisposableStore());
		let provider: ITerminalProfileProvider | undefined;
		let terminalOptions: ICreateTerminalOptions | undefined;
		const instance = {
			onDisposed: Event.None,
		} satisfies Partial<ITerminalInstance> as ITerminalInstance;
		const terminalService = {
			async createTerminal(options?: ICreateTerminalOptions) {
				terminalOptions = options;
				return instance;
			},
		} satisfies Partial<ITerminalService> as ITerminalService;
		const terminalProfileService = new class extends mock<ITerminalProfileService>() {
			override registerTerminalProfileProvider(_extensionIdentifier: string, _id: string, value: ITerminalProfileProvider) {
				provider = value;
				return toDisposable(() => { });
			}
			override registerInternalContributedProfile() { return toDisposable(() => { }); }
		};
		const service = store.add(new AgentHostTerminalService(
			terminalService,
			new class extends mock<ITerminalChatService>() { },
			terminalProfileService,
			new class extends mock<IQuickInputService>() { },
		));
		const connection = { clientId: 'agent-host' } satisfies Partial<IAgentConnection> as IAgentConnection;
		store.add(service.registerEntry({ name: 'Host', address: 'host', getConnection: () => connection }));
		const creationContext: ITerminalCreationContext = {
			logicalWorkspaceId: 'workspace-a',
			logicalTerminalId: 'terminal-a',
		};
		const options: ICreateContributedTerminalProfileOptions = {
			cwd: URI.file('/workspace'),
			creationContext,
		};

		await provider?.createContributedTerminalProfile(options);

		assert.strictEqual(terminalOptions?.creationContext, creationContext);
	});
});
