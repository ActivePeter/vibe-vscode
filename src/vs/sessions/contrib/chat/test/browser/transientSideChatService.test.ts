/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IChat, ISession } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { AGENT_SESSIONS_TRANSIENT_SIDE_CHAT_SETTING, TransientSideChatService } from '../../browser/transientSideChatService.js';

suite('TransientSideChatService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const sourceChat = upcastPartial<IChat>({
		resource: URI.parse('test:///chat/source'),
		title: constObservable('Source Chat'),
	});
	const sideChat = upcastPartial<IChat>({ resource: URI.parse('test:///chat/side') });
	const session = upcastPartial<ISession>({
		sessionId: 'session',
		resource: URI.parse('test:///session'),
	});

	function setup(onOpenChat?: () => Promise<void>, enabled = true) {
		const calls: string[] = [];
		const didDeleteChat = disposables.add(new Emitter<{ session: ISession; chatResource: URI }>());
		const configurationService = new TestConfigurationService({ [AGENT_SESSIONS_TRANSIENT_SIDE_CHAT_SETTING]: enabled });
		const sessionsService = upcastPartial<ISessionsService>({
			closeChat: async (_session, chat, options) => {
				calls.push(`close:${chat.resource.toString()}:${options?.skipHistory}`);
			},
			openChat: async (_session, chatResource) => {
				calls.push(`open:${chatResource.toString()}`);
				await onOpenChat?.();
			},
		});
		const managementService = upcastPartial<ISessionsManagementService>({
			onDidDeleteSession: Event.None,
			onDidDeleteChat: didDeleteChat.event,
		});
		return {
			service: disposables.add(new TransientSideChatService(sessionsService, managementService, configurationService)),
			calls,
			didDeleteChat,
		};
	}

	test('falls back when the source chat has no live host', async () => {
		const { service, calls } = setup();

		assert.deepStrictEqual({
			shown: await service.show(session, sourceChat, sideChat, 'question'),
			states: service.states.get(),
			calls,
		}, {
			shown: false,
			states: [],
			calls: [],
		});
	});

	test('falls back to full-chat presentation when the experiment-driven setting is disabled', async () => {
		const { service, calls } = setup(undefined, false);
		disposables.add(service.registerHost(sourceChat.resource));

		assert.deepStrictEqual({
			shown: await service.show(session, sourceChat, sideChat, 'question'),
			states: service.states.get(),
			calls,
		}, {
			shown: false,
			states: [],
			calls: [],
		});
	});

	test('shows and promotes through the normal chat path', async () => {
		const { service, calls } = setup();
		disposables.add(service.registerHost(sourceChat.resource));

		const shown = await service.show(session, sourceChat, sideChat, 'question');
		const transient = service.states.get()[0];
		await service.promote(sourceChat.resource);

		assert.deepStrictEqual({
			shown,
			transient: { question: transient?.question, promoting: transient?.promoting },
			states: service.states.get(),
			calls,
		}, {
			shown: true,
			transient: { question: 'question', promoting: false },
			states: [],
			calls: [
				`close:${sideChat.resource.toString()}:true`,
				`open:${sideChat.resource.toString()}`,
			],
		});
	});

	test('clears transient state when the side chat opens through another surface', async () => {
		const { service } = setup();
		disposables.add(service.registerHost(sourceChat.resource));
		await service.show(session, sourceChat, sideChat, 'question');

		service.removeBySideChat(sideChat.resource);

		assert.deepStrictEqual(service.states.get(), []);
	});

	test('clears transient state when either referenced chat is deleted', async () => {
		const { service, didDeleteChat } = setup();
		disposables.add(service.registerHost(sourceChat.resource));

		await service.show(session, sourceChat, sideChat, 'question');
		didDeleteChat.fire({ session, chatResource: sideChat.resource });
		const afterSideChatDelete = service.states.get();

		await service.show(session, sourceChat, sideChat, 'question');
		didDeleteChat.fire({ session, chatResource: sourceChat.resource });

		assert.deepStrictEqual({
			afterSideChatDelete,
			afterSourceChatDelete: service.states.get(),
		}, {
			afterSideChatDelete: [],
			afterSourceChatDelete: [],
		});
	});

	test('successful promotion does not remove a newer transient question', async () => {
		const openChat = new DeferredPromise<void>();
		const { service } = setup(() => openChat.p);
		const replacement = upcastPartial<IChat>({ resource: URI.parse('test:///chat/replacement') });
		disposables.add(service.registerHost(sourceChat.resource));
		await service.show(session, sourceChat, sideChat, 'first');

		const promotion = service.promote(sourceChat.resource);
		await service.show(session, sourceChat, replacement, 'second');
		openChat.complete();
		await promotion;

		assert.deepStrictEqual(service.states.get().map(state => ({
			sideChat: state.sideChat.resource.toString(),
			question: state.question,
			promoting: state.promoting,
		})), [{
			sideChat: replacement.resource.toString(),
			question: 'second',
			promoting: false,
		}]);
	});

	test('failed promotion does not restore stale state over a newer question', async () => {
		const openChat = new DeferredPromise<void>();
		const { service } = setup(() => openChat.p);
		const replacement = upcastPartial<IChat>({ resource: URI.parse('test:///chat/replacement') });
		disposables.add(service.registerHost(sourceChat.resource));
		await service.show(session, sourceChat, sideChat, 'first');

		const promotion = service.promote(sourceChat.resource);
		await service.show(session, sourceChat, replacement, 'second');
		openChat.error(new Error('open failed'));
		await assert.rejects(promotion, /open failed/);

		assert.deepStrictEqual(service.states.get().map(state => ({
			sideChat: state.sideChat.resource.toString(),
			question: state.question,
			promoting: state.promoting,
		})), [{
			sideChat: replacement.resource.toString(),
			question: 'second',
			promoting: false,
		}]);
	});

	test('marks the matching transient side chat as failed', async () => {
		const { service } = setup();
		disposables.add(service.registerHost(sourceChat.resource));
		await service.show(session, sourceChat, sideChat, 'question');

		service.markFailed(sideChat.resource);

		assert.deepStrictEqual(service.states.get().map(state => ({
			sideChat: state.sideChat.resource.toString(),
			failed: state.failed,
		})), [{
			sideChat: sideChat.resource.toString(),
			failed: true,
		}]);
	});

	test('records when a new side question replaces the source slot', async () => {
		const { service } = setup();
		const replacement = upcastPartial<IChat>({ resource: URI.parse('test:///chat/replacement') });
		disposables.add(service.registerHost(sourceChat.resource));

		await service.show(session, sourceChat, sideChat, 'first');
		const first = service.states.get()[0];
		await service.show(session, sourceChat, replacement, 'second');
		const second = service.states.get()[0];

		assert.deepStrictEqual({
			first: first?.replacedExisting,
			second: second?.replacedExisting,
		}, {
			first: false,
			second: true,
		});
	});

});
