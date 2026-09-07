/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Startup runs before workbench NLS is available; the English data file owns its message contract. */
export type IWebClientStartupMessages = typeof import('./workbench-startup.nls.en.json');

export interface IWebClientStartupConfiguration {
	readonly resourceCache: string | undefined;
	readonly messages: IWebClientStartupMessages;
}
