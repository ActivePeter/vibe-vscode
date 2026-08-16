/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IChat, ISession, ISideChatSelection } from '../../../services/sessions/common/session.js';
import { ISendRequestOptions, ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ITransientSideChatService } from './transientSideChatService.js';

export interface IPresentedSideChat {
	readonly sideChat: IChat;
	readonly presentedTransiently: boolean;
}

async function openSideChat(
	sessionsService: ISessionsService,
	sessionsPartService: ISessionsPartService,
	session: ISession,
	sideChat: IChat,
): Promise<void> {
	await sessionsService.openChat(session, sideChat.resource);
	sessionsPartService.getSessionView(session.sessionId)?.splitChatToSide(sideChat.resource);
}

/** Activates a new side chat in its own group before sending the request. */
export async function openAndSendSideChat(
	sessionsManagementService: ISessionsManagementService,
	sessionsService: ISessionsService,
	sessionsPartService: ISessionsPartService,
	session: ISession,
	sideChat: IChat,
	requestOptions: ISendRequestOptions,
): Promise<void> {
	await openSideChat(sessionsService, sessionsPartService, session, sideChat);
	await sessionsManagementService.sendRequest(session, sideChat, requestOptions);
}

/**
 * Presents `sideChat` transiently above its source composer when that source
 * has a live host, otherwise falls back to normal side-group navigation.
 */
export async function presentSideChat(
	sessionsService: ISessionsService,
	sessionsPartService: ISessionsPartService,
	transientSideChatService: ITransientSideChatService,
	session: ISession,
	sourceChat: IChat,
	sideChat: IChat,
	question: string,
): Promise<boolean> {
	const presentedTransiently = await transientSideChatService.show(session, sourceChat, sideChat, question);
	if (!presentedTransiently) {
		await openSideChat(sessionsService, sessionsPartService, session, sideChat);
	}
	return presentedTransiently;
}

export async function sendSideChat(
	sessionsManagementService: ISessionsManagementService,
	transientSideChatService: ITransientSideChatService,
	session: ISession,
	sideChat: IChat,
	requestOptions: ISendRequestOptions,
	presentedTransiently: boolean,
): Promise<void> {
	try {
		await sessionsManagementService.sendRequest(session, sideChat, {
			...requestOptions,
			preserveActiveChat: presentedTransiently,
		});
	} catch (error) {
		if (presentedTransiently) {
			transientSideChatService.markFailed(sideChat.resource);
		}
		throw error;
	}
}

export async function presentAndSendSideChat(
	sessionsManagementService: ISessionsManagementService,
	sessionsService: ISessionsService,
	sessionsPartService: ISessionsPartService,
	transientSideChatService: ITransientSideChatService,
	session: ISession,
	sourceChat: IChat,
	sideChat: IChat,
	requestOptions: ISendRequestOptions,
): Promise<void> {
	const presentedTransiently = await presentSideChat(
		sessionsService,
		sessionsPartService,
		transientSideChatService,
		session,
		sourceChat,
		sideChat,
		requestOptions.query,
	);
	await sendSideChat(sessionsManagementService, transientSideChatService, session, sideChat, requestOptions, presentedTransiently);
}

export async function createAndPresentSideChat(
	sessionsManagementService: ISessionsManagementService,
	sessionsService: ISessionsService,
	sessionsPartService: ISessionsPartService,
	transientSideChatService: ITransientSideChatService,
	session: ISession,
	sourceChat: IChat,
	turnId: string,
	question: string,
	selection?: ISideChatSelection,
): Promise<IPresentedSideChat> {
	const sideChat = await sessionsManagementService.createSideChatInSession(session, sourceChat.resource, turnId, selection);
	const presentedTransiently = await presentSideChat(
		sessionsService,
		sessionsPartService,
		transientSideChatService,
		session,
		sourceChat,
		sideChat,
		question,
	);
	return { sideChat, presentedTransiently };
}

/**
 * Creates a side chat branched from `turnId` in `sourceChat`, then opens and
 * sends it through transient presentation or the normal side-group fallback.
 */
export async function createAndSendSideChat(
	sessionsManagementService: ISessionsManagementService,
	sessionsService: ISessionsService,
	sessionsPartService: ISessionsPartService,
	transientSideChatService: ITransientSideChatService,
	session: ISession,
	sourceChat: IChat,
	turnId: string,
	requestOptions: ISendRequestOptions,
	selection?: ISideChatSelection,
): Promise<IChat> {
	const { sideChat, presentedTransiently } = await createAndPresentSideChat(
		sessionsManagementService,
		sessionsService,
		sessionsPartService,
		transientSideChatService,
		session,
		sourceChat,
		turnId,
		requestOptions.query,
		selection,
	);
	await sendSideChat(sessionsManagementService, transientSideChatService, session, sideChat, requestOptions, presentedTransiently);
	return sideChat;
}
