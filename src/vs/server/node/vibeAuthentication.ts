/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import BetterSqlite3 from 'better-sqlite3';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { username } from 'better-auth/plugins';
import { join } from '../../base/common/path.js';

const authenticationDatabaseFileName = 'better-auth.sqlite3';
const authenticationSecretFileName = 'better-auth.secret';
const authenticationSecretPattern = /^[0-9A-Za-z_-]{43}$/;
const instanceOwnerValue = 'administrator';

export const vibeAuthenticationPublicOriginHeaderName = 'x-vibe-public-origin';

export interface VibeAuthenticationServiceOptions {
	readonly stateDirectory: string;
	readonly basePath?: string;
	readonly sessionTtlSeconds?: number;
	readonly sessionUpdateAgeSeconds?: number;
}

/**
 * Owns Better Auth, its persistent SQLite database, and the single-instance-owner invariant.
 */
export class VibeAuthenticationService {
	private readonly authenticationHandler: (request: Request) => Promise<Response>;
	private readonly database: BetterSqlite3.Database;
	private disposed = false;

	private constructor(authenticationHandler: (request: Request) => Promise<Response>, database: BetterSqlite3.Database) {
		this.authenticationHandler = authenticationHandler;
		this.database = database;
	}

	public static async create(options: VibeAuthenticationServiceOptions): Promise<VibeAuthenticationService> {
		const basePath = options.basePath ?? '';
		const sessionTtlSeconds = options.sessionTtlSeconds ?? 12 * 60 * 60;
		const sessionUpdateAgeSeconds = options.sessionUpdateAgeSeconds ?? Math.min(5 * 60, Math.max(1, Math.floor(sessionTtlSeconds / 2)));
		if (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds < 60 || sessionTtlSeconds > 7 * 24 * 60 * 60) {
			throw new Error('Authentication session lifetime must be between 60 seconds and 7 days.');
		}
		if (!Number.isSafeInteger(sessionUpdateAgeSeconds) || sessionUpdateAgeSeconds < 1 || sessionUpdateAgeSeconds >= sessionTtlSeconds) {
			throw new Error('Authentication session update age must be a positive integer below the session lifetime.');
		}

		await fs.mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
		await fs.chmod(options.stateDirectory, 0o700);
		const secret = await readOrCreateSecret(join(options.stateDirectory, authenticationSecretFileName));
		const databasePath = join(options.stateDirectory, authenticationDatabaseFileName);
		const databaseFile = await fs.open(databasePath, 'a', 0o600);
		await databaseFile.close();
		await fs.chmod(databasePath, 0o600);

		const database = new BetterSqlite3(databasePath);
		try {
			database.pragma('busy_timeout = 5000');
			database.pragma('foreign_keys = ON');
			database.pragma('journal_mode = WAL');
			const cookiePath = `${basePath}/`;
			const authenticationOptions = {
				appName: 'Vibe VS Code',
				baseURL: 'https://vibe-authentication.invalid',
				basePath: `${basePath}/auth/api`,
				secret,
				database,
				emailAndPassword: {
					enabled: true,
					minPasswordLength: 12,
					maxPasswordLength: 256,
				},
				user: {
					additionalFields: {
						instanceOwner: {
							type: 'string',
							required: true,
							input: false,
							returned: false,
							defaultValue: instanceOwnerValue,
							unique: true,
						},
					},
				},
				session: {
					expiresIn: sessionTtlSeconds,
					updateAge: sessionUpdateAgeSeconds,
				},
				rateLimit: {
					enabled: true,
					storage: 'database',
					window: 60,
					max: 100,
					customRules: {
						// Caddy verifies every Workbench resource through this read-only endpoint.
						// Resource loading must not consume a shared request budget.
						'/get-session': false,
						'/sign-in/username': { window: 60, max: 5 },
						'/sign-up/email': { window: 60, max: 5 },
					},
				},
				trustedOrigins: request => {
					const publicOrigin = request?.headers.get(vibeAuthenticationPublicOriginHeaderName);
					return publicOrigin ? [publicOrigin] : [];
				},
				advanced: {
					cookiePrefix: 'vibe',
					useSecureCookies: true,
					ipAddress: {
						ipAddressHeaders: ['x-vibe-client-ip'],
					},
					defaultCookieAttributes: {
						httpOnly: true,
						secure: true,
						sameSite: 'lax',
						path: cookiePath,
					},
				},
				telemetry: {
					enabled: false,
				},
				plugins: [
					username({
						displayUsername: false,
						immutableUsername: true,
						minUsernameLength: 1,
						maxUsernameLength: 64,
						usernameNormalization: false,
						usernameValidator: value => /^[\p{L}\p{N}][\p{L}\p{N}._@-]*$/u.test(value.normalize('NFC')),
					}),
				],
			} satisfies BetterAuthOptions;
			const authentication = betterAuth(authenticationOptions);
			const migrations = await getMigrations(authentication.options);
			await migrations.runMigrations();
			await fs.chmod(databasePath, 0o600);
			return new VibeAuthenticationService(authentication.handler, database);
		} catch (error) {
			database.close();
			throw error;
		}
	}

	public get registrationOpen(): boolean {
		this.assertNotDisposed();
		return this.database.prepare('SELECT 1 FROM "user" LIMIT 1').get() === undefined;
	}

	public handle(request: Request): Promise<Response> {
		this.assertNotDisposed();
		return this.authenticationHandler(request);
	}

	public checkHealth(): void {
		this.assertNotDisposed();
		this.database.prepare('SELECT 1').get();
	}

	public dispose(): void {
		if (!this.disposed) {
			this.disposed = true;
			this.database.close();
		}
	}

	private assertNotDisposed(): void {
		if (this.disposed) {
			throw new Error('Authentication service has been disposed.');
		}
	}
}

async function readOrCreateSecret(secretPath: string): Promise<string> {
	try {
		return await readSecret(secretPath);
	} catch (error) {
		if (!isFileSystemError(error, 'ENOENT')) {
			throw error;
		}
	}

	const secret = crypto.randomBytes(32).toString('base64url');
	let secretFile: fs.FileHandle | undefined;
	try {
		secretFile = await fs.open(secretPath, 'wx', 0o600);
		await secretFile.writeFile(secret, 'utf8');
		await secretFile.sync();
		return secret;
	} catch (error) {
		if (isFileSystemError(error, 'EEXIST')) {
			return readSecret(secretPath);
		}
		throw error;
	} finally {
		await secretFile?.close();
	}
}

async function readSecret(secretPath: string): Promise<string> {
	const secret = await fs.readFile(secretPath, 'utf8');
	if (!authenticationSecretPattern.test(secret)) {
		throw new Error('The Better Auth secret is malformed.');
	}
	await fs.chmod(secretPath, 0o600);
	return secret;
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error && error.code === code;
}
