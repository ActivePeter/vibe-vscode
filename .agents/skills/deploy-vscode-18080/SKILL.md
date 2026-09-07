---
name: deploy-vscode-18080
description: Update or restart the mutable Vibe VS Code development service on HTTPS port 18080 from the checkout containing this skill. Use once after validated source changes, when explicitly asked to deploy the latest source, or when asked to restart the selected immutable snapshot. Do not trigger for read-only or documentation-only work unless requested.
---

# Deploy Vibe VS Code on 18080

Deploy only after the current code-editing task and its relevant validation are complete. Avoid restarting the service after intermediate edits.

Before running the deployment, tell the user which mode is starting. Run the bundled script relative to this file:

```bash
# Always latest (default after source changes)
./scripts/deploy-18080.sh

# Reuse and restart the selected immutable release
./scripts/deploy-18080.sh --mode snapshot

# Explicitly refresh a pinned snapshot
./scripts/deploy-18080.sh --mode snapshot --update-snapshot
```

Automatic service recovery always reuses its selected release; it never rebuilds. Do not add Supervisor.

The script resolves the source root from its own repository location. Mutable state and TLS files
default to XDG state/config directories. An operator can override those locations through the
existing `VIBE_VSCODE_SERVICE_STATE_ROOT`, `VIBE_VSCODE_SERVICE_LOG`,
`VIBE_VSCODE_TLS_CERT_PATH`, and `VIBE_VSCODE_TLS_KEY_PATH` environment inputs without editing
tracked files. `VIBE_VSCODE_SERVER_BASE_PATH` selects an optional simple URL base path, and
`VIBE_VSCODE_AUTH_SESSION_TTL_SECONDS` selects a 60-second to 7-day session lifetime.
`VIBE_VSCODE_PUBLIC_ORIGIN` is required and must be the browser-visible HTTPS origin, without
a URL path. Confirm that address from operator configuration or the user; never infer it from
client-supplied proxy headers or substitute a localhost probe address for a remote browser.

The account, session, and request authorization contract is canonical in
[Full-screen login and instance authentication](../../../vibe_vscode_doc/design/login_authentication.md).

The script must remain the single automation entry for this skill. It:

- keeps the active service on a self-contained, versioned last-known-good runtime while compiling the canonical checkout;
- holds one stable fail-fast `flock` across build, staging, stop, activation, health checks, rollback, and cleanup;
- stages and validates a complete runtime snapshot before stopping the active service;
- prepares staged browser assets and metadata with the shared `build/web-release.ts prepare` command, then starts `bin/vibe-vscode-server` in the metadata-selected development profile;
- validates the shared launcher's `--version` before stopping the old service; the launcher, CSS entry, browser caching, and production archive contracts are canonical in [Releases and installation](../../../docs/release.md);
- downloads a pinned standalone Caddy release with fixed checksums, then copies Caddy, Node, runtime dependency trees, and server helpers into that snapshot, reusing unchanged files only from the previous versioned release rather than linking to mutable source;
- switches to the candidate only after the build succeeds, and automatically restores the last-known-good runtime when startup or health checks fail;
- resolves and builds the source checkout relative to this skill, without invoking another project's control code;
- keeps mutable state and TLS material outside the checkout at operator-supplied or XDG-standard locations;
- terminates public HTTPS and WebSocket traffic in Caddy on `0.0.0.0:18080`, while the upstream VS Code Server uses its original HTTP implementation over a private Unix socket;
- starts exactly two candidate processes: Caddy and the VS Code Remote Server, with Better Auth and Node's built-in SQLite initialized inside the Remote Server and persistent authentication state outside immutable releases;
- enables authentication with the same `--auth-state-dir`, `--public-origin`, and `--auth-session-ttl-seconds` CLI contract used by the production systemd unit;
- validates the configured origin, session lifetime, and database initialization against disposable state before stopping the active service; it never opens the user's authentication database during candidate preflight;
- lets Caddy expose only the Remote Server's authentication routes without `forward_auth`, and sends all other HTTP and WebSocket traffic through the same Remote Server's `/auth/verify` contract;
- strips protocol-upgrade headers from authentication routes and verification subrequests, so they cannot enter Node's separate upgrade handler; only an authorized original request may upgrade;
- returns any sliding-session `Set-Cookie` emitted by `/auth/verify` to the browser before proxying the authorized request;
- starts VS Code without its connection token only behind the mandatory Caddy authorization boundary and a private Unix socket;
- pins Better Auth's trusted origin and Workbench's `remoteAuthority` to the configured public identity, independently of request headers;
- requires the public authentication status to return `200`, an unauthenticated Workbench request to return `303`, the Remote Server's private authentication health check to return `204`, and the private Workbench endpoint to return `200` before succeeding;
- fails instead of killing an unrecognized process when the port or backend socket is not owned by the canonical tmux session.

The entry point never starts an authentication sidecar. New candidates declare the shared
`authentication: "embedded-cli-v1"` contract in `vibe-release.json`. While restoring the exact
healthy embedded release that predates that CLI, the existing rollback bridge supplies its old
authentication environment inputs. Such a release cannot become a newly selected snapshot.

A running pre-launcher or source-linked release may remain only the verified rollback anchor after
passing both health boundaries. New candidates and selected snapshot restarts must satisfy the
shared launcher and self-contained release contract. Do not use the legacy bridge for a new build.

On failure, report the relevant service log tail and leave the error visible. Do not invoke or fall back to another checkout, do not start an ad-hoc server, and do not touch port `18081` unless the user explicitly expands the deployment scope.

When changing the deployment entry point, run `./tests/deploy-18080.test.sh` before any live deployment.
When changing authentication or Caddy routing, also run `node ./tests/authentication-gateway.test.ts <pinned-caddy-binary>` against freshly compiled source. This test uses disposable state and a loopback-only port, verifies real HTTP/WebSocket denial and renewal, and runs in Vibe CI.
