/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/transientSideChat.css';
import * as dom from '../../../../base/browser/dom.js';
import { renderAsPlaintext } from '../../../../base/browser/markdownRenderer.js';
import { Action } from '../../../../base/common/actions.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable, IReader, observableValue } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { status as announceStatus } from '../../../../base/browser/ui/aria/aria.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { EDITOR_DRAG_AND_DROP_BACKGROUND } from '../../../../workbench/common/theme.js';
import { setModelPreservingInputTypedWhileLoading } from '../../../../workbench/contrib/chat/browser/chat.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { ChatCollapsibleContentPart } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/chatCollapsibleContentPart.js';
import { getFinalResponseStartIndex } from '../../../../workbench/contrib/chat/browser/widget/chatListRenderer.js';
import { ChatMcpServersStarting, IChatModelReference, IChatService, IChatToolInvocation } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { ChatAgentLocation } from '../../../../workbench/contrib/chat/common/constants.js';
import type { IChatProgressResponseContent } from '../../../../workbench/contrib/chat/common/model/chatModel.js';
import { isResponseVM } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { annotateSpecialMarkdownContent } from '../../../../workbench/contrib/chat/common/widget/annotations.js';
import { IChat, ISession, isActiveSessionStatus, SessionStatus } from '../../../services/sessions/common/session.js';
import { activeSessionViewBackground, activeSessionViewForeground, agentsPanelBackground, inactiveSessionViewBackground } from '../../../common/theme.js';
import { ITransientSideChatService, ITransientSideChatState } from './transientSideChatService.js';

interface ITransientSideChatSource {
	readonly chat: IChat;
	readonly session: ISession;
}

interface ITransientSideChatSourceWidget {
	readonly inputEditor: ICodeEditor;
	readonly inputPart: {
		readonly hasActiveToolConfirmationCarousel: boolean;
	};
	focusInput(): void;
}

let transientSideChatIdPool = 0;

const MIN_RESPONSE_VIEWPORT_HEIGHT = 1;
const SIDE_QUESTION_MAX_HEIGHT_RATIO = 0.6;
const CHAT_CONTENT_MAX_WIDTH = 950;
const CHAT_INPUT_HORIZONTAL_INSET = 64;

export function getTransientSideChatResponseHeight(viewHeight: number, contentHeight: number, cardChromeHeight = 0, minimumHeight = MIN_RESPONSE_VIEWPORT_HEIGHT): number {
	const maxHeight = Math.max(minimumHeight, Math.floor(viewHeight * SIDE_QUESTION_MAX_HEIGHT_RATIO) - Math.ceil(cardChromeHeight));
	const desiredHeight = Math.max(minimumHeight, Math.ceil(contentHeight));
	return Math.min(maxHeight, desiredHeight);
}

export function getTransientSideChatPinnedResponseHeight(renderedHeight: number, viewportHeight: number, layoutHeight?: number): number | undefined {
	const height = layoutHeight || renderedHeight || viewportHeight;
	return height > 0 ? height : undefined;
}

export function shouldShowTransientSideChatProgress(status: SessionStatus, waitingForFinalResponse: boolean): boolean {
	return waitingForFinalResponse && status !== SessionStatus.NeedsInput && status !== SessionStatus.Error;
}

export function getTransientSideChatModelActivity(content: readonly IChatProgressResponseContent[]): string | undefined {
	for (let index = content.length - 1; index >= 0; index--) {
		const part = content[index];
		if (part.kind === 'progressMessage') {
			const text = renderAsPlaintext(part.content).trim();
			if (text) {
				return text;
			}
		}
		if (part.kind === 'mcpServersStartingSlow' && part.servers.get().length > 0) {
			return localize('transientSideChat.startingMcpServers', "Starting MCP servers...");
		}
		if (part instanceof ChatMcpServersStarting && part.state.get().working) {
			return localize('transientSideChat.startingMcpServers', "Starting MCP servers...");
		}
		if (part.kind === 'toolInvocation' || part.kind === 'toolInvocationSerialized') {
			const message = IChatToolInvocation.isComplete(part)
				? part.pastTenseMessage ?? part.invocationMessage
				: part.invocationMessage;
			const text = typeof message === 'string' ? message.trim() : message ? renderAsPlaintext(message).trim() : '';
			if (text) {
				return text;
			}
		}
	}
	return undefined;
}

