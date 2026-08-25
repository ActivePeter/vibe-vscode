#!/usr/bin/env bash

set -euo pipefail

readonly SOURCE_ROOT=/mnt/ceph/vibe-vscode
readonly SERVICE_SESSION=vibe_vscode_latest
readonly SERVICE_PORT=18080
readonly SERVICE_URL="https://127.0.0.1:${SERVICE_PORT}/"
readonly SERVICE_STATE_ROOT=/mnt/ceph/dever_for_dev/.dever/vscode-services/state/latest
readonly SERVICE_LOG=/mnt/ceph/dever_for_dev/.dever/vscode-services/logs/latest.log
readonly TLS_KEY_PATH=/mnt/ceph/dever_for_dev/.dever/https/localhost-key.pem
readonly TLS_CERT_PATH=/mnt/ceph/dever_for_dev/.dever/https/localhost-cert.pem
readonly DEPLOY_TIMEOUT_SECONDS="${VIBE_VSCODE_DEPLOY_TIMEOUT_SECONDS:-900}"
readonly SCRIPT_PATH="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/$(basename -- "${BASH_SOURCE[0]}")"
readonly NODE_VERSION="$(tr -d '[:space:]' < "$SOURCE_ROOT/.nvmrc")"
readonly NODE_ROOT="$HOME/.nvm/versions/node/v$NODE_VERSION"
readonly NODE_BIN="$NODE_ROOT/bin/node"
readonly NPM_BIN="$NODE_ROOT/bin/npm"

fail() {
	printf 'deploy-vscode-18080: %s\n' "$1" >&2
	exit 1
}

log() {
	printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$1"
}

