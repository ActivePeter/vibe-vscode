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
tracked files.

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
- starts the development service without a connection token, waits for an anonymous HTTPS `200` response, verifies the public listener and private backend health, and confirms the tmux session is running from the expected candidate root before succeeding;
- fails instead of killing an unrecognized process when the port or backend socket is not owned by the canonical tmux session.

A running pre-launcher or source-linked release may remain only the verified rollback anchor after
passing both health boundaries. New candidates and selected snapshot restarts must satisfy the
shared launcher and self-contained release contract. Do not use the legacy bridge for a new build.

On failure, report the relevant service log tail and leave the error visible. Do not invoke or fall back to another checkout, do not start an ad-hoc server, and do not touch port `18081` unless the user explicitly expands the deployment scope.

When changing the deployment entry point, run `./tests/deploy-18080.test.sh` before any live deployment.
