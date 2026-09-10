# Sim Agent Workbench

Sim runs as a Node workspace extension: its original sidebar, workflows, DAGs,
agent chats and monitor use standard VS Code Webviews. The extension owns the
native application, database, queue and private instance storage. No separately
deployed Sim website is required. The native package currently targets Linux x64
Extension Hosts.

Open **Sim** in the activity bar to create a project chat. Project choices come
from Vibe's public plugin API. Different resources open separate editor tabs;
switching tabs retains the sidebar. Selected source text can be sent through
**Create Sim Chat from Selection** in the editor context menu.

Use **Sim: Configure Agent Runtime** if the Agent CLI is not on the Extension
Host's PATH. **Sign In to Agent for This Instance** and **Open Agent Configuration
for This Instance** operate on this instance's private profile. Credentials from
the old shared service are not imported. Permissions default to read-only;
user/remote machine settings can enable project writes or the explicit
Unrestricted session choice. Restart the Sim runtime after changing those settings.

Old shared data and old Workbench Sim tabs are not automatically imported.
The [runtime design](../../vibe_vscode_doc/design/sim_plugin_runtime.md) is the
canonical contract for ownership, isolation, permissions, migration and failures.

From the repository root, with Node.js 24 and a Linux x64 native build toolchain
(C/C++, Python, make, bison, flex, tar, rsync and flock):

```sh
npm --prefix extensions/vibe-sim run compile
npm run build-vibe-sim-native
node extensions/vibe-sim/dist/verifyRuntime.js
npm --prefix extensions/vibe-sim test
VIBE_SIM_NATIVE_TEST_PACKAGE="$PWD/extensions/vibe-sim/runtime" \
  node --test extensions/vibe-sim/scripts/nativeRuntime.test.mts
```

The last command validates actual Sim instances and databases, not fixture
adapters. Linux x64 Server product packaging and the standard 18080 update
entry point build and verify the locked native package automatically.
Ordinary extension compilation stays lightweight; without a complete package,
opening Sim fails explicitly instead of attaching to a shared service.
