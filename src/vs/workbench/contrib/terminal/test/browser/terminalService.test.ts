/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, fail, rejects, strictEqual } from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { remoteResolverTerminal, TerminalExitReason, TerminalLocation, TitleEventSource, type ICreateContributedTerminalProfileOptions, type IPtyHostAttachTarget, type IShellLaunchConfig, type ITerminalBackend, type ITerminalsLayoutInfo, type ITerminalsLayoutInfoById, type TerminalIcon } from '../../../../../platform/terminal/common/terminal.js';
import { IDeserializedTerminalEditorInput, ITerminalEditorService, ITerminalGroup, ITerminalGroupService, ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../browser/terminal.js';
import { TerminalEditorInput } from '../../browser/terminalEditorInput.js';
import { TerminalEditorService } from '../../browser/terminalEditorService.js';
import { TerminalGroup } from '../../browser/terminalGroup.js';
import { TerminalProfileQuickpick } from '../../browser/terminalProfileQuickpick.js';
import { TerminalService } from '../../browser/terminalService.js';
import { ITerminalProfileService, TERMINAL_CONFIG_SECTION } from '../../common/terminal.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { ILogicalWorkspace, ILogicalWorkspaceService, LogicalWorkspaceActivationActor } from '../../../../services/logicalWorkspace/common/logicalWorkspace.js';
import { IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';
import { TestEnvironmentService, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import type { IConfigurationChangeEvent } from '../../../../../platform/configuration/common/configuration.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { TerminalCapabilityStore } from '../../../../../platform/terminal/common/capabilities/terminalCapabilityStore.js';
import { TerminalStatusList } from '../../browser/terminalStatusList.js';
import { IResourceEditorInput } from '../../../../../platform/editor/common/editor.js';
import { EditorCloseContext, IEditorCloseEvent } from '../../../../common/editor.js';

suite('Workbench - TerminalService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let terminalService: TerminalService;
	let configurationService: TestConfigurationService;
	let dialogService: TestDialogService;
	let instantiationService: ReturnType<typeof workbenchInstantiationService>;

	setup(async () => {
		dialogService = new TestDialogService();
		configurationService = new TestConfigurationService({
			files: {},
			terminal: {
				integrated: {
					confirmOnKill: 'never',
					enablePersistentSessions: true
				}
			}
		});

		instantiationService = workbenchInstantiationService({
			configurationService: () => configurationService,
		}, store);
		instantiationService.stub(IDialogService, dialogService);
		instantiationService.stub(ITerminalInstanceService, 'getBackend', undefined);
		instantiationService.stub(ITerminalInstanceService, 'getRegisteredBackends', []);
		instantiationService.stub(IRemoteAgentService, 'getConnection', null);

		terminalService = store.add(instantiationService.createInstance(TerminalService));
		instantiationService.stub(ITerminalService, terminalService);
	});

	suite('background terminals', () => {
		async function assertReusesEditorInstanceWhenAttachCreationRaces(hideFromUser: boolean): Promise<void> {
			const attachTarget = {
				id: 17,
				logicalWorkspaceId: 'workspace',
				logicalTerminalId: 'terminal',
				pid: 1,
				title: 'Terminal',
				titleSource: TitleEventSource.Process,
				cwd: '/',
				shellIntegrationNonce: '',
			} satisfies Partial<IPtyHostAttachTarget> as IPtyHostAttachTarget;
			const shellLaunchConfig: IShellLaunchConfig = { attachPersistentProcess: attachTarget, hideFromUser };
			const existing = {
				persistentProcessId: attachTarget.id,
				remoteAuthority: undefined,
				target: TerminalLocation.Editor,
				shellLaunchConfig: { logicalWorkspaceId: 'workspace', logicalTerminalId: 'terminal' },
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
			const editorInstances: ITerminalInstance[] = [];
			Object.defineProperty(instantiationService.get(ITerminalEditorService), 'instances', { configurable: true, get: () => editorInstances });
			instantiationService.stub(ITerminalInstanceService, 'convertProfileToShellLaunchConfig', () => shellLaunchConfig);
			const createInstance = instantiationService.stub(ITerminalInstanceService, 'createInstance', () => {
				throw new Error('A second attach client must not be created');
			});
			type FindExistingAttachInstance = (attachTarget: Pick<IPtyHostAttachTarget, 'id' | 'logicalWorkspaceId' | 'logicalTerminalId'> | undefined, remoteAuthority?: string) => ITerminalInstance | undefined;
			const findExistingAttachInstance = (Reflect.get(terminalService, '_findExistingAttachInstance') as FindExistingAttachInstance).bind(terminalService);
			let attachChecks = 0;
			Reflect.set(terminalService, '_findExistingAttachInstance', (candidate: Parameters<FindExistingAttachInstance>[0], remoteAuthority?: string) => {
				const result = findExistingAttachInstance(candidate, remoteAuthority);
				if (++attachChecks === 1) {
					editorInstances.push(existing);
				}
				return result;
			});
			terminalService.registerProcessSupport(true);

			const restored = await terminalService.createTerminal({ config: shellLaunchConfig, location: TerminalLocation.Panel, skipContributedProfileCheck: true });

			deepStrictEqual({ restoredSameInstance: restored === existing, createCalls: createInstance.callCount, attachChecks }, {
				restoredSameInstance: true,
				createCalls: 0,
				attachChecks: 2,
			});
		}

		test('should reuse an editor instance when visible attach creation races the serializer', async () => {
			await assertReusesEditorInstanceWhenAttachCreationRaces(false);
		});

		test('should reuse an editor instance when hidden attach creation races the serializer', async () => {
			await assertReusesEditorInstanceWhenAttachCreationRaces(true);
		});

		test('should let a Terminal editor working set adopt the retained instance', () => {
			const resource = URI.parse('vscode-terminal://physical/1');
			const editorInput = { resource } as TerminalEditorInput;
			const editorInstances: ITerminalInstance[] = [];
			let revivedAttachClients = 0;
			Object.defineProperty(instantiationService.get(ITerminalEditorService), 'instances', { configurable: true, get: () => editorInstances });
			instantiationService.stub(ITerminalEditorService, 'detachInstance', () => { });
			instantiationService.stub(ITerminalEditorService, 'resolveResource', (instance: ITerminalInstance) => {
				editorInstances.push(instance);
				return resource;
			});
			instantiationService.stub(ITerminalEditorService, 'getInputFromResource', () => editorInput);
			instantiationService.stub(ITerminalEditorService, 'reviveInput', () => {
				revivedAttachClients++;
				return editorInput;
			});
			const instance = {
				instanceId: 1,
				persistentProcessId: 17,
				remoteAuthority: 'test-remote',
				target: TerminalLocation.Editor,
				resource,
				shellLaunchConfig: { logicalWorkspaceId: 'workspace', logicalTerminalId: 'terminal' },
				onDisposed: Event.None,
				detachFromElement: () => { },
				setVisible: () => { },
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
			terminalService.moveToBackground(instance);

			const restored = terminalService.reviveTerminalEditorInput({
				id: 17,
				logicalWorkspaceId: 'workspace',
				logicalTerminalId: 'terminal',
				remoteAuthority: 'test-remote',
				pid: 1,
				title: 'Terminal',
				titleSource: TitleEventSource.Process,
				cwd: '/',
				icon: undefined,
				color: undefined,
				hasChildProcesses: false,
				shellIntegrationNonce: '',
			} satisfies IDeserializedTerminalEditorInput);

			deepStrictEqual({
				restoredSameInput: restored === editorInput,
				revivedAttachClients,
				foregroundInstances: terminalService.foregroundInstances,
				backgroundCount: (Reflect.get(terminalService, '_backgroundedTerminalInstances') as unknown[]).length,
			}, {
				restoredSameInput: true,
				revivedAttachClients: 0,
				foregroundInstances: [instance],
				backgroundCount: 0,
			});
		});

		test('should keep retained Terminal editor identity partitioned by backend authority', () => {
			const localResource = URI.parse('vscode-terminal://physical/2');
			const editorInput = { resource: localResource } as TerminalEditorInput;
			const editorInstances: ITerminalInstance[] = [];
			let adoptedInstance: ITerminalInstance | undefined;
			Object.defineProperty(instantiationService.get(ITerminalEditorService), 'instances', { configurable: true, get: () => editorInstances });
			instantiationService.stub(ITerminalEditorService, 'detachInstance', () => { });
			instantiationService.stub(ITerminalEditorService, 'resolveResource', (instance: ITerminalInstance) => {
				adoptedInstance = instance;
				editorInstances.push(instance);
				return localResource;
			});
			instantiationService.stub(ITerminalEditorService, 'getInputFromResource', () => editorInput);
			instantiationService.stub(ITerminalEditorService, 'reviveInput', () => {
				throw new Error('The retained local instance must be adopted');
			});
			const createInstance = (instanceId: number, remoteAuthority: string | undefined, resource: URI): ITerminalInstance => ({
				instanceId,
				persistentProcessId: 17,
				remoteAuthority,
				target: TerminalLocation.Editor,
				resource,
				shellLaunchConfig: { logicalWorkspaceId: 'workspace', logicalTerminalId: 'same-terminal-id' },
				onDisposed: Event.None,
				detachFromElement: () => { },
				setVisible: () => { },
			}) satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
			const remoteInstance = createInstance(1, 'test-remote', URI.parse('vscode-terminal://physical/1'));
			const localInstance = createInstance(2, undefined, localResource);
			terminalService.moveToBackground(remoteInstance);
			terminalService.moveToBackground(localInstance);

			const restored = terminalService.reviveTerminalEditorInput({
				id: 17,
				logicalWorkspaceId: 'workspace',
				logicalTerminalId: 'same-terminal-id',
				remoteAuthority: null,
				pid: 1,
				title: 'Local Terminal',
				titleSource: TitleEventSource.Process,
				cwd: '/',
				icon: undefined,
				color: undefined,
				hasChildProcesses: false,
				shellIntegrationNonce: '',
			} satisfies IDeserializedTerminalEditorInput);

			deepStrictEqual({
				restoredSameInput: restored === editorInput,
				adoptedLocalInstance: adoptedInstance === localInstance,
				foregroundInstances: terminalService.foregroundInstances,
				backgroundInstances: (Reflect.get(terminalService, '_backgroundedTerminalInstances') as Array<{ instance: ITerminalInstance }>).map(entry => entry.instance),
			}, {
				restoredSameInput: true,
				adoptedLocalInstance: true,
				foregroundInstances: [localInstance],
				backgroundInstances: [remoteInstance],
			});
		});

		test('should preserve terminals backgrounded while the remote layout is loading', async () => {
			const attachTarget = {
				id: 17,
				logicalWorkspaceId: 'workspace',
				logicalTerminalId: 'remote-terminal',
			} satisfies Partial<IPtyHostAttachTarget> as IPtyHostAttachTarget;
			const layoutRequested = new DeferredPromise<void>();
			const layoutReady = new DeferredPromise<{ tabs: []; background: IPtyHostAttachTarget[] }>();
			const backend = {
				remoteAuthority: 'test-remote',
				onDidRequestDetach: Event.None,
				async getTerminalLayoutInfo() {
					await layoutRequested.complete();
					return layoutReady.p;
				},
				async reduceConnectionGraceTime() { },
			} satisfies Partial<ITerminalBackend> as unknown as ITerminalBackend;
			const remoteEnvironmentService = Object.create(TestEnvironmentService, {
				remoteAuthority: { value: 'test-remote' },
			}) as IWorkbenchEnvironmentService;
			const remoteInstantiationService = workbenchInstantiationService({
				configurationService: () => configurationService,
				environmentService: () => remoteEnvironmentService,
			}, store);
			remoteInstantiationService.stub(ITerminalInstanceService, 'getBackend', async (remoteAuthority: string | undefined) => remoteAuthority === 'test-remote' ? backend : undefined);
			remoteInstantiationService.stub(ITerminalInstanceService, 'getRegisteredBackends', []);
			remoteInstantiationService.stub(ITerminalProfileService, 'getContributedDefaultProfile', async () => undefined);
			remoteInstantiationService.stub(IRemoteAgentService, 'getConnection', null);
			const createInstance = remoteInstantiationService.stub(ITerminalInstanceService, 'createInstance', () => {
				throw new Error('An existing attach client must be retained');
			});
			remoteInstantiationService.stub(ITerminalGroupService, 'getGroupForInstance', () => ({
				removeInstance: () => { },
			} satisfies Partial<ITerminalGroup> as unknown as ITerminalGroup));

			const remoteTerminalService = store.add(remoteInstantiationService.createInstance(TerminalService));
			remoteInstantiationService.stub(ITerminalService, remoteTerminalService);
			await layoutRequested.p;
			const createBackgroundInstance = (instanceId: number, remoteAuthority: string | undefined, logicalTerminalId: string, persistentProcessId: number): ITerminalInstance => ({
				instanceId,
				persistentProcessId,
				remoteAuthority,
				target: TerminalLocation.Panel,
				shellLaunchConfig: { logicalWorkspaceId: 'workspace', logicalTerminalId },
				onDisposed: Event.None,
				onIconChanged: Event.None,
				onProcessIdReady: Event.None,
				onTitleChanged: Event.None,
				detachFromElement: () => { },
				setVisible: () => { },
			}) satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
			const matchingRemoteInstance = createBackgroundInstance(1, 'test-remote', attachTarget.logicalTerminalId!, attachTarget.id);
			const unrelatedLocalInstance = createBackgroundInstance(2, undefined, 'local-terminal', 23);
			remoteTerminalService.moveToBackground(matchingRemoteInstance);
			remoteTerminalService.moveToBackground(unrelatedLocalInstance);

			await layoutReady.complete({ tabs: [], background: [attachTarget] });
			await remoteTerminalService.whenConnected;

			deepStrictEqual({
				backgroundInstances: (Reflect.get(remoteTerminalService, '_backgroundedTerminalInstances') as Array<{ instance: ITerminalInstance }>).map(entry => entry.instance),
				allInstances: remoteTerminalService.instances,
				createCalls: createInstance.callCount,
			}, {
				backgroundInstances: [matchingRemoteInstance, unrelatedLocalInstance],
				allInstances: [matchingRemoteInstance, unrelatedLocalInstance],
				createCalls: 0,
			});
		});

		test('should wait for an editor terminal to finish opening before reporting it foregrounded', async () => {
			const openStarted = new DeferredPromise<void>();
			const releaseOpen = new DeferredPromise<void>();
			instantiationService.stub(ITerminalEditorService, 'detachInstance', () => { });
			instantiationService.stub(ITerminalEditorService, 'openEditor', async () => {
				await openStarted.complete();
				await releaseOpen.p;
			});

			const disposalEmitter = store.add(new Emitter<ITerminalInstance>());
			const instance = {
				instanceId: 1,
				target: TerminalLocation.Editor,
				onDisposed: disposalEmitter.event,
				detachFromElement: () => { },
				setVisible: () => { },
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
			terminalService.moveToBackground(instance);

			let completed = false;
			const showing = terminalService.showBackgroundTerminal(instance).then(() => completed = true);
			await openStarted.p;
			await timeout(0);
			strictEqual(completed, false);

			await releaseOpen.complete();
			await showing;
			strictEqual(completed, true);
		});

		test('should restore background ownership when an editor terminal fails to open', async () => {
			const expectedError = new Error('editor open failed');
			instantiationService.stub(ITerminalEditorService, 'detachInstance', () => { });
			instantiationService.stub(ITerminalEditorService, 'openEditor', async () => { throw expectedError; });

			const disposalEmitter = store.add(new Emitter<ITerminalInstance>());
			const instance = {
				instanceId: 1,
				target: TerminalLocation.Editor,
				isDisposed: false,
				onDisposed: disposalEmitter.event,
				detachFromElement: () => { },
				setVisible: () => { },
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
			terminalService.moveToBackground(instance);
			let changeCount = 0;
			store.add(terminalService.onDidChangeInstances(() => changeCount++));

			await rejects(terminalService.showBackgroundTerminal(instance), error => error === expectedError);

			deepStrictEqual({
				instances: terminalService.instances,
				foregroundInstances: terminalService.foregroundInstances,
				backgroundInstances: (Reflect.get(terminalService, '_backgroundedTerminalInstances') as Array<{ instance: ITerminalInstance }>).map(entry => entry.instance),
				changeCount,
			}, {
				instances: [instance],
				foregroundInstances: [],
				backgroundInstances: [instance],
				changeCount: 0,
			});
		});

		test('should restore background ownership when a panel group fails to open', async () => {
			const expectedError = new Error('panel group open failed');
			let groupForInstance: ITerminalGroup | undefined = {
				removeInstance: () => groupForInstance = undefined,
			} satisfies Partial<ITerminalGroup> as unknown as ITerminalGroup;
			instantiationService.stub(ITerminalGroupService, 'getGroupForInstance', () => groupForInstance);
			instantiationService.stub(ITerminalGroupService, 'createGroup', () => { throw expectedError; });

			const disposalEmitter = store.add(new Emitter<ITerminalInstance>());
			const instance = {
				instanceId: 2,
				target: TerminalLocation.Panel,
				isDisposed: false,
				onDisposed: disposalEmitter.event,
				detachFromElement: () => { },
				setVisible: () => { },
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
			terminalService.moveToBackground(instance);

			await rejects(terminalService.showBackgroundTerminal(instance), error => error === expectedError);

			deepStrictEqual({
				instances: terminalService.instances,
				foregroundInstances: terminalService.foregroundInstances,
				backgroundInstances: (Reflect.get(terminalService, '_backgroundedTerminalInstances') as Array<{ instance: ITerminalInstance }>).map(entry => entry.instance),
				disposalListenerRestored: disposalEmitter.hasListeners(),
			}, {
				instances: [instance],
				foregroundInstances: [],
				backgroundInstances: [instance],
				disposalListenerRestored: true,
			});
		});

		test('should keep the panel open while moving its last terminal to the background', async () => {
			await configurationService.setUserConfiguration(TERMINAL_CONFIG_SECTION, { hideOnLastClosed: true });
			configurationService.onDidChangeConfigurationEmitter.fire({
				affectsConfiguration: () => true,
				affectedKeys: ['terminal.integrated.hideOnLastClosed']
			} as unknown as IConfigurationChangeEvent);

			const activeInstanceEmitter = store.add(new Emitter<ITerminalInstance | undefined>());
			instantiationService.stub(ITerminalGroupService, 'onDidChangeActiveInstance', activeInstanceEmitter.event);
			const hidePanelSpy = instantiationService.stub(ITerminalGroupService, 'hidePanel', () => { });
			instantiationService.stub(ITerminalGroupService, 'getGroupForInstance', () => ({
				removeInstance: () => activeInstanceEmitter.fire(undefined),
			} satisfies Partial<ITerminalGroup> as unknown as ITerminalGroup));
			const serviceUnderTest = store.add(instantiationService.createInstance(TerminalService));

			const disposalEmitter = store.add(new Emitter<ITerminalInstance>());
			const visibility: boolean[] = [];
			let detachCount = 0;
			const instance = {
				instanceId: 1,
				target: TerminalLocation.Panel,
				onDisposed: disposalEmitter.event,
				detachFromElement: () => detachCount++,
				setVisible: visible => visibility.push(visible),
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;

			serviceUnderTest.moveToBackground(instance);
			const hidePanelCallsAfterBackgrounding = hidePanelSpy.callCount;
			activeInstanceEmitter.fire(undefined);

			deepStrictEqual({
				detachCount,
				visibility,
				isTracked: serviceUnderTest.instances.includes(instance),
				hidePanelCallsAfterBackgrounding,
				hidePanelCallsAfterClosing: hidePanelSpy.callCount,
			}, {
				detachCount: 1,
				visibility: [false],
				isTracked: true,
				hidePanelCallsAfterBackgrounding: 0,
				hidePanelCallsAfterClosing: 1,
			});
		});

		test('should remove disposed hidden terminals and their listeners', async () => {
			const disposalEmitters = Array.from({ length: 3 }, () => store.add(new Emitter<ITerminalInstance>()));
			const instances = disposalEmitters.map((emitter, index) => ({
				instanceId: index + 1,
				onDisposed: emitter.event,
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance));
			let instanceIndex = 0;
			instantiationService.stub(ITerminalInstanceService, 'convertProfileToShellLaunchConfig', () => ({ hideFromUser: true }));
			instantiationService.stub(ITerminalInstanceService, 'createInstance', () => instances[instanceIndex++]);
			terminalService.registerProcessSupport(true);

			const backgroundedTerminalDisposables = Reflect.get(terminalService, '_backgroundedTerminalDisposables') as { size: number };
			for (let i = 0; i < instances.length; i++) {
				const instance = await terminalService.createTerminal({
					config: { hideFromUser: true },
					skipContributedProfileCheck: true,
				});

				strictEqual(terminalService.instances.includes(instance), true);
				strictEqual(backgroundedTerminalDisposables.size, 1);
				strictEqual(disposalEmitters[i].hasListeners(), true);

				disposalEmitters[i].fire(instance);

				strictEqual(terminalService.instances.includes(instance), false);
				strictEqual(backgroundedTerminalDisposables.size, 0);
				strictEqual(disposalEmitters[i].hasListeners(), false);
			}
		});

		test('should restore and persist only the current remote backend layout', async () => {
			const attachTarget = {
				id: 23,
				logicalWorkspaceId: 'logical-workspace',
				logicalTerminalId: 'remote-background-terminal',
			} satisfies Partial<IPtyHostAttachTarget> as IPtyHostAttachTarget;
			let persistedState: ITerminalsLayoutInfoById | undefined;
			const backend = {
				remoteAuthority: 'test-remote',
				onDidRequestDetach: Event.None,
				async getTerminalLayoutInfo() {
					return { tabs: [], background: [attachTarget] };
				},
				async reduceConnectionGraceTime() { },
				async setTerminalLayoutInfo(state: ITerminalsLayoutInfoById | undefined) {
					persistedState = state;
				},
			} satisfies Partial<ITerminalBackend> as unknown as ITerminalBackend;
			const remoteEnvironmentService = Object.create(TestEnvironmentService, {
				remoteAuthority: { value: 'test-remote' },
			}) as IWorkbenchEnvironmentService;
			const remoteInstantiationService = workbenchInstantiationService({
				configurationService: () => configurationService,
				environmentService: () => remoteEnvironmentService,
			}, store);
			remoteInstantiationService.stub(ITerminalInstanceService, 'getBackend', async (remoteAuthority: string | undefined) => remoteAuthority === 'test-remote' ? backend : undefined);
			remoteInstantiationService.stub(ITerminalInstanceService, 'getRegisteredBackends', []);
			remoteInstantiationService.stub(ITerminalProfileService, 'getContributedDefaultProfile', async () => undefined);
			remoteInstantiationService.stub(IRemoteAgentService, 'getConnection', null);

			let revivedShellLaunchConfig: IShellLaunchConfig | undefined;
			const revivedInstance = {
				instanceId: 24,
				persistentProcessId: attachTarget.id,
				remoteAuthority: 'test-remote',
				target: TerminalLocation.Panel,
				shouldPersist: true,
				get shellLaunchConfig() { return revivedShellLaunchConfig!; },
				onDisposed: Event.None,
				onIconChanged: Event.None,
				onProcessIdReady: Event.None,
				onTitleChanged: Event.None,
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
			remoteInstantiationService.stub(ITerminalInstanceService, 'convertProfileToShellLaunchConfig', (config: Parameters<ITerminalInstanceService['convertProfileToShellLaunchConfig']>[0]) => revivedShellLaunchConfig = config as IShellLaunchConfig);
			remoteInstantiationService.stub(ITerminalInstanceService, 'createInstance', () => revivedInstance);
			const remoteTerminalService = store.add(remoteInstantiationService.createInstance(TerminalService));
			remoteInstantiationService.stub(ITerminalService, remoteTerminalService);
			remoteTerminalService.registerProcessSupport(true);

			await remoteTerminalService.whenConnected;

			const remoteForeground = createLayoutTerminalInstance(25, 17, 'test-remote');
			const localForeground = createLayoutTerminalInstance(26, 17, undefined);
			const group = store.add(remoteInstantiationService.createInstance(TerminalGroup, undefined, remoteForeground));
			group.addInstance(localForeground);
			group.setActiveInstanceByIndex(1);
			Object.assign(remoteInstantiationService.get(ITerminalGroupService), { groups: [group], activeGroup: group });

			const localBackground = createLayoutTerminalInstance(27, attachTarget.id, undefined, { forcePersist: true });
			const editorBackground = createLayoutTerminalInstance(28, 29, 'test-remote', { forcePersist: true });
			editorBackground.target = TerminalLocation.Editor;
			const backgroundedInstances = Reflect.get(remoteTerminalService, '_backgroundedTerminalInstances') as Array<{ instance: ITerminalInstance }>;
			backgroundedInstances.push({ instance: localBackground }, { instance: editorBackground });

			await runWithFakedTimers({}, async () => saveState(remoteTerminalService));

			deepStrictEqual({
				restoredAttachTarget: revivedShellLaunchConfig?.attachPersistentProcess,
				persistedState,
			}, {
				restoredAttachTarget: attachTarget,
				persistedState: {
					tabs: [{
						isActive: true,
						activePersistentProcessId: undefined,
						terminals: [{ relativeSize: 0, terminal: 17 }],
					}],
					background: [attachTarget.id],
				},
			});
		});

		test('should restore the active process only from the reconnecting backend authority', async () => {
			const attachTarget = {
				id: 17,
				isOrphan: true,
			} satisfies Partial<IPtyHostAttachTarget> as IPtyHostAttachTarget;
			const localInstance = createLayoutTerminalInstance(30, attachTarget.id, undefined, { attachPersistentProcess: attachTarget });
			const remoteInstance = createLayoutTerminalInstance(31, attachTarget.id, 'test-remote', { attachPersistentProcess: attachTarget });
			(Reflect.get(terminalService, '_backgroundedTerminalInstances') as Array<{ instance: ITerminalInstance }>).push(
				{ instance: localInstance },
				{ instance: remoteInstance },
			);
			let activeInstance: ITerminalInstance | undefined;
			instantiationService.stub(ITerminalGroupService, 'setActiveInstance', (instance: ITerminalInstance) => activeInstance = instance);
			Reflect.set(terminalService, '_recreateTerminalGroup', async () => undefined);
			const layoutInfo: ITerminalsLayoutInfo = {
				tabs: [{
					isActive: true,
					activePersistentProcessId: attachTarget.id,
					terminals: [{ relativeSize: 1, terminal: attachTarget }],
				}],
				background: [],
			};
			const recreateTerminalGroups = Reflect.get(terminalService, '_recreateTerminalGroups') as (layoutInfo: ITerminalsLayoutInfo, remoteAuthority: string | undefined) => Promise<ITerminalGroup[]>;

			await recreateTerminalGroups.call(terminalService, layoutInfo, 'test-remote');

			deepStrictEqual({
				activatedRemoteInstance: activeInstance === remoteInstance,
				activatedLocalInstance: activeInstance === localInstance,
			}, {
				activatedRemoteInstance: true,
				activatedLocalInstance: false,
			});
		});
	});

	test('should reject and dispose a new editor terminal when its editor fails to open', async () => {
		const expectedError = new Error('editor open failed');
		const shellLaunchConfig: IShellLaunchConfig = { executable: '/bin/sh' };
		let exitReason: TerminalExitReason | undefined;
		const instance = {
			shellLaunchConfig,
			shellType: undefined,
			dispose: (reason?: TerminalExitReason) => exitReason = reason,
		} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
		instantiationService.stub(ITerminalInstanceService, 'convertProfileToShellLaunchConfig', () => shellLaunchConfig);
		instantiationService.stub(ITerminalInstanceService, 'createInstance', () => instance);
		instantiationService.stub(ITerminalEditorService, 'openEditor', async () => { throw expectedError; });
		terminalService.registerProcessSupport(true);

		await rejects(terminalService.createTerminal({
			config: { executable: '/bin/sh' },
			location: TerminalLocation.Editor,
			skipContributedProfileCheck: true,
		}), error => error === expectedError);

		strictEqual(exitReason, TerminalExitReason.Unknown);
	});

	test('should roll back and dispose a split editor terminal when its editor fails to open', async () => {
		const expectedError = new Error('split editor open failed');
		let exitReason: TerminalExitReason | undefined;
		const capabilities = store.add(new TerminalCapabilityStore());
		const statusList = store.add(instantiationService.createInstance(TerminalStatusList));
		const child = {
			instanceId: 77,
			resource: URI.parse('vscode-terminal://physical/77'),
			target: TerminalLocation.Editor,
			description: '',
			shellLaunchConfig: {},
			onDidFocus: Event.None,
			onDidBlur: Event.None,
			onExit: Event.None,
			onDisposed: Event.None,
			onTitleChanged: Event.None,
			onIconChanged: Event.None,
			capabilities,
			statusList,
			detachFromElement: () => { },
			setParentContextKeyService: () => { },
			dispose: (reason?: TerminalExitReason) => exitReason = reason,
		} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
		const parent = {
			resource: URI.parse('vscode-terminal://physical/1'),
			target: TerminalLocation.Editor,
		} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
		instantiationService.stub(ITerminalInstanceService, 'createInstance', () => child);
		instantiationService.stub(IEditorService, 'openEditor', async () => { throw expectedError; });
		const editorTerminalService = store.add(instantiationService.createInstance(TerminalEditorService));

		await rejects(editorTerminalService.splitInstance(parent), error => error === expectedError);

		deepStrictEqual({ instances: editorTerminalService.instances, exitReason }, {
			instances: [],
			exitReason: TerminalExitReason.Unknown,
		});
	});

	test('should reject a fulfilled editor open after the input was closed', async () => {
		const closedEditors = store.add(new Emitter<IEditorCloseEvent>());
		instantiationService.stub(IEditorService, 'onDidCloseEditor', closedEditors.event);
		const editorTerminalService = store.add(instantiationService.createInstance(TerminalEditorService));
		let closedInput: TerminalEditorInput | undefined;
		instantiationService.stub(IEditorService, 'openEditor', async (input: IResourceEditorInput) => {
			closedInput = editorTerminalService.getInputFromResource(input.resource!);
			closedEditors.fire({
				editor: closedInput,
				groupId: 1,
				context: EditorCloseContext.UNKNOWN,
				index: 0,
				sticky: false,
			});
			return undefined;
		});
		const instance = {
			instanceId: 76,
			resource: URI.parse('vscode-terminal://physical/76'),
			target: TerminalLocation.Editor,
			description: '',
			shellLaunchConfig: {},
			onDidFocus: Event.None,
			onDidBlur: Event.None,
			onExit: Event.None,
			onDisposed: Event.None,
			onTitleChanged: Event.None,
			onIconChanged: Event.None,
			capabilities: store.add(new TerminalCapabilityStore()),
			statusList: store.add(instantiationService.createInstance(TerminalStatusList)),
			detachFromElement: () => { },
			setParentContextKeyService: () => { },
			dispose: () => { },
		} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;

		await rejects(editorTerminalService.openEditor(instance), /could not be opened/);
		closedInput?.dispose();

		deepStrictEqual({
			instances: editorTerminalService.instances,
			inputClosed: closedInput !== undefined,
		}, {
			instances: [],
			inputClosed: true,
		});
	});

	test('should share the complete editor open transaction with concurrent callers', async () => {
		const openStarted = new DeferredPromise<void>();
		const releaseOpen = new DeferredPromise<void>();
		const openEditor = instantiationService.stub(IEditorService, 'openEditor', async () => {
			await openStarted.complete();
			await releaseOpen.p;
			return undefined;
		});
		const editorTerminalService = store.add(instantiationService.createInstance(TerminalEditorService));
		const instance = {
			instanceId: 77,
			resource: URI.parse('vscode-terminal://physical/77'),
			target: TerminalLocation.Editor,
			description: '',
			shellLaunchConfig: {},
			onDidFocus: Event.None,
			onDidBlur: Event.None,
			onExit: Event.None,
			onDisposed: Event.None,
			onTitleChanged: Event.None,
			onIconChanged: Event.None,
			capabilities: store.add(new TerminalCapabilityStore()),
			statusList: store.add(instantiationService.createInstance(TerminalStatusList)),
			detachFromElement: () => { },
			setParentContextKeyService: () => { },
			dispose: () => { },
		} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
		const observe = (promise: Promise<void>) => promise.then(() => 'fulfilled', error => error instanceof Error ? error.message : 'rejected');
		const outcomes = Promise.all([
			observe(editorTerminalService.openEditor(instance)),
			observe(editorTerminalService.openEditor(instance)),
		]);

		await openStarted.p;
		await releaseOpen.complete();

		deepStrictEqual({ outcomes: await outcomes, instances: editorTerminalService.instances, openCalls: openEditor.callCount }, {
			outcomes: ['The terminal editor could not be opened.', 'The terminal editor could not be opened.'],
			instances: [],
			openCalls: 1,
		});
	});

	test('should serialize concurrent editor terminal opens and continue after a failure', async () => {
		const firstOpenStarted = new DeferredPromise<void>();
		const releaseFirstOpen = new DeferredPromise<void>();
		const firstError = new Error('first editor open failed');
		const openedResources: string[] = [];
		let inFlight = 0;
		let maximumInFlight = 0;
		const openedEditors: TerminalEditorInput[] = [];
		Object.defineProperty(instantiationService.get(IEditorService), 'editors', { configurable: true, get: () => openedEditors });
		const editorTerminalService = store.add(instantiationService.createInstance(TerminalEditorService));
		instantiationService.stub(IEditorService, 'openEditor', async (input: IResourceEditorInput) => {
			inFlight++;
			maximumInFlight = Math.max(maximumInFlight, inFlight);
			const resource = input.resource;
			openedResources.push(resource?.toString() ?? 'unknown');
			try {
				if (resource?.path === '/1') {
					await firstOpenStarted.complete();
					await releaseFirstOpen.p;
					throw firstError;
				}
			} finally {
				inFlight--;
			}
			openedEditors.push(editorTerminalService.getInputFromResource(resource!));
			return undefined;
		});
		const createInstance = (instanceId: number): ITerminalInstance => ({
			instanceId,
			resource: URI.parse(`vscode-terminal://physical/${instanceId}`),
			target: TerminalLocation.Editor,
			description: '',
			shellLaunchConfig: {},
			onDidFocus: Event.None,
			onDidBlur: Event.None,
			onExit: Event.None,
			onDisposed: Event.None,
			onTitleChanged: Event.None,
			onIconChanged: Event.None,
			capabilities: store.add(new TerminalCapabilityStore()),
			statusList: store.add(instantiationService.createInstance(TerminalStatusList)),
			detachFromElement: () => { },
			setParentContextKeyService: () => { },
		}) satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
		const instances = [createInstance(1), createInstance(2), createInstance(3)];

		const opens = instances.map(instance => editorTerminalService.openEditor(instance));
		const firstFailure = rejects(opens[0], error => error === firstError);
		await firstOpenStarted.p;
		await timeout(0);
		deepStrictEqual({ openedResources, maximumInFlight }, {
			openedResources: ['vscode-terminal://physical/1'],
			maximumInFlight: 1,
		});

		await releaseFirstOpen.complete();
		await firstFailure;
		await Promise.all(opens.slice(1));

		deepStrictEqual({ openedResources, maximumInFlight, instances: editorTerminalService.instances }, {
			openedResources: [
				'vscode-terminal://physical/1',
				'vscode-terminal://physical/2',
				'vscode-terminal://physical/3',
			],
			maximumInFlight: 1,
			instances: instances.slice(1),
		});
		for (const instance of [...editorTerminalService.instances]) {
			editorTerminalService.detachInstance(instance);
		}
	});

	test('should give a copied editor terminal a new process and Logical Terminal identity', () => {
		const sourceLaunchConfig: IShellLaunchConfig = {
			logicalWorkspaceId: 'workspace',
			logicalTerminalId: 'original-terminal',
			attachPersistentProcess: {
				id: 17,
				pid: 42,
				title: 'Restored Terminal',
				titleSource: TitleEventSource.Process,
				cwd: '/',
				shellIntegrationNonce: '',
			},
		};
		const createInstance = (instanceId: number, shellLaunchConfig: IShellLaunchConfig): ITerminalInstance => ({
			instanceId,
			resource: URI.parse(`vscode-terminal://physical/${instanceId}`),
			target: TerminalLocation.Editor,
			shellLaunchConfig,
			onDidFocus: Event.None,
			onDidBlur: Event.None,
			onExit: Event.None,
			onDisposed: Event.None,
			onTitleChanged: Event.None,
			onIconChanged: Event.None,
			capabilities: store.add(new TerminalCapabilityStore()),
			statusList: store.add(instantiationService.createInstance(TerminalStatusList)),
			focusWhenReady: async () => { },
			dispose: () => { },
		}) satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
		const originalInstance = createInstance(1, sourceLaunchConfig);
		let copiedLaunchConfig: IShellLaunchConfig | undefined;
		instantiationService.stub(ITerminalInstanceService, 'createInstance', (launchConfig: IShellLaunchConfig) => {
			copiedLaunchConfig = launchConfig;
			return createInstance(2, launchConfig);
		});
		const originalInput = store.add(instantiationService.createInstance(TerminalEditorInput, originalInstance.resource, originalInstance));
		originalInput.setCopyLaunchConfig(sourceLaunchConfig);

		store.add(originalInput.copy());

		deepStrictEqual({
			logicalWorkspaceId: copiedLaunchConfig?.logicalWorkspaceId,
			logicalTerminalIdChanged: copiedLaunchConfig?.logicalTerminalId !== sourceLaunchConfig.logicalTerminalId,
			logicalTerminalIdType: typeof copiedLaunchConfig?.logicalTerminalId,
			attachPersistentProcess: copiedLaunchConfig?.attachPersistentProcess,
		}, {
			logicalWorkspaceId: 'workspace',
			logicalTerminalIdChanged: true,
			logicalTerminalIdType: 'string',
			attachPersistentProcess: undefined,
		});
	});

	test('should restore a panel terminal when moving it to an editor fails', async () => {
		const expectedError = new Error('move to editor failed');
		const source = {
			target: TerminalLocation.Panel,
			isDisposed: false,
		} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
		let removed = 0;
		let restored = 0;
		const sourceGroup = {
			removeInstance: () => {
				removed++;
				groups.length = 0;
			},
			addInstance: () => { restored++; },
		} satisfies Partial<ITerminalGroup> as unknown as ITerminalGroup;
		const groups: ITerminalGroup[] = [sourceGroup];
		let recreatedWith: ITerminalInstance | undefined;
		Object.defineProperty(instantiationService.get(ITerminalGroupService), 'groups', {
			configurable: true,
			get: () => groups,
		});
		instantiationService.stub(ITerminalGroupService, 'getGroupForInstance', () => sourceGroup);
		instantiationService.stub(ITerminalGroupService, 'createGroup', (instance: IShellLaunchConfig | ITerminalInstance | undefined) => {
			recreatedWith = instance as ITerminalInstance;
			return sourceGroup;
		});
		instantiationService.stub(ITerminalEditorService, 'openEditor', async () => { throw expectedError; });

		await rejects(terminalService.moveToEditor(source), error => error === expectedError);

		deepStrictEqual({ removed, restored, recreatedWith, target: source.target }, {
			removed: 1,
			restored: 0,
			recreatedWith: source,
			target: TerminalLocation.Panel,
		});
	});

	suite('logical workspace terminals', () => {
		async function createServiceWithPendingLogicalWorkspaceAuthority() {
			const authorityReady = new DeferredPromise<void>();
			const provisionalWorkspace: ILogicalWorkspace = { id: 'provisional', name: 'Provisional', terminalIds: [], shellLayout: undefined };
			const authoritativeWorkspace: ILogicalWorkspace = { id: 'authoritative', name: 'Authoritative', terminalIds: [], shellLayout: undefined };
			let activeWorkspace = provisionalWorkspace;
			let isReady = false;
			const whenReady = (async () => {
				await authorityReady.p;
				activeWorkspace = authoritativeWorkspace;
				isReady = true;
			})();
			const logicalWorkspaceService = new class extends mock<ILogicalWorkspaceService>() {
				override get activeWorkspace(): ILogicalWorkspace { return activeWorkspace; }
				override get workspaces(): readonly ILogicalWorkspace[] { return [activeWorkspace]; }
				override get isReady(): boolean { return isReady; }
				override readonly whenReady = whenReady;
			}();

			const controlledInstantiationService = workbenchInstantiationService({
				configurationService: () => configurationService,
			}, store);
			controlledInstantiationService.stub(ILogicalWorkspaceService, logicalWorkspaceService);
			controlledInstantiationService.stub(ITerminalInstanceService, 'getBackend', undefined);
			controlledInstantiationService.stub(ITerminalInstanceService, 'getRegisteredBackends', []);
			controlledInstantiationService.stub(IRemoteAgentService, 'getConnection', null);
			const service = store.add(controlledInstantiationService.createInstance(TerminalService));
			controlledInstantiationService.stub(ITerminalService, service);
			await timeout(0); // Allow the service's deferred TerminalEditorStyle to register for disposal.

			return { authorityReady, authoritativeWorkspace, instantiationService: controlledInstantiationService, service };
		}

		test('should wait for the authoritative Workspace before assigning a new terminal owner', async () => {
			const controlled = await createServiceWithPendingLogicalWorkspaceAuthority();
			const shellLaunchConfig: IShellLaunchConfig = { executable: '/bin/sh' };
			controlled.instantiationService.stub(ITerminalInstanceService, 'convertProfileToShellLaunchConfig', () => shellLaunchConfig);
			let terminalCreated = false;
			const instance = { shellLaunchConfig, shellType: undefined } satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
			controlled.instantiationService.stub(ITerminalGroupService, 'createGroup', () => {
				terminalCreated = true;
				return { terminalInstances: [instance] } satisfies Partial<ITerminalGroup> as ITerminalGroup;
			});
			controlled.service.registerProcessSupport(true);

			const creation = controlled.service.createTerminal({
				config: { executable: '/bin/sh' },
				skipContributedProfileCheck: true,
			});
			await timeout(0);
			strictEqual(terminalCreated, false);

			await controlled.authorityReady.complete();
			await creation;

			deepStrictEqual({
				logicalWorkspaceId: shellLaunchConfig.logicalWorkspaceId,
				logicalTerminalId: typeof shellLaunchConfig.logicalTerminalId,
			}, {
				logicalWorkspaceId: controlled.authoritativeWorkspace.id,
				logicalTerminalId: 'string',
			});
		});

		test('should let a remote resolver terminal bootstrap before Workspace authority is ready', async () => {
			const controlled = await createServiceWithPendingLogicalWorkspaceAuthority();
			const shellLaunchConfig: IShellLaunchConfig = { executable: '/bin/sh', [remoteResolverTerminal]: true };
			controlled.instantiationService.stub(ITerminalInstanceService, 'convertProfileToShellLaunchConfig', () => shellLaunchConfig);
			const instance = { instanceId: 32, shellLaunchConfig, shellType: undefined } satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
			controlled.instantiationService.stub(ITerminalInstanceService, 'createInstance', () => instance);
			controlled.instantiationService.stub(ITerminalGroupService, 'createGroup', () => ({ terminalInstances: [instance] } satisfies Partial<ITerminalGroup> as ITerminalGroup));

			const creationTimeout = timeout(50);
			let created: ITerminalInstance;
			try {
				created = await Promise.race([
					controlled.service.createTerminal({ config: shellLaunchConfig, skipContributedProfileCheck: true }),
					creationTimeout.then(() => fail('Remote resolver terminal waited for Workspace authority')),
				]);
			} finally {
				creationTimeout.cancel();
			}

			deepStrictEqual({
				createdSameInstance: created === instance,
				authoritySettled: controlled.authorityReady.isSettled,
				logicalWorkspaceId: shellLaunchConfig.logicalWorkspaceId,
				logicalTerminalId: shellLaunchConfig.logicalTerminalId,
			}, {
				createdSameInstance: true,
				authoritySettled: false,
				logicalWorkspaceId: undefined,
				logicalTerminalId: undefined,
			});
		});

		test('should observe Workspace readiness failure when terminal profile selection exits early', async () => {
			const controlled = await createServiceWithPendingLogicalWorkspaceAuthority();
			controlled.instantiationService.stubInstance(TerminalProfileQuickpick, {
				showAndGetResult: async () => undefined,
			});
			const expectedError = new Error('Workspace authority failed');
			const picking = controlled.service.showProfileQuickPick('createInstance');
			await timeout(0);

			await controlled.authorityReady.error(expectedError);

			await rejects(picking, error => error === expectedError);
		});

		test('should wait for the authoritative Workspace before delegating a contributed terminal', async () => {
			const controlled = await createServiceWithPendingLogicalWorkspaceAuthority();
			const shellLaunchConfig: IShellLaunchConfig = { executable: '/bin/sh' };
			controlled.instantiationService.stub(ITerminalInstanceService, 'convertProfileToShellLaunchConfig', () => shellLaunchConfig);
			const instance = {
				shellLaunchConfig,
				shellType: undefined,
				focusWhenReady: async () => { },
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
			Object.defineProperty(controlled.instantiationService.get(ITerminalGroupService), 'instances', {
				configurable: true,
				get: () => [instance],
			});
			controlled.instantiationService.stub(ITerminalGroupService, 'createGroup', () => ({ terminalInstances: [instance] } satisfies Partial<ITerminalGroup> as ITerminalGroup));
			controlled.instantiationService.stub(ITerminalGroupService, 'setActiveInstanceByIndex', () => { });
			let providerEntered = false;
			controlled.instantiationService.stub(ITerminalProfileService, 'getContributedProfileProvider', () => ({
				createContributedTerminalProfile: async (options: ICreateContributedTerminalProfileOptions) => {
					providerEntered = true;
					await controlled.service.createTerminal({
						config: { executable: '/bin/sh' },
						skipContributedProfileCheck: true,
						creationContext: options.creationContext,
					});
				},
			}));
			controlled.service.registerProcessSupport(true);

			const creation = controlled.service.createTerminal({
				config: { title: 'Contributed', id: 'contributed', extensionIdentifier: 'test.extension' },
			});
			await timeout(0);
			strictEqual(providerEntered, false);

			await controlled.authorityReady.complete();
			await creation;

			deepStrictEqual({
				providerEntered,
				logicalWorkspaceId: shellLaunchConfig.logicalWorkspaceId,
				logicalTerminalId: typeof shellLaunchConfig.logicalTerminalId,
			}, {
				providerEntered: true,
				logicalWorkspaceId: controlled.authoritativeWorkspace.id,
				logicalTerminalId: 'string',
			});
		});

		test('should retain the initiating Workspace while terminal profiles resolve', async () => {
			const profilesReady = new DeferredPromise<void>();
			instantiationService.stub(ITerminalProfileService, 'profilesReady', profilesReady.p);
			const shellLaunchConfig: IShellLaunchConfig = { executable: '/bin/sh' };
			instantiationService.stub(ITerminalInstanceService, 'convertProfileToShellLaunchConfig', () => shellLaunchConfig);

			const instance = {
				shellLaunchConfig,
				shellType: undefined,
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
			instantiationService.stub(ITerminalGroupService, 'createGroup', () => ({
				terminalInstances: [instance],
			} satisfies Partial<ITerminalGroup> as ITerminalGroup));
			terminalService.registerProcessSupport(true);

			const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
			await logicalWorkspaceService.whenReady;
			const initiatingWorkspaceId = logicalWorkspaceService.activeWorkspace.id;
			const targetWorkspace = await logicalWorkspaceService.createWorkspace('Target');
			const terminalPromise = terminalService.createTerminal({
				config: { executable: '/bin/sh' },
				skipContributedProfileCheck: true,
			});
			logicalWorkspaceService.activateWorkspace(targetWorkspace.id, LogicalWorkspaceActivationActor.Picker);
			await profilesReady.complete();
			await terminalPromise;

			deepStrictEqual({
				logicalWorkspaceId: shellLaunchConfig.logicalWorkspaceId,
				logicalTerminalId: typeof shellLaunchConfig.logicalTerminalId,
				targetWorkspaceId: targetWorkspace.id,
			}, {
				logicalWorkspaceId: initiatingWorkspaceId,
				logicalTerminalId: 'string',
				targetWorkspaceId: targetWorkspace.id,
			});
		});

		test('should retain the initiating Workspace while an Extension Host split parent resolves', async () => {
			const parentReady = new DeferredPromise<ITerminalInstance>();
			const shellLaunchConfig: IShellLaunchConfig = { executable: '/bin/sh', cwd: '/workspace' };
			instantiationService.stub(ITerminalInstanceService, 'convertProfileToShellLaunchConfig', () => shellLaunchConfig);
			const instance = {
				shellLaunchConfig,
				shellType: undefined,
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
			instantiationService.stub(ITerminalEditorService, 'splitInstance', async () => instance);
			terminalService.registerProcessSupport(true);

			const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
			await logicalWorkspaceService.whenReady;
			const initiatingWorkspaceId = logicalWorkspaceService.activeWorkspace.id;
			const targetWorkspace = await logicalWorkspaceService.createWorkspace('Target');
			const creation = terminalService.createTerminal({
				config: { executable: '/bin/sh' },
				location: { parentTerminal: parentReady.p },
				skipContributedProfileCheck: true,
			});
			logicalWorkspaceService.activateWorkspace(targetWorkspace.id, LogicalWorkspaceActivationActor.Picker);
			await parentReady.complete({
				target: TerminalLocation.Editor,
				shellLaunchConfig: { cwd: '/workspace' },
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
			await creation;

			deepStrictEqual({
				logicalWorkspaceId: shellLaunchConfig.logicalWorkspaceId,
				logicalTerminalId: typeof shellLaunchConfig.logicalTerminalId,
				targetWorkspaceId: targetWorkspace.id,
			}, {
				logicalWorkspaceId: initiatingWorkspaceId,
				logicalTerminalId: 'string',
				targetWorkspaceId: targetWorkspace.id,
			});
		});

		test('should retain the initiating Workspace through a contributed profile provider', async () => {
			const providerReady = new DeferredPromise<void>();
			const providerEntered = new DeferredPromise<void>();
			const shellLaunchConfig: IShellLaunchConfig = { executable: '/bin/sh' };
			instantiationService.stub(ITerminalInstanceService, 'convertProfileToShellLaunchConfig', () => shellLaunchConfig);

			const instance = {
				shellLaunchConfig,
				shellType: undefined,
				focusWhenReady: async () => { },
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
			const unrelatedInstance = {
				shellLaunchConfig: {},
				shellType: undefined,
				focusWhenReady: async () => { },
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
			const groupInstances = [instance];
			const activatedInstances: ITerminalInstance[] = [];
			Object.defineProperty(instantiationService.get(ITerminalGroupService), 'instances', {
				configurable: true,
				get: () => groupInstances,
			});
			instantiationService.stub(ITerminalGroupService, 'createGroup', () => ({
				terminalInstances: [instance],
			} satisfies Partial<ITerminalGroup> as ITerminalGroup));
			instantiationService.stub(ITerminalGroupService, 'setActiveInstance', (instance: ITerminalInstance) => activatedInstances.push(instance));
			instantiationService.stub(ITerminalGroupService, 'setActiveInstanceByIndex', () => { });
			instantiationService.stub(ITerminalProfileService, 'getContributedProfileProvider', () => ({
				createContributedTerminalProfile: async (options: ICreateContributedTerminalProfileOptions) => {
					await providerEntered.complete();
					await providerReady.p;
					await terminalService.createTerminal({
						config: { executable: '/bin/sh' },
						skipContributedProfileCheck: true,
						creationContext: options.creationContext,
					});
					// A concurrent terminal may become the host's last item before the provider RPC returns.
					groupInstances.push(unrelatedInstance);
				},
			}));
			terminalService.registerProcessSupport(true);

			const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
			await logicalWorkspaceService.whenReady;
			const initiatingWorkspaceId = logicalWorkspaceService.activeWorkspace.id;
			const targetWorkspace = await logicalWorkspaceService.createWorkspace('Target');
			const terminalPromise = terminalService.createTerminal({
				config: {
					title: 'Contributed',
					id: 'contributed',
					extensionIdentifier: 'test.extension',
				},
			});
			await providerEntered.p;
			logicalWorkspaceService.activateWorkspace(targetWorkspace.id, LogicalWorkspaceActivationActor.Picker);
			await providerReady.complete();
			const createdInstance = await terminalPromise;

			deepStrictEqual({
				createdExpectedInstance: createdInstance === instance,
				activatedExpectedInstance: activatedInstances.at(-1) === instance,
				logicalWorkspaceId: shellLaunchConfig.logicalWorkspaceId,
				logicalTerminalId: typeof shellLaunchConfig.logicalTerminalId,
				targetWorkspaceId: targetWorkspace.id,
			}, {
				createdExpectedInstance: true,
				activatedExpectedInstance: true,
				logicalWorkspaceId: initiatingWorkspaceId,
				logicalTerminalId: 'string',
				targetWorkspaceId: targetWorkspace.id,
			});
		});

		test('should migrate legacy Workspace ownership into terminal metadata', async () => {
			const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
			await logicalWorkspaceService.whenReady;
			const legacyWorkspace = await logicalWorkspaceService.createWorkspace('Legacy');
			(legacyWorkspace.terminalIds as string[]).push('legacy-terminal');
			const shellLaunchConfig: IShellLaunchConfig = {
				attachPersistentProcess: {
					id: 42,
					logicalTerminalId: 'legacy-terminal',
					pid: 1,
					title: 'Terminal',
					titleSource: TitleEventSource.Process,
					cwd: '/',
					shellIntegrationNonce: '',
				},
			};
			instantiationService.stub(ITerminalInstanceService, 'convertProfileToShellLaunchConfig', () => shellLaunchConfig);
			instantiationService.stub(ITerminalGroupService, 'createGroup', () => ({
				terminalInstances: [{ shellLaunchConfig, shellType: undefined } as ITerminalInstance],
			} satisfies Partial<ITerminalGroup> as ITerminalGroup));
			terminalService.registerProcessSupport(true);

			await terminalService.createTerminal({
				config: shellLaunchConfig,
				skipContributedProfileCheck: true,
			});

			deepStrictEqual({
				logicalWorkspaceId: shellLaunchConfig.logicalWorkspaceId,
				logicalTerminalId: shellLaunchConfig.logicalTerminalId,
			}, {
				logicalWorkspaceId: legacyWorkspace.id,
				logicalTerminalId: 'legacy-terminal',
			});
		});

		test('should not write terminal ownership into Workspace view state', async () => {
			const shellLaunchConfig: IShellLaunchConfig = { executable: '/bin/sh' };
			instantiationService.stub(ITerminalInstanceService, 'convertProfileToShellLaunchConfig', () => shellLaunchConfig);
			instantiationService.stub(ITerminalGroupService, 'createGroup', () => {
				throw new Error('terminal group creation failed');
			});
			terminalService.registerProcessSupport(true);

			const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
			await logicalWorkspaceService.whenReady;
			await rejects(terminalService.createTerminal({
				config: { executable: '/bin/sh' },
				skipContributedProfileCheck: true,
			}), /terminal group creation failed/);

			deepStrictEqual({
				logicalWorkspaceId: shellLaunchConfig.logicalWorkspaceId,
				logicalTerminalId: typeof shellLaunchConfig.logicalTerminalId,
				legacyTerminalIds: logicalWorkspaceService.workspaces.flatMap(workspace => workspace.terminalIds),
			}, {
				logicalWorkspaceId: logicalWorkspaceService.activeWorkspace.id,
				logicalTerminalId: 'string',
				legacyTerminalIds: [],
			});
		});
	});

	suite('safeDisposeTerminal', () => {
		let onExitEmitter: Emitter<number | undefined>;

		setup(() => {
			onExitEmitter = store.add(new Emitter<number | undefined>());
		});

		test('should not show prompt when confirmOnKill is never', async () => {
			await setConfirmOnKill(configurationService, 'never');
			await terminalService.safeDisposeTerminal({
				target: TerminalLocation.Editor,
				hasChildProcesses: true,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
			await terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: true,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
		});
		test('should not show prompt when any terminal editor is closed (handled by editor itself)', async () => {
			await setConfirmOnKill(configurationService, 'editor');
			terminalService.safeDisposeTerminal({
				target: TerminalLocation.Editor,
				hasChildProcesses: true,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
			await setConfirmOnKill(configurationService, 'always');
			terminalService.safeDisposeTerminal({
				target: TerminalLocation.Editor,
				hasChildProcesses: true,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
		});
		test('should not show prompt when confirmOnKill is editor and panel terminal is closed', async () => {
			await setConfirmOnKill(configurationService, 'editor');
			terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: true,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
		});
		test('should show prompt when confirmOnKill is panel and panel terminal is closed', async () => {
			await setConfirmOnKill(configurationService, 'panel');
			// No child process cases
			dialogService.setConfirmResult({ confirmed: false });
			terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: false,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
			dialogService.setConfirmResult({ confirmed: true });
			terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: false,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
			// Child process cases
			dialogService.setConfirmResult({ confirmed: false });
			await terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: true,
				dispose: () => fail()
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
			dialogService.setConfirmResult({ confirmed: true });
			terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: true,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
		});
		test('should show prompt when confirmOnKill is always and panel terminal is closed', async () => {
			await setConfirmOnKill(configurationService, 'always');
			// No child process cases
			dialogService.setConfirmResult({ confirmed: false });
			terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: false,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
			dialogService.setConfirmResult({ confirmed: true });
			terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: false,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
			// Child process cases
			dialogService.setConfirmResult({ confirmed: false });
			await terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: true,
				dispose: () => fail()
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
			dialogService.setConfirmResult({ confirmed: true });
			terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: true,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
		});
	});

	suite('persistent title and icon updates', () => {
		let backend: TestPersistentTerminalBackend;

		setup(() => {
			backend = new TestPersistentTerminalBackend();
			(terminalService as unknown as { _primaryBackend: Partial<ITerminalBackend> })._primaryBackend = backend;
		});

		test('should not update pty host metadata for custom pty terminals', async () => {
			const instance = createTerminalInstance({ customPtyImplementation: true });

			await runWithFakedTimers({}, async () => {
				updateTitle(terminalService, instance);
				updateIcon(terminalService, instance, false);
			});

			strictEqual(backend.titleUpdateCount, 0);
			strictEqual(backend.iconUpdateCount, 0);
		});

		test('should update pty host metadata for regular pty terminals', async () => {
			const instance = createTerminalInstance();

			await runWithFakedTimers({}, async () => {
				updateTitle(terminalService, instance);
				updateIcon(terminalService, instance, true);
			});

			strictEqual(backend.titleUpdateCount, 1);
			strictEqual(backend.iconUpdateCount, 1);
			strictEqual(backend.lastTitle, 'terminal title');
			strictEqual(backend.lastIconUserInitiated, true);
		});
	});
});

async function setConfirmOnKill(configurationService: TestConfigurationService, value: 'never' | 'always' | 'panel' | 'editor') {
	await configurationService.setUserConfiguration(TERMINAL_CONFIG_SECTION, { confirmOnKill: value });
	configurationService.onDidChangeConfigurationEmitter.fire({
		affectsConfiguration: () => true,
		affectedKeys: ['terminal.integrated.confirmOnKill']
	} as unknown as IConfigurationChangeEvent);
}

class TestPersistentTerminalBackend implements Partial<ITerminalBackend> {
	titleUpdateCount = 0;
	iconUpdateCount = 0;
	lastTitle: string | undefined;
	lastIconUserInitiated: boolean | undefined;

	async updateTitle(_id: number, title: string, _titleSource: TitleEventSource): Promise<void> {
		this.titleUpdateCount++;
		this.lastTitle = title;
	}

	async updateIcon(_id: number, userInitiated: boolean, _icon: TerminalIcon, _color?: string): Promise<void> {
		this.iconUpdateCount++;
		this.lastIconUserInitiated = userInitiated;
	}
}

function createTerminalInstance(options?: { customPtyImplementation?: boolean }): ITerminalInstance {
	return {
		persistentProcessId: 13,
		title: 'terminal title',
		titleSource: TitleEventSource.Process,
		staticTitle: undefined,
		icon: { id: 'remote' },
		color: undefined,
		isDisposed: false,
		shellLaunchConfig: options?.customPtyImplementation
			? { customPtyImplementation: () => { throw new Error('should not be called'); } }
			: {},
	} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
}

function updateTitle(terminalService: TerminalService, instance: ITerminalInstance): void {
	const fn = Reflect.get(terminalService, '_updateTitle') as (instance: ITerminalInstance) => void;
	fn.call(terminalService, instance);
}

function updateIcon(terminalService: TerminalService, instance: ITerminalInstance, userInitiated: boolean): void {
	const fn = Reflect.get(terminalService, '_updateIcon') as (instance: ITerminalInstance, userInitiated: boolean) => void;
	fn.call(terminalService, instance, userInitiated);
}

function saveState(terminalService: TerminalService): void {
	const fn = Reflect.get(terminalService, '_saveState') as () => void;
	fn.call(terminalService);
}

function createLayoutTerminalInstance(instanceId: number, persistentProcessId: number, remoteAuthority: string | undefined, shellLaunchConfig: IShellLaunchConfig = {}): ITerminalInstance {
	return {
		instanceId,
		persistentProcessId,
		remoteAuthority,
		shouldPersist: true,
		shellLaunchConfig,
		onDisposed: Event.None,
		onDidFocus: Event.None,
		capabilities: { onDidChangeCapabilities: Event.None } as unknown as ITerminalInstance['capabilities'],
	} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
}
