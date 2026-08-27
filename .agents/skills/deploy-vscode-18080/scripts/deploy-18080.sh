#!/usr/bin/env bash

set -euo pipefail

readonly SOURCE_ROOT=/mnt/ceph/vibe-vscode
readonly SERVICE_SESSION=vibe_vscode_latest
readonly SERVICE_PORT=18080
readonly SERVICE_URL="https://127.0.0.1:${SERVICE_PORT}/"
readonly SERVICE_STATE_ROOT=/mnt/ceph/dever_for_dev/.dever/vscode-services/state/latest
readonly SERVICE_LOG=/mnt/ceph/dever_for_dev/.dever/vscode-services/logs/latest.log
readonly SERVICE_RUNTIME_ROOT="$SOURCE_ROOT/.build/vibe-vscode-18080"
readonly SERVICE_RELEASES_ROOT="$SERVICE_RUNTIME_ROOT/releases"
readonly SERVICE_CURRENT_LINK="$SERVICE_RUNTIME_ROOT/last-known-good"
readonly SERVICE_PREVIOUS_LINK="$SERVICE_RUNTIME_ROOT/previous"
readonly TLS_KEY_PATH=/mnt/ceph/dever_for_dev/.dever/https/localhost-key.pem
readonly TLS_CERT_PATH=/mnt/ceph/dever_for_dev/.dever/https/localhost-cert.pem
readonly DEPLOY_TIMEOUT_SECONDS="${VIBE_VSCODE_DEPLOY_TIMEOUT_SECONDS:-900}"
readonly SCRIPT_PATH="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/$(basename -- "${BASH_SOURCE[0]}")"
readonly NODE_VERSION="$(tr -d '[:space:]' < "$SOURCE_ROOT/.nvmrc")"
readonly NODE_ROOT="$HOME/.nvm/versions/node/v$NODE_VERSION"
readonly NODE_BIN="$NODE_ROOT/bin/node"
readonly NPM_BIN="$NODE_ROOT/bin/npm"

ACTIVE_RUNTIME_ROOT=
STAGING_RUNTIME_ROOT=

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

cleanup_staging_runtime() {
	case "$STAGING_RUNTIME_ROOT" in
		"$SERVICE_RUNTIME_ROOT"/.staging-*) rm -rf -- "$STAGING_RUNTIME_ROOT" ;;
	esac
}

trap cleanup_staging_runtime EXIT

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

validate_runtime_root() {
	local runtime_root="$1"
	local required_path
	local -a required_paths=(
		"$runtime_root/package.json"
		"$runtime_root/product.json"
		"$runtime_root/node_modules"
		"$runtime_root/remote/node_modules"
		"$runtime_root/out/server-main.js"
		"$runtime_root/out/vs/code/browser/workbench/workbench-dev.html"
		"$runtime_root/extensions/vibe-vscode/package.json"
		"$runtime_root/extensions/vibe-vscode/dist/browser/extension.js"
	)

	for required_path in "${required_paths[@]}"; do
		[[ -e "$required_path" ]] || return 1
	done
}

resolve_runtime_link() {
	local link_path="$1"
	local runtime_root

	[[ -L "$link_path" ]] || return 1
	runtime_root="$(readlink -f -- "$link_path")"
	validate_runtime_root "$runtime_root" || return 1
	printf '%s\n' "$runtime_root"
}

set_runtime_link() {
	local link_path="$1"
	local runtime_root="$2"
	local temporary_link="${link_path}.tmp.$$"

	mkdir -p -- "$SERVICE_RUNTIME_ROOT"
	ln -s -- "$runtime_root" "$temporary_link"
	mv -Tf -- "$temporary_link" "$link_path"
}

