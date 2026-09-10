/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commands, ExtensionContext, l10n, Uri, window, workspace } from 'vscode';
import { ManagedSimRuntime, RuntimeStatus } from './managedRuntime';
import { RuntimeErrorCode, SimRuntimeError } from './protocol';

let shutdown: (() => Promise<void>) | undefined;

function describeError(code: RuntimeErrorCode): string {
	switch (code) {
		case 'runtimeNotPackaged': return l10n.t("The native Sim runtime is not packaged in this build. The existing Sim interface has not been switched.");
		case 'invalidPackage': return l10n.t("The Sim runtime package is invalid or its entry point is outside the extension's runtime directory.");
		case 'incompatiblePackage': return l10n.t("The Sim runtime package uses an incompatible protocol version.");
		case 'unsupportedPlatform': return l10n.t("The preview Sim runtime currently supports Linux Extension Hosts only.");
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
		case 'stopped': return l10n.t("Sim plugin runtime is stopped. These preview controls do not change the existing Sim interface.");
	}
}

/** Registers explicit preview commands only; neither a sidebar nor a tab starts or stops the runtime. */
export function activate(context: ExtensionContext): void {
	const output = window.createOutputChannel(l10n.t("Sim Runtime"), { log: true });
	context.subscriptions.push(output);
	const storage = context.storageUri ?? Uri.joinPath(context.globalStorageUri, 'empty-workspace');
	const runtime = new ManagedSimRuntime(context.extensionUri.fsPath, Uri.joinPath(storage, 'runtime').fsPath, {
		onDidChangeStatus: status => output.info(describeStatus(status)),
	});
	shutdown = () => runtime.dispose();
	context.subscriptions.push({ dispose: () => { void runtime.dispose().catch(() => { /* deactivate awaits the same exit barrier. */ }); } });

	const reportError = async (error: Error): Promise<void> => {
		const message = describeError(error instanceof SimRuntimeError ? error.code : 'startFailed');
		output.error(message);
		await window.showErrorMessage(message);
	};
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
			const info = await runtime.start();
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
