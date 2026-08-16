/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IChat, ISession } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';

export const AGENT_SESSIONS_TRANSIENT_SIDE_CHAT_SETTING = 'chat.agentSessions.transientSideChat';

export interface ITransientSideChatState {
	readonly session: ISession;
	readonly sourceChat: IChat;
	readonly sideChat: IChat;
	readonly question: string;
	readonly promoting: boolean;
	readonly failed: boolean;
	readonly replacedExisting: boolean;
}

export const ITransientSideChatService = createDecorator<ITransientSideChatService>('transientSideChatService');

export interface ITransientSideChatService {
	readonly _serviceBrand: undefined;
	readonly states: IObservable<readonly ITransientSideChatState[]>;
	registerHost(sourceChat: URI): IDisposable;
	show(session: ISession, sourceChat: IChat, sideChat: IChat, question: string): Promise<boolean>;
	promote(sourceChat: URI): Promise<void>;
	markFailed(sideChat: URI): void;
	removeBySideChat(sideChat: URI): void;
}

export class TransientSideChatService extends Disposable implements ITransientSideChatService {
	declare readonly _serviceBrand: undefined;

	private readonly _states = observableValue<readonly ITransientSideChatState[]>(this, []);
	readonly states: IObservable<readonly ITransientSideChatState[]> = this._states;

	private readonly _hosts = new Map<string, object>();

	constructor(
		@ISessionsService private readonly sessionsService: ISessionsService,
		@ISessionsManagementService sessionsManagementService: ISessionsManagementService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(sessionsManagementService.onDidDeleteSession(session => {
			const next = this._states.get().filter(state => state.session.sessionId !== session.sessionId);
			if (next.length !== this._states.get().length) {
				this._states.set(next, undefined);
			}
		}));
		this._register(sessionsManagementService.onDidDeleteChat(({ chatResource }) => {
			const key = chatResource.toString();
			const next = this._states.get().filter(state =>
				state.sourceChat.resource.toString() !== key && state.sideChat.resource.toString() !== key
			);
			if (next.length !== this._states.get().length) {
				this._states.set(next, undefined);
			}
		}));
	}

	registerHost(sourceChat: URI): IDisposable {
		const key = sourceChat.toString();
		const registration = {};
		this._hosts.set(key, registration);
		return toDisposable(() => {
			if (this._hosts.get(key) === registration) {
				this._hosts.delete(key);
			}
		});
	}

	async show(session: ISession, sourceChat: IChat, sideChat: IChat, question: string): Promise<boolean> {
		if (!this._isEnabled()) {
			return false;
		}
		const key = sourceChat.resource.toString();
		const host = this._hosts.get(key);
		if (!host) {
			return false;
		}

		const replacedExisting = this._getState(sourceChat.resource) !== undefined;
		await this.sessionsService.closeChat(session, sideChat, { skipHistory: true });
		if (!this._isEnabled()) {
			return false;
		}
		this._setState({
			session,
			sourceChat,
			sideChat,
			question,
			promoting: false,
			failed: false,
			replacedExisting,
		});
		return true;
	}

	private _isEnabled(): boolean {
		return this.configurationService.getValue<boolean>(AGENT_SESSIONS_TRANSIENT_SIDE_CHAT_SETTING) === true;
	}

	async promote(sourceChat: URI): Promise<void> {
		const state = this._getState(sourceChat);
		if (!state || state.promoting) {
			return;
		}

		this._setState({ ...state, promoting: true });
		const sideChatResource = state.sideChat.resource.toString();
		try {
			await this.sessionsService.openChat(state.session, state.sideChat.resource);
			const current = this._getState(sourceChat);
			if (current?.sideChat.resource.toString() === sideChatResource && current.promoting) {
				this._remove(sourceChat);
			}
		} catch (error) {
			const current = this._getState(sourceChat);
			if (current?.sideChat.resource.toString() === sideChatResource && current.promoting) {
				this._setState({ ...current, promoting: false });
			}
			throw error;
		}
	}

	markFailed(sideChat: URI): void {
		const key = sideChat.toString();
		const state = this._states.get().find(candidate => candidate.sideChat.resource.toString() === key);
		if (state && !state.failed) {
			this._setState({ ...state, failed: true });
		}
	}

	removeBySideChat(sideChat: URI): void {
		const state = this._states.get().find(candidate => candidate.sideChat.resource.toString() === sideChat.toString());
		if (state) {
			this._remove(state.sourceChat.resource);
		}
	}

	private _getState(sourceChat: URI): ITransientSideChatState | undefined {
		const key = sourceChat.toString();
		return this._states.get().find(state => state.sourceChat.resource.toString() === key);
	}

	private _setState(nextState: ITransientSideChatState): void {
		const key = nextState.sourceChat.resource.toString();
		const states = this._states.get();
		const index = states.findIndex(state => state.sourceChat.resource.toString() === key);
		const next = [...states];
		if (index === -1) {
			next.push(nextState);
		} else {
			next[index] = nextState;
		}
		this._states.set(next, undefined);
	}

	private _remove(sourceChat: URI): void {
		const key = sourceChat.toString();
		const states = this._states.get();
		const next = states.filter(state => state.sourceChat.resource.toString() !== key);
		if (next.length !== states.length) {
			this._states.set(next, undefined);
		}
	}
}
