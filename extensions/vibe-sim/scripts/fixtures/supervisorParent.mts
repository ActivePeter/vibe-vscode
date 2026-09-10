/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';

const [supervisor, service] = process.argv.slice(2);
const child = spawn(supervisor, [process.execPath, service], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
child.on('message', message => {
	process.send!({ supervisorPid: child.pid, ...message as { servicePid: number; descendantPid: number } });
});
process.on('message', message => {
	if (message === 'exit') {
		child.send('exit');
	} else if (message === 'stop') {
		child.kill('SIGTERM');
	}
});
child.once('close', code => process.exit(code ?? 1));
