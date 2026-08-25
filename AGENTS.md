# VS Code Agents Instructions

This file provides instructions for AI coding agents working with the VS Code codebase.

For detailed project overview, architecture, coding guidelines, and validation steps, see the [Copilot Instructions](.github/copilot-instructions.md).

## Hosted Service Source Authority

- `/mnt/ceph/vibe-vscode` is the only source checkout allowed to build the VS Code services on ports `18080` and `18081`.
- Port `18080` runs mutable development output from this checkout. Port `18081` may run an immutable packaged runtime, but that package must also be built from this checkout.
- Both services must listen on `0.0.0.0`, not only on a loopback address, so they remain reachable from remote browsers and the hosted development environment.
- Do not patch, compile, source, invoke, or treat `/mnt/ceph/dever_for_dev/third_party/vscode` as a source tree or service-control dependency. That location only retains legacy Dever-side control scripts during the migration.
- Keep the existing per-service state directories under `/mnt/ceph/dever_for_dev/.dever/vscode-services`; source authority and user state ownership are separate concerns.

## Post-change Development Deployment

- After completing and validating source-code changes, invoke the project skill `$deploy-vscode-18080` once before handing the work back to the user.
- Trigger it after the final relevant edit, not after intermediate changes. Skip read-only tasks and documentation-only edits unless the user explicitly requests deployment.
- This automatic post-change deployment targets only the mutable development service on port `18080`. Never update port `18081` without an explicit user request.
