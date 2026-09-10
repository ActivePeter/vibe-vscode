/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const protocolVersion = 1;

export const runtimeErrorCodes = [
	'runtimeNotPackaged', 'invalidPackage', 'incompatiblePackage', 'unsupportedPlatform',
	'storageUnavailable', 'storageBusy', 'invalidIdentity', 'invalidProtocol',
	'startFailed', 'startTimedOut', 'runtimeExited', 'stopFailed', 'stopTimedOut',
	'cancelled', 'stopping', 'disposed',
] as const;

export type RuntimeErrorCode = typeof runtimeErrorCodes[number];

/** Errors crossing the process boundary contain codes, never credentials or raw adapter errors. */
export class SimRuntimeError extends Error {
	constructor(readonly code: RuntimeErrorCode) {
		super(code);
		this.name = 'SimRuntimeError';
	}
}

export interface RuntimePackage {
	readonly entrypoint: string;
	readonly version: string;
}

export interface InitializeMessage {
	readonly type: 'initialize';
	readonly protocolVersion: typeof protocolVersion;
	readonly runId: string;
	readonly stateDirectory: string;
	readonly runtimePackage: RuntimePackage;
}

export interface ShutdownMessage {
	readonly type: 'shutdown';
	readonly protocolVersion: typeof protocolVersion;
	readonly runId: string;
}

export interface ReadyMessage {
	readonly type: 'ready';
	readonly protocolVersion: typeof protocolVersion;
	readonly runId: string;
	readonly instanceId: string;
}

export interface FailedMessage {
	readonly type: 'failed';
	readonly protocolVersion: typeof protocolVersion;
	readonly runId: string;
	readonly code: RuntimeErrorCode;
}

/** A package adapter owns partial-start cleanup and all resources it creates, including workers. */
export interface SimRuntimeAdapter {
	start(context: {
		readonly protocolVersion: typeof protocolVersion;
		readonly instanceId: string;
		readonly stateDirectory: string;
		readonly signal: AbortSignal;
	}): Promise<{ stop(): Promise<void> }>;
}

/** JSON/IPC input is untrusted until narrowed by the receiving protocol owner. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isInstanceId(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function isRuntimeErrorCode(value: unknown): value is RuntimeErrorCode {
	return typeof value === 'string' && runtimeErrorCodes.some(code => code === value);
}
