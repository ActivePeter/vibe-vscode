/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { resolveReleaseNotes } from '../releaseNotes.ts';

const commit = 'b'.repeat(40);

test('release notes come from the tag-named file and gain the artifact appendix', async () => {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'release-notes-'));
	try {
		await fs.mkdir(path.join(temporary, 'notes'));
		await fs.mkdir(path.join(temporary, 'artifacts'));
		await fs.writeFile(path.join(temporary, 'notes/v1.2.3.md'), '\n# Vibe VS Code v1.2.3\n\n## 本版内容\n\n- 登录\n');
		await fs.writeFile(path.join(temporary, 'artifacts/vibe-vscode-server-v1.2.3-linux-x64.tar.gz.sha256'), `${'c'.repeat(64)}  vibe-vscode-server-v1.2.3-linux-x64.tar.gz\n`);
		await fs.writeFile(path.join(temporary, 'artifacts/vibe-vscode-server-v1.2.3-linux-x64.tar.gz'), 'not read');
		const notes = await resolveReleaseNotes('v1.2.3', path.join(temporary, 'notes'), { commit, artifactsDirectory: path.join(temporary, 'artifacts') });
		assert.deepStrictEqual({ file: notes.file, body: notes.body }, {
			file: path.join(temporary, 'notes/v1.2.3.md'),
			body: [
				'', '# Vibe VS Code v1.2.3', '', '## 本版内容', '', '- 登录', '',
				'## 产物 / Artifacts', '',
				`- Tag \`v1.2.3\`, source commit \`${commit}\``,
				`- \`vibe-vscode-server-v1.2.3-linux-x64.tar.gz\` sha256 \`${'c'.repeat(64)}\``, '',
			].join('\n'),
		});
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
});

test('a missing file fails unless explicitly allowed, and a copied file naming another tag fails', async () => {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'release-notes-'));
	try {
		await assert.rejects(resolveReleaseNotes('v1.2.3', temporary, { commit }), /Release notes are missing: .*v1\.2\.3\.md/);
		const placeholder = await resolveReleaseNotes('v1.2.3', temporary, { commit, allowMissing: true });
		assert.deepStrictEqual({ file: placeholder.file, placeholder: placeholder.body.includes('文案待补'), appendix: placeholder.body.includes(`source commit \`${commit}\``) }, { file: undefined, placeholder: true, appendix: true });
		await fs.writeFile(path.join(temporary, 'v1.2.3.md'), '# Vibe VS Code v1.2.2\n\n- copied from the previous release\n');
		await assert.rejects(resolveReleaseNotes('v1.2.3', temporary, { commit }), /must be a heading that names v1\.2\.3/);
		await fs.writeFile(path.join(temporary, 'v1.2.3.md'), 'v1.2.3 without a heading\n');
		await assert.rejects(resolveReleaseNotes('v1.2.3', temporary, { commit }), /must be a heading/);
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
});
