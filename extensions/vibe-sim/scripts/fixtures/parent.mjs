/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createRequire } from 'node:module';

const [managerPath, extensionDirectory, stateDirectory] = process.argv.slice(2);
const { ManagedSimRuntime } = createRequire(import.meta.url)(managerPath);
const runtime = new ManagedSimRuntime(extensionDirectory, stateDirectory);
process.on('message', () => process.exit(42)); // Deliberately bypass deactivate and dispose.
process.on('disconnect', () => process.exit(42));
await runtime.start();
process.send({ type: 'ready' });
