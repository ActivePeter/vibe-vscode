<!-- Copyright (c) Microsoft Corporation. All rights reserved. -->

# Releases and installation

Vibe VS Code releases target Linux x64 and run the Web workbench with a remote server. The archive includes Node, pinned Caddy 2.11.4, production dependencies, built-in extensions, and verified browser cache chunks. Users do not need Node or a source checkout to run it. Other operating systems and architectures are not covered by this release workflow yet.

> Installing, starting, configuring, running as a service, upgrading and rolling back are covered by [Install and start](install.md). This page is for maintainers: how a tag becomes a verified archive and a draft release.

## Build and publish

[Vibe Release](../.github/workflows/release.yml) runs on a pushed `vMAJOR.MINOR.PATCH` tag, including prerelease suffixes. It can also be dispatched manually with an **existing tag**. Both paths resolve the tag to one commit before validation, and build that same commit throughout.

The workflow reuses [Vibe CI](../.github/workflows/vibe-ci.yml): build-tool type checking, client/extension compilation, ESLint, hygiene, dependency layers, build tests, and regression tests discovered by product-area globs are release gates. New tests in those directories run without a separate file registration. Both bundled and minified Web Server packages must pass cache integrity, native dependency loading, archive creation, production-launcher checks, and installed-runtime smoke tests (TLS, health checks, locks and process cleanup). These checks also run on pull requests, before any release tag is created. A failed gate prevents publication.

The release job builds `gulp vscode-reh-web-linux-x64-min`, verifies native dependencies through ESM and CommonJS with the packaged Node, checks compressed JS/CSS and runtime-link containment, then creates:

- `vibe-vscode-server-<tag>-linux-x64.tar.gz`
- `vibe-vscode-server-<tag>-linux-x64.tar.gz.sha256`
- `install.sh` (identical to the repository-root installer and the copy in the archive)

Only the final publication job has repository write permission. It creates a **draft GitHub Release** for the existing tag; a maintainer reviews and publishes that draft. Pull requests and branch pushes do not create tags or publish releases. Until a draft is published, its files are not public installation downloads. A rerun does not overwrite an existing release; use a new tag for changed code.

The archive preserves Gulp's production layout: dependencies originally built in `remote/node_modules` are packaged at the archive root as `node_modules`, not under `remote/`.

| Archive path | Purpose |
| --- | --- |
| `node`, `node_modules/` | Matching Node runtime and production/native dependencies |
| `out/`, `extensions/` | Built server, browser workbench, and extensions |
| `out/vs/code/browser/workbench/cache/` | Manifest, loader, and verified gzip chunks |
| `caddy`, `caddy.LICENSE` | Pinned HTTPS/WebSocket gateway and its upstream license, verified before packaging |
| `bin/vibe-vscode` | Foreground start, status and optional systemd generation |
| `bin/install.sh` | Upgrade/rollback entry point, including custom-root detection |
| `bin/vibe-vscode-server` | Shared low-level launcher; applies immutable release metadata |
| `vibe-release.json` | Version, exact source commit, runtime mode, platform, architecture, and authentication launcher contract |
| `resources/server/vibe-vscode/` | Shared Caddy rules and data-only CLI configuration parser |

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

`prepare` bundles and compresses staged browser assets and installs the launcher with release metadata. Omit `--development` for production output. `verify` checks the core cache manifest and its payloads; `package` additionally validates the production layout, compressed assets, native loading, launcher, and source identity and downloads the pinned Caddy archive, verifies its SHA-512 and the extracted binary's SHA-256, before creating the three release attachments outside the input package.

There is one cache implementation in `build/lib/webClientCache.ts` and one compression implementation in `build/lib/precompress.ts`, shared by Gulp, `build/next`, and staged development preparation. The cache always reads the explicit `workbench.css` entry and ignores CSS imports when bundling JavaScript. Source staging first materializes that stylesheet and the standalone startup module from copied source output; it never rewrites the live checkout's output. Production builds already emit those entries.

The always-latest development service remains source-based. Its deployment script builds a staged snapshot and starts the same [metadata-driven low-level launcher](#runtime-launcher-contract). The existing single-writer lock, process-ownership checks, private backend, health gates, and rollback transaction stay in the deployment coordinator. A healthy runtime predating authentication or its CLI may be retained only as the exact rollback anchor during [the bounded development migration](../vibe_vscode_doc/design/login_authentication.md#10-部署健康与回滚); new candidates and selected snapshot restarts must declare `authentication: "embedded-cli-v1"` and pass the shared launcher's `--version` preflight. Candidate authentication configuration is validated against disposable state before stopping the active service.

### Runtime launcher contract

The low-level `bin/vibe-vscode-server` reads `version` and `mode` from `vibe-release.json` and supplies `--web-client-cache-version <version>`. Cache identity comes from release metadata, not a directory name or inherited environment.

| Metadata mode | Runtime environment | Producer |
| --- | --- | --- |
| `production` | `NODE_ENV=production`, `VSCODE_DEV` unset | Release archive |
| `development` | `NODE_ENV=development`, `VSCODE_DEV=1` | Staged source snapshot |

Missing `mode` defaults to production for older metadata; an unknown mode fails before start. Apart from version/help preflight, the launcher requires `--auth-state-dir`. The Remote Server validates repeatable/comma-separated `--public-origin`, TTL, a private `--socket-path`, and `--without-connection-token` before opening authentication state. The user CLI supplies these arguments; public TLS remains Caddy's responsibility.

## Release notes

The draft body comes from a file that ships with the tagged commit, so notes are reviewed in pull requests alongside the code they describe:

- Write `docs/release-notes/<tag>.md` from [`docs/release-notes/TEMPLATE.md`](release-notes/TEMPLATE.md). The file name is the exact tag, and the first line must be a heading that names the tag; a copied previous file fails validation. While the version is undecided, keep it as `docs/release-notes/next.md` and rename it in the release pull request.
- The `source` job runs `node build/release-notes.ts` before any build and fails when the file is missing. A manual dispatch may set `allow_missing_notes` to publish a draft with a placeholder body instead; a pushed tag never can.
- The `publish` job assembles the final body: the file, a generated appendix with the tag, source commit and archive checksums, then GitHub's categorized pull-request list ([`.github/release.yml`](../.github/release.yml)).
- The release is still created as a **draft**. Publishing it in the GitHub UI is the confirmation step, and the body can be edited there; copy any edits back into the file in the next release pull request.
