/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { coalesce } from '../../../../../base/common/arrays.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableResourceMap } from '../../../../../base/common/lifecycle.js';
import { ResourceSet } from '../../../../../base/common/map.js';
import { equals } from '../../../../../base/common/objects.js';
import { autorun, observableSignalFromEvent } from '../../../../../base/common/observable.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { convertLegacyChatSessionTiming, IChatDetail, IChatService, IChatSessionTiming } from '../../common/chatService/chatService.js';
import { chatModelToChatDetail } from '../../common/chatService/chatServiceImpl.js';
import { ChatSessionStatus, IChatSessionItem, IChatSessionItemController, IChatSessionItemMetadata, IChatSessionItemsDelta, IChatSessionsService, localChatSessionType } from '../../common/chatSessionsService.js';
import { IChatModel } from '../../common/model/chatModel.js';
import { getChatSessionType } from '../../common/model/chatUri.js';
import { getInProgressSessionDescription } from '../chatSessions/chatSessionDescription.js';
import { chatResponseStateToSessionStatus, getSessionStatusForModel } from '../chatSessions/chatSessions.contribution.js';
import { Schemas } from '../../../../../base/common/network.js';
import { AgentSessionCatalog, cancelledCatalogSnapshot, CatalogRefreshFailureAction, CatalogSnapshot, completeCatalogSnapshot, partialCatalogSnapshot } from './agentSessionCatalog.js';

/** Marks failures from the persisted-history read, which is safe to retry independently. */
class LocalAgentSessionHistoryReadError extends Error {
	constructor(override readonly cause: unknown) {
		super(toErrorMessage(cause));
		this.name = 'LocalAgentSessionHistoryReadError';
	}
}

export class LocalAgentsSessionsController extends Disposable implements IChatSessionItemController, IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.localAgentsSessionsController';

	readonly chatSessionType = localChatSessionType;

	readonly _onDidChangeChatSessionItems = this._register(new Emitter<IChatSessionItemsDelta>());
	readonly onDidChangeChatSessionItems = this._onDidChangeChatSessionItems.event;

	private readonly _modelListeners = this._register(new DisposableResourceMap());
	private readonly _liveUpdateGenerations = new WeakMap<IChatModel, number>();
	private readonly _catalog: AgentSessionCatalog<LocalChatSessionItem>;

	private _isDisposed = false;

	constructor(
		@IChatService private readonly chatService: IChatService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._catalog = this._register(new AgentSessionCatalog<LocalChatSessionItem>({
			name: 'LocalAgentSessions',
			keyOf: item => item.resource.toString(),
			equals: (left, right) => left.isEqual(right),
			read: token => this.readCatalogSnapshot(token),
			// Local history is a queued storage read. A transient queue/storage failure can recover
			// without user action, so it belongs to the catalog-owned retry loop.
			classifyError: error => error instanceof LocalAgentSessionHistoryReadError
				? CatalogRefreshFailureAction.Retry
				: CatalogRefreshFailureAction.Throw,
		}, this.logService));
		this._register(this._catalog.onDidChange(delta => this._onDidChangeChatSessionItems.fire({
			...(delta.addedOrUpdated ? { addedOrUpdated: delta.addedOrUpdated } : undefined),
			...(delta.removed ? { removed: delta.removed.map(item => item.resource) } : undefined),
		})));
		this._register(this.chatSessionsService.registerChatSessionItemController(this.chatSessionType, this));

		this.registerListeners();
	}

	override dispose(): void {
		this._isDisposed = true;
		super.dispose();
	}

	get items(): readonly IChatSessionItem[] {
		return this._catalog.items;
	}

	async refresh(token: CancellationToken): Promise<void> {
		await this._catalog.refresh(token);
	}

	private registerListeners(): void {
		const addModelListeners = async (model: IChatModel) => {
			if (getChatSessionType(model.sessionResource) !== this.chatSessionType) {
				return;
			}
			if (this._isDisposed) {
				return;
			}
			// Supersede any projection still running for an earlier registration of this model.
			this._liveUpdateGenerations.set(model, (this._liveUpdateGenerations.get(model) ?? 0) + 1);

			// Install the live projection before the fallible catalog reconciliation. A failed
			// initial refresh must not permanently disconnect this already-created model.
			let publishLiveChanges = false;
			const requestChangeListener = model.lastRequestObs.map(last => last?.response && observableSignalFromEvent('chatSessions.modelRequestChangeListener', last.response.onDidChange));
			const modelChangeListener = observableSignalFromEvent('chatSessions.modelChangeListener', model.onDidChange);
			const modelListener = autorun(reader => {
				requestChangeListener.read(reader)?.read(reader);
				modelChangeListener.read(reader);

				if (publishLiveChanges) {
					this.updateLiveSessionItem(model);
				}
			});
			this._modelListeners.set(model.sessionResource, modelListener);

			try {
				await this.refresh(CancellationToken.None);
			} catch {
				// Throw-classified catalog failures are already logged. Live model events remain connected.
				if (this._isDisposed || this._modelListeners.get(model.sessionResource) !== modelListener) {
					return;
				}
				publishLiveChanges = true;
				this.updateLiveSessionItem(model);
				return;
			}
			if (this._isDisposed || this._modelListeners.get(model.sessionResource) !== modelListener) {
				return;
			}

			publishLiveChanges = true;
			this.updateLiveSessionItem(model);
		};

		const registerModel = (model: IChatModel) => {
			void addModelListeners(model).catch(error => this.logService.error('[LocalAgentSessions] Failed to register live session model', error));
		};
		this._register(this.chatService.onDidCreateModel(registerModel));
		for (const model of this.chatService.chatModels.get()) {
			registerModel(model);
		}

		this._register(this.chatService.onDidDisposeSession(e => {
			for (const sessionResource of e.sessionResources) {
				this._modelListeners.deleteAndDispose(sessionResource);
			}

			if (e.sessionResources.some(resource => getChatSessionType(resource) === this.chatSessionType)) {
				// Disposing a live model is not the same as deleting its persisted session. Reconcile
				// against live + history so only a complete catalog read can publish a removal.
				void this.refresh(CancellationToken.None).catch(() => {
					// Throw-classified failures are logged by AgentSessionCatalog. This is an event boundary.
				});
			}
		}));
	}

	private updateLiveSessionItem(model: IChatModel): void {
		const generation = (this._liveUpdateGenerations.get(model) ?? 0) + 1;
		this._liveUpdateGenerations.set(model, generation);
		void this.tryUpdateLiveSessionItem(model, generation).catch(error => this.logService.error('[LocalAgentSessions] Failed to update live session item', error));
	}

	private async tryUpdateLiveSessionItem(model: IChatModel, generation: number): Promise<void> {
		const updated = this.toChatSessionItem(await chatModelToChatDetail(model));
		if (this._isDisposed
			|| this._liveUpdateGenerations.get(model) !== generation
			|| this.chatService.getSession(model.sessionResource) !== model
			|| !this._modelListeners.get(model.sessionResource)) {
			return;
		}
		if (!updated) {
			// The session no longer qualifies as a list item (e.g. it has no requests
			// yet, or its requests were removed). Drop any stale item we were showing.
			this._catalog.delete(model.sessionResource.toString());
			return;
		}

		this._catalog.upsert(updated);
	}

	private async readCatalogSnapshot(token: CancellationToken): Promise<CatalogSnapshot<LocalChatSessionItem>> {
		const sessions: LocalChatSessionItem[] = [];
		const sessionsByResource = new ResourceSet();

		for (const sessionDetail of await this.chatService.getLiveSessionItems()) {
			const editorSession = this.toChatSessionItem(sessionDetail);
			if (!editorSession) {
				continue;
			}

			sessionsByResource.add(sessionDetail.sessionResource);
			sessions.push(editorSession);
		}

		if (token.isCancellationRequested) {
			return cancelledCatalogSnapshot();
		}

		let historyItems: IChatDetail[];
		try {
			historyItems = await this.chatService.getHistorySessionItems();
		} catch (error) {
			if (token.isCancellationRequested || isCancellationError(error)) {
				return cancelledCatalogSnapshot();
			}
			return partialCatalogSnapshot(sessions, new LocalAgentSessionHistoryReadError(error));
		}

		if (token.isCancellationRequested) {
			return cancelledCatalogSnapshot();
		}
		const history = coalesce(historyItems.map(history => this.toChatSessionItem(history)));
		sessions.push(...history.filter(historyItem => !sessionsByResource.has(historyItem.resource)));
		return completeCatalogSnapshot(sessions);
	}

	private toChatSessionItem(chat: IChatDetail): LocalChatSessionItem | undefined {
		const model = this.chatService.getSession(chat.sessionResource);

		if (model) {
			if (!model.hasRequests) {
				return undefined; // ignore sessions without requests
			}
		} else if (chat.isActive) {
			// Sessions that are active but don't have a chat model are ultimately untitled with no requests
			return undefined;
		}

		return new LocalChatSessionItem(chat, model);
	}
}

