/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Standalone on purpose: the release workflow runs this before and after packaging on runners
// without build dependencies, so it must import nothing outside Node built-ins.
import { promises as fs } from 'node:fs';
import { resolveReleaseNotes } from './lib/releaseNotes.ts';

const positional: string[] = [];
let allowMissing = false;
let artifactsDirectory: string | undefined;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
	if (args[index] === '--allow-missing') {
		allowMissing = true;
	} else if (args[index] === '--artifacts') {
		artifactsDirectory = args[++index];
	} else {
		positional.push(args[index]);
	}
}
if (positional.length !== 4 || positional.some(value => value.startsWith('--')) || (args.includes('--artifacts') && !artifactsDirectory)) {
	throw new Error('Usage: node build/release-notes.ts <release-tag> <notes-directory> <commit> <output-file> [--artifacts <directory>] [--allow-missing]');
}
const [tag, notesDirectory, commit, outputFile] = positional;
const notes = await resolveReleaseNotes(tag, notesDirectory, { commit, artifactsDirectory, allowMissing });
await fs.writeFile(outputFile, notes.body);
console.log(notes.file ? `Release notes for ${tag} taken from ${notes.file}.` : `Release notes for ${tag} are missing; wrote the placeholder body.`);
