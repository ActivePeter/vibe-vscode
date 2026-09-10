# Sim Runtime

This Node workspace extension implements the first, infrastructure-only stage of
[Sim plugin runtime ownership](../../vibe_vscode_doc/design/sim_plugin_runtime.md).
It does not yet ship a native Sim adapter or replace the existing Sim sidebar and resource tabs.

The command palette exposes `Sim: Start Plugin Runtime (Preview)`, `Sim: Stop Plugin Runtime`,
and `Sim: Show Plugin Runtime Status`. A missing native package is reported explicitly;
the extension never falls back to a shared Sim website. Preview writer leases support Linux
Extension Hosts in the same kernel/network namespace, not distributed storage coordination.

From the repository root, run `npm --prefix extensions/vibe-sim run compile` and
`npm --prefix extensions/vibe-sim test`. The tests use real child processes with a fixture adapter;
they do not establish native Sim database or queue isolation. The packaging contract and next
migration gates are maintained in the linked design document.
