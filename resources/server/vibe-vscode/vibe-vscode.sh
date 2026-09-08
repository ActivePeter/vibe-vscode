#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.

set -euo pipefail
umask 0077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
COMMAND="${1:---help}"
[[ $# -eq 0 ]] || shift

fail() { printf 'vibe-vscode: %s\n' "$*" >&2; exit 1; }

if [[ "$COMMAND" == systemd ]]; then
	install_unit=false
	system_unit=false
	unit_arguments=()
	for argument in "$@"; do
		case "$argument" in
		--install) install_unit=true ;;
		--user | --user=*) system_unit=true; unit_arguments+=("$argument") ;;
		*) unit_arguments+=("$argument") ;;
		esac
	done
	if [[ "$install_unit" == true ]]; then
		unit="$("$ROOT/node" "$ROOT/resources/server/vibe-vscode/cli-config.ts" "$ROOT" systemd "${unit_arguments[@]}")"
		if [[ "$system_unit" == true ]]; then
			target=/etc/systemd/system/vibe-vscode.service
			next='systemctl daemon-reload && systemctl enable --now vibe-vscode'
		else
			target="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/vibe-vscode.service"
			next='systemctl --user daemon-reload && systemctl --user enable --now vibe-vscode'
		fi
		mkdir -p -- "$(dirname -- "$target")" 2>/dev/null || fail "cannot create $(dirname -- "$target"); create it with write permission for $(id -un), then rerun"
		printf '%s\n' "$unit" > "$target" 2>/dev/null || fail "cannot write $target; fix its permissions, then rerun"
		printf 'Wrote %s\nNext: %s\n' "$target" "$next"
		exit 0
	fi
fi
if [[ "$COMMAND" != start && "$COMMAND" != status ]]; then
	exec "$ROOT/node" "$ROOT/resources/server/vibe-vscode/cli-config.ts" "$ROOT" "$COMMAND" "$@"
fi
configuration="$("$ROOT/node" "$ROOT/resources/server/vibe-vscode/cli-config.ts" "$ROOT" "$COMMAND" "$@")"
mapfile -t configuration <<< "$configuration"
STATE="${configuration[0]}"
PORT="${configuration[1]}"
IFS=',' read -r -a ORIGINS <<< "${configuration[2]}"
TTL="${configuration[3]}"
BACKEND_PID=''
CADDY_PID=''
SOCKET_DIRECTORY=''
SOCKET=''

probe() {
	curl --noproxy '*' --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 2 "$@" 2>/dev/null || true
}

healthy() {
	[[ -S "$SOCKET" ]] || return 1
	[[ "$(probe --unix-socket "$SOCKET" http://localhost/auth/health)" == 204 ]] || return 1
	[[ "$(probe --unix-socket "$SOCKET" http://localhost/)" == 200 ]] || return 1
	local origin
	for origin in "${ORIGINS[@]}"; do
		# Probe this local gateway with the real browser authority/SNI, without DNS or proxy dependencies.
		[[ "$(probe --insecure --connect-to "::127.0.0.1:$PORT" "$origin/auth/api/status")" == 200 ]] || return 1
		[[ "$(probe --insecure --connect-to "::127.0.0.1:$PORT" --header 'Accept: text/html' "$origin/")" == 303 ]] || return 1
	done
}

if [[ "$COMMAND" == status ]]; then
	SOCKET="$(readlink -- "$STATE/backend.sock")" || fail "no running instance recorded in $STATE"
	healthy || fail 'one or more private/public health checks failed'
	printf 'Vibe VS Code is healthy: %s\n' "${ORIGINS[*]}"
	exit 0
fi

for required in flock curl base64 mktemp setsid; do
	command -v "$required" >/dev/null || fail "missing required command: $required"
done
[[ -x "$ROOT/caddy" ]] || fail 'the release is missing its bundled Caddy binary'
mkdir -p -- "$STATE" 2>/dev/null || fail "cannot create the state directory $STATE; create it, make it writable by $(id -un), then rerun"
exec 9>"$STATE/run.lock"
flock -n 9 || fail "another instance is already using $STATE"
chmod 0700 "$STATE"