function hasTransientSideChatCompletedFinalResponse(widget: ChatWidget | undefined, sideChatResource: URI): boolean {
	const viewModel = widget?.viewModel;
	if (!viewModel || !isEqual(viewModel.sessionResource, sideChatResource)) {
		return false;
	}
	return viewModel.getItems().some(item =>
		isResponseVM(item) && item.isComplete && getFinalResponseStartIndex(annotateSpecialMarkdownContent(item.response.value)) !== undefined
	);
}

export function getTransientSideChatStatusAnnouncement(previousStatus: SessionStatus | undefined, status: SessionStatus, isNewSideChat: boolean, replacedExisting: boolean): string | undefined {
	if (isNewSideChat) {
		return replacedExisting
			? localize('transientSideChat.replacedStatus', "New side question shown. The previous answer remains in Closed chats.")
			: localize('transientSideChat.askedStatus', "Side question asked");
	}
	if (!isActiveSessionStatus(previousStatus ?? SessionStatus.Completed)) {
		return undefined;
	}
	switch (status) {
		case SessionStatus.Completed:
			return localize('transientSideChat.answeredStatus', "Side question answered");
		case SessionStatus.Error:
			return localize('transientSideChat.failedStatus', "Side question failed");
		default:
			return undefined;
	}
}

export function shouldDismissTransientSideChatFromSourceInput(state: {
	readonly visible: boolean;
	readonly defaultPrevented: boolean;
	readonly confirmationVisible: boolean;
	readonly suggestVisible: boolean;
	readonly hoverVisible: boolean;
	readonly requestInProgress: boolean;
	readonly speechToTextRecording: boolean;
	readonly currentlyEditing: boolean;
}): boolean {
	return state.visible
		&& !state.defaultPrevented
		&& !state.confirmationVisible
		&& !state.suggestVisible
		&& !state.hoverVisible
		&& !state.requestInProgress
		&& !state.speechToTextRecording
		&& !state.currentlyEditing;
}

export function getTransientSideChatPresentation(status: SessionStatus): {
	readonly statusLabel: string;
	readonly promoteLabel: string;
	readonly className: 'needs-input' | 'error' | undefined;
} {
	switch (status) {
		case SessionStatus.NeedsInput:
			return {
				statusLabel: localize('transientSideChat.needsInputStatus', "Input needed. Open the full chat to continue."),
				promoteLabel: localize('transientSideChat.promoteToContinue', "Open Full Chat to Continue"),
				className: 'needs-input',
			};
		case SessionStatus.Error:
			return {
				statusLabel: localize('transientSideChat.failedDetail', "The side question failed. Open the full chat for details."),
				promoteLabel: localize('transientSideChat.promoteForDetails', "Open Full Chat for Details"),
				className: 'error',
			};
		default:
			return {
				statusLabel: '',
				promoteLabel: localize('transientSideChat.promote', "Open Full Chat"),
				className: undefined,
			};
	}
}

export class TransientSideChatWidget extends Disposable {
	readonly element: HTMLElement;

	private readonly _card: HTMLElement;
	private readonly _header: HTMLElement;
	private readonly _questionText: HTMLElement;
	private readonly _statusText: HTMLElement;
	private readonly _progress: HTMLElement;
	private readonly _progressLabel: HTMLElement;
	private readonly _widgetHost: HTMLElement;
	private readonly _widget = this._register(new MutableDisposable<ChatWidget>());
	private readonly _sourceContextKeyService: IContextKeyService;
	private readonly _scopedContextKeyService: IContextKeyService;
	private readonly _scopedInstantiationService: IInstantiationService;
	private readonly _promoteAction: Action;
	private readonly _closeAction: Action;

