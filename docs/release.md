<!-- Copyright (c) Microsoft Corporation. All rights reserved. -->

# Releases and installation

Vibe VS Code releases target Linux x64 and run the Web workbench with a remote server. The archive includes Node, production dependencies, built-in extensions, and verified browser cache chunks. Users do not need Node or a source checkout to run it. Other operating systems and architectures are not covered by this release workflow yet.

## Build and publish

[Vibe Release](../.github/workflows/release.yml) runs on a pushed `vMAJOR.MINOR.PATCH` tag, including prerelease suffixes. It can also be dispatched manually with an **existing tag**. Both paths resolve the tag to one commit before validation, and build that same commit throughout.

The workflow reuses [Vibe CI](../.github/workflows/vibe-ci.yml): build-tool type checking, client/extension compilation, ESLint, hygiene, dependency layers, build tests, and regression tests discovered by product-area globs are release gates. New tests in those directories run without a separate file registration. Both bundled and minified Web Server packages must pass cache integrity, native dependency loading, archive creation, and production-launcher checks. These checks also run on pull requests, before any release tag is created. A failed gate prevents publication.

The release job builds `gulp vscode-reh-web-linux-x64-min`, verifies native dependencies through ESM and CommonJS with the packaged Node, checks compressed JS/CSS and runtime-link containment, then creates:

- `vibe-vscode-server-<tag>-linux-x64.tar.gz`
- `vibe-vscode-server-<tag>-linux-x64.tar.gz.sha256`

Only the final publication job has repository write permission. It creates a **draft GitHub Release** for the existing tag; a maintainer reviews and publishes that draft. Pull requests and branch pushes do not create tags or publish releases. Until a draft is published, its files are not public installation downloads. A rerun does not overwrite an existing release; use a new tag for changed code.

The archive preserves Gulp's production layout: dependencies originally built in `remote/node_modules` are packaged at the archive root as `node_modules`, not under `remote/`.

| Archive path | Purpose |
| --- | --- |
| `node`, `node_modules/` | Matching Node runtime and production/native dependencies |
| `out/`, `extensions/` | Built server, browser workbench, and extensions |
| `out/vs/code/browser/workbench/cache/` | Manifest, loader, and verified gzip chunks |
| `bin/vibe-vscode-server` | Shared runtime launcher; applies immutable release metadata |
| `vibe-release.json` | Version, exact source commit, runtime mode, platform, and architecture |
| `resources/server/vibe-vscode/` | Caddy, systemd, and operator configuration templates |

### Source builds and development deployments

From an installed source checkout, the standard production command is:

```bash
npm run gulp vscode-reh-web-linux-x64-min
```

Its output is the `vscode-reh-web-linux-x64` directory beside the checkout. Do not run this command against an output directory owned by another build. One CLI owns runtime preparation, cache verification, and archive creation:

```bash
node build/web-release.ts prepare '<staged-runtime-root>' '<version>' '<source-commit>' --development
node build/web-release.ts verify '<runtime-root>'
node build/web-release.ts package '<gulp-package-root>' '<artifact-directory>' '<release-tag>' '<source-commit>'
```

`prepare` bundles and compresses staged browser assets and installs the launcher with release metadata. Omit `--development` for production output. `verify` checks the core cache manifest and its payloads; `package` additionally validates the production layout, compressed assets, native loading, launcher, and source identity before creating an archive outside the input package.

There is one cache implementation in `build/lib/webClientCache.ts` and one compression implementation in `build/lib/precompress.ts`, shared by Gulp, `build/next`, and staged development preparation. The cache always reads the explicit `workbench.css` entry and ignores CSS imports when bundling JavaScript. Source staging first materializes that stylesheet and the standalone startup module from copied source output; it never rewrites the live checkout's output. Production builds already emit those entries.

