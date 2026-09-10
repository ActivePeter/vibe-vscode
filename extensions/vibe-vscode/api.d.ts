/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Public exports of the built-in `vibe-vscode.project-switcher` extension. */
declare module 'vibe-vscode' {

	/** A read-only projection of ready Vibe authorities. URIs retain their scheme and authority. */
	export interface VibeProjectContext {
		readonly version: 1;
		/** Monotonic within this Workbench lifetime; not a database revision. */
		readonly generation: number;
		readonly physicalWorkspace: {
			readonly id: string;
			readonly name: string;
			readonly remoteAuthority: string;
			readonly folders: readonly { readonly name: string; readonly uri: string; readonly index: number }[];
		};
		readonly logicalWorkspaces: readonly { readonly id: string; readonly name: string }[];
		readonly logicalWorkspace?: { readonly id: string; readonly name: string };
		readonly project?: { readonly name: string; readonly uri: string };
	}

	export interface VibeVSCodeApi {
		readonly version: 1;
		/** Waits for authority readiness. Failures reject; they never mean an empty project catalog. */
		getProjectContext(): Thenable<VibeProjectContext>;
		/** Also fires for catalog/name changes without an active-project switch. */
		readonly onDidChangeProjectContext: import('vscode').Event<VibeProjectContext>;
	}
}
