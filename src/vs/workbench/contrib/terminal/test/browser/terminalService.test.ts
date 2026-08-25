/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, fail, rejects, strictEqual } from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { TerminalLocation, TitleEventSource, type ICreateContributedTerminalProfileOptions, type IPtyHostAttachTarget, type IShellLaunchConfig, type ITerminalBackend, type ITerminalsLayoutInfoById, type TerminalIcon } from '../../../../../platform/terminal/common/terminal.js';
import { ITerminalEditorService, ITerminalGroup, ITerminalGroupService, ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../browser/terminal.js';
import { TerminalGroup } from '../../browser/terminalGroup.js';
import { TerminalService } from '../../browser/terminalService.js';
import { ITerminalProfileService, TERMINAL_CONFIG_SECTION } from '../../common/terminal.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { ILogicalWorkspaceService, LogicalWorkspaceActivationActor } from '../../../../services/logicalWorkspace/common/logicalWorkspace.js';
import { IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';
import { TestEnvironmentService, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import type { IConfigurationChangeEvent } from '../../../../../platform/configuration/common/configuration.js';

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
			const backgroundedInstances = Reflect.get(remoteTerminalService, '_backgroundedTerminalInstances') as Array<{ instance: ITerminalInstance }>;
			backgroundedInstances.push({ instance: localBackground });

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
	});

	suite('logical workspace terminals', () => {
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
			const initiatingWorkspaceId = logicalWorkspaceService.activeWorkspace.id;
			const targetWorkspace = logicalWorkspaceService.createWorkspace('Target');
			const terminalPromise = terminalService.createTerminal({
				config: { executable: '/bin/sh' },
				skipContributedProfileCheck: true,
			});
			logicalWorkspaceService.activateWorkspace(targetWorkspace.id, LogicalWorkspaceActivationActor.Picker);
			await profilesReady.complete();
			await terminalPromise;

			deepStrictEqual({
				initiatingWorkspaceOwnsTerminal: logicalWorkspaceService.workspaceContainsTerminal(initiatingWorkspaceId, shellLaunchConfig.logicalTerminalId!),
				targetWorkspaceOwnsTerminal: logicalWorkspaceService.workspaceContainsTerminal(targetWorkspace.id, shellLaunchConfig.logicalTerminalId!),
			}, {
				initiatingWorkspaceOwnsTerminal: true,
				targetWorkspaceOwnsTerminal: false,
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
			instantiationService.stub(ITerminalGroupService, 'instances', [instance]);
			instantiationService.stub(ITerminalGroupService, 'createGroup', () => ({
				terminalInstances: [instance],
			} satisfies Partial<ITerminalGroup> as ITerminalGroup));
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
				},
			}));
			terminalService.registerProcessSupport(true);

			const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
			const initiatingWorkspaceId = logicalWorkspaceService.activeWorkspace.id;
			const targetWorkspace = logicalWorkspaceService.createWorkspace('Target');
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
			await terminalPromise;

			deepStrictEqual({
				initiatingWorkspaceOwnsTerminal: logicalWorkspaceService.workspaceContainsTerminal(initiatingWorkspaceId, shellLaunchConfig.logicalTerminalId!),
				targetWorkspaceOwnsTerminal: logicalWorkspaceService.workspaceContainsTerminal(targetWorkspace.id, shellLaunchConfig.logicalTerminalId!),
			}, {
				initiatingWorkspaceOwnsTerminal: true,
				targetWorkspaceOwnsTerminal: false,
			});
		});

		test('should commit terminal ownership only after an instance is created', async () => {
			const shellLaunchConfig: IShellLaunchConfig = { executable: '/bin/sh' };
			instantiationService.stub(ITerminalInstanceService, 'convertProfileToShellLaunchConfig', () => shellLaunchConfig);
			instantiationService.stub(ITerminalGroupService, 'createGroup', () => {
				throw new Error('terminal group creation failed');
			});
			terminalService.registerProcessSupport(true);

			const logicalWorkspaceService = instantiationService.get(ILogicalWorkspaceService);
			await rejects(terminalService.createTerminal({
				config: { executable: '/bin/sh' },
				skipContributedProfileCheck: true,
			}), /terminal group creation failed/);

			strictEqual(typeof shellLaunchConfig.logicalTerminalId, 'string');
			strictEqual(logicalWorkspaceService.workspaces.some(workspace => workspace.terminalIds.includes(shellLaunchConfig.logicalTerminalId!)), false);
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
