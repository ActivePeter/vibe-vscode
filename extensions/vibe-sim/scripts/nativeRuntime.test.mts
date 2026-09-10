/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { SimRuntimeAdapter } from '../src/protocol.ts';
import type { NativeClient as Client } from '../src/native/nativeClient.ts';
import { bundle } from './testUtils.mts';

const packageDirectory = process.env.VIBE_SIM_NATIVE_TEST_PACKAGE;
const require = createRequire(import.meta.url);

test('the packaged native Sim migrates its real schema and gates its private API', { skip: !packageDirectory, timeout: 180_000 }, async t => {
	const state = await fs.mkdtemp(path.join(tmpdir(), 'vibe-sim-application-test-'));
	let instance: Awaited<ReturnType<SimRuntimeAdapter['start']>> | undefined;
	t.after(async () => { await instance?.stop(); await fs.rm(state, { recursive: true, force: true }); });
	const adapter = await import(pathToFileURL(path.join(packageDirectory!, 'adapter.mjs')).href) as SimRuntimeAdapter;
	instance = await adapter.start({ protocolVersion: 1, instanceId: 'e5e24481-1540-48d6-bf70-88f27744a640', stateDirectory: state, signal: t.signal });
	assert.ok(instance.connection);
	const { applicationPort, gateway } = instance.connection;
	const origin = `http://127.0.0.1:${applicationPort}`;
	const denied = await fetch(`${origin}/api/auth/get-session`);
	const response = await fetch(`${origin}/api/auth/get-session`, { headers: { 'x-vibe-agent-gateway': gateway, host: 'sim.vscode.invalid' } });
	const session = await response.json();
	const workspace = await fetch(`${origin}/workspace?_vscodeSurface=sidebar`, { headers: { 'x-vibe-agent-gateway': gateway, host: 'sim.vscode.invalid' } });
	const html = await workspace.text();
	assert.deepStrictEqual({ denied: denied.status, session: response.status, user: typeof session?.user?.id, workspace: workspace.status, native: html.includes('/_next/static/') }, {
		denied: 403, session: 200, user: 'string', workspace: 200, native: true,
	});
});

test('two packaged native Sim instances isolate real sessions, gateways and stop/restart state', { skip: !packageDirectory, timeout: 180_000 }, async t => {
	const root = await fs.mkdtemp(path.join(tmpdir(), 'vibe-sim-session-isolation-'));
	const instances: Awaited<ReturnType<SimRuntimeAdapter['start']>>[] = [];
	const clients: Client[] = [];
	t.after(async () => {
		for (const client of clients) { client.dispose(); }
		await Promise.all(instances.map(instance => instance.stop()));
		await fs.rm(root, { recursive: true, force: true });
	});
	const clientModule = path.join(root, 'client.cjs');
	await fs.writeFile(clientModule, bundle('native/nativeClient'));
	const { NativeClient } = require(clientModule) as typeof import('../src/native/nativeClient.ts');
	const adapter = await import(pathToFileURL(path.join(packageDirectory!, 'adapter.mjs')).href) as SimRuntimeAdapter;
	const start = async (stateDirectory: string) => {
		await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
		const instance = await adapter.start({ protocolVersion: 1, instanceId: randomUUID(), stateDirectory, signal: t.signal });
		instances.push(instance);
		assert.ok(instance.connection);
		const client = new NativeClient(randomUUID(), instance.connection, () => true);
		clients.push(client);
		return { instance, client };
	};
	const json = async <T>(client: Client, route: string, body?: object): Promise<T> => {
		const { response } = await client.request(route, body ? { method: 'POST', headers: [['content-type', 'application/json']], body: new TextEncoder().encode(JSON.stringify(body)) } : {});
		assert.equal(response.status, 200, route);
		return await response.json() as T;
	};
	const stateA = path.join(root, 'state-a');
	const [a, b] = await Promise.all([start(stateA), start(path.join(root, 'state-b'))]);
	t.diagnostic('Both native applications and their schema migrations are ready');
	const catalog = { physicalWorkspace: { id: 'same-workspace', name: 'Same project', remoteAuthority: '', folders: [{ name: 'Same project', uri: pathToFileURL(root).href, index: 0 }] }, logicalWorkspaces: [] };
	const createChat = async (client: Client) => {
		const workspaces = await json<{ workspaces: { id: string }[] }>(client, '/api/workspaces');
		const workspaceId = workspaces.workspaces[0].id;
		const { host } = await json<{ host: { id: string } }>(client, '/api/vscode/hosts', { workspaceId, catalog, expectedRevision: 0 });
		const body = { workspaceId, hostId: host.id, projectUri: catalog.physicalWorkspace.folders[0].uri, requestId: randomUUID() };
		const session = await json<{ id: string; workspaceId: string }>(client, '/api/vscode/sessions', body);
		assert.deepStrictEqual(await json(client, '/api/vscode/sessions', body), session, 'creation retries recover the same native chat');
		return session;
	};
	const [chatA, chatB] = await Promise.all([createChat(a.client), createChat(b.client)]);
	const list = async (client: Client, workspaceId: string) => (await json<{ sessions: { id: string }[] }>(client, `/api/vscode/sessions?workspaceId=${workspaceId}`)).sessions.map(session => session.id);
	const idsA = await list(a.client, chatA.workspaceId);
	const idsB = await list(b.client, chatB.workspaceId);
	const aOrigin = `http://127.0.0.1:${a.instance.connection!.applicationPort}`;
	const untrusted = await fetch(`${aOrigin}/api/auth/get-session`);
	const crossInstance = await fetch(`${aOrigin}/api/auth/get-session`, { headers: { 'x-vibe-agent-gateway': b.instance.connection!.gateway } });
	const crossOrigin = await fetch(`${aOrigin}/api/vscode/hosts`, {
		method: 'POST', headers: { 'x-vibe-agent-gateway': a.instance.connection!.gateway, origin: 'https://outside.invalid', 'x-forwarded-host': 'sim.vscode.invalid', 'x-forwarded-proto': 'https', 'content-type': 'application/json' }, body: '{}',
	});
	const foreignChat = await a.client.request(`/api/vscode/sessions/${chatB.id}/config?workspaceId=${chatA.workspaceId}`);
	const socket = a.client.openSocket('/socket.io/?EIO=4&transport=websocket', []);
	t.after(() => socket.terminate());
	const handshake = await new Promise<string>((resolve, reject) => { socket.once('message', message => resolve(message.toString())); socket.once('error', reject); });
	socket.close();
	await a.instance.stop();
	const bAfterStop = await list(b.client, chatB.workspaceId);
	const restarted = await start(stateA);
	assert.deepStrictEqual({
		idsA, idsB, distinct: chatA.id !== chatB.id, untrusted: untrusted.status, crossInstance: crossInstance.status,
		crossOrigin: crossOrigin.status, foreignChat: foreignChat.response.status, socketHandshake: handshake.startsWith('0{'),
		bAfterStop, restarted: await list(restarted.client, chatA.workspaceId),
	}, {
		idsA: [chatA.id], idsB: [chatB.id], distinct: true, untrusted: 403, crossInstance: 403, crossOrigin: 403, foreignChat: 404,
		socketHandshake: true, bAfterStop: [chatB.id], restarted: [chatA.id],
	});
});