class LocalChatSessionItem implements IChatSessionItem {
	readonly resource: URI;
	readonly iconPath = Codicon.chatSparkle;

	readonly label: string;
	readonly description: string | undefined;
	readonly status: ChatSessionStatus | undefined;
	readonly timing: IChatSessionTiming;
	readonly changes: IChatSessionItem['changes'];
	readonly metadata: IChatSessionItemMetadata | undefined;

	constructor(chatDetail: IChatDetail, model: IChatModel | undefined) {
		this.resource = chatDetail.sessionResource;
		this.label = chatDetail.title;
		this.description = model ? getInProgressSessionDescription(model) : undefined;
		this.status = (model && getSessionStatusForModel(model)) ?? chatResponseStateToSessionStatus(chatDetail.lastResponseState);
		this.timing = convertLegacyChatSessionTiming(chatDetail.timing);
		this.changes = chatDetail.stats ? {
			insertions: chatDetail.stats.added,
			deletions: chatDetail.stats.removed,
			files: chatDetail.stats.fileCount,
		} : undefined;
		const workingDirectoryPath = chatDetail.workingDirectory?.scheme === Schemas.file ? chatDetail.workingDirectory.fsPath : undefined;
		this.metadata = workingDirectoryPath ? { workingDirectoryPath: workingDirectoryPath } : undefined;
	}

	isEqual(other: LocalChatSessionItem): boolean {
		return isEqual(this.resource, other.resource)
			&& this.label === other.label
			&& this.description === other.description
			&& this.status === other.status
			&& this.timing.created === other.timing.created
			&& this.timing.lastRequestStarted === other.timing.lastRequestStarted
			&& this.timing.lastRequestEnded === other.timing.lastRequestEnded
			&& equals(this.changes, other.changes);
	}
}
