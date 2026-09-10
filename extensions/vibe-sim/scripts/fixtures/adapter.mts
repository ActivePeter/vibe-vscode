/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A lifecycle fixture, not a native Sim backend. Never included in the extension package.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { SimRuntimeAdapter } from '../../src/protocol.ts';

export async function start({ stateDirectory, instanceId, signal, agentPolicy }: Parameters<SimRuntimeAdapter['start']>[0]): ReturnType<SimRuntimeAdapter['start']> {
	const { mode } = JSON.parse(await fs.readFile(path.join(stateDirectory, 'control.json'), 'utf8'));
	await fs.appendFile(path.join(stateDirectory, 'starts.jsonl'), JSON.stringify({
		instanceId, pid: process.pid, execArgv: process.execArgv, agentPolicy,
		ambientConfiguration: Object.keys(process.env).filter(key => /DATABASE|REDIS|SIM|TOKEN|SECRET|NODE_OPTIONS|LD_PRELOAD/.test(key)),
	}) + '\n');
	let abortWritten = Promise.resolve();
	const aborted = () => { abortWritten = fs.writeFile(path.join(stateDirectory, 'aborted'), 'true'); };
	signal.addEventListener('abort', aborted, { once: true });
	if (mode === 'crash-start') {
		process.exit(27);
	}
	if (mode === 'fail-start') {
		signal.removeEventListener('abort', aborted);
		throw new Error('private-adapter-error-must-not-cross-ipc');
	}
	if (mode === 'hang-start') {
		await new Promise(() => { });
	}
	if (mode === 'barrier') {
		// Intentionally ignores cancellation, so the host must reject a late start result.
		while (!await fs.access(path.join(stateDirectory, 'release')).then(() => true, () => false)) {
			await setTimeout(10);
		}
	}
	const poll = setInterval(async () => {
		if (await fs.access(path.join(stateDirectory, 'crash')).then(() => true, () => false)) {
			process.exit(28);
		}
	}, 10);
	return {
		async stop() {
			if (mode === 'hang-stop') {
				await new Promise(() => { });
			}
			clearInterval(poll);
			signal.removeEventListener('abort', aborted);
			await abortWritten;
			if (mode === 'fail-stop') {
				throw new Error('private-stop-error-must-not-cross-ipc');
			}
			await fs.writeFile(path.join(stateDirectory, 'stopped'), String(process.pid));
		},
	};
}
