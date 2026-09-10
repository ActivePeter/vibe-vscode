/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VibeProjectContext } from 'vibe-vscode';

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
	readonly supervisor?: string;
	readonly nodeExecutable?: string;
}

/** Private endpoint metadata crosses only the parent IPC channel, never a command result or Webview. */
export interface NativeConnectionInfo {
	readonly applicationPort: number;
	readonly realtimePort: number;
	readonly gateway: string;
}

export function isNativeConnectionInfo(value: unknown): value is NativeConnectionInfo {
	return isRecord(value)
		&& Number.isInteger(value.applicationPort) && Number(value.applicationPort) > 0 && Number(value.applicationPort) <= 65535
		&& Number.isInteger(value.realtimePort) && Number(value.realtimePort) > 0 && Number(value.realtimePort) <= 65535
		&& typeof value.gateway === 'string' && /^[a-f0-9]{64}$/.test(value.gateway);
}

export interface InitializeMessage {
	readonly type: 'initialize';
	readonly protocolVersion: typeof protocolVersion;
	readonly runId: string;
	readonly stateDirectory: string;
	readonly runtimePackage: RuntimePackage;
	readonly agentExecutables?: AgentExecutables;
	readonly agentPolicy?: AgentPolicy;
}

export type AgentKind = 'codex' | 'claude';
export type AgentExecutables = Readonly<Record<AgentKind, string>>;

/** Executables come only from user/machine settings, never from a Webview or workspace config. */
export function isAgentExecutables(value: unknown): value is AgentExecutables {
	return isRecord(value) && [value.codex, value.claude].every(item => typeof item === 'string' && item.length > 0 && item.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(item));
}

export interface AgentPolicy {
	readonly codexSandbox: 'read-only' | 'workspace-write';
	readonly allowUnrestricted: boolean;
}

export const defaultAgentPolicy: AgentPolicy = Object.freeze({ codexSandbox: 'read-only', allowUnrestricted: false });

/** Machine/user consent sets the ceiling; Sim still validates each saved session choice. */
export function isAgentPolicy(value: unknown): value is AgentPolicy {
	return isRecord(value) && (value.codexSandbox === 'read-only' || value.codexSandbox === 'workspace-write') && typeof value.allowUnrestricted === 'boolean';
}

export interface ShutdownMessage {
	readonly type: 'shutdown';
	readonly protocolVersion: typeof protocolVersion;
	readonly runId: string;
}

export interface ProjectContextAppliedMessage {
	readonly type: 'projectContextApplied';
	readonly protocolVersion: typeof protocolVersion;
	readonly runId: string;
	readonly requestId: string;
}

/** Public Vibe snapshots are projections; accepting one never creates or changes a project owner. */
export function isProjectContext(value: unknown): value is VibeProjectContext {
	const text = (item: unknown, maximum: number) => typeof item === 'string' && item.length > 0 && item.length <= maximum;
	const logical = (item: unknown) => isRecord(item) && text(item.id, 512) && text(item.name, 256);
	if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.generation) || Number(value.generation) < 0
		|| !isRecord(value.physicalWorkspace) || !Array.isArray(value.logicalWorkspaces) || value.logicalWorkspaces.length > 256 || !value.logicalWorkspaces.every(logical)) { return false; }
	const physical = value.physicalWorkspace;
	return text(physical.id, 512) && text(physical.name, 256) && typeof physical.remoteAuthority === 'string' && physical.remoteAuthority.length <= 512
		&& Array.isArray(physical.folders) && physical.folders.length <= 256
		&& physical.folders.every(folder => isRecord(folder) && text(folder.name, 256) && text(folder.uri, 8192) && Number.isSafeInteger(folder.index) && Number(folder.index) >= 0)
		&& (value.logicalWorkspace === undefined || logical(value.logicalWorkspace))
		&& (value.project === undefined || isRecord(value.project) && text(value.project.name, 256) && text(value.project.uri, 8192));
}

export interface ReadyMessage {
	readonly type: 'ready';
	readonly protocolVersion: typeof protocolVersion;
	readonly runId: string;
	readonly instanceId: string;
	readonly connection?: NativeConnectionInfo;
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
		readonly agentExecutables?: AgentExecutables;
		readonly agentPolicy?: AgentPolicy;
	}): Promise<{ readonly connection?: NativeConnectionInfo; readonly closed?: Promise<void>; stop(): Promise<void> }>;
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
