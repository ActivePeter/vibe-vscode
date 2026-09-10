/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import type { AgentExecutables, AgentKind } from './protocol';

/** One profile contract is used by native execution, explicit login and configuration editing. */
export function agentProfile(stateDirectory: string, agent: AgentKind, executables?: AgentExecutables) {
	const home = path.join(stateDirectory, 'agents', agent);
	return {
		executable: executables?.[agent] ?? agent,
		home,
		configFile: path.join(home, agent === 'codex' ? 'config.toml' : 'settings.json'),
		environment: {
			HOME: path.join(stateDirectory, 'home'),
			...(agent === 'codex' ? { CODEX_HOME: home } : { CLAUDE_CONFIG_DIR: home }),
		},
	};
}
