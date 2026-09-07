/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IRemoteAgentEnvironment } from '../../../../../platform/remote/common/remoteAgentEnvironment.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITunnelService } from '../../../../../platform/tunnel/common/tunnel.js';
import { IWorkbenchConfigurationService } from '../../../../services/configuration/common/configuration.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';
import { IRemoteExplorerService, PORT_AUTO_FALLBACK_SETTING, PORT_AUTO_FORWARD_SETTING, PORT_AUTO_SOURCE_SETTING, PORT_AUTO_SOURCE_SETTING_PROCESS, PortsEnablement } from '../../../../services/remote/common/remoteExplorerService.js';
import { TunnelModel } from '../../../../services/remote/common/tunnelModel.js';
import { IDebugService } from '../../../debug/common/debug.js';
import { IExternalUriOpenerService } from '../../../externalUriOpener/common/externalUriOpenerService.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { AutomaticPortForwarding, isCandidateRemappedTunnelLocalEndpoint } from '../../browser/remoteExplorer.js';

suite('AutomaticPortForwarding', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createForwarding(environmentTunnelsSet = false) {
		const instantiationService = store.add(new TestInstantiationService());
		const remoteEnvironment = new DeferredPromise<IRemoteAgentEnvironment>();
		const waitingForEnvironment = new DeferredPromise<void>();
		const waitingForCandidates = new DeferredPromise<void>();
		const environmentTunnels = store.add(new Emitter<void>({ onDidAddFirstListener: () => waitingForEnvironment.complete() }));
		const candidates = store.add(new Emitter<Map<string, { host: string; port: number }>>({ onDidAddFirstListener: () => waitingForCandidates.complete() }));
		const features = store.add(new Emitter<void>());
		let candidateReads = 0;
		const configuration = new TestConfigurationService({
			[PORT_AUTO_FORWARD_SETTING]: true,
			[PORT_AUTO_SOURCE_SETTING]: PORT_AUTO_SOURCE_SETTING_PROCESS,
			[PORT_AUTO_FALLBACK_SETTING]: 0,
		});
		store.add(configuration.onDidChangeConfigurationEmitter);
		instantiationService.stub(IWorkbenchConfigurationService, Object.assign(configuration, { whenRemoteConfigurationLoaded: async () => { } }));
		instantiationService.stub(IRemoteAgentService, { getEnvironment: () => remoteEnvironment.p });
		instantiationService.stub(IWorkbenchEnvironmentService, { remoteAuthority: 'test-remote' });
		instantiationService.stub(IRemoteExplorerService, {
			portsFeaturesEnabled: PortsEnablement.AdditionalFeatures,
			onEnabledPortsFeatures: features.event,
			tunnelModel: new class extends mock<TunnelModel>() {
				override get environmentTunnelsSet() { return environmentTunnelsSet; }
				override onEnvironmentTunnelsSet = environmentTunnels.event;
				override onCandidatesChanged = candidates.event;
				override get candidatesOrUndefined() { candidateReads++; return undefined; }
				override get candidates() { return []; }
			}(),
		});
		instantiationService.stub(ITerminalService, { instances: [], onDidCreateInstance: Event.None, onDidDisposeInstance: Event.None });
		instantiationService.stub(IDebugService, { onDidNewSession: Event.None, onDidEndSession: Event.None });
		instantiationService.stub(INotificationService, {});
		instantiationService.stub(IOpenerService, {});
		instantiationService.stub(IExternalUriOpenerService, {});
		instantiationService.stub(IContextKeyService, {});
		instantiationService.stub(ITunnelService, {});
		instantiationService.stub(IHostService, {});
		instantiationService.stub(IPreferencesService, {});
		instantiationService.stub(IStorageService, { getBoolean: () => true });
		instantiationService.stub(ILogService, store.add(new NullLogService()));
		const forwarding = store.add(instantiationService.createInstance(AutomaticPortForwarding));
		return {
			forwarding, waitingForEnvironment, waitingForCandidates,
			start: () => remoteEnvironment.complete(new class extends mock<IRemoteAgentEnvironment>() { override os = OperatingSystem.Linux; }()),
			setEnvironment: () => { environmentTunnelsSet = true; environmentTunnels.fire(); },
			state: () => ({
				environmentListener: environmentTunnels.hasListeners(),
				candidateListener: candidates.hasListeners(),
				featureListener: features.hasListeners(),
				configurationListener: configuration.onDidChangeConfigurationEmitter.hasListeners(),
				candidateReads,
			}),
		};
	}

	test('disposes a pending environment subscription', async () => {
		const test = createForwarding();
		await test.start();
		await test.waitingForEnvironment.p;
		test.forwarding.dispose();
		test.setEnvironment();
		await timeout(0);
		assert.deepStrictEqual(test.state(), {
			environmentListener: false, candidateListener: false, featureListener: false, configurationListener: false, candidateReads: 0,
		});
	});

	test('does not resume initialization after disposal between the event and continuation', async () => {
		const test = createForwarding();
		await test.start();
		await test.waitingForEnvironment.p;
		test.setEnvironment();
		test.forwarding.dispose();
		await timeout(0);
		assert.deepStrictEqual(test.state(), {
			environmentListener: false, candidateListener: false, featureListener: false, configurationListener: false, candidateReads: 0,
		});
	});

	test('disposes a pending initial candidate subscription', async () => {
		const test = createForwarding(true);
		await test.start();
		await test.waitingForCandidates.p;
		test.forwarding.dispose();
		assert.deepStrictEqual(test.state(), {
			environmentListener: false, candidateListener: false, featureListener: false, configurationListener: false, candidateReads: 1,
		});
	});

	test('does not create forwarders when disposed before the remote environment arrives', async () => {
		const test = createForwarding();
		test.forwarding.dispose();
		await test.start();
		await timeout(0);
		assert.deepStrictEqual(test.state(), {
			environmentListener: false, candidateListener: false, featureListener: false, configurationListener: false, candidateReads: 0,
		});
	});

	test('identifies remapped local tunnel ports', () => {
		const tunnels = [
			{ remotePort: 3000, localPort: 3001 },
			{ remotePort: 4000, localPort: 4000 },
			{ remotePort: 5000, localPort: undefined },
		];
		const candidates = [
			{ host: 'localhost', port: 3001 },
			{ host: '127.0.0.1', port: 3001 },
			{ host: '0.0.0.0', port: 3001 },
			{ host: 'example.com', port: 3001 },
			{ host: 'localhost', port: 3000 },
			{ host: 'localhost', port: 4000 },
			{ host: 'localhost', port: 5000 },
			{ host: 'localhost', port: 6000 },
		];

		assert.deepStrictEqual(candidates.map(candidate => isCandidateRemappedTunnelLocalEndpoint(candidate, tunnels)), [
			true,
			true,
			true,
			false,
			false,
			false,
			false,
			false,
		]);
	});
});
