/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface ReleaseNotesOptions {
	/** Full source commit of the release tag; appended to the notes. */
	readonly commit: string;
	/** Directory holding `*.sha256` files for the release archives; each becomes one appendix line. */
	readonly artifactsDirectory?: string;
	/** Only manual dispatches may publish without a notes file; the placeholder body says so. */
	readonly allowMissing?: boolean;
}

export interface ReleaseNotes {
	/** The notes file that was used, or undefined when the placeholder body was produced. */
	readonly file: string | undefined;
	readonly body: string;
}

// allow-any-unicode-next-line
const missingNotesPlaceholder = '本版本文案待补,发布前请在此填写本版内容与升级须知。\n\nRelease notes are missing for this tag; fill in the highlights and upgrade notes before publishing.';

/**
 * Resolves the GitHub Release body for `tag` from `docs/releases/<tag>.md`.
 * The file must start with a heading naming the tag, so a copied previous file cannot slip through.
 */
export async function resolveReleaseNotes(tag: string, notesDirectory: string, options: ReleaseNotesOptions): Promise<ReleaseNotes> {
	const file = path.join(notesDirectory, `${tag}.md`);
	let content: string | undefined;
	try {
		content = await fs.readFile(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}
	if (content === undefined) {
		if (!options.allowMissing) {
			throw new Error(`Release notes are missing: ${file}. Add the file, or dispatch the workflow with allow_missing_notes.`);
		}
		return { file: undefined, body: `${missingNotesPlaceholder}\n\n${await artifactsAppendix(tag, options)}` };
	}
	const heading = content.split('\n').find(line => line.trim() !== '');
	if (!heading || !heading.startsWith('# ') || !heading.includes(tag)) {
		throw new Error(`The first line of ${file} must be a heading that names ${tag}.`);
	}
	return { file, body: `${content.trimEnd()}\n\n${await artifactsAppendix(tag, options)}` };
}

async function artifactsAppendix(tag: string, options: ReleaseNotesOptions): Promise<string> {
	// allow-any-unicode-next-line
	const lines = [`## 产物 / Artifacts`, ``, `- Tag \`${tag}\`, source commit \`${options.commit}\``];
	if (options.artifactsDirectory) {
		const names = (await fs.readdir(options.artifactsDirectory)).filter(name => name.endsWith('.sha256')).sort();
		for (const name of names) {
			const [hash, archive] = (await fs.readFile(path.join(options.artifactsDirectory, name), 'utf8')).trim().split(/\s+/);
			lines.push(`- \`${archive}\` sha256 \`${hash}\``);
		}
	}
	return lines.join('\n') + '\n';
}
