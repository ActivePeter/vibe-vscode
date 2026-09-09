/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';

/** Source artwork for the server-rendered pages and generated browser icons. */
export const vibeLogoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
	<defs><clipPath id="vibe-logo"><rect width="64" height="64" rx="14"/></clipPath></defs>
	<g clip-path="url(#vibe-logo)">
		<rect width="64" height="64" fill="#FFFFFF"/>
		<path d="M0 25.333333H21L32 45.333333L43 25.333333H64V64H0Z" fill="#2864F0"/>
	</g>
</svg>`;

export const vibeLogoDataUri = `data:image/svg+xml,${encodeURIComponent(vibeLogoSvg)}`;
export const vibeLogoRevision = createHash('sha256').update(vibeLogoSvg).digest('hex').slice(0, 12);