require_command() {
	command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

health_status() {
	curl --insecure --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 2 "$SERVICE_URL" 2>/dev/null || true
}

listener_addresses() {
	ss -H -ltn "sport = :$SERVICE_PORT" 2>/dev/null | awk '{ print $4 }'
}

is_port_listening() {
	[[ -n "$(listener_addresses)" ]]
}

has_public_listener() {
	listener_addresses | grep -Fxq "0.0.0.0:$SERVICE_PORT"
}

print_log_tail() {
	if [[ -f "$SERVICE_LOG" ]]; then
		printf '\nLast 80 lines from %s:\n' "$SERVICE_LOG" >&2
		tail -n 80 -- "$SERVICE_LOG" >&2
	fi
}

require_source_tree() {
	local required_path
	local -a required_paths=(
		"$NODE_BIN"
		"$NPM_BIN"
		"$SOURCE_ROOT/node_modules/.bin/tsc"
		"$SOURCE_ROOT/build/node_modules"
		"$SOURCE_ROOT/extensions/node_modules/esbuild"
		"$SOURCE_ROOT/extensions/markdown-language-features/node_modules/@vscode/markdown-editor"
		"$SOURCE_ROOT/extensions/vibe-vscode/esbuild.browser.mts"
	)

	for required_path in "${required_paths[@]}"; do
		[[ -e "$required_path" ]] || fail "missing build dependency: $required_path"
	done
}

resolve_workspace_path() {
	local preferred_path="$SERVICE_STATE_ROOT/vibe-vscode.code-workspace"
	local candidate
	local -a candidates=()

	if [[ -f "$preferred_path" ]]; then
		printf '%s\n' "$preferred_path"
		return
	fi

	while IFS= read -r -d '' candidate; do
		candidates+=("$candidate")
	done < <(find "$SERVICE_STATE_ROOT" -maxdepth 1 -type f -name '*.code-workspace' -print0)

	[[ "${#candidates[@]}" -eq 1 ]] || fail "expected exactly one persistent workspace file in $SERVICE_STATE_ROOT"
	printf '%s\n' "${candidates[0]}"
}

require_service_state() {
	[[ -d "$SERVICE_STATE_ROOT" ]] || fail "service state directory is missing: $SERVICE_STATE_ROOT"
	[[ -r "$TLS_KEY_PATH" ]] || fail "HTTPS private key is not readable: $TLS_KEY_PATH"
	[[ -r "$TLS_CERT_PATH" ]] || fail "HTTPS certificate is not readable: $TLS_CERT_PATH"
	resolve_workspace_path >/dev/null
}

stop_service() {
	local deadline=$((SECONDS + 10))

	if ! tmux has-session -t "$SERVICE_SESSION" 2>/dev/null; then
		is_port_listening && fail "port $SERVICE_PORT is owned by an unrecognized process"
		return
	fi

	printf 'Stopping existing Vibe VS Code service on port %s...\n' "$SERVICE_PORT"
	tmux kill-session -t "$SERVICE_SESSION"
	while is_port_listening; do
		(( SECONDS < deadline )) || fail "service port remained active after stopping tmux session: $SERVICE_PORT"
		sleep 0.1
	done
}

build_current() {
	mkdir -p -- "$(dirname -- "$SERVICE_LOG")"
	: > "$SERVICE_LOG"
	{
		log 'Vibe VS Code development build started.'
		cd -- "$SOURCE_ROOT"
		export PATH="$NODE_ROOT/bin:$PATH"
		"$NPM_BIN" run compile-client
		"$NPM_BIN" run compile-web
		"$NPM_BIN" run compile-vibe-vscode
		[[ -f "$SOURCE_ROOT/out/server-main.js" ]] || fail 'compile completed without out/server-main.js'
		[[ -f "$SOURCE_ROOT/extensions/vibe-vscode/dist/browser/extension.js" ]] || fail 'vibe-vscode browser extension bundle is missing'
		log 'Compilation completed.'
	} 2>&1 | tee -a "$SERVICE_LOG"
}

run_server() {
	local workspace_path="$1"

	mkdir -p -- "$SERVICE_STATE_ROOT/server" "$(dirname -- "$SERVICE_LOG")"
	exec >> "$SERVICE_LOG" 2>&1
	log "Starting HTTPS Vibe VS Code development service on 0.0.0.0:$SERVICE_PORT."
	cd -- "$SOURCE_ROOT"
	exec env NODE_ENV=development VSCODE_DEV=1 \
		"$NODE_BIN" out/server-main.js \
		--host 0.0.0.0 \
		--port "$SERVICE_PORT" \
		--tls-key-path "$TLS_KEY_PATH" \
		--tls-cert-path "$TLS_CERT_PATH" \
		--without-connection-token \
		--server-data-dir "$SERVICE_STATE_ROOT/server" \
		--default-workspace "$workspace_path" \
		--disable-telemetry \
		--disable-experiments \
		--accept-server-license-terms
}

start_service() {
	local workspace_path="$1"
	local tmux_command

	printf -v tmux_command 'exec %q %q %q' "$SCRIPT_PATH" --internal-run "$workspace_path"
	tmux new-session -d -s "$SERVICE_SESSION" -c "$SOURCE_ROOT" "$tmux_command"
}

wait_until_ready() {
	local deadline=$((SECONDS + DEPLOY_TIMEOUT_SECONDS))

	while (( SECONDS < deadline )); do
		if [[ "$(health_status)" == '200' ]]; then
			if ! has_public_listener; then
				printf 'Observed listener addresses:\n%s\n' "$(listener_addresses)" >&2
				print_log_tail
				fail "service is healthy on localhost but is not listening on 0.0.0.0:$SERVICE_PORT"
			fi
			printf 'Vibe VS Code deployment is ready: %s (0.0.0.0:%s)\n' "$SERVICE_URL" "$SERVICE_PORT"
			return
		fi

		if ! tmux has-session -t "$SERVICE_SESSION" 2>/dev/null; then
			print_log_tail
			fail "service session exited before port $SERVICE_PORT became healthy"
		fi

		sleep 2
	done

	print_log_tail
	fail "timed out after ${DEPLOY_TIMEOUT_SECONDS}s waiting for $SERVICE_URL"
}

case "${1:-}" in
	--internal-run)
		[[ "$#" -eq 2 ]] || fail 'invalid internal service arguments'
		run_server "$2"
		;;
	'')
		[[ "$#" -eq 0 ]] || fail 'usage: deploy-18080.sh'
		;;
	*)
		fail 'usage: deploy-18080.sh'
		;;
esac

[[ "$DEPLOY_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail 'VIBE_VSCODE_DEPLOY_TIMEOUT_SECONDS must be a positive integer'
require_command awk
require_command curl
require_command find
require_command grep
require_command ss
require_command tee
require_command tmux
require_source_tree
require_service_state

stop_service
printf 'Building and deploying from %s...\n' "$SOURCE_ROOT"
build_current
start_service "$(resolve_workspace_path)"
wait_until_ready
