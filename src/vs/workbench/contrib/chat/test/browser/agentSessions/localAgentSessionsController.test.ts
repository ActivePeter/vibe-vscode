/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { runWithFakedTimers } from '../../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { workbenchInstantiationService } from '../../../../../test/browser/workbenchTestServices.js';
import { ILogicalWorkspaceService, LogicalWorkspaceActivationActor } from '../../../../../services/logicalWorkspace/common/logicalWorkspace.js';
import { LocalAgentsSessionsController } from '../../../browser/agentSessions/localAgentSessionsController.js';
import { IChatService, ResponseModelState } from '../../../common/chatService/chatService.js';
import { chatModelToChatDetail } from '../../../common/chatService/chatServiceImpl.js';
import { ChatSessionStatus, IChatSessionItem, IChatSessionsService, localChatSessionType } from '../../../common/chatSessionsService.js';
import { ChatEditingSessionState, ModifiedFileEntryState } from '../../../common/editing/chatEditingService.js';
import { ChatRequestRemovalReason, IChatChangedRequestEvent, IChatChangeEvent, IChatModel, IChatRequestModel, IChatResponseModel } from '../../../common/model/chatModel.js';
import { LocalChatSessionUri } from '../../../common/model/chatUri.js';
import { MockChatService } from '../../common/chatService/mockChatService.js';
import { MockChatSessionsService } from '../../common/mockChatSessionsService.js';

function createTestTiming(options?: {
	created?: number;
	lastRequestStarted?: number | undefined;
	lastRequestEnded?: number | undefined;
}): IChatSessionItem['timing'] {
	const now = Date.now();
	return {
		created: options?.created ?? now,
		lastRequestStarted: options?.lastRequestStarted,
		lastRequestEnded: options?.lastRequestEnded,
	};
}

interface MockChatModel extends IChatModel {
	setCustomTitle(title: string): void;
	setRequestInProgress(inProgress: boolean): void;
	addFirstRequest(): void;
	removeRequests(): void;
}

function createMockChatModel(options: {
	sessionResource: URI;
	hasRequests?: boolean;
	requestInProgress?: boolean;
	timestamp?: number;
	lastResponseComplete?: boolean;
	lastResponseCanceled?: boolean;
	lastResponseHasError?: boolean;
	lastResponseTimestamp?: number;
	lastResponseCompletedAt?: number;
	customTitle?: string;
	editingSession?: {
		entries: Array<{
			state: ModifiedFileEntryState;
			linesAdded: number;
			linesRemoved: number;
			modifiedURI: URI;
			getDiffInfo?: () => Promise<void>;
		}>;
	};
}): MockChatModel {
	const requests: IChatRequestModel[] = [];

	const createRequest = (): IChatRequestModel => {
		const mockResponse: Partial<IChatResponseModel> = {
			isComplete: options.lastResponseComplete ?? true,
			isCanceled: options.lastResponseCanceled ?? false,
			result: options.lastResponseHasError ? { errorDetails: { message: 'error' } } : undefined,
			timestamp: options.lastResponseTimestamp ?? Date.now(),
			completedAt: options.lastResponseCompletedAt,
			response: {
				value: [],
				getMarkdown: () => '',
				getFinalResponse: () => '',
				toString: () => options.customTitle ? '' : 'Test response content'
			}
		};

		return {
			id: 'request-1',
			response: mockResponse as IChatResponseModel
		} as IChatRequestModel;
	};

	let hasRequests = options.hasRequests !== false;
	if (hasRequests) {
		requests.push(createRequest());
	}

	const editingSessionEntries = options.editingSession?.entries.map(entry => ({
		state: observableValue('state', entry.state),
		linesAdded: observableValue('linesAdded', entry.linesAdded),
		linesRemoved: observableValue('linesRemoved', entry.linesRemoved),
		originalURI: entry.modifiedURI,
		modifiedURI: entry.modifiedURI,
		getDiffInfo: entry.getDiffInfo,
	}));

	const mockEditingSession = options.editingSession ? {
		entries: observableValue('entries', editingSessionEntries ?? []),
		state: observableValue('state', ChatEditingSessionState.Idle)
	} : undefined;

	const _onDidChange = new Emitter<IChatChangeEvent>();

	let title = options.customTitle ?? 'Test Chat Title';
	const requestInProgress = observableValue('requestInProgress', options.requestInProgress ?? false);
	return {
		get title() {
			return title;
		},
		sessionResource: options.sessionResource,
		get hasRequests() {
			return hasRequests;
		},
		timestamp: options.timestamp ?? Date.now(),
		timing: createTestTiming({ created: options.timestamp }),
		requestInProgress,
		getRequests: () => requests,
		onDidChange: _onDidChange.event,
		editingSession: mockEditingSession as IChatModel['editingSession'],
		lastRequestObs: observableValue('lastRequest', undefined),

		// Mock helpers
		setCustomTitle: (newTitle: string) => {
			title = newTitle;
			_onDidChange.fire({ kind: 'setCustomTitle', title });
		},
		setRequestInProgress: (inProgress: boolean) => {
			if (requestInProgress.get() === inProgress) {
				return;
			}
			requestInProgress.set(inProgress, undefined);
			_onDidChange.fire({ kind: 'changedRequest' } as IChatChangedRequestEvent);
		},
		addFirstRequest: () => {
			if (hasRequests) {
				return;
			}
			hasRequests = true;
			const request = createRequest();
			requests.push(request);
			_onDidChange.fire({ kind: 'addRequest', request });
		},
		removeRequests: () => {
			if (!hasRequests) {
				return;
			}
			hasRequests = false;
			const [request] = requests.splice(0, requests.length);
			_onDidChange.fire({ kind: 'removeRequest', requestId: request.id, reason: ChatRequestRemovalReason.Removal });
		},
	} as Partial<IChatModel> as MockChatModel;
}

