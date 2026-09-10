/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// An intentionally misbehaving child validates the parent's late-message guard independently.
const { randomUUID } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
let request;
process.on('message', message => {
	if (message.type === 'initialize') {
		request = message;
		writeFileSync(join(message.stateDirectory, 'late-host-started'), String(process.pid));
	} else if (message.type === 'shutdown') {
		process.send({ type: 'ready', protocolVersion: 1, runId: request.runId, instanceId: randomUUID() });
		setTimeout(() => process.exit(0), 50);
	}
});
process.on('disconnect', () => process.exit(1));
