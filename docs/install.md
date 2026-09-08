<!-- Copyright (c) Microsoft Corporation. All rights reserved. -->

# Install and start

Vibe VS Code releases target Linux x64 and run the Web workbench with a remote server. The archive includes Node, pinned Caddy 2.11.4, production dependencies, built-in extensions, and verified browser cache chunks. Users do not need Node, Caddy, root, systemd, or a source checkout to run it. This guide covers installing, starting, configuring, running as a service, upgrading and rolling back; how releases are built and published is in [Releases](release.md).

## Quick start

Choose a **published** tag from [GitHub Releases](https://github.com/ActivePeter/vibe-vscode/releases), replace `<tag>`, and use the HTTPS address you will open in the browser:

```bash
curl -fsSL 'https://github.com/ActivePeter/vibe-vscode/releases/download/<tag>/install.sh' | bash -s -- --tag '<tag>'
~/.vibe-vscode/current/bin/vibe-vscode start --origin https://dev.example.com:18080
# Open https://dev.example.com:18080; register the administrator, then add projects in the workbench.
```

No root, systemd, separate Node installation, or separate Caddy installation is required. The host needs Bash, curl, tar, find, GNU coreutils (including sha256sum), and util-linux (flock and setsid). Use a port above 1023 for an unprivileged start. Add `--root '<absolute-install-root>'` to the installer for a custom installation.

The installer verifies the archive checksum and runtime before atomically selecting `<root>/releases/<tag>` through `<root>/current`. It never overwrites an existing release, creates state, or starts a service. `start` creates the state directory and its subdirectories (`0700`), exiting with the path when it cannot, then runs the bundled Caddy and Remote Server in the foreground, streams their logs, and stops both on Ctrl-C or if either component exits. Caddy listens on `0.0.0.0`; the backend uses a private Unix socket in a `0700` runtime directory.

Without certificate options, Caddy issues certificates with its local CA. The startup log prints the browser addresses first and the root certificate to trust: `<state-dir>/caddy/pki/authorities/local/root.crt`. Import that root certificate into the browser/client's trust store; do not distribute its private key. No trust store is modified automatically. With your own certificate, pass `--tls-cert '<certificate-file>' --tls-key '<private-key-file>'`; its SANs must cover every configured hostname or IP.

Restrict access to the intended administrator until registration is complete: **the first visitor creates the only administrator account**. The `ready` message appears only after the private authentication/workbench checks and public status/login checks all pass. An empty physical workspace is created under state on first start and preserved thereafter; add project folders in the UI. There is no `--workspace` or `--base-path` option in this first launcher version.

### Configuration and browser addresses

The default port is `18080`, state is `<root>/state`, and the default origin is `https://<hostname -f>:<port>` (with the machine hostname as fallback). Prefer an explicit, reachable `--origin`. A domain is not required; repeat the option for LAN, VPN, or local access:

```bash
~/.vibe-vscode/current/bin/vibe-vscode start \
  --origin https://192.168.1.5:18080 \
  --origin https://100.64.0.7:18080 \
  --origin https://localhost:18080
```

These are an explicit HTTPS allowlist, not permission to trust arbitrary request headers. The first forwarded host, or Host when absent, only selects a listed origin; an unmatched form POST is rejected, and navigation returns to the first configured origin. Workbench connections use the same selection. Cookies are host-only: different hostnames/IPs normally have separate browser sessions and sign out independently. Cookies do **not** isolate different ports on the same hostname. The authentication contract is documented in [Full-screen login and instance authentication](../vibe_vscode_doc/design/login_authentication.md).

Persistent defaults live in `<state-dir>/vibe-vscode.env`; the first `start` creates that directory. Edit the file as data:

```dotenv
VIBE_VSCODE_ORIGIN=https://dev.example.com:18080,https://100.64.0.7:18080
VIBE_VSCODE_PORT=18080
VIBE_VSCODE_SESSION_TTL=43200
```

| Input | Meaning |
| --- | --- |
| `--state-dir <directory>` | Selects state and the configuration file itself; there is no `VIBE_VSCODE_STATE_DIR` file key |
| `--origin` / `VIBE_VSCODE_ORIGIN` | Repeated CLI options, or comma-separated file values; complete HTTPS origins without paths, credentials or wildcards |
| `--port` / `VIBE_VSCODE_PORT` | Caddy's local listening port; defaults to 18080 |
| `--tls-cert` / `VIBE_VSCODE_TLS_CERT` | Certificate file, supplied together with the key |
| `--tls-key` / `VIBE_VSCODE_TLS_KEY` | Private key file |
| `--session-ttl` / `VIBE_VSCODE_SESSION_TTL` | Sliding-session lifetime in seconds, from 60 to 604800; defaults to 43200 |

CLI options override file values; providing `--origin` replaces the entire file list. The file is not sourced as shell code: variables, tilde and command substitutions are not expanded, and unknown keys are rejected. Certificate paths in the file are relative to state unless absolute; CLI paths are relative to the calling directory. State cannot overlap a runtime or the releases tree.

Keep `auth/`, `server/`, `extensions/`, `caddy/` and `vibe-vscode.code-workspace` under state across restarts and upgrades. Losing `auth/` loses the administrator database and signing secret, invalidates sessions, and reopens registration. Back up state before upgrades.

## Run as a service (optional)

Stop any foreground instance first. Generate a user unit with the same options as `start` (or put the defaults in the configuration file above):

```bash
~/.vibe-vscode/current/bin/vibe-vscode systemd --install --origin https://dev.example.com:18080
systemctl --user daemon-reload && systemctl --user enable --now vibe-vscode
loginctl enable-linger "$(id -un)"
```

`--install` creates `~/.config/systemd/user/` (or `$XDG_CONFIG_HOME/systemd/user/`) when missing and writes `vibe-vscode.service` there; if the directory cannot be created or written it exits with an error naming the path so you can create it and grant permission, then rerun. Without `--install`, `systemd` prints the unit to stdout. Linger keeps the user service running after logout and may require administrator approval. Nothing is enabled automatically. Its `ExecStart` uses `<root>/current/bin/vibe-vscode start --state-dir …`, preserving CLI overrides and rereading the same data file at each start. Crash recovery reuses the selected release without building or downloading.

For an administrator-managed system service, run `systemd --install --user <service-account> --state-dir '<absolute-state-dir>'` as root; it writes `/etc/systemd/system/vibe-vscode.service`, then use `systemctl` without `--user`. Create the account and give it access to the installation, state and certificate files first; the generator does not change accounts or permissions. No separate Caddy service or hand-edited templates are needed.

## Upgrade, health checks, and rollback

```bash
~/.vibe-vscode/current/bin/install.sh --tag '<new-tag>'
# Stop and restart the foreground command, or: systemctl --user restart vibe-vscode
~/.vibe-vscode/current/bin/vibe-vscode status --origin https://dev.example.com:18080
```

Use the same `--state-dir` and configuration/CLI options as the running instance. `status` is read-only: it checks private `/auth/health` (204) and workbench `/` (200), then public `/auth/api/status` (200) and unauthenticated navigation `/` (303) for every origin. Local HTTPS probes preserve the browser authority/SNI while connecting to the local gateway; they skip trust validation so a new local CA can start. They do not prove that remote DNS, firewalls, or the browser's trust store are configured.

The installer holds `<root>/install.lock` across download, validation and pointer changes. Concurrent installation fails without changing the selected release. An install failure leaves the old selection and service untouched; upgrading `current` also leaves a running instance pinned to its resolved release. `start` separately holds `<state-dir>/run.lock` for its entire lifetime, including health checks and child-process cleanup, so two starts cannot share state. It only signals the process groups it created, never an unrelated port owner.

If the new runtime cannot start, its children are cleaned up; the version pointer is not silently changed. Select the prior release explicitly, then restart and check health:

```bash
~/.vibe-vscode/current/bin/install.sh --rollback
# Restart with the same options, or: systemctl --user restart vibe-vscode
~/.vibe-vscode/current/bin/vibe-vscode status --origin https://dev.example.com:18080
```

Rollback swaps `current` and `previous`; repeating it switches back. No release is automatically deleted, and state is never reset or copied into a release. Runtime rollback does not undo database migrations: consult each version's upgrade notes and keep a state backup. Restarts interrupt active connections; coordinate them with users.

## Verify browser caching and startup requirements

After the first successful load, refresh or reopen the browser. In DevTools Network, requests for the core `cache/*.bin` chunks should be **zero while the verified chunks remain stored**, including when the HTTP cache is disabled. The HTML, manifest, loader, workers, extensions, and workspace resources can still make requests. An upgrade downloads the changed chunks; an interrupted load retains verified completed chunks and resumes the missing ones. The startup screen reports download progress, transfer speed, cache reuse, and unavailable storage.

The external `workbenchStartup.js` module precedes the main module and registers its load/error listeners synchronously. Its controller owns startup transitions and timers, its view owns accessible DOM updates, and its metrics object counts verified-loader transfer progress. Only `code/didStartWorkbench` readiness permits cache-generation cleanup; preparing resources or rendering the workbench shell is not success. Page disposal prevents late asynchronous work from starting another workbench or updating the overlay.

Startup translations live in `src/vs/platform/remote/common/workbench-startup.nls.<locale>.json`. The English bundle defines the message type; the server resolves a safe locale and falls back to English. Translation tests enforce matching keys and placeholders. These JSON assets and the external startup module are included in every Web build.

- Without `--web-client-cache-version`, explicit chunk caching and versioned URLs are disabled. The upstream packaged-resource HTTP cache policy is unchanged. To test this mode, invoke the bundled `node out/server-main.js` directly without the launcher.
- With `--web-client-cache-version`, verified chunk loading is the only startup path. A missing manifest file makes the Web server constructor fail synchronously, before it serves a workbench; it never silently disables caching. Release validation also rejects an incomplete package before publication.
- Chunk loading requires a secure context (HTTPS or localhost), `DecompressionStream`, and `crypto.subtle`. Unsupported environments stop at the startup screen with a specific explanation and guidance to change the connection or browser. Browser support is determined by these capabilities, not an assumed version number; there is no native-module fallback.
- A chunk download or verification failure keeps already saved chunks and offers **Resume Loading**. When caching is explicitly disabled, an ordinary module failure instead offers a manual reload; persistent failures in that mode may require clearing the browser's HTTP cache. Neither mode uses special recovery URLs or localStorage recovery tokens, and native startup does not infer cache-hit metrics.
- With CacheStorage denied, full, or unavailable, resources can still be downloaded and verified without being persisted.
- Browser-managed storage can be evicted. Cached startup resources do not provide offline access to the remote workspace and are not a promise of permanent storage.
