#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
VERSION="$("$ROOT/node" -p 'require(process.argv[1]).version' "$ROOT/vibe-release.json")"
MODE="$("$ROOT/node" -p 'require(process.argv[1]).mode ?? "production"' "$ROOT/vibe-release.json")"

case "$MODE" in
production)
	unset VSCODE_DEV
	export NODE_ENV=production
	;;
development)
	export VSCODE_DEV=1 NODE_ENV=development
	;;
*)
	printf 'Unsupported runtime mode: %s\n' "$MODE" >&2
	exit 1
	;;
esac
exec "$ROOT/node" "$ROOT/out/server-main.js" --web-client-cache-version "$VERSION" "$@"
