/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { VibeProjectContext, VibeVSCodeApi } from 'vibe-vscode';

/** Vibe owns the public project API, not any consuming plugin's UI or service lifecycle. */
export function activate(context: vscode.ExtensionContext): VibeVSCodeApi {
	const projectChanges = new vscode.EventEmitter<VibeProjectContext>();
	const consumers = new Map<string, string>();
	let projectGeneration = -1;
	const api: VibeVSCodeApi = Object.freeze({
		version: 1,
		getProjectContext: async () => {
			const snapshot = freezeProjectContext(await vscode.commands.executeCommand<VibeProjectContext>('vibe-vscode.getProjectContext'));
			projectGeneration = Math.max(projectGeneration, snapshot.generation);
			return snapshot;
		},
		onDidChangeProjectContext: projectChanges.event,
	});
	context.subscriptions.push(
		projectChanges,
		{ dispose: () => consumers.clear() },
		vscode.commands.registerCommand('_vibe-vscode.projectContext.changed', (snapshot: VibeProjectContext) => {
			if (snapshot?.version === 1 && snapshot.generation > projectGeneration) {
				projectGeneration = snapshot.generation;
				projectChanges.fire(freezeProjectContext(snapshot));
			}
		}),
		api.onDidChangeProjectContext(snapshot => {
			for (const command of consumers.values()) {
				void vscode.commands.executeCommand(command, snapshot).then(undefined, () => { /* Reconnecting consumers reconcile through getProjectContext. */ });
			}
		}),
		vscode.commands.registerCommand('vibe-vscode.projectContext.subscribe', async (subscription: { id?: string; command?: string } | undefined) => {
			if (!subscription || typeof subscription.id !== 'string' || !/^[\w.-]{1,256}$/.test(subscription.id)
				|| typeof subscription.command !== 'string' || !/^[\w.-]{1,256}$/.test(subscription.command) || consumers.size >= 256 && !consumers.has(subscription.id)) {
				throw new Error(vscode.l10n.t("Invalid project context subscription."));
			}
			// Register before awaiting readiness; the initial result and events share one generation space.
			consumers.set(subscription.id, subscription.command);
			try {
				return await api.getProjectContext();
			} catch (error) {
				if (consumers.get(subscription.id) === subscription.command) { consumers.delete(subscription.id); }
				throw error;
			}
		}),
		vscode.commands.registerCommand('vibe-vscode.projectContext.unsubscribe', (id: string) => { consumers.delete(id); }),
	);
	return api;
}

/** IPC strips freezing; each consumer receives the same read-only contract as the Workbench. */
function freezeProjectContext(snapshot: VibeProjectContext): VibeProjectContext {
	return Object.freeze({
		...snapshot,
		physicalWorkspace: Object.freeze({
			...snapshot.physicalWorkspace,
			folders: Object.freeze(snapshot.physicalWorkspace.folders.map(folder => Object.freeze({ ...folder }))),
		}),
		logicalWorkspaces: Object.freeze(snapshot.logicalWorkspaces.map(workspace => Object.freeze({ ...workspace }))),
		logicalWorkspace: snapshot.logicalWorkspace ? Object.freeze({ ...snapshot.logicalWorkspace }) : undefined,
		project: snapshot.project ? Object.freeze({ ...snapshot.project }) : undefined,
	});
}