	private readonly _source = observableValue<ITransientSideChatSource | undefined>(this, undefined);
	private readonly _state: IObservable<ITransientSideChatState | undefined>;
	private readonly _hostRegistration = this._register(new MutableDisposable());
	private readonly _modelRef = this._register(new MutableDisposable<IChatModelReference>());
	private readonly _loadCts = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly _progressModelListener = this._register(new MutableDisposable());
	private _currentSideChatResource: URI | undefined;
	private _hostVisible = true;
	private _active = true;
	private _lastLayout: { readonly height: number; readonly width: number } | undefined;
	private _announcedSideChatResource: string | undefined;
	private _lastSideChatStatus: SessionStatus | undefined;
	private _progressVisible = false;
	private _progressSideChatResource: string | undefined;
	private _waitingForFinalResponse = false;
	private _fixedResponseHeight: number | undefined;
	private _lastResponseLayoutHeight: number | undefined;
	private _minimumResponseHeight = MIN_RESPONSE_VIEWPORT_HEIGHT;
	private _chatActivity = '';

	constructor(
		parent: HTMLElement,
		private readonly _mainWidget: ITransientSideChatSourceWidget,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IChatService private readonly _chatService: IChatService,
		@ITransientSideChatService private readonly _transientSideChatService: ITransientSideChatService,
		@ILogService private readonly _logService: ILogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IHoverService hoverService: IHoverService,
	) {
		super();
		this._sourceContextKeyService = contextKeyService;

		this.element = dom.append(parent, dom.$('.transient-side-chat-host.hidden'));

		const cardId = `transient-side-chat-${++transientSideChatIdPool}`;
		this._card = dom.append(this.element, dom.$('.transient-side-chat-card.hidden', {
			id: cardId,
			role: 'region',
			tabindex: '-1',
		}));

		this._header = dom.append(this._card, dom.$('.transient-side-chat-header'));
		const heading = dom.append(this._header, dom.$('.transient-side-chat-heading'));
		const title = dom.append(heading, dom.$('.transient-side-chat-title', undefined, localize('transientSideChat.title', "Side question")));
		this._questionText = dom.append(heading, dom.$('.transient-side-chat-question'));
		this._statusText = dom.append(heading, dom.$('.transient-side-chat-status.hidden'));
		title.id = `${cardId}-title`;
		this._questionText.id = `${cardId}-question`;
		this._card.setAttribute('aria-labelledby', title.id);
		this._card.setAttribute('aria-describedby', this._questionText.id);
		this._register(hoverService.setupManagedHover(
			getDefaultHoverDelegate('element'),
			this._questionText,
			() => this._questionText.textContent ?? '',
		));

		const actions = this._register(new ActionBar(this._header, {
			ariaLabel: localize('transientSideChat.actions', "Side question actions"),
		}));
		actions.getContainer().classList.add('transient-side-chat-actions');
		this._promoteAction = this._register(new Action(
			'transientSideChat.promote',
			localize('transientSideChat.promote', "Open Full Chat"),
			ThemeIcon.asClassName(Codicon.openPreview),
			true,
			() => this._promote(),
		));
		this._closeAction = this._register(new Action(
			'transientSideChat.close',
			localize('transientSideChat.close', "Close Side Question"),
			ThemeIcon.asClassName(Codicon.close),
			true,
			() => this._dismiss(),
		));
		actions.push([this._promoteAction, this._closeAction], { icon: true, label: false });

		this._progress = dom.append(this._card, dom.$('.transient-side-chat-progress.hidden'));
		this._progressLabel = dom.append(this._progress, dom.$('span.transient-side-chat-progress-label'));
		this._register(hoverService.setupManagedHover(
			getDefaultHoverDelegate('element'),
			this._progressLabel,
			() => this._progressLabel.textContent ?? '',
		));
		this._widgetHost = dom.append(this._card, dom.$('.transient-side-chat-widget'));
		this._register(dom.addDisposableListener(this._widgetHost, ChatCollapsibleContentPart.userToggleEvent, () => {
			const widget = this._widget.value;
			if (widget && !this._progressVisible && this._fixedResponseHeight === undefined) {
				this._fixedResponseHeight = getTransientSideChatPinnedResponseHeight(this._widgetHost.clientHeight, widget.viewportHeight, this._lastResponseLayoutHeight);
				if (this._fixedResponseHeight !== undefined && this._lastLayout) {
					this.layout(this._lastLayout.height, this._lastLayout.width);
				}
			}
		}));
		this._scopedContextKeyService = this._register(contextKeyService.createScoped(this.element));
		this._scopedInstantiationService = this._register(instantiationService.createChild(new ServiceCollection(
			[IContextKeyService, this._scopedContextKeyService],
		)));

		this._state = derived(this, reader => {
			const source = this._source.read(reader);
			if (!source) {
				return undefined;
			}
			const sourceResource = source.chat.resource.toString();
			return this._transientSideChatService.states.read(reader)
				.find(state => state.sourceChat.resource.toString() === sourceResource);
		});
		this._register(autorun(reader => this._renderState(this._state.read(reader), reader)));
		this._register(dom.addDisposableListener(this.element, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key !== 'Escape') {
				return;
			}
			if (event.defaultPrevented || !this._state.get() || this._state.get()?.promoting) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			this._dismiss();
		}));
		const sourceInputEditor = this._mainWidget.inputEditor.getDomNode();
		if (sourceInputEditor) {
			this._register(dom.addDisposableListener(sourceInputEditor, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
				if (event.key !== 'Escape' || !this._mainWidget.inputEditor.hasTextFocus()) {
					return;
				}
				const focusedContext = this._sourceContextKeyService.getContext(dom.getActiveElement());
				if (!shouldDismissTransientSideChatFromSourceInput({
					visible: !!this._state.get() && !this._state.get()?.promoting,
					defaultPrevented: event.defaultPrevented,
					confirmationVisible: this._mainWidget.inputPart.hasActiveToolConfirmationCarousel,
					suggestVisible: focusedContext.getValue<boolean>('suggestWidgetVisible') ?? false,
					hoverVisible: focusedContext.getValue<boolean>(EditorContextKeys.hoverVisible.key) ?? false,
					requestInProgress: focusedContext.getValue<boolean>(ChatContextKeys.requestInProgress.key) ?? false,
					speechToTextRecording: focusedContext.getValue<boolean>(ChatContextKeys.speechToTextRecording.key) ?? false,
					currentlyEditing: (focusedContext.getValue<boolean>(ChatContextKeys.currentlyEditing.key) ?? false)
						|| (focusedContext.getValue<boolean>(ChatContextKeys.currentlyEditingInput.key) ?? false),
				})) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				this._dismiss();
			}));
		}
	}

	setSource(chat: IChat, session: ISession | undefined): void {
		if (!session) {
			this._clearSideModel();
			this._hostRegistration.clear();
			this._source.set(undefined, undefined);
			return;
		}
		const current = this._source.get();
		if (current && isEqual(current.chat.resource, chat.resource) && current.session.sessionId === session.sessionId) {
			return;
		}
		this._transientSideChatService.removeBySideChat(chat.resource);
		this._clearSideModel();
		this._source.set({ chat, session }, undefined);
		this._hostRegistration.value = this._transientSideChatService.registerHost(chat.resource);
	}

	setActive(active: boolean): void {
		this._active = active;
		this._widget.value?.setStyles(this._buildStyles());
	}

	setVisible(visible: boolean): void {
		this._hostVisible = visible;
		this._syncWidgetVisibility();
	}

	layout(height: number, width: number): void {
		this._lastLayout = { height, width };
		const widget = this._widget.value;
		if (!widget) {
			return;
		}
		const widgetHeight = this._progressVisible
			? MIN_RESPONSE_VIEWPORT_HEIGHT
			: getTransientSideChatResponseHeight(height, this._fixedResponseHeight ?? widget.scrollHeight, this._header.offsetHeight, this._minimumResponseHeight);
		this._lastResponseLayoutHeight = widgetHeight;
		const widgetWidth = this._widgetHost.clientWidth || Math.max(0, Math.min(width - CHAT_INPUT_HORIZONTAL_INSET, CHAT_CONTENT_MAX_WIDTH));
		widget.layout(widgetHeight, widgetWidth);
	}

	override dispose(): void {
		this._loadCts.value?.cancel();
		super.dispose();
	}

	private _renderState(state: ITransientSideChatState | undefined, reader: IReader): void {
		const visible = !!state;
		this.element.classList.toggle('hidden', !visible);
		if (!state) {
			this._card.classList.add('hidden');
			this._announcedSideChatResource = undefined;
			this._lastSideChatStatus = undefined;
			this._progressSideChatResource = undefined;
			this._waitingForFinalResponse = false;
			this._chatActivity = '';
			this._fixedResponseHeight = undefined;
			this._setProgressVisible(false);
			this._clearSideModel();
			this._syncWidgetVisibility();
			return;
		}

		this._card.classList.remove('hidden');
		this._promoteAction.enabled = !state.promoting;
		this._closeAction.enabled = !state.promoting;

		this._questionText.textContent = state.question;

		const status = state.failed ? SessionStatus.Error : state.sideChat.status.read(reader);
		const activity = state.sideChat.description.read(reader);
		this._chatActivity = (activity && renderAsPlaintext(activity).trim()) || '';
		this._updateProgressLabel();
		const sideChatResource = state.sideChat.resource.toString();
		if (this._progressSideChatResource !== sideChatResource) {
			this._progressSideChatResource = sideChatResource;
			this._waitingForFinalResponse = true;
			this._fixedResponseHeight = undefined;
		}
		const isNewSideChat = sideChatResource !== this._announcedSideChatResource;
		const statusAnnouncement = getTransientSideChatStatusAnnouncement(this._lastSideChatStatus, status, isNewSideChat, state.replacedExisting);
		if (this._hostVisible && this._active && statusAnnouncement) {
			announceStatus(statusAnnouncement);
		}
		this._announcedSideChatResource = sideChatResource;
		this._lastSideChatStatus = status;

		const presentation = getTransientSideChatPresentation(status);
		this._statusText.textContent = presentation.statusLabel;
		this._statusText.classList.toggle('hidden', !presentation.statusLabel);
		this._statusText.classList.toggle('needs-input', presentation.className === 'needs-input');
		this._statusText.classList.toggle('error', presentation.className === 'error');
		this._promoteAction.label = presentation.promoteLabel;
		this._updateProgress(status);

		this._ensureSideModel(state);
		this._syncWidgetVisibility();
		if (this._lastLayout) {
			this.layout(this._lastLayout.height, this._lastLayout.width);
		}
	}

	private _ensureSideModel(state: ITransientSideChatState): void {
		const widget = this._ensureWidget();
		const resource = state.sideChat.resource;
		if (isEqual(this._currentSideChatResource, resource)) {
			return;
		}

		this._clearSideModel();
		this._currentSideChatResource = resource;

		const cts = new CancellationTokenSource();
		this._loadCts.value = cts;
		const inputBeforeLoad = widget.getInput();
		void this._chatService.acquireOrLoadSession(resource, ChatAgentLocation.Chat, cts.token, 'TransientSideChatWidget').then(ref => {
			if (cts.token.isCancellationRequested || !isEqual(this._currentSideChatResource, resource)) {
				ref?.dispose();
				return;
			}
			if (!ref) {
				this._logService.error(`[TransientSideChatWidget] No chat model available for ${resource.toString()}`);
				this._transientSideChatService.markFailed(resource);
				return;
			}
			this._modelRef.value = ref;
			setModelPreservingInputTypedWhileLoading(widget, inputBeforeLoad, () => widget.setModel(ref.object));
			widget.scrollTop = 0;
			this._progressModelListener.value = widget.viewModel?.onDidChange(() => {
				this._updateProgressLabel();
				this._updateProgress();
			});
			this.element.dataset.transientChatResource = resource.toString();
			this._updateProgressLabel();
			this._updateProgress();
			this._syncWidgetVisibility();
			if (this._lastLayout) {
				this.layout(this._lastLayout.height, this._lastLayout.width);
			}
		}, error => {
			if (cts.token.isCancellationRequested || !isEqual(this._currentSideChatResource, resource)) {
				return;
			}
			this._logService.error('[TransientSideChatWidget] Failed to load chat model', error);
			this._transientSideChatService.markFailed(resource);
		});
	}

	private _ensureWidget(): ChatWidget {
		let widget = this._widget.value;
		if (widget) {
			return widget;
		}

		widget = this._scopedInstantiationService.createInstance(
			ChatWidget,
			ChatAgentLocation.Chat,
			{},
			{
				autoScroll: false,
				defaultElementHeight: MIN_RESPONSE_VIEWPORT_HEIGHT,
				renderFollowups: false,
				renderStyle: 'compact',
				renderGettingStartedTip: false,
				filter: isResponseVM,
				rendererOptions: {
					noHeader: true,
					noFooter: true,
					editable: false,
					contentHorizontalPadding: 24,
					animateCompletedResponseCollapse: false,
				},
				enableImplicitContext: false,
				supportsChangingModes: false,
				isSessionsWindow: true,
				enableChatPet: false,
				renderScrollToBottomButton: false,
			},
			this._buildStyles(),
		);
		this._widget.value = widget;
		widget.render(this._widgetHost);
		widget.setInputVisible(false);
		this._register(widget.holdAutoScroll());
		this._register(widget.onDidChangeContentHeight(() => {
			this._updateProgressLabel();
			this._updateProgress();
			if (this._lastLayout) {
				this.layout(this._lastLayout.height, this._lastLayout.width);
			}
		}));
		widget.setVisible(false);
		if (this._lastLayout) {
			this.layout(this._lastLayout.height, this._lastLayout.width);
		}
		return widget;
	}

	private _updateProgress(status?: SessionStatus): void {
		const state = this._state.get();
		if (!state) {
			this._setProgressVisible(false);
			return;
		}
		const currentStatus = status ?? (state.failed ? SessionStatus.Error : state.sideChat.status.get());
		if (hasTransientSideChatCompletedFinalResponse(this._widget.value, state.sideChat.resource)) {
			this._waitingForFinalResponse = false;
		}
		this._setProgressVisible(shouldShowTransientSideChatProgress(currentStatus, this._waitingForFinalResponse));
	}

	private _updateProgressLabel(): void {
		const response = this._widget.value?.viewModel?.getItems().findLast(isResponseVM);
		const modelActivity = response ? getTransientSideChatModelActivity(response.response.value) : undefined;
		this._progressLabel.textContent = modelActivity || this._chatActivity || localize('transientSideChat.workingOnIt', "Working on it...");
	}

	private _setProgressVisible(visible: boolean): void {
		if (this._progressVisible === visible) {
			return;
		}
		this._progressVisible = visible;
		this._progress.classList.toggle('hidden', !visible);
		this._widgetHost.classList.toggle('pending', visible);
		if (visible) {
			this._minimumResponseHeight = Math.max(MIN_RESPONSE_VIEWPORT_HEIGHT, this._progress.offsetHeight);
		}
	}

	private _clearSideModel(): void {
		this._loadCts.value?.cancel();
		this._loadCts.clear();
		this._progressModelListener.clear();
		this._currentSideChatResource = undefined;
		this._widget.value?.setModel(undefined);
		this._modelRef.clear();
		delete this.element.dataset.transientChatResource;
	}

	private _syncWidgetVisibility(): void {
		const state = this._state.get();
		this._widget.value?.setVisible(this._hostVisible && !!state);
	}

	private _dismiss(): void {
		const state = this._state.get();
		if (state) {
			this._transientSideChatService.removeBySideChat(state.sideChat.resource);
			this._mainWidget.focusInput();
			announceStatus(localize('transientSideChat.closedStatus', "Side question closed"));
		}
	}

	private async _promote(): Promise<void> {
		const source = this._source.get();
		if (!source) {
			return;
		}
		try {
			await this._transientSideChatService.promote(source.chat.resource);
			announceStatus(localize('transientSideChat.promotedStatus', "Opened side question as a full chat"));
		} catch (error) {
			this._logService.error('[TransientSideChatWidget] Failed to open full chat', error);
			const message = localize('transientSideChat.promoteFailed', "The side question could not be opened as a full chat.");
			this._notificationService.error(message);
			announceStatus(message);
		}
	}

	private _buildStyles() {
		return {
			listForeground: activeSessionViewForeground,
			listBackground: this._active ? activeSessionViewBackground : inactiveSessionViewBackground,
			overlayBackground: EDITOR_DRAG_AND_DROP_BACKGROUND,
			inputEditorBackground: inactiveSessionViewBackground,
			resultEditorBackground: agentsPanelBackground,
		};
	}
}
