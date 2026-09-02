# VS Code Agents Instructions

This file provides instructions for AI coding agents working with the VS Code codebase.

For detailed project overview, architecture, coding guidelines, and validation steps, see the [Copilot Instructions](.github/copilot-instructions.md).

## Hosted Service Source Authority

- The checkout containing this file is the only source tree allowed to build the VS Code services on ports `18080` and `18081`. Deployment entry points must resolve it relative to their own repository location.
- Port `18080` runs mutable development output from this checkout. Port `18081` may run an immutable packaged runtime, but that package must also be built from this checkout.
- The public endpoints for both services must listen on `0.0.0.0`, not only on a loopback address, so they remain reachable from remote browsers and the hosted development environment. Private VS Code backend sockets must not be exposed publicly.
- Port `18080` terminates HTTPS and WebSocket traffic in the pinned standalone Caddy binary managed by this repository; its VS Code backend uses a private Unix socket. Do not add Docker or restore direct TLS handling inside VS Code Server for this service.
- Do not patch, compile, source, or invoke a sibling checkout as a source or service-control dependency.
- Keep mutable service state outside both the source checkout and immutable releases. Supply environment-owned state and certificate locations through the deployment entry point's documented local inputs.

## Repository Portability Review

- Trigger this review whenever tracked source, configuration, documentation, scripts, tests, fixtures, logs, screenshots, or generated artifacts contain a machine-specific path or refer to another local checkout.
- Repository-owned resources must be resolved relative to the checkout or the calling script. Environment-owned state, credentials, certificates, and service directories must enter through one documented local configuration or command surface. Published documentation must use placeholders.
- Accept the change only when a clean checkout at a different location can build and run without editing tracked files, and a review of added lines finds no developer-specific mount, home, username, or sibling-checkout path.
- Do not broaden this rule to reject platform path semantics, standard temporary locations, or clearly synthetic test fixtures. Do not add parallel configuration channels solely to remove a hardcoded path.

## Post-change Development Deployment

- After completing and validating source-code changes, invoke the project skill `$deploy-vscode-18080` once before handing the work back to the user.
- Trigger it after the final relevant edit, not after intermediate changes. Skip read-only tasks and documentation-only edits unless the user explicitly requests deployment.
- This automatic post-change deployment targets only the mutable development service on port `18080`. Never update port `18081` without an explicit user request.
