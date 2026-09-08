/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Selects an already validated origin; request headers can never add a trusted authority. */
export function matchVibePublicOrigin(publicOrigins: readonly string[], forwardedHost: string | undefined, host: string | undefined): string | undefined {
	const authority = (forwardedHost?.split(',', 1)[0].trim() || host)?.toLowerCase();
	return publicOrigins.find(origin => new URL(origin).host === authority);
}
