/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';

/** Uses the pinned Next standalone entry contract, with ephemeral loopback binding and private IPC. */
const directory = path.join(import.meta.dirname, 'application/apps/sim');
const require = createRequire(path.join(directory, 'package.json'));
const { config } = JSON.parse(await fs.readFile(path.join(directory, '.next/required-server-files.json'), 'utf8'));
config.experimental = { ...config.experimental, isrFlushToDisk: false };
config.images = { ...config.images, unoptimized: true };
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
process.env.NEXT_TELEMETRY_DISABLED = '1';

/** Internal callbacks retain native authorization; no private header can follow a redirect off-instance. */
const fetchNative = globalThis.fetch;
globalThis.fetch = async (input, init) => {
	const request = new Request(input, init);
	const url = new URL(request.url);
	const port = Number(process.env.PORT);
	const local = Number.isInteger(port) && port > 0 && url.origin === `http://127.0.0.1:${port}`;
	if (url.origin !== 'https://sim.vscode.invalid' && !local) {
		return fetchNative(request);
	}
	if (!Number.isInteger(port) || port < 1) {
		throw new Error('The plugin application has not bound its private listener');
	}
	const headers = new Headers(request.headers);
	headers.set('x-vibe-agent-gateway', process.env.VIBE_VSCODE_AGENT_GATEWAY_SECRET!);
	headers.set('origin', 'https://sim.vscode.invalid');
	headers.set('host', 'sim.vscode.invalid');
	headers.set('x-forwarded-proto', 'https');
	url.protocol = 'http:';
	url.hostname = '127.0.0.1';
	url.port = String(port);
	return fetchNative(new Request(url, request), { headers, redirect: 'error' });
};

process.once('disconnect', () => process.kill(process.pid, 'SIGTERM'));
process.on('message', message => {
	if (typeof message !== 'object' || !message || !('realtimePort' in message)) {
		return;
	}
	const port = message.realtimePort;
	if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) {
		process.exit(1);
	}
	process.env.SOCKET_SERVER_URL = `http://127.0.0.1:${port}`;
	process.send?.({ type: 'configured' });
});

require('next');
const { startServer } = require('next/dist/server/lib/start-server');
await startServer({ dir: directory, isDev: false, hostname: '127.0.0.1', port: 0, allowRetry: false });
process.send?.({ type: 'listening', port: Number(process.env.PORT) });
