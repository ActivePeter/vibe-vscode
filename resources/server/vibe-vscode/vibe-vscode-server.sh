#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
read -r VERSION MODE < <("$ROOT/node" -p 'const m = require(process.argv[1]); `${m.version} ${m.mode ?? "production"}`' "$ROOT/vibe-release.json")

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

# Service starts use the same explicit authentication CLI contract in both profiles.
# Version/help preflight must work without opening state or requiring deployment inputs.
authentication_state=false
public_origin=false
informational=false
for argument in "$@"; do
	case "$argument" in
	--auth-state-dir | --auth-state-dir=*) authentication_state=true ;;
	--public-origin | --public-origin=*) public_origin=true ;;
	--version | --help | -h) informational=true ;;
	esac
done
if [[ "$informational" == false && ( "$authentication_state" == false || "$public_origin" == false ) ]]; then
	printf 'Vibe VS Code requires --auth-state-dir and --public-origin behind its private Caddy gateway.\n' >&2
	exit 1
fi
exec "$ROOT/node" "$ROOT/out/server-main.js" --web-client-cache-version "$VERSION" "$@"
