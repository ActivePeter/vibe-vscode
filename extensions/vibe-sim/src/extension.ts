/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commands, ExtensionContext, l10n, Uri, window, workspace } from 'vscode';
import { AgentSetup, readAgentExecutables, readAgentPolicy } from './agentSetup';
import { ManagedSimRuntime, RuntimeStatus } from './managedRuntime';
import { RuntimeErrorCode, SimRuntimeError } from './protocol';
import { SimViews } from './simViews';

let shutdown: (() => Promise<void>) | undefined;

function describeError(code: RuntimeErrorCode): string {
	switch (code) {
		case 'runtimeNotPackaged': return l10n.t("The native Sim runtime is not packaged in this build. Build or install the complete Sim extension.");
		case 'invalidPackage': return l10n.t("The Sim runtime package is invalid or its entry point is outside the extension's runtime directory.");
		case 'incompatiblePackage': return l10n.t("The Sim runtime package uses an incompatible protocol version.");
		case 'unsupportedPlatform': return l10n.t("The native Sim runtime currently supports Linux x64 Extension Hosts only.");
		case 'storageUnavailable': return l10n.t("The Sim runtime cannot access its extension-owned storage.");
		case 'storageBusy': return l10n.t("Another Sim runtime owns this workspace's storage. Stop that runtime before starting this one.");
		case 'invalidIdentity': return l10n.t("The stored Sim instance identity is invalid. It has been preserved for recovery; no new identity was created.");
		case 'invalidProtocol': return l10n.t("The Sim runtime sent an invalid lifecycle message.");
		case 'startFailed': return l10n.t("The Sim runtime failed to start.");
		case 'startTimedOut': return l10n.t("The Sim runtime did not become ready before the startup deadline.");
		case 'runtimeExited': return l10n.t("The Sim runtime exited unexpectedly. Existing data has been preserved; agent work has not been replayed.");
		case 'stopFailed': return l10n.t("The Sim runtime reported an error while stopping.");
		case 'stopTimedOut': return l10n.t("The Sim runtime has not confirmed its exit. A second runtime will not be started.");
		case 'cancelled': return l10n.t("Sim runtime startup was cancelled.");
		case 'stopping': return l10n.t("The Sim runtime is still stopping. Retry after it exits.");
		case 'disposed': return l10n.t("The Sim extension has been deactivated.");
	}
}

function describeStatus(status: RuntimeStatus): string {
	if (status.error) {
		return describeError(status.error);
	}
	switch (status.phase) {
		case 'ready': return l10n.t("Sim plugin runtime is ready. Instance: {0}", status.instanceId!);
		case 'starting': return l10n.t("Sim plugin runtime is starting.");
		case 'stopping': return l10n.t("Sim plugin runtime is stopping.");
		case 'failed': return l10n.t("Sim plugin runtime failed.");
		case 'stopped': return l10n.t("Sim plugin runtime is stopped. Existing chats have been preserved.");
	}
}

/** The extension owns one runtime; its standard Webview surfaces only acquire that shared instance. */
export function activate(context: ExtensionContext): void {
	const output = window.createOutputChannel(l10n.t("Sim Runtime"), { log: true });
	context.subscriptions.push(output);
	const storage = context.storageUri ?? Uri.joinPath(context.globalStorageUri, 'empty-workspace');
	let views: SimViews | undefined;
	const runtime = new ManagedSimRuntime(context.extensionUri.fsPath, Uri.joinPath(storage, 'runtime').fsPath, {
		onDidChangeStatus: status => { output.info(describeStatus(status)); views?.onRuntimeChanged(status, describeStatus(status)); },
		getAgentExecutables: readAgentExecutables,
		getAgentPolicy: readAgentPolicy,
	});
	const setup = new AgentSetup(runtime, context.extensionUri.fsPath);
	context.subscriptions.push(setup);
	shutdown = async () => { setup.dispose(); views?.dispose(); await runtime.dispose(); };
	context.subscriptions.push({ dispose: () => { void runtime.dispose().catch(() => { /* deactivate awaits the same exit barrier. */ }); } });

	const reportError = async (error: Error): Promise<void> => {
		const message = error instanceof SimRuntimeError ? describeError(error.code) : error.message;
		output.error(message);
		await window.showErrorMessage(message);
	};
	views = new SimViews(context, runtime, error => { void reportError(error); }, error => error instanceof SimRuntimeError ? describeError(error.code) : error.message);
	context.subscriptions.push(views);
	for (const [id, action] of [
		['vibe-vscode.openSim', (path?: unknown) => views!.openEditor(path)],
		['vibe-vscode.openAgentMonitor', () => views!.openEditor('/agents')],
		['vibe-vscode.createSimChatFromSelection', () => views!.createChatFromSelection()],
		['vibe-vscode.sim.signInAgent', () => setup.signIn()],
		['vibe-vscode.sim.openAgentConfiguration', () => setup.openConfiguration()],
		['vibe-vscode.sim.configureAgentExecutables', () => commands.executeCommand('workbench.action.openSettings', '@ext:vibe-vscode.sim')],
	] as const) {
		context.subscriptions.push(commands.registerCommand(id, async (path?: unknown) => { try { await action(path); } catch (error) { await reportError(error); } }));
	}
	context.subscriptions.push(commands.registerCommand('vibe-vscode.sim.startRuntime', async () => {
		if (!workspace.isTrusted) {
			await window.showErrorMessage(l10n.t("Trust this workspace before starting the Sim runtime."));
			return;
		}
		if (storage.scheme !== 'file' || context.extensionUri.scheme !== 'file') {
			await reportError(new SimRuntimeError('storageUnavailable'));
			return;
		}
		try {
			const alreadyReady = runtime.status.phase === 'ready';
			const info = await runtime.start();
			if (!alreadyReady) { views?.reconnect(); }
			await window.showInformationMessage(describeStatus(runtime.status));
			return info;
		} catch (error) {
			await reportError(error);
			return undefined;
		}
	}));
	context.subscriptions.push(commands.registerCommand('vibe-vscode.sim.stopRuntime', async () => {
		try {
			await runtime.stop();
		} catch (error) {
			await reportError(error);
		}
	}));
	context.subscriptions.push(commands.registerCommand('vibe-vscode.sim.showRuntimeStatus', () => {
		const status = runtime.status;
		output.info(describeStatus(status));
		output.show(true);
		return status;
	}));
}

export async function deactivate(): Promise<void> {
	await shutdown?.();
}