create_runtime_snapshot() {
	local result_variable="$1"
	local release_id
	local release_root
	local node_modules_path
	local relative_path
	local root_file

	release_id="$(date -u +'%Y%m%dT%H%M%SZ')-$RANDOM-$$"
	release_root="$SERVICE_RELEASES_ROOT/$release_id"
	STAGING_RUNTIME_ROOT="$SERVICE_RUNTIME_ROOT/.staging-$release_id"

	mkdir -p -- "$SERVICE_RELEASES_ROOT" "$STAGING_RUNTIME_ROOT/remote"
	rsync --archive "$SOURCE_ROOT/out/" "$STAGING_RUNTIME_ROOT/out/"
	rsync --archive --exclude='node_modules/' "$SOURCE_ROOT/extensions/" "$STAGING_RUNTIME_ROOT/extensions/"

	for root_file in package.json product.json product.overrides.json; do
		if [[ -f "$SOURCE_ROOT/$root_file" ]]; then
			cp -a -- "$SOURCE_ROOT/$root_file" "$STAGING_RUNTIME_ROOT/$root_file"
		fi
	done
	cp -a -- "$SOURCE_ROOT/remote/package.json" "$STAGING_RUNTIME_ROOT/remote/package.json"
	ln -s -- "$SOURCE_ROOT/node_modules" "$STAGING_RUNTIME_ROOT/node_modules"
	ln -s -- "$SOURCE_ROOT/remote/node_modules" "$STAGING_RUNTIME_ROOT/remote/node_modules"

	while IFS= read -r -d '' node_modules_path; do
		relative_path="${node_modules_path#"$SOURCE_ROOT"/}"
		mkdir -p -- "$(dirname -- "$STAGING_RUNTIME_ROOT/$relative_path")"
		ln -s -- "$node_modules_path" "$STAGING_RUNTIME_ROOT/$relative_path"
	done < <(find "$SOURCE_ROOT/extensions" -name node_modules -prune -print0)

	validate_runtime_root "$STAGING_RUNTIME_ROOT" || fail "staged runtime is incomplete: $STAGING_RUNTIME_ROOT"
	mv -- "$STAGING_RUNTIME_ROOT" "$release_root"
	STAGING_RUNTIME_ROOT=
	printf -v "$result_variable" '%s' "$release_root"
}

service_runtime_root() {
	local runtime_root

	runtime_root="$(tmux display-message -p -t "$SERVICE_SESSION" '#{pane_current_path}')"
	realpath -e -- "$runtime_root"
}

stop_service() {
	local deadline=$((SECONDS + 10))

	if ! tmux has-session -t "$SERVICE_SESSION" 2>/dev/null; then
		is_port_listening && fail "port $SERVICE_PORT is owned by an unrecognized process"
		return 0
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
	local runtime_root="$1"
	local workspace_path="$2"

	mkdir -p -- "$SERVICE_STATE_ROOT/server" "$(dirname -- "$SERVICE_LOG")"
	exec >> "$SERVICE_LOG" 2>&1
	log "Starting HTTPS Vibe VS Code development service from $runtime_root on 0.0.0.0:$SERVICE_PORT."
	cd -- "$runtime_root"
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
	local runtime_root="$1"
	local workspace_path="$2"
	local tmux_command

	validate_runtime_root "$runtime_root" || return 1
	printf -v tmux_command 'exec %q %q %q %q' "$SCRIPT_PATH" --internal-run "$runtime_root" "$workspace_path"
	tmux new-session -d -s "$SERVICE_SESSION" -c "$runtime_root" "$tmux_command"
}

wait_until_ready() {
	local runtime_label="$1"
	local deadline=$((SECONDS + DEPLOY_TIMEOUT_SECONDS))

	while (( SECONDS < deadline )); do
		if [[ "$(health_status)" == '200' ]]; then
			if ! has_public_listener; then
				printf 'Observed listener addresses:\n%s\n' "$(listener_addresses)" >&2
				printf 'Service is healthy on localhost but is not listening on 0.0.0.0:%s.\n' "$SERVICE_PORT" >&2
				return 1
			fi
			printf 'Vibe VS Code runtime is ready: %s (%s, 0.0.0.0:%s)\n' "$runtime_label" "$SERVICE_URL" "$SERVICE_PORT"
			return 0
		fi

		if ! tmux has-session -t "$SERVICE_SESSION" 2>/dev/null; then
			printf 'Service session exited before %s became healthy.\n' "$runtime_label" >&2
			return 1
		fi

		sleep 2
	done

	printf 'Timed out after %s seconds waiting for %s.\n' "$DEPLOY_TIMEOUT_SECONDS" "$runtime_label" >&2
	return 1
}

