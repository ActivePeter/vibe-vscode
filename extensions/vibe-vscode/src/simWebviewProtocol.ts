/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const SIM_ROUTE_VALIDATION_ORIGIN = 'https://vibe-vscode.invalid';

const unsafePathCharacters = /[\\\u0000-\u001F\u007F]/;

/** A Sim route is an absolute path that cannot resolve outside a fixed origin. */
export function isSafeSimPath(value: string | undefined): value is string {
	if (typeof value !== 'string' || !value.startsWith('/') || unsafePathCharacters.test(value)) {
		return false;
	}

	try {
		const rawPath = value.split(/[?#]/, 1)[0];
		const decodedRawPath = decodeURIComponent(rawPath);
		return !decodedRawPath.startsWith('//')
			&& !decodedRawPath.split('/').some(segment => segment === '.' || segment === '..')
			&& !unsafePathCharacters.test(decodedRawPath)
			&& !unsafePathCharacters.test(value);
	} catch {
		return false;
	}
}