cleanup() {
	trap - EXIT HUP INT TERM
	local pid deadline=$((SECONDS + 10))
	for pid in "$CADDY_PID" "$BACKEND_PID"; do
		[[ -z "$pid" ]] || kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
	done
	for pid in "$CADDY_PID" "$BACKEND_PID"; do
		[[ -n "$pid" ]] || continue
		while kill -0 -- "-$pid" 2>/dev/null && (( SECONDS < deadline )); do sleep 0.1; done
		kill -KILL -- "-$pid" 2>/dev/null || true
		wait "$pid" 2>/dev/null || true
	done
	if [[ -n "$SOCKET" && "$(readlink -- "$STATE/backend.sock" 2>/dev/null || true)" == "$SOCKET" ]]; then
		rm -f -- "$STATE/backend.sock"
	fi
	[[ -z "$SOCKET_DIRECTORY" ]] || rm -rf -- "$SOCKET_DIRECTORY"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p -- "$STATE/auth" "$STATE/server" "$STATE/extensions" "$STATE/caddy" 2>/dev/null || fail "cannot create the state subdirectories under $STATE; fix its permissions, then rerun"
chmod 0700 "$STATE/auth" "$STATE/server" "$STATE/extensions" "$STATE/caddy"
WORKSPACE="$STATE/vibe-vscode.code-workspace"
if [[ ! -e "$WORKSPACE" && ! -L "$WORKSPACE" ]]; then
	(set -o noclobber; printf '{"folders":[],"settings":{}}\n' > "$WORKSPACE")
fi
[[ -f "$WORKSPACE" && ! -L "$WORKSPACE" ]] || fail 'the instance workspace must be a regular state file'
SOCKET_DIRECTORY="$(mktemp -d "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/vibe-vscode.XXXXXXXX")"
SOCKET="$SOCKET_DIRECTORY/backend.sock"
[[ ! -e "$STATE/backend.sock" || -L "$STATE/backend.sock" ]] || fail 'backend.sock is not an instance-owned symlink'
ln -s -- "$SOCKET" "$STATE/backend.sock.new.$$"
mv -Tf -- "$STATE/backend.sock.new.$$" "$STATE/backend.sock"
printf '%s' "${configuration[4]}" | base64 --decode > "$STATE/caddy/Caddyfile"

printf 'Vibe VS Code browser addresses: %s\n' "${ORIGINS[*]}"
[[ -z "${configuration[5]}" ]] || printf '%s\n' "${configuration[5]}"
cd -- "$ROOT"
backend_arguments=(
	--socket-path "$SOCKET" --without-connection-token
	--server-data-dir "$STATE/server" --extensions-dir "$STATE/extensions"
	--auth-state-dir "$STATE/auth" --auth-session-ttl-seconds "$TTL"
	--default-workspace "$WORKSPACE" --accept-server-license-terms
)
for origin in "${ORIGINS[@]}"; do backend_arguments+=(--public-origin "$origin"); done
# Each component owns a process group, so cleanup also reaches its descendants.
setsid "$ROOT/bin/vibe-vscode-server" "${backend_arguments[@]}" &
BACKEND_PID=$!
setsid env XDG_DATA_HOME="$STATE" XDG_CONFIG_HOME="$STATE/caddy/config" \
	VIBE_VSCODE_PUBLIC_PORT="$PORT" VIBE_VSCODE_AUTH_PATH=/auth \
	VIBE_VSCODE_AUTH_ADDRESS="unix/$SOCKET" VIBE_VSCODE_BACKEND_ADDRESS="unix/$SOCKET" \
	"$ROOT/caddy" run --config "$STATE/caddy/Caddyfile" --adapter caddyfile &
CADDY_PID=$!

deadline=$((SECONDS + 60))
ready=false
while (( SECONDS < deadline )); do
	kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$CADDY_PID" 2>/dev/null || fail 'a component exited before startup completed'
	if healthy; then ready=true; break; fi
	sleep 0.2
done
[[ "$ready" == true ]] || fail 'startup health checks timed out'
printf 'vibe vscode is ready: open %s\n' "${ORIGINS[0]}"
wait -n "$BACKEND_PID" "$CADDY_PID" || true
fail 'a component exited unexpectedly; stopping the other component'