prepare_active_runtime() {
	local workspace_path="$1"
	local running_runtime
	local bootstrap_runtime

	if ! tmux has-session -t "$SERVICE_SESSION" 2>/dev/null; then
		is_port_listening && fail "port $SERVICE_PORT is owned by an unrecognized process"
		ACTIVE_RUNTIME_ROOT="$(resolve_runtime_link "$SERVICE_CURRENT_LINK" || true)"
		return 0
	fi

	running_runtime="$(service_runtime_root)"
	validate_runtime_root "$running_runtime" || fail "running service uses an incomplete runtime: $running_runtime"

	if [[ "$(health_status)" != '200' ]] || ! has_public_listener; then
		ACTIVE_RUNTIME_ROOT="$(resolve_runtime_link "$SERVICE_CURRENT_LINK" || true)"
		return 0
	fi

	if [[ "$running_runtime" != "$SOURCE_ROOT" ]]; then
		ACTIVE_RUNTIME_ROOT="$running_runtime"
		set_runtime_link "$SERVICE_CURRENT_LINK" "$ACTIVE_RUNTIME_ROOT"
		return 0
	fi

	printf 'Migrating the legacy source-tree service to an immutable runtime snapshot...\n'
	create_runtime_snapshot bootstrap_runtime
	stop_service
	if start_service "$bootstrap_runtime" "$workspace_path" && wait_until_ready 'last-known-good bootstrap runtime'; then
		ACTIVE_RUNTIME_ROOT="$bootstrap_runtime"
		set_runtime_link "$SERVICE_CURRENT_LINK" "$ACTIVE_RUNTIME_ROOT"
		return 0
	fi

	print_log_tail
	stop_service
	if start_service "$SOURCE_ROOT" "$workspace_path" && wait_until_ready 'restored legacy source runtime'; then
		fail 'could not activate the immutable bootstrap runtime; restored the legacy source service'
	fi
	print_log_tail
	fail 'could not activate the immutable bootstrap runtime or restore the legacy source service'
}

promote_runtime() {
	local candidate_runtime="$1"
	local previous_runtime="$2"
	local release_root

	if [[ -n "$previous_runtime" && "$previous_runtime" == "$SERVICE_RELEASES_ROOT/"* && "$previous_runtime" != "$candidate_runtime" ]]; then
		set_runtime_link "$SERVICE_PREVIOUS_LINK" "$previous_runtime"
	fi
	set_runtime_link "$SERVICE_CURRENT_LINK" "$candidate_runtime"

	for release_root in "$SERVICE_RELEASES_ROOT"/*; do
		[[ -d "$release_root" ]] || continue
		if [[ "$release_root" != "$candidate_runtime" && "$release_root" != "$previous_runtime" ]]; then
			rm -rf -- "$release_root"
		fi
	done
}

activate_candidate_runtime() {
	local candidate_runtime="$1"
	local workspace_path="$2"

	stop_service
	if start_service "$candidate_runtime" "$workspace_path" && wait_until_ready 'candidate runtime'; then
		promote_runtime "$candidate_runtime" "$ACTIVE_RUNTIME_ROOT"
		printf 'Vibe VS Code deployment is ready: %s (0.0.0.0:%s)\n' "$SERVICE_URL" "$SERVICE_PORT"
		return 0
	fi

	print_log_tail
	printf 'Candidate runtime failed; restoring last-known-good runtime...\n' >&2
	stop_service
	if [[ -n "$ACTIVE_RUNTIME_ROOT" ]] && start_service "$ACTIVE_RUNTIME_ROOT" "$workspace_path" && wait_until_ready 'restored last-known-good runtime'; then
		fail 'candidate runtime failed health checks; restored last-known-good runtime'
	fi

	print_log_tail
	fail 'candidate runtime failed and last-known-good runtime could not be restored'
}

case "${1:-}" in
	--internal-run)
		[[ "$#" -eq 3 ]] || fail 'invalid internal service arguments'
		run_server "$2" "$3"
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
require_command cp
require_command curl
require_command find
require_command grep
require_command ln
require_command mv
require_command readlink
require_command realpath
require_command rm
require_command rsync
require_command ss
require_command tee
require_command tmux
require_source_tree
require_service_state

readonly workspace_path="$(resolve_workspace_path)"
prepare_active_runtime "$workspace_path"
printf 'Building and deploying from %s...\n' "$SOURCE_ROOT"
build_current
candidate_runtime=
create_runtime_snapshot candidate_runtime
activate_candidate_runtime "$candidate_runtime" "$workspace_path"
