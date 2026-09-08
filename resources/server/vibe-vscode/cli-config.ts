/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { hostname, homedir, userInfo } from 'node:os';
import * as path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';

// Packaged Node executes this with native TypeScript support. Configuration is data, never shell code.
const [runtime, command, ...args] = process.argv.slice(2);
try {
	if (['--help', '-h', 'help'].includes(command)) {
		console.log(`Usage: vibe-vscode <start|status|systemd> [options]
  --origin <https://host[:port]>  Repeat for multiple allowed browser addresses
  --port <port>                  Public HTTPS port (default: 18080)
  --state-dir <directory>        Persistent state and vibe-vscode.env
  --tls-cert <file> --tls-key <file>  Use your certificate; otherwise Caddy's local CA
  --session-ttl <seconds>        Session lifetime (default: 43200)
  --user <user>                  systemd only: generate a system service

start runs in the foreground; Ctrl-C stops both processes. status checks both boundaries.
systemd prints a unit; it does not install or enable anything.
Config: <state-dir>/vibe-vscode.env, literal VIBE_VSCODE_ORIGIN, PORT, TLS_CERT,
TLS_KEY and SESSION_TTL values. Command-line options override the file.`);
		process.exit(0);
	}
	if (!['start', 'status', 'systemd'].includes(command)) {
		throw new Error('Expected start, status or systemd. See --help.');
	}
	const { values } = parseArgs({ args, options: {
		origin: { type: 'string', multiple: true }, port: { type: 'string' },
		'state-dir': { type: 'string' }, 'tls-cert': { type: 'string' }, 'tls-key': { type: 'string' },
		'session-ttl': { type: 'string' }, user: { type: 'string' },
	} });
	if (values.user && command !== 'systemd') {
		throw new Error('--user is only supported by systemd.');
	}
	const managed = path.basename(path.dirname(runtime)) === 'releases';
	const installRoot = managed ? path.dirname(path.dirname(runtime)) : path.join(homedir(), '.vibe-vscode');
	const state = await resolvePath(path.resolve(values['state-dir'] ?? path.join(installRoot, 'state')));
	if (overlaps(state, runtime) || overlaps(state, path.join(installRoot, 'releases'))) {
		throw new Error('State must be outside the runtime and releases directory.');
	}
	let configuration: NodeJS.Dict<string> = {};
	try {
		configuration = parseEnv(await fs.readFile(path.join(state, 'vibe-vscode.env'), 'utf8'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}
	for (const key of Object.keys(configuration)) {
		if (!['ORIGIN', 'PORT', 'TLS_CERT', 'TLS_KEY', 'SESSION_TTL'].some(name => key === `VIBE_VSCODE_${name}`)) {
			throw new Error(`Unknown configuration key ${key}; --state-dir selects the configuration file itself.`);
		}
	}
	const port = values.port ?? configuration.VIBE_VSCODE_PORT ?? '18080';
	if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
		throw new Error('--port must be between 1 and 65535.');
	}
	const ttl = values['session-ttl'] ?? configuration.VIBE_VSCODE_SESSION_TTL ?? '43200';
	if (!/^\d+$/.test(ttl) || Number(ttl) < 60 || Number(ttl) > 604800) {
		throw new Error('--session-ttl must be between 60 seconds and 7 days.');
	}
	let defaultHost = hostname();
	if (!values.origin && !configuration.VIBE_VSCODE_ORIGIN) {
		try {
			defaultHost = execFileSync('hostname', ['-f'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || defaultHost;
		} catch { /* The startup message always exposes the chosen address. */ }
	}
	const origins = [...new Set((values.origin ?? [configuration.VIBE_VSCODE_ORIGIN ?? `https://${defaultHost}:${port}`]).flatMap(value => value.split(',')).map(value => {
		const text = value.trim();
		const url = new URL(text);
		if (!/^https:\/\//i.test(text) || /[\x00-\x20\x7f\\]/.test(text) || url.protocol !== 'https:' || url.username || url.password || url.hostname.includes('*') || url.pathname !== '/' || url.search || url.hash) {
			throw new Error('--origin requires complete HTTPS origins without credentials, paths, queries, fragments or wildcards.');
		}
		return url.origin;
	}))];
	const cert = values['tls-cert'] ?? configuration.VIBE_VSCODE_TLS_CERT;
	const key = values['tls-key'] ?? configuration.VIBE_VSCODE_TLS_KEY;
	if (Boolean(cert) !== Boolean(key)) {
		throw new Error('Supply both --tls-cert and --tls-key, or neither.');
	}
	const certificates = cert && key ? [path.resolve(values['tls-cert'] ? process.cwd() : state, cert), path.resolve(values['tls-key'] ? process.cwd() : state, key)] : [];
	for (const file of certificates) {
		if (!(await fs.stat(file)).isFile()) {
			throw new Error(`Not a certificate/key file: ${file}`);
		}
	}
	for (const value of [state, runtime, ...certificates]) {
		if (/[\x00-\x1f\x7f]/.test(value)) {
			throw new Error('Paths must not contain control characters.');
		}
	}
	if (command === 'systemd') {
		if (values.user && !/^[a-zA-Z0-9_-]+\$?$/.test(values.user)) {
			throw new Error('--user must be a system account name or numeric UID.');
		}
		const launcher = managed ? path.join(installRoot, 'current/bin/vibe-vscode') : path.join(runtime, 'bin/vibe-vscode');
		const launchArgs = [launcher, 'start', '--state-dir', state];
		for (const [name, value] of Object.entries(values)) {
			if (name !== 'state-dir' && name !== 'user' && value !== undefined) {
				for (const item of Array.isArray(value) ? value : [value]) {
					launchArgs.push(`--${name}`, name === 'tls-cert' ? certificates[0] : name === 'tls-key' ? certificates[1] : item);
				}
			}
		}
		console.log(`# Generated by vibe-vscode systemd. Edit vibe-vscode.env for persistent defaults.
${values.user ? '# System service: install with administrator approval.' : `# To keep a user service running after logout: loginctl enable-linger ${userInfo().username}`}
[Unit]
Description=Vibe VS Code (HTTPS and authentication)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${values.user ? `User=${values.user}\n` : ''}ExecStart=${launchArgs.map(quoteSystemd).join(' ')}
Restart=on-failure
RestartSec=3
KillMode=control-group
TimeoutStopSec=20
UMask=0077

[Install]
WantedBy=${values.user ? 'multi-user.target' : 'default.target'}`);
	} else {
		const template = await fs.readFile(path.join(runtime, 'resources/server/vibe-vscode/Caddyfile'), 'utf8');
		const sites = [...new Set(origins.map(origin => `https://${new URL(origin).hostname}:${port}`))].join(', ');
		const caddy = template.replace('{\n', '{\n\tskip_install_trust\n').replace(':{$VIBE_VSCODE_PUBLIC_PORT} {', `${sites} {`).replace('tls {$VIBE_VSCODE_TLS_CERT_PATH} {$VIBE_VSCODE_TLS_KEY_PATH}', certificates.length ? `tls ${certificates.map(file => JSON.stringify(file)).join(' ')}` : 'tls internal');
		console.log([state, port, origins.join(','), ttl, Buffer.from(caddy).toString('base64'), certificates.length ? '' : `TLS uses Caddy's local CA; trust ${path.join(state, 'caddy/pki/authorities/local/root.crt')} in your browser or system.`, origins[0]].join('\n'));
	}
} catch (error) {
	console.error(`vibe-vscode: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}

async function resolvePath(value: string): Promise<string> {
	try {
		return await fs.realpath(value);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
		return path.join(await resolvePath(path.dirname(value)), path.basename(value));
	}
}

function overlaps(first: string, second: string): boolean {
	return [path.relative(first, second), path.relative(second, first)].some(relative => !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)));
}

function quoteSystemd(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}