suite('LocalAgentsSessionsController', () => {
	const disposables = new DisposableStore();
	let mockChatService: MockChatService;
	let mockChatSessionsService: MockChatSessionsService;
	let instantiationService: TestInstantiationService;

	setup(() => {
		mockChatService = new MockChatService();
		mockChatSessionsService = new MockChatSessionsService();
		instantiationService = disposables.add(workbenchInstantiationService(undefined, disposables));
		instantiationService.stub(IChatService, mockChatService);
		instantiationService.stub(IChatSessionsService, mockChatSessionsService);
	});

	teardown(() => {
		disposables.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	function createController(): LocalAgentsSessionsController {
		return disposables.add(instantiationService.createInstance(LocalAgentsSessionsController));
	}

	test('should have correct session type', () => {
		const controller = createController();
		assert.strictEqual(controller.chatSessionType, localChatSessionType);
	});

	test('should register itself with chat sessions service', async () => {
		const controller = createController();

		const controllerResults: { readonly chatSessionType: string; readonly items: readonly IChatSessionItem[] }[] = [];
		for await (const result of mockChatSessionsService.getChatSessionItems(undefined, CancellationToken.None)) {
			controllerResults.push(result);
		}
		assert.strictEqual(controllerResults.length, 1);
		assert.strictEqual(controllerResults[0].chatSessionType, controller.chatSessionType);
	});

	test('should provide empty sessions when no live or history sessions', async () => {
		return runWithFakedTimers({}, async () => {
			const controller = createController();

			mockChatService.setLiveSessionItems([]);
			mockChatService.setHistorySessionItems([]);

			await controller.refresh(CancellationToken.None);
			const sessions = controller.items;
			assert.strictEqual(sessions.length, 0);
		});
	});

	test('should provide live session items', async () => {
		return runWithFakedTimers({}, async () => {
			const controller = createController();

			const sessionResource = LocalChatSessionUri.forSession('test-session');
			const mockModel = createMockChatModel({
				sessionResource,
				hasRequests: true,
				timestamp: Date.now()
			});

			mockChatService.addSession(mockModel);
			mockChatService.setLiveSessionItems([{
				sessionResource,
				title: 'Test Session',
				lastMessageDate: Date.now(),
				isActive: true,
				timing: createTestTiming(),
				lastResponseState: ResponseModelState.Complete
			}]);

			await controller.refresh(CancellationToken.None);
			const sessions = controller.items;
			assert.strictEqual(sessions.length, 1);
			assert.strictEqual(sessions[0].label, 'Test Session');
			assert.strictEqual(sessions[0].resource.toString(), sessionResource.toString());
		});
	});

	test('should provide history session items', async () => {
		return runWithFakedTimers({}, async () => {
			const controller = createController();

			const sessionResource = LocalChatSessionUri.forSession('history-session');

			mockChatService.setLiveSessionItems([]);
			mockChatService.setHistorySessionItems([{
				sessionResource,
				title: 'History Session',
				lastMessageDate: Date.now() - 10000,
				isActive: false,
				lastResponseState: ResponseModelState.Complete,
				timing: createTestTiming()
			}]);

			await controller.refresh(CancellationToken.None);
			const sessions = controller.items;
			assert.strictEqual(sessions.length, 1);
			assert.strictEqual(sessions[0].label, 'History Session');
		});
	});

	test('should preserve the last complete catalog when history temporarily fails', async () => {
		const controller = createController();
		const retainedResource = LocalChatSessionUri.forSession('retained-history-session');
		const addedResource = LocalChatSessionUri.forSession('added-after-recovery');
		const retainedDetail = {
			sessionResource: retainedResource,
			title: 'Retained History Session',
			lastMessageDate: Date.now(),
			isActive: false,
			lastResponseState: ResponseModelState.Complete,
			timing: createTestTiming(),
		};
		mockChatService.setHistorySessionItems([retainedDetail]);
		await controller.refresh(CancellationToken.None);

		const deltas: { addedOrUpdated: string[]; removed: string[] }[] = [];
		disposables.add(controller.onDidChangeChatSessionItems(delta => deltas.push({
			addedOrUpdated: (delta.addedOrUpdated ?? []).map(item => item.resource.toString()),
			removed: (delta.removed ?? []).map(resource => resource.toString()),
		})));

		const readHistory = mockChatService.getHistorySessionItems.bind(mockChatService);
		let historyAvailable = false;
		mockChatService.getHistorySessionItems = async () => {
			if (!historyAvailable) {
				throw new Error('temporary history failure');
			}
			return readHistory();
		};

		await controller.refresh(CancellationToken.None);
		assert.deepStrictEqual({
			items: controller.items.map(item => item.resource.toString()),
			deltas,
		}, {
			items: [retainedResource.toString()],
			deltas: [],
		});

		historyAvailable = true;
		mockChatService.setHistorySessionItems([
			retainedDetail,
			{
				sessionResource: addedResource,
				title: 'Added After Recovery',
				lastMessageDate: Date.now(),
				isActive: false,
				lastResponseState: ResponseModelState.Complete,
				timing: createTestTiming(),
			},
		]);
		await controller.refresh(CancellationToken.None);

		assert.deepStrictEqual({
			items: controller.items.map(item => item.resource.toString()),
			deltas,
		}, {
			items: [retainedResource.toString(), addedResource.toString()],
			deltas: [{ addedOrUpdated: [addedResource.toString()], removed: [] }],
		});
	});

	test('should reject unexpected live enumeration failures instead of retrying them as history IO', async () => {
		const controller = createController();
		mockChatService.getLiveSessionItems = async () => { throw new Error('live enumeration invariant failed'); };

		await assert.rejects(controller.refresh(CancellationToken.None), /live enumeration invariant failed/);
	});

	test('should not commit a cancelled history refresh', async () => {
		const controller = createController();
		const sessionResource = LocalChatSessionUri.forSession('retained-after-cancellation');
		mockChatService.setHistorySessionItems([{
			sessionResource,
			title: 'Retained After Cancellation',
			lastMessageDate: Date.now(),
			isActive: false,
			lastResponseState: ResponseModelState.Complete,
			timing: createTestTiming(),
		}]);
		await controller.refresh(CancellationToken.None);

		const pendingHistory = new DeferredPromise<Awaited<ReturnType<IChatService['getHistorySessionItems']>>>();
		mockChatService.getHistorySessionItems = () => pendingHistory.p;
		const cancellation = new CancellationTokenSource();
		disposables.add(cancellation);
		const removed: string[] = [];
		disposables.add(controller.onDidChangeChatSessionItems(delta => removed.push(...(delta.removed ?? []).map(resource => resource.toString()))));

		const refresh = controller.refresh(cancellation.token);
		await timeout(0);
		cancellation.cancel();
		pendingHistory.complete([]);
		await refresh;

		assert.deepStrictEqual({
			items: controller.items.map(item => item.resource.toString()),
			removed,
		}, {
			items: [sessionResource.toString()],
			removed: [],
		});
	});

	test('should remove missing items after a successful complete refresh', async () => {
		const controller = createController();
		const sessionResource = LocalChatSessionUri.forSession('authoritatively-removed');
		mockChatService.setHistorySessionItems([{
			sessionResource,
			title: 'Authoritatively Removed',
			lastMessageDate: Date.now(),
			isActive: false,
			lastResponseState: ResponseModelState.Complete,
			timing: createTestTiming(),
		}]);
		await controller.refresh(CancellationToken.None);

		const removed: string[] = [];
		disposables.add(controller.onDidChangeChatSessionItems(delta => removed.push(...(delta.removed ?? []).map(resource => resource.toString()))));
		mockChatService.setHistorySessionItems([]);
		await controller.refresh(CancellationToken.None);

		assert.deepStrictEqual({
			items: controller.items,
			removed,
		}, {
			items: [],
			removed: [sessionResource.toString()],
		});
	});

	test('should keep the provider item set authoritative across workspace switches', async () => {
		return runWithFakedTimers({}, async () => {
			const controller = createController();
			const sessionResource = LocalChatSessionUri.forSession('global-provider-session');
			mockChatService.setLiveSessionItems([]);
			mockChatService.setHistorySessionItems([{
				sessionResource,
				title: 'Global Provider Session',
				lastMessageDate: Date.now(),
				isActive: false,
				lastResponseState: ResponseModelState.Complete,
				timing: createTestTiming(),
			}]);
			await controller.refresh(CancellationToken.None);

			let providerDeltaCount = 0;
			disposables.add(controller.onDidChangeChatSessionItems(() => providerDeltaCount++));
			const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
			await logicalWorkspaceService.whenReady;
			const nextWorkspace = await logicalWorkspaceService.createWorkspace('Next');
			logicalWorkspaceService.activateWorkspace(nextWorkspace.id, LogicalWorkspaceActivationActor.Picker);

			assert.deepStrictEqual({
				items: controller.items.map(item => item.resource.toString()),
				providerDeltaCount,
			}, {
				items: [sessionResource.toString()],
				providerDeltaCount: 0,
			});
		});
	});

	test('should not duplicate sessions in history and live', async () => {
		return runWithFakedTimers({}, async () => {
			const controller = createController();

			const sessionResource = LocalChatSessionUri.forSession('duplicate-session');
			const mockModel = createMockChatModel({
				sessionResource,
				hasRequests: true
			});

			mockChatService.addSession(mockModel);
			mockChatService.setLiveSessionItems([{
				sessionResource,
				title: 'Live Session',
				lastMessageDate: Date.now(),
				isActive: true,
				lastResponseState: ResponseModelState.Complete,
				timing: createTestTiming()
			}]);
			mockChatService.setHistorySessionItems([{
				sessionResource,
				title: 'History Session',
				lastMessageDate: Date.now() - 10000,
				isActive: false,
				lastResponseState: ResponseModelState.Complete,
				timing: createTestTiming()
			}]);

			await controller.refresh(CancellationToken.None);
			const sessions = controller.items;
			assert.strictEqual(sessions.length, 1);
			assert.strictEqual(sessions[0].label, 'Live Session');
		});
	});

	suite('Session Status', () => {
		test('should return InProgress status when request in progress', async () => {
			return runWithFakedTimers({}, async () => {
				const controller = createController();

				const sessionResource = LocalChatSessionUri.forSession('in-progress-session');
				const mockModel = createMockChatModel({
					sessionResource,
					hasRequests: true,
					requestInProgress: true
				});

				mockChatService.addSession(mockModel);
				mockChatService.setLiveSessionItems([{
					sessionResource,
					title: 'In Progress Session',
					lastMessageDate: Date.now(),
					isActive: true,
					lastResponseState: ResponseModelState.Complete,
					timing: createTestTiming()
				}]);

				await controller.refresh(CancellationToken.None);
				const sessions = controller.items;
				assert.strictEqual(sessions.length, 1);
				assert.strictEqual(sessions[0].status, ChatSessionStatus.InProgress);
			});
		});

		test('should return Completed status when last response is complete', async () => {
			return runWithFakedTimers({}, async () => {
				const controller = createController();

				const sessionResource = LocalChatSessionUri.forSession('completed-session');
				const mockModel = createMockChatModel({
					sessionResource,
					hasRequests: true,
					requestInProgress: false,
					lastResponseComplete: true,
					lastResponseCanceled: false,
					lastResponseHasError: false
				});

				mockChatService.addSession(mockModel);
				mockChatService.setLiveSessionItems([{
					sessionResource,
					title: 'Completed Session',
					lastMessageDate: Date.now(),
					isActive: true,
					lastResponseState: ResponseModelState.Complete,
					timing: createTestTiming(),
				}]);

				await controller.refresh(CancellationToken.None);
				const sessions = controller.items;
				assert.strictEqual(sessions.length, 1);
				assert.strictEqual(sessions[0].status, ChatSessionStatus.Completed);
			});
		});

		test('should return Success status when last response was canceled', async () => {
			return runWithFakedTimers({}, async () => {
				const controller = createController();

				const sessionResource = LocalChatSessionUri.forSession('canceled-session');
				const mockModel = createMockChatModel({
					sessionResource,
					hasRequests: true,
					requestInProgress: false,
					lastResponseComplete: false,
					lastResponseCanceled: true
				});

				mockChatService.addSession(mockModel);
				mockChatService.setLiveSessionItems([{
					sessionResource,
					title: 'Canceled Session',
					lastMessageDate: Date.now(),
					isActive: true,
					lastResponseState: ResponseModelState.Complete,
					timing: createTestTiming(),
				}]);

				await controller.refresh(CancellationToken.None);
				const sessions = controller.items;
				assert.strictEqual(sessions.length, 1);
				assert.strictEqual(sessions[0].status, ChatSessionStatus.Completed);
			});
		});

		test('should return Failed status when last response has error', async () => {
			return runWithFakedTimers({}, async () => {
				const controller = createController();

				const sessionResource = LocalChatSessionUri.forSession('error-session');
				const mockModel = createMockChatModel({
					sessionResource,
					hasRequests: true,
					requestInProgress: false,
					lastResponseComplete: true,
					lastResponseHasError: true
				});

				mockChatService.addSession(mockModel);
				mockChatService.setLiveSessionItems([{
					sessionResource,
					title: 'Error Session',
					lastMessageDate: Date.now(),
					isActive: true,
					lastResponseState: ResponseModelState.Complete,
					timing: createTestTiming(),
				}]);

				await controller.refresh(CancellationToken.None);
				const sessions = controller.items;
				assert.strictEqual(sessions.length, 1);
				assert.strictEqual(sessions[0].status, ChatSessionStatus.Failed);
			});
		});
	});

	suite('Session Statistics', () => {
		test('should return statistics for sessions with modified entries', async () => {
			return runWithFakedTimers({}, async () => {
				const controller = createController();

				const sessionResource = LocalChatSessionUri.forSession('stats-session');
				const mockModel = createMockChatModel({
					sessionResource,
					hasRequests: true,
					editingSession: {
						entries: [
							{
								state: ModifiedFileEntryState.Modified,
								linesAdded: 10,
								linesRemoved: 5,
								modifiedURI: URI.file('/test/file1.ts')
							},
							{
								state: ModifiedFileEntryState.Modified,
								linesAdded: 20,
								linesRemoved: 3,
								modifiedURI: URI.file('/test/file2.ts')
							}
						]
					}
				});

				mockChatService.addSession(mockModel);
				mockChatService.setLiveSessionItems([{
					sessionResource,
					title: 'Stats Session',
					lastMessageDate: Date.now(),
					isActive: true,
					lastResponseState: ResponseModelState.Complete,
					timing: createTestTiming(),
					stats: {
						added: 30,
						removed: 8,
						fileCount: 2
					}
				}]);

				await controller.refresh(CancellationToken.None);
				const sessions = controller.items;
				assert.strictEqual(sessions.length, 1);
				assert.ok(sessions[0].changes);
				const changes = sessions[0].changes as { files: number; insertions: number; deletions: number };
				assert.strictEqual(changes.files, 2);
				assert.strictEqual(changes.insertions, 30);
				assert.strictEqual(changes.deletions, 8);
			});
		});

		test('should not return statistics for sessions without modified entries', async () => {
			return runWithFakedTimers({}, async () => {
				const controller = createController();

				const sessionResource = LocalChatSessionUri.forSession('no-stats-session');
				const mockModel = createMockChatModel({
					sessionResource,
					hasRequests: true,
					editingSession: {
						entries: [
							{
								state: ModifiedFileEntryState.Accepted,
								linesAdded: 10,
								linesRemoved: 5,
								modifiedURI: URI.file('/test/file1.ts')
							}
						]
					}
				});

				mockChatService.addSession(mockModel);
				mockChatService.setLiveSessionItems([{
					sessionResource,
					title: 'No Stats Session',
					lastMessageDate: Date.now(),
					isActive: true,
					lastResponseState: ResponseModelState.Complete,
					timing: createTestTiming()
				}]);

				await controller.refresh(CancellationToken.None);
				const sessions = controller.items;
				assert.strictEqual(sessions.length, 1);
				assert.strictEqual(sessions[0].changes, undefined);
			});
		});
	});

	suite('Session Timing', () => {
		test('should use model timestamp for created when model exists', async () => {
			return runWithFakedTimers({}, async () => {
				const controller = createController();

				const sessionResource = LocalChatSessionUri.forSession('timing-session');
				const modelTimestamp = Date.now() - 5000;
				const mockModel = createMockChatModel({
					sessionResource,
					hasRequests: true,
					timestamp: modelTimestamp
				});

				mockChatService.addSession(mockModel);
				mockChatService.setLiveSessionItems([{
					sessionResource,
					title: 'Timing Session',
					lastMessageDate: Date.now(),
					isActive: true,
					lastResponseState: ResponseModelState.Complete,
					timing: createTestTiming({ created: modelTimestamp })
				}]);

				await controller.refresh(CancellationToken.None);
				const sessions = controller.items;
				assert.strictEqual(sessions.length, 1);
				assert.strictEqual(sessions[0].timing.created, modelTimestamp);
			});
		});

		test('should use lastMessageDate for created when model does not exist', async () => {
			return runWithFakedTimers({}, async () => {
				const controller = createController();

				const sessionResource = LocalChatSessionUri.forSession('history-timing');
				const lastMessageDate = Date.now() - 10000;

				mockChatService.setLiveSessionItems([]);
				mockChatService.setHistorySessionItems([{
					sessionResource,
					title: 'History Timing Session',
					lastMessageDate,
					isActive: false,
					lastResponseState: ResponseModelState.Complete,
					timing: createTestTiming({ created: lastMessageDate })
				}]);

				await controller.refresh(CancellationToken.None);
				const sessions = controller.items;
				assert.strictEqual(sessions.length, 1);
				assert.strictEqual(sessions[0].timing.created, lastMessageDate);
			});
		});

		test('should set lastRequestEnded from last response completedAt', async () => {
			return runWithFakedTimers({}, async () => {
				const controller = createController();

				const sessionResource = LocalChatSessionUri.forSession('endtime-session');
				const completedAt = Date.now() - 1000;
				const mockModel = createMockChatModel({
					sessionResource,
					hasRequests: true,
					lastResponseComplete: true,
					lastResponseCompletedAt: completedAt
				});

				mockChatService.addSession(mockModel);
				mockChatService.setLiveSessionItems([{
					sessionResource,
					title: 'EndTime Session',
					lastMessageDate: Date.now(),
					isActive: true,
					lastResponseState: ResponseModelState.Complete,
					timing: createTestTiming({ lastRequestEnded: completedAt })
				}]);

				await controller.refresh(CancellationToken.None);
				const sessions = controller.items;
				assert.strictEqual(sessions.length, 1);
				assert.strictEqual(sessions[0].timing.lastRequestEnded, completedAt);
			});
		});
	});

	suite('Events', () => {
		test('should not let an older live update overwrite a newer model change', async () => {
			const controller = createController();
			const firstStats = new DeferredPromise<void>();
			const secondStats = new DeferredPromise<void>();
			const firstStatsStarted = new DeferredPromise<void>();
			const secondStatsStarted = new DeferredPromise<void>();
			let statsReadCount = 0;
			const sessionResource = LocalChatSessionUri.forSession('out-of-order-live-update');
			const mockModel = createMockChatModel({
				sessionResource,
				hasRequests: true,
				customTitle: 'Older Title',
				editingSession: {
					entries: [{
						state: ModifiedFileEntryState.Modified,
						linesAdded: 1,
						linesRemoved: 0,
						modifiedURI: URI.file('/test/out-of-order.ts'),
						getDiffInfo: () => {
							statsReadCount++;
							if (statsReadCount === 1) {
								firstStatsStarted.complete();
								return firstStats.p;
							}
							secondStatsStarted.complete();
							return secondStats.p;
						},
					}],
				},
			});

			mockChatService.addSession(mockModel);
			await firstStatsStarted.p;
			mockModel.setCustomTitle('Newer Title');
			await secondStatsStarted.p;

			secondStats.complete();
			await timeout(0);
			firstStats.complete();
			await timeout(0);

			assert.deepStrictEqual(controller.items.map(item => item.label), ['Newer Title']);
		});

		test('should not revive a deleted session from an in-flight live update', async () => {
			const controller = createController();
			const pendingStats = new DeferredPromise<void>();
			const statsStarted = new DeferredPromise<void>();
			const sessionResource = LocalChatSessionUri.forSession('deleted-during-live-update');
			const mockModel = createMockChatModel({
				sessionResource,
				hasRequests: true,
				editingSession: {
					entries: [{
						state: ModifiedFileEntryState.Modified,
						linesAdded: 1,
						linesRemoved: 0,
						modifiedURI: URI.file('/test/deleted.ts'),
						getDiffInfo: () => {
							statsStarted.complete();
							return pendingStats.p;
						},
					}],
				},
			});

			mockChatService.addSession(mockModel);
			await statsStarted.p;
			mockChatService.fireDidDisposeSession([sessionResource]);
			await timeout(0);
			pendingStats.complete();
			await timeout(0);

			assert.deepStrictEqual(controller.items, []);
		});

		test('should keep model listeners after the initial catalog refresh fails', async () => {
			const controller = createController();
			let liveReadCount = 0;
			mockChatService.getLiveSessionItems = async () => {
				liveReadCount++;
				throw new Error('initial live enumeration failed');
			};
			const sessionResource = LocalChatSessionUri.forSession('initial-refresh-failure');
			const mockModel = createMockChatModel({ sessionResource, hasRequests: true });

			mockChatService.addSession(mockModel);
			await timeout(0);
			const titleUpdated = Event.toPromise(Event.filter(controller.onDidChangeChatSessionItems, delta =>
				(delta.addedOrUpdated ?? []).some(item => item.resource.toString() === sessionResource.toString() && item.label === 'Recovered Title')));

			mockModel.setCustomTitle('Recovered Title');
			await titleUpdated;

			assert.ok(liveReadCount >= 1);
			assert.strictEqual(controller.items.find(item => item.resource.toString() === sessionResource.toString())?.label, 'Recovered Title');
		});

		test('should fire onDidChangeChatSessionItems when model progress changes', async () => {
			return runWithFakedTimers({}, async () => {
				const controller = createController();

				const sessionResource = LocalChatSessionUri.forSession('progress-session');
				const mockModel = createMockChatModel({
					sessionResource,
					hasRequests: true,
					requestInProgress: false
				});

				// Add the session first
				mockChatService.addSession(mockModel);
				mockChatService.setLiveSessionItems([await chatModelToChatDetail(mockModel)]);

				// Flush the initial add/reconcile churn from session creation.
				await controller.refresh(CancellationToken.None);
				await timeout(0);

				let changeEventCount = 0;
				disposables.add(controller.onDidChangeChatSessionItems(() => {
					changeEventCount++;
				}));

				const onDidChangeChatSessionItems = Event.toPromise(controller.onDidChangeChatSessionItems);

				// Simulate a real progress change by toggling the in-progress state.
				mockModel.setRequestInProgress(true);
				await onDidChangeChatSessionItems;

				assert.strictEqual(changeEventCount, 1);
			});
		});

		test('should fire onDidChangeChatSessionItems when model request status changes', async () => {
			return runWithFakedTimers({}, async () => {
				const controller = disposables.add(createController());

				const sessionResource = LocalChatSessionUri.forSession('status-change-session');
				const mockModel = createMockChatModel({
					sessionResource,
					hasRequests: true,
					requestInProgress: false
				});

				// Add the session first
				mockChatService.addSession(mockModel);
				mockChatService.setLiveSessionItems([await chatModelToChatDetail(mockModel)]);

				let changeEventCount = 0;
				disposables.add(controller.onDidChangeChatSessionItems(() => {
					changeEventCount++;
				}));
				await controller.refresh(CancellationToken.None);
				assert.strictEqual(changeEventCount, 1); // 1 from refresh detecting the new session

				const onDidChangeChatSessionItems = Event.toPromise(controller.onDidChangeChatSessionItems);

				mockModel.setRequestInProgress(true);

				await onDidChangeChatSessionItems;
				assert.strictEqual(changeEventCount, 2);
			});
		});

		test('should fire onDidChangeChatSessionItems when refresh discovers new sessions', async () => {
			return runWithFakedTimers({}, async () => {
				const controller = createController();

				const sessionResource1 = LocalChatSessionUri.forSession('session-1');
				const mockModel1 = createMockChatModel({ sessionResource: sessionResource1, hasRequests: true });
				mockChatService.addSession(mockModel1);
				mockChatService.setLiveSessionItems([await chatModelToChatDetail(mockModel1)]);

				// Initial refresh populates _items
				await controller.refresh(CancellationToken.None);
				assert.strictEqual(controller.items.length, 1);

				// Simulate a forked session appearing (new model added, live items updated)
				const sessionResource2 = LocalChatSessionUri.forSession('session-2-forked');
				const mockModel2 = createMockChatModel({ sessionResource: sessionResource2, hasRequests: true, customTitle: 'Forked: Test Chat Title' });
				mockChatService.addSession(mockModel2);
				mockChatService.setLiveSessionItems([
					await chatModelToChatDetail(mockModel1),
					await chatModelToChatDetail(mockModel2),
				]);

				const fired: { addedOrUpdated?: readonly IChatSessionItem[]; removed?: readonly URI[] }[] = [];
				disposables.add(controller.onDidChangeChatSessionItems(delta => fired.push(delta)));

				await controller.refresh(CancellationToken.None);

				assert.strictEqual(controller.items.length, 2);
				// The event must have fired with the new (forked) session
				const addedResources = fired.flatMap(d => d.addedOrUpdated ?? []).map(i => i.resource.toString());
				assert.ok(addedResources.includes(sessionResource2.toString()), 'forked session should appear in addedOrUpdated');
				assert.ok(!addedResources.includes(sessionResource1.toString()), 'existing session should not appear in addedOrUpdated');
			});
		});

		test('should add a newly started session once it gets its first request', async () => {
			return runWithFakedTimers({}, async () => {
				const controller = createController();

				const sessionResource = LocalChatSessionUri.forSession('new-session');
				const mockModel = createMockChatModel({
					sessionResource,
					hasRequests: false
				});

				const fired: { addedOrUpdated?: readonly IChatSessionItem[]; removed?: readonly URI[] }[] = [];
				disposables.add(controller.onDidChangeChatSessionItems(delta => fired.push(delta)));

				// A brand new session is created without any requests yet.
				mockChatService.addSession(mockModel);
				await timeout(0);
				assert.strictEqual(controller.items.length, 0, 'session without requests should not be listed yet');

				// The user sends the first message, so the session now qualifies as a list item.
				mockModel.addFirstRequest();
				await timeout(0);

				assert.strictEqual(controller.items.length, 1, 'session should appear as soon as it has a request');
				const addedResources = fired.flatMap(d => d.addedOrUpdated ?? []).map(i => i.resource.toString());
				assert.ok(addedResources.includes(sessionResource.toString()), 'new session should appear in addedOrUpdated without a manual refresh');
			});
		});

		test('should remove a listed session once its requests are removed', async () => {
			return runWithFakedTimers({}, async () => {
				const controller = createController();

				const sessionResource = LocalChatSessionUri.forSession('emptied-session');
				const mockModel = createMockChatModel({
					sessionResource,
					hasRequests: true
				});

				mockChatService.addSession(mockModel);
				mockChatService.setLiveSessionItems([await chatModelToChatDetail(mockModel)]);
				await controller.refresh(CancellationToken.None);
				assert.strictEqual(controller.items.length, 1);

				const removedResources: URI[] = [];
				disposables.add(controller.onDidChangeChatSessionItems(delta => {
					if (delta.removed) {
						removedResources.push(...delta.removed);
					}
				}));

				// All requests are removed, so the session no longer qualifies as a list item.
				mockModel.removeRequests();
				await timeout(0);

				assert.strictEqual(controller.items.length, 0, 'session should be dropped once it has no requests');
				assert.ok(removedResources.some(r => r.toString() === sessionResource.toString()), 'emptied session should be removed without a manual refresh');
			});
		});

		test('should clean up model listeners when model is removed via chatModels observable', async () => {
			return runWithFakedTimers({}, async () => {
				const controller = createController();

				const sessionResource = LocalChatSessionUri.forSession('cleanup-session');
				const mockModel = createMockChatModel({
					sessionResource,
					hasRequests: true
				});

				// Add the session first
				mockChatService.addSession(mockModel);

				// Now remove the session - the observable should trigger cleanup
				mockChatService.removeSession(sessionResource);

				// Verify the listener was cleaned up by triggering a title change
				// The onDidChangeChatSessionItems from registerModelListeners cleanup should fire once
				// but after that, title changes should NOT fire onDidChangeChatSessionItems
				let changeEventCount = 0;
				disposables.add(controller.onDidChangeChatSessionItems(() => {
					changeEventCount++;
				}));

				mockModel.setCustomTitle('New Title');

				assert.strictEqual(changeEventCount, 0, 'onDidChangeChatSessionItems should NOT fire after model is removed');
			});
		});

		test('should retain a disposed live model when the session remains in persisted history', async () => {
			return runWithFakedTimers({}, async () => {
				const controller = createController();

				const sessionResource = LocalChatSessionUri.forSession('dispose-session');
				const mockModel = createMockChatModel({
					sessionResource,
					hasRequests: true
				});

				// Add the session and populate items
				const sessionDetail = await chatModelToChatDetail(mockModel);
				mockChatService.addSession(mockModel);
				mockChatService.setLiveSessionItems([sessionDetail]);
				await controller.refresh(CancellationToken.None);
				assert.strictEqual(controller.items.length, 1);

				// Listen for the removed event
				const removedResources: URI[] = [];
				disposables.add(controller.onDidChangeChatSessionItems(delta => {
					if (delta.removed) {
						removedResources.push(...delta.removed);
					}
				}));

				// Closing the live model moves it from the live source to persisted history.
				mockChatService.setLiveSessionItems([]);
				mockChatService.setHistorySessionItems([sessionDetail]);
				mockChatService.fireDidDisposeSession([sessionResource]);
				await timeout(0);

				assert.deepStrictEqual({
					items: controller.items.map(item => item.resource.toString()),
					removed: removedResources.map(resource => resource.toString()),
				}, {
					items: [sessionResource.toString()],
					removed: [],
				});
			});
		});

		test('should remove a deleted session after disposal reconciliation returns a complete snapshot', async () => {
			return runWithFakedTimers({}, async () => {
				const controller = createController();

				const sessionResource = LocalChatSessionUri.forSession('disposed-refresh-session');
				const mockModel = createMockChatModel({
					sessionResource,
					hasRequests: true
				});

				// Add the session and populate items
				mockChatService.addSession(mockModel);
				mockChatService.setLiveSessionItems([await chatModelToChatDetail(mockModel)]);
				await controller.refresh(CancellationToken.None);
				assert.strictEqual(controller.items.length, 1);

				const removedResources: string[] = [];
				disposables.add(controller.onDidChangeChatSessionItems(delta => removedResources.push(...(delta.removed ?? []).map(resource => resource.toString()))));

				// A persisted deletion removes the session from both sources before disposal is announced.
				mockChatService.setLiveSessionItems([]);
				mockChatService.setHistorySessionItems([]);
				mockChatService.fireDidDisposeSession([sessionResource]);
				await timeout(0);

				assert.deepStrictEqual({
					items: controller.items,
					removedResources,
				}, {
					items: [],
					removedResources: [sessionResource.toString()],
				});
			});
		});
	});
});
