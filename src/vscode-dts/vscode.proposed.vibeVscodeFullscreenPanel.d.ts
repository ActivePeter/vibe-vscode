/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	export interface WebviewPanelOptions {

		/**
		 * Opens this webview as the exclusive vibe vscode fullscreen panel.
		 *
		 * This option is restricted to the built-in vibe vscode extension.
		 */
		readonly vibeVscodeFullscreen?: boolean;
	}
}
