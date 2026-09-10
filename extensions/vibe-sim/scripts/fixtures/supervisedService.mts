/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';

process.on('SIGTERM', () => { /* Test forced shutdown after the grace period. */ });
const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.on('message', message => {
	if (message === 'exit') {
		process.exit(0);
	}
});
process.send!({ servicePid: process.pid, descendantPid: descendant.pid });
setInterval(() => {}, 1000);
