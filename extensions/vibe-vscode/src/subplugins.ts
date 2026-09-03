/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface VibeSubPluginRoute {
	readonly id: string;
	readonly label: string;
	readonly path: string;
}

/** Context slices delivered by the trusted host to a subplugin. */
export interface VibeSubPluginContextSubscriptions {
	readonly activeFile?: boolean;
	readonly selection?: boolean;
}

/** Immutable context snapshot delivered by the trusted host to a subplugin surface. */
export interface VibeSubPluginHostContext {
	readonly language: string;
	readonly activeFile?: {
		readonly uri: string;
		readonly selection?: {
			readonly startLine: number;
			readonly startCharacter: number;
			readonly endLine: number;
			readonly endCharacter: number;
		};
	};
}

export interface VibeSubPlugin {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly defaultPath: string;
	readonly routes: readonly VibeSubPluginRoute[];
	readonly contextSubscriptions: VibeSubPluginContextSubscriptions;
}

/**
 * Internal subplugins mounted by the trusted Vibe editor host.
 *
 * The host owns editor presentation and VS Code capabilities. Each subplugin owns its
 * application runtime and UI, so Sim keeps using its original Workflow and DAG canvases.
 */
export function getVibeSubPlugins(): readonly VibeSubPlugin[] {
	return [
		{
			id: 'sim',
			label: 'Sim',
			description: 'Workflow and PR dependency DAG',
			defaultPath: '/workspace',
			contextSubscriptions: {
				activeFile: true,
				selection: true,
			},
			routes: [
				{ id: 'workspace', label: 'Workspace', path: '/workspace' },
				{ id: 'dag-demo', label: 'DAG Demo', path: '/plan-graph-demo' },
			],
		},
	];
}
