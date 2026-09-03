/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Desktop product packaging discovers esbuild.mts, while this browser-only UI extension uses the
// same bundle in desktop and web extension hosts.
import './esbuild.browser.mts';