The always-latest development service remains source-based. Its deployment script builds a staged snapshot and starts the same [metadata-driven launcher](#configure-and-start) as the systemd template. The existing single-writer lock, process-ownership checks, private backend, health gates, and rollback transaction stay in the deployment coordinator. A healthy pre-launcher runtime may be retained only as the exact rollback anchor during migration; new candidates and selected snapshot restarts must pass the shared launcher's `--version` preflight.

## Download and install

Choose a published version from [GitHub Releases](https://github.com/ActivePeter/vibe-vscode/releases). Replace every `<placeholder>` below; download and verify as an unprivileged user before installing into an operator-owned directory.

```bash
set -euo pipefail
TAG='<release-tag>'
ASSET="vibe-vscode-server-$TAG-linux-x64.tar.gz"
curl -fL -o "$ASSET" "https://github.com/ActivePeter/vibe-vscode/releases/download/$TAG/$ASSET"
curl -fL -o "$ASSET.sha256" "https://github.com/ActivePeter/vibe-vscode/releases/download/$TAG/$ASSET.sha256"
sha256sum --check "$ASSET.sha256"
```

Use a new directory for each release. Keep mutable server state, installed user extensions, connection tokens, and TLS material outside that tree. The service account should be able to read releases, but not rewrite them or the `current` pointer.

```bash
set -euo pipefail
INSTALL_ROOT='<absolute-install-root>'
mkdir -p "$INSTALL_ROOT/releases"
exec 9>"$INSTALL_ROOT/deploy.lock"
flock -n 9
CANDIDATE="$INSTALL_ROOT/releases/$TAG"
test ! -e "$CANDIDATE"
mkdir "$CANDIDATE"
tar -xzf "$ASSET" -C "$CANDIDATE"
"$CANDIDATE/bin/vibe-vscode-server" --version
```

Keep this lock held through activation and health checks. For the first installation, select the verified candidate with an atomic pointer replacement:

```bash
ln -s "$CANDIDATE" "$INSTALL_ROOT/current.new"
mv -T "$INSTALL_ROOT/current.new" "$INSTALL_ROOT/current"
```

Do not reuse an existing release directory, merge a tarball into `current`, or change a published tag in place. For subsequent upgrades, follow the rollback procedure below.

## Configure and start

The shared launcher reads `version` and `mode` from `vibe-release.json` and supplies `--web-client-cache-version <version>`. Cache identity comes from the release, not its installation directory name or inherited environment.

| Metadata mode | Runtime environment | Producer |
| --- | --- | --- |
| `production` | `NODE_ENV=production`, `VSCODE_DEV` unset | Release archive |
| `development` | `NODE_ENV=development`, `VSCODE_DEV=1` | Staged source snapshot |

Missing `mode` defaults to production for older release metadata; an unknown mode fails before the server starts. Operators configure sockets, state, and authentication through launch arguments, not by editing immutable metadata.

For a private backend, the equivalent operator-facing launch is:

```bash
"$INSTALL_ROOT/current/bin/vibe-vscode-server" \
  --socket-path '<private-unix-socket>' \
  --server-data-dir '<state-root>/server' \
  --extensions-dir '<state-root>/extensions' \
  --connection-token-file '<connection-token-file>'
```

| Argument | Meaning |
| --- | --- |
| `--socket-path` | Private backend socket; it is not exposed as a public TCP listener |
| `--server-data-dir` | Mutable settings, sessions, and server databases outside releases |
| `--extensions-dir` | Mutable user-installed extensions outside releases |
| `--connection-token-file` | Owner-readable file containing a random connection token |
| `--web-client-cache-version` | Immutable tag/commit identity; supplied by the launcher |

For loopback-only diagnostics, `--host 127.0.0.1 --port 8080` can replace `--socket-path`. Public HTTPS belongs to Caddy, not the VS Code backend. Do not use `--without-connection-token` on a remotely accessible instance. That option is appropriate only behind a separately enforced authentication gateway that protects **all HTTP and WebSocket traffic**, with the backend remaining private.

### systemd and Caddy/TLS

Install Caddy separately, and create a dedicated `vibe-vscode` service account. The supplied templates use standard Linux systemd locations:

- Copy `resources/server/vibe-vscode/service.env.example` from the archive to `/etc/vibe-vscode/service.env`, and replace every placeholder. This is the shared operator configuration for the backend and proxy.
- Create the configured state directory, owned by `vibe-vscode`, with permissions that deny other users. Create a cryptographically random connection-token file readable only by that account. Give the Caddy account access to the configured certificate and private key; it does not need access to the token or state databases.
- Install `resources/server/vibe-vscode/vibe-vscode.service` as `/etc/systemd/system/vibe-vscode.service`.
- Install `resources/server/vibe-vscode/caddy.service.conf` as `/etc/systemd/system/caddy.service.d/vibe-vscode.conf`. It assumes the distribution's Caddy executable is `/usr/bin/caddy`; adjust the installed drop-in if necessary.

The backend unit creates the private socket under `/run/vibe-vscode`. The Caddy drop-in joins its group so it can reach that socket. Caddy binds public HTTPS to `0.0.0.0` on `VIBE_VSCODE_PUBLIC_PORT` (18080 by default), using the configured TLS files. No private backend TCP port is opened.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vibe-vscode
sudo systemctl enable caddy
sudo systemctl restart caddy
```

The bundled Caddyfile disables its admin API, so use a restart, not `caddy reload`, after changing proxy configuration. The public certificate must be trusted by the browser. Open the HTTPS workbench using the connection token for initial authentication; do not share token-bearing URLs or include them in logs or screenshots.

## Upgrade, health checks, and rollback

Hold the same stable `deploy.lock` from candidate preparation through verification and any rollback. Keep the old server running while downloading, checking the checksum, and validating the new candidate. Record the resolved previous `current` target before changing it.

Atomically point `current` at the new release, then restart only the recognized `vibe-vscode` systemd service. Verify all of the following before releasing the lock:

- The private socket responds to `/version` with the expected source commit.
- The public HTTPS `/version` responds through the configured TLS endpoint.
- An unauthenticated workbench request is denied, and an authenticated browser can open the workbench and connect its extension host.
- The public listener belongs to Caddy and the backend remains on its private socket.

For a private health probe, an operator with socket access can use:

```bash
curl --fail --unix-socket /run/vibe-vscode/backend.sock http://localhost/version
```

If activation or health checks fail, atomically point `current` back to the recorded previous release, restart the same service, and verify its health before releasing the lock. Do not delete or reset the state databases to repair a failed rollout. Preserve the active and previous releases, plus any release still referenced by a live process. Restarting the server can interrupt active connections; coordinate upgrades with users.

## Verify browser caching and fallbacks

After the first successful load, refresh or reopen the browser. In DevTools Network, requests for the core `cache/*.bin` chunks should be **zero while the verified chunks remain stored**, including when the HTTP cache is disabled. The HTML, manifest, loader, workers, extensions, and workspace resources can still make requests. An upgrade downloads the changed chunks; an interrupted load retains verified completed chunks and resumes the missing ones. The startup screen reports download progress, transfer speed, cache reuse, and unavailable storage.

The external `workbenchStartup.js` module precedes the main module and registers its load/error listeners synchronously. Its controller owns startup transitions and timers, its view owns accessible DOM updates, and its metrics object counts verified-loader transfer progress. Only `code/didStartWorkbench` readiness permits cache-generation cleanup; preparing resources or rendering the workbench shell is not success. Page disposal prevents late asynchronous work from starting another workbench or updating the overlay.

Startup translations live in `src/vs/platform/remote/common/workbench-startup.nls.<locale>.json`. The English bundle defines the message type; the server resolves a safe locale and falls back to English. Translation tests enforce matching keys and placeholders. These JSON assets and the external startup module are included in every Web build.

- Without `--web-client-cache-version`, explicit chunk caching and versioned URLs are disabled. The upstream packaged-resource HTTP cache policy is unchanged. To test this mode, invoke the bundled `node out/server-main.js` directly without the launcher.
- With a version but no manifest, startup uses the ordinary module path. Release validation rejects this incomplete package before publication.
- Without `DecompressionStream` or `crypto.subtle`, startup falls back to ordinary modules.
- If an ordinary module fails, the startup screen offers a manual reload. Persistent failures may require clearing the browser's HTTP cache. There are no special recovery URLs, localStorage recovery tokens, or inferred native cache-hit metrics. Chunk verification and downloading missing or corrupt chunks remain independent of this fallback.
- With CacheStorage denied, full, or unavailable, resources can still be downloaded and verified without being persisted.
- Browser-managed storage can be evicted. Cached startup resources do not provide offline access to the remote workspace and are not a promise of permanent storage.
