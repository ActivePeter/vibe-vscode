#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SOURCE_ROOT="$(cd -- "$SCRIPT_DIRECTORY/../../../.." && pwd -P)"
readonly SERVICE_SESSION=vibe_vscode_latest
readonly SERVICE_PORT=18080
readonly SERVICE_URL="https://127.0.0.1:${SERVICE_PORT}/"
readonly SERVICE_SOCKET_ROOT="${VIBE_VSCODE_SOCKET_ROOT:-${XDG_RUNTIME_DIR:-/tmp}/vibe-vscode-18080}"
readonly SERVICE_BACKEND_SOCKET="$SERVICE_SOCKET_ROOT/backend.sock"
readonly SERVICE_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}/vibe-vscode"
readonly SERVICE_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/vibe-vscode"
readonly SERVICE_STATE_ROOT="${VIBE_VSCODE_SERVICE_STATE_ROOT:-$SERVICE_STATE_HOME/services/${SERVICE_PORT}}"
readonly SERVICE_LOG="${VIBE_VSCODE_SERVICE_LOG:-$SERVICE_STATE_HOME/logs/${SERVICE_PORT}.log}"
readonly SERVICE_RUNTIME_ROOT="$SOURCE_ROOT/.build/vibe-vscode-18080"
readonly SERVICE_RELEASES_ROOT="$SERVICE_RUNTIME_ROOT/releases"
readonly SERVICE_CURRENT_LINK="$SERVICE_RUNTIME_ROOT/last-known-good"
readonly SERVICE_PREVIOUS_LINK="$SERVICE_RUNTIME_ROOT/previous"
readonly SERVICE_DEPLOY_LOCK="$SERVICE_RUNTIME_ROOT/deploy.lock"
readonly TLS_KEY_PATH="${VIBE_VSCODE_TLS_KEY_PATH:-$SERVICE_CONFIG_HOME/tls/localhost-key.pem}"
readonly TLS_CERT_PATH="${VIBE_VSCODE_TLS_CERT_PATH:-$SERVICE_CONFIG_HOME/tls/localhost-cert.pem}"
readonly CADDY_VERSION=2.11.4
readonly CADDY_CACHE_ROOT="$SERVICE_RUNTIME_ROOT/tools/caddy/$CADDY_VERSION"
readonly CADDY_BINARY="$CADDY_CACHE_ROOT/caddy"
readonly CADDY_CONFIG_RELATIVE_PATH=resources/server/vibe-vscode/Caddyfile
readonly DEPLOY_TIMEOUT_SECONDS="${VIBE_VSCODE_DEPLOY_TIMEOUT_SECONDS:-900}"
readonly DEFAULT_DEPLOY_MODE="${VIBE_VSCODE_DEPLOY_MODE:-latest}"
readonly SCRIPT_PATH="$SCRIPT_DIRECTORY/$(basename -- "${BASH_SOURCE[0]}")"
readonly NODE_VERSION="$(tr -d '[:space:]' < "$SOURCE_ROOT/.nvmrc")"
readonly NODE_ROOT="$HOME/.nvm/versions/node/v$NODE_VERSION"
readonly NODE_BIN="$NODE_ROOT/bin/node"
readonly NPM_BIN="$NODE_ROOT/bin/npm"

ACTIVE_RUNTIME_ROOT=
ACTIVE_RUNTIME_ALLOW_LEGACY_LINKS=false
STAGING_RUNTIME_ROOT=
DEPLOY_LOCK_FD=

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

print_usage() {
	cat <<'EOF'
Usage: deploy-18080.sh [--mode latest|snapshot] [--update-snapshot]

  --mode latest       Build and promote the current source before restart (default).
  --mode snapshot     Restart the selected immutable release without rebuilding.
  --update-snapshot   Build and promote a new release in snapshot mode.
EOF
}

resolve_deploy_action() {
	local mode="$1"
	local update_snapshot="$2"

	case "$mode" in
	latest)
		printf 'update\n'
		;;
	snapshot)
		if [[ "$update_snapshot" == true ]]; then
			printf 'update\n'
		else
			printf 'restart\n'
		fi
		;;
	*)
		fail "invalid deployment mode: $mode (expected latest or snapshot)"
		;;
	esac
}

acquire_deployment_lock() {
	local lock_path="${1:-$SERVICE_DEPLOY_LOCK}"

	mkdir -p -- "$(dirname -- "$lock_path")"
	exec {DEPLOY_LOCK_FD}>"$lock_path"
	if ! flock --nonblock "$DEPLOY_LOCK_FD"; then
		printf 'deploy-vscode-18080: another deployment holds %s\n' "$lock_path" >&2
		return 75
	fi
}

ensure_caddy_binary() {
	local architecture
	local archive_name
	local archive_path
	local archive_sha512
	local binary_sha256
	local download_url
	local temporary_archive
	local temporary_directory

	architecture="$(uname -m)"
	case "$architecture" in
	x86_64)
		architecture=amd64
		archive_sha512=8220d1f013b6f27510247b2360c9e0ca9f018feebd82515f07635318b34ff9777ccc8fd0b6e6f2486ce3a33fe389fbb7db12d05baa474f4587509fb4f5ebf1c9
		binary_sha256=b7105518e3ed1c0761f232e44fc09345535533c9cb0abf0e12809416c7ac64d9
		;;
	aarch64 | arm64)
		architecture=arm64
		archive_sha512=d5a7c423853c24a799765e0e8210d5c7c22a8f56ed37a3cae2fb9f58be138853c02b4efd6b59d576e6d8c7c0d30b9c1592deeaa6a536ff69bcca23b8c1ea709c
		binary_sha256=e1f904038fc11ca897ac5a12fdacfb2a7add02a8720c426d562a37f6fdad2afe
		;;
	*)
		fail "unsupported Caddy architecture: $architecture"
		;;
	esac

	if [[ -x "$CADDY_BINARY" ]] && printf '%s  %s\n' "$binary_sha256" "$CADDY_BINARY" | sha256sum --check --status; then
		return
	fi

	mkdir -p -- "$CADDY_CACHE_ROOT"
	archive_name="caddy_${CADDY_VERSION}_linux_${architecture}.tar.gz"
	archive_path="$CADDY_CACHE_ROOT/$archive_name"
	download_url="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/${archive_name}"
	if [[ ! -f "$archive_path" ]] || ! printf '%s  %s\n' "$archive_sha512" "$archive_path" | sha512sum --check --status; then
		temporary_archive="${archive_path}.tmp.$$"
		rm -f -- "$temporary_archive"
		curl --fail --location --retry 3 --show-error --silent --output "$temporary_archive" "$download_url"
		printf '%s  %s\n' "$archive_sha512" "$temporary_archive" | sha512sum --check --status || fail "Caddy archive checksum mismatch: $download_url"
		mv -f -- "$temporary_archive" "$archive_path"
	fi

	temporary_directory="$CADDY_CACHE_ROOT/.extract.$$"
	rm -rf -- "$temporary_directory"
	mkdir -p -- "$temporary_directory"
	tar --extract --gzip --file "$archive_path" --directory "$temporary_directory" caddy
	chmod 0755 "$temporary_directory/caddy"
	printf '%s  %s\n' "$binary_sha256" "$temporary_directory/caddy" | sha256sum --check --status || fail "Caddy binary checksum mismatch: $archive_path"
	mv -f -- "$temporary_directory/caddy" "$CADDY_BINARY"
	rm -rf -- "$temporary_directory"
}

health_status() {
	curl --insecure --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 2 "$SERVICE_URL" 2>/dev/null || true
}

backend_health_status() {
	[[ -S "$SERVICE_BACKEND_SOCKET" ]] || return 0
	curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 2 --unix-socket "$SERVICE_BACKEND_SOCKET" http://localhost/ 2>/dev/null || true
}

is_backend_socket_listening() {
	ss -H -xl | awk '$1 == "u_str" && $2 == "LISTEN" { print $5 }' | grep -Fxq "$SERVICE_BACKEND_SOCKET"
}

listener_addresses() {
	ss -H -ltn "sport = :$SERVICE_PORT" 2>/dev/null | awk '{ print $4 }'
}

is_port_listening() {
	[[ -n "$(listener_addresses)" ]]
}

has_public_listener() {
	listener_addresses | grep -Eq "^(0\\.0\\.0\\.0|\\*|\\[::\\]):$SERVICE_PORT$"
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

require_source_tree() {
	local required_path
	local -a required_paths=(
		"$NODE_BIN"
		"$NPM_BIN"
		"$CADDY_BINARY"
		"$SOURCE_ROOT/node_modules/.bin/tsc"
		"$SOURCE_ROOT/build/node_modules"
		"$SOURCE_ROOT/extensions/node_modules/esbuild"
		"$SOURCE_ROOT/extensions/markdown-language-features/node_modules/@vscode/markdown-editor"
		"$SOURCE_ROOT/extensions/vibe-vscode/esbuild.browser.mts"
		"$SOURCE_ROOT/$CADDY_CONFIG_RELATIVE_PATH"
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
	done < <(find -H "$SERVICE_STATE_ROOT" -maxdepth 1 -type f -name '*.code-workspace' -print0)

	[[ "${#candidates[@]}" -eq 1 ]] || fail "expected exactly one persistent workspace file in $SERVICE_STATE_ROOT"
	printf '%s\n' "${candidates[0]}"
}

require_service_state() {
	[[ -d "$SERVICE_STATE_ROOT" ]] || fail "service state directory is missing: $SERVICE_STATE_ROOT"
	[[ -r "$TLS_KEY_PATH" ]] || fail "HTTPS private key is not readable: $TLS_KEY_PATH"
	[[ -r "$TLS_CERT_PATH" ]] || fail "HTTPS certificate is not readable: $TLS_CERT_PATH"
	mkdir -p -- "$SERVICE_SOCKET_ROOT"
	chmod 0700 "$SERVICE_SOCKET_ROOT"
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

validate_caddy_runtime_root() {
	local runtime_root="$1"
	local required_path
	local -a executable_paths=(
		"$runtime_root/node"
		"$runtime_root/caddy"
		"$runtime_root/resources/server/bin-dev/helpers/browser.sh"
		"$runtime_root/resources/server/bin-dev/remote-cli/code.sh"
	)

	validate_runtime_root "$runtime_root" || return 1
	[[ -f "$runtime_root/$CADDY_CONFIG_RELATIVE_PATH" ]] || return 1
	for required_path in "${executable_paths[@]}"; do
		[[ -x "$required_path" ]] || return 1
	done
	VIBE_VSCODE_PUBLIC_PORT="$SERVICE_PORT" \
		VIBE_VSCODE_TLS_CERT_PATH="$TLS_CERT_PATH" \
		VIBE_VSCODE_TLS_KEY_PATH="$TLS_KEY_PATH" \
		VIBE_VSCODE_BACKEND_ADDRESS="unix/$SERVICE_BACKEND_SOCKET" \
		"$runtime_root/caddy" validate --config "$runtime_root/$CADDY_CONFIG_RELATIVE_PATH" --adapter caddyfile >/dev/null || return 1
}

validate_candidate_runtime_root() {
	local runtime_root="$1"

	validate_caddy_runtime_root "$runtime_root" || return 1
	validate_runtime_links "$runtime_root"
}

validate_runtime_links() {
	local runtime_root="$1"
	local link_path
	local resolved_link

	# A release is immutable only when every symbolic link resolves inside that same release.
	# Links to source, another release, or any unrelated host path make rollback depend on mutable
	# state outside the selected snapshot.
	while IFS= read -r -d '' link_path; do
		resolved_link="$(realpath -e -- "$link_path" 2>/dev/null || true)"
		case "$resolved_link" in
		"$runtime_root" | "$runtime_root"/*) ;;
		*)
			printf 'Runtime link escapes immutable release: %s -> %s\n' "$link_path" "${resolved_link:-<unresolved>}" >&2
			return 1
			;;
		esac
	done < <(find "$runtime_root" -type l -print0)
}

remove_unresolved_package_bin_links() {
	local runtime_root="$1"
	local link_path

	# Package-manager .bin directories can contain links to intentionally omitted build tools.
	# Only those known build-tool shims may be omitted. Any other unresolved runtime link must
	# survive this cleanup so validation rejects the incomplete candidate.
	while IFS= read -r -d '' link_path; do
		if ! realpath -e -- "$link_path" >/dev/null 2>&1; then
			rm -f -- "$link_path"
		fi
	done < <(find "$runtime_root" -type l -path '*/node_modules/.bin/*' -print0)
}

resolve_runtime_link() {
	local link_path="$1"
	local runtime_root

	[[ -L "$link_path" ]] || return 1
	runtime_root="$(readlink -f -- "$link_path")"
	validate_candidate_runtime_root "$runtime_root" || return 1
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

copy_runtime_tree() {
	local source_path="$1"
	local target_path="$2"
	local previous_path="${3:-}"
	local resolved_previous_path=
	local -a rsync_arguments=(--archive)

	# Reuse immutable files from the active release when possible. The first migration from a
	# source-linked runtime performs a real copy; later releases hard-link unchanged files only
	# to another versioned runtime, never to the canonical checkout.
	if [[ -n "$previous_path" && -d "$previous_path" && ! -L "$previous_path" ]]; then
		resolved_previous_path="$(realpath -e -- "$previous_path")"
	fi
	case "$resolved_previous_path" in
	'' | "$SOURCE_ROOT" | "$SOURCE_ROOT"/*) ;;
	*) rsync_arguments+=(--link-dest="$resolved_previous_path") ;;
	esac
	mkdir -p -- "$target_path"
	rsync "${rsync_arguments[@]}" "$source_path/" "$target_path/"
}

create_runtime_snapshot() {
	local result_variable="$1"
	local release_id
	local release_root
	local node_modules_path
	local previous_path
	local relative_path
	local root_file

	release_id="$(date -u +'%Y%m%dT%H%M%SZ')-$RANDOM-$$"
	release_root="$SERVICE_RELEASES_ROOT/$release_id"
	STAGING_RUNTIME_ROOT="$SERVICE_RUNTIME_ROOT/.staging-$release_id"

	mkdir -p -- "$SERVICE_RELEASES_ROOT" "$STAGING_RUNTIME_ROOT/remote"
	rsync --archive "$SOURCE_ROOT/out/" "$STAGING_RUNTIME_ROOT/out/"
	rsync --archive --exclude='node_modules/' "$SOURCE_ROOT/extensions/" "$STAGING_RUNTIME_ROOT/extensions/"
	mkdir -p -- "$STAGING_RUNTIME_ROOT/resources"
	rsync --archive "$SOURCE_ROOT/resources/server/" "$STAGING_RUNTIME_ROOT/resources/server/"

	for root_file in package.json product.json product.overrides.json; do
		if [[ -f "$SOURCE_ROOT/$root_file" ]]; then
			cp -a -- "$SOURCE_ROOT/$root_file" "$STAGING_RUNTIME_ROOT/$root_file"
		fi
	done
	cp -a -- "$NODE_BIN" "$STAGING_RUNTIME_ROOT/node"
	cp -a -- "$CADDY_BINARY" "$STAGING_RUNTIME_ROOT/caddy"
	cp -a -- "$SOURCE_ROOT/remote/package.json" "$STAGING_RUNTIME_ROOT/remote/package.json"
	previous_path=
	if [[ -n "$ACTIVE_RUNTIME_ROOT" ]]; then
		previous_path="$ACTIVE_RUNTIME_ROOT/node_modules"
	fi
	copy_runtime_tree "$SOURCE_ROOT/node_modules" "$STAGING_RUNTIME_ROOT/node_modules" "$previous_path"
	previous_path=
	if [[ -n "$ACTIVE_RUNTIME_ROOT" ]]; then
		previous_path="$ACTIVE_RUNTIME_ROOT/remote/node_modules"
	fi
	copy_runtime_tree "$SOURCE_ROOT/remote/node_modules" "$STAGING_RUNTIME_ROOT/remote/node_modules" "$previous_path"

	while IFS= read -r -d '' node_modules_path; do
		relative_path="${node_modules_path#"$SOURCE_ROOT"/}"
		previous_path=
		if [[ -n "$ACTIVE_RUNTIME_ROOT" ]]; then
			previous_path="$ACTIVE_RUNTIME_ROOT/$relative_path"
		fi
		copy_runtime_tree "$node_modules_path" "$STAGING_RUNTIME_ROOT/$relative_path" "$previous_path"
	done < <(find "$SOURCE_ROOT/extensions" -name node_modules -prune -print0)

	remove_unresolved_package_bin_links "$STAGING_RUNTIME_ROOT"
	validate_candidate_runtime_root "$STAGING_RUNTIME_ROOT" || fail "staged runtime is incomplete or depends on state outside its immutable release: $STAGING_RUNTIME_ROOT"
	mv -- "$STAGING_RUNTIME_ROOT" "$release_root"
	STAGING_RUNTIME_ROOT=
	printf -v "$result_variable" '%s' "$release_root"
}

service_runtime_root() {
	local runtime_root

	runtime_root="$(tmux display-message -p -t "$SERVICE_SESSION" '#{pane_current_path}')"
	realpath -e -- "$runtime_root"
}

is_recognized_service_session() {
	local start_command

	start_command="$(tmux display-message -p -t "$SERVICE_SESSION" '#{pane_start_command}' 2>/dev/null || true)"
	[[ "$start_command" == *"$SCRIPT_PATH"*'--internal-run'* ]]
}

stop_service() {
	local deadline=$((SECONDS + 10))
	local running_runtime_root

	if ! tmux has-session -t "$SERVICE_SESSION" 2>/dev/null; then
		is_port_listening && fail "port $SERVICE_PORT is owned by an unrecognized process"
		is_backend_socket_listening && fail "backend socket is owned by an unrecognized process: $SERVICE_BACKEND_SOCKET"
		rm -f -- "$SERVICE_BACKEND_SOCKET"
		return 0
	fi
	is_recognized_service_session || fail "tmux session $SERVICE_SESSION is not owned by this deployment entry point"
	running_runtime_root="$(service_runtime_root)"
	validate_runtime_root "$running_runtime_root" || fail "tmux session $SERVICE_SESSION uses an incomplete runtime: $running_runtime_root"

	printf 'Stopping existing Vibe VS Code service on port %s...\n' "$SERVICE_PORT"
	tmux kill-session -t "$SERVICE_SESSION"
	while is_port_listening || is_backend_socket_listening; do
		(( SECONDS < deadline )) || fail "service endpoint remained active after stopping tmux session: $SERVICE_PORT"
		sleep 0.1
	done
	rm -f -- "$SERVICE_BACKEND_SOCKET"
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

run_gateway_stack() {
	local runtime_root="$1"
	local workspace_path="$2"
	local runtime_node="$runtime_root/node"
	local backend_pid=
	local exited_component
	local gateway_pid=
	local pid

	cleanup_stack() {
		trap - EXIT HUP INT TERM
		for pid in "$gateway_pid" "$backend_pid"; do
			[[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null || true
		done
		for pid in "$gateway_pid" "$backend_pid"; do
			[[ -n "$pid" ]] && wait "$pid" 2>/dev/null || true
		done
		rm -f -- "$SERVICE_BACKEND_SOCKET"
	}

	mkdir -p -- "$SERVICE_STATE_ROOT/server" "$SERVICE_SOCKET_ROOT" "$(dirname -- "$SERVICE_LOG")"
	chmod 0700 "$SERVICE_SOCKET_ROOT"
	is_backend_socket_listening && fail "backend socket is already owned by another process: $SERVICE_BACKEND_SOCKET"
	rm -f -- "$SERVICE_BACKEND_SOCKET"
	exec >> "$SERVICE_LOG" 2>&1
	log "Starting Caddy HTTPS gateway on 0.0.0.0:$SERVICE_PORT with a private VS Code Unix-socket backend from $runtime_root."
	cd -- "$runtime_root"
	trap cleanup_stack EXIT
	trap 'cleanup_stack; exit 129' HUP
	trap 'cleanup_stack; exit 130' INT
	trap 'cleanup_stack; exit 143' TERM
	env NODE_ENV=development VSCODE_DEV=1 \
		"$runtime_node" out/server-main.js \
		--socket-path "$SERVICE_BACKEND_SOCKET" \
		--without-connection-token \
		--server-data-dir "$SERVICE_STATE_ROOT/server" \
		--default-workspace "$workspace_path" \
		--disable-telemetry \
		--disable-experiments \
		--accept-server-license-terms &
	backend_pid=$!

	env \
		VIBE_VSCODE_PUBLIC_PORT="$SERVICE_PORT" \
		VIBE_VSCODE_TLS_CERT_PATH="$TLS_CERT_PATH" \
		VIBE_VSCODE_TLS_KEY_PATH="$TLS_KEY_PATH" \
		VIBE_VSCODE_BACKEND_ADDRESS="unix/$SERVICE_BACKEND_SOCKET" \
		"$runtime_root/caddy" run --config "$runtime_root/$CADDY_CONFIG_RELATIVE_PATH" --adapter caddyfile &
	gateway_pid=$!

	set +e
	wait -n "$backend_pid" "$gateway_pid"
	set -e
	if kill -0 "$backend_pid" 2>/dev/null; then
		exited_component='Caddy gateway'
	else
		exited_component='VS Code backend'
	fi
	log "$exited_component exited unexpectedly; stopping the service stack."
	cleanup_stack
	return 1
}

run_service() {
	local runtime_root="$1"
	local workspace_path="$2"
	local allow_legacy_links="${3:-false}"

	if [[ "$allow_legacy_links" == true ]]; then
		validate_caddy_runtime_root "$runtime_root" || fail "legacy rollback runtime cannot start without its pinned Caddy gateway: $runtime_root"
	else
		validate_candidate_runtime_root "$runtime_root" || fail "runtime cannot start without its pinned Caddy gateway: $runtime_root"
	fi
	run_gateway_stack "$runtime_root" "$workspace_path"
}

start_service() {
	local runtime_root="$1"
	local workspace_path="$2"
	local allow_legacy_links="${3:-false}"
	local internal_mode=--internal-run
	local tmux_command

	if [[ "$allow_legacy_links" == true ]]; then
		validate_caddy_runtime_root "$runtime_root" || return 1
		internal_mode=--internal-run-legacy-links
	else
		validate_candidate_runtime_root "$runtime_root" || return 1
	fi
	printf -v tmux_command 'exec env VIBE_VSCODE_SOCKET_ROOT=%q %q %q %q %q' "$SERVICE_SOCKET_ROOT" "$SCRIPT_PATH" "$internal_mode" "$runtime_root" "$workspace_path"
	tmux new-session -d -s "$SERVICE_SESSION" -c "$runtime_root" "$tmux_command"
}

wait_until_ready() {
	local runtime_label="$1"
	local expected_runtime_root="$2"
	local running_runtime_root
	local deadline=$((SECONDS + DEPLOY_TIMEOUT_SECONDS))
	expected_runtime_root="$(realpath -e -- "$expected_runtime_root")"

	while (( SECONDS < deadline )); do
		if ! tmux has-session -t "$SERVICE_SESSION" 2>/dev/null; then
			printf 'Service session exited before %s became healthy.\n' "$runtime_label" >&2
			return 1
		fi
		running_runtime_root="$(service_runtime_root 2>/dev/null || true)"
		if [[ "$running_runtime_root" != "$expected_runtime_root" ]]; then
			printf 'Service session for %s is running from unexpected root: %s\n' "$runtime_label" "${running_runtime_root:-<unavailable>}" >&2
			return 1
		fi

		if [[ "$(health_status)" == '200' ]]; then
			if ! has_public_listener; then
				printf 'Observed listener addresses:\n%s\n' "$(listener_addresses)" >&2
				printf 'Service is healthy on localhost but has no public wildcard listener on port %s.\n' "$SERVICE_PORT" >&2
				return 1
			fi
			if [[ "$(backend_health_status)" != '200' ]]; then
				printf 'Caddy is healthy but the private VS Code backend is not reachable through %s.\n' "$SERVICE_BACKEND_SOCKET" >&2
				return 1
			fi
			printf 'Vibe VS Code runtime is ready: %s (%s, Caddy HTTPS, anonymous access, private Unix-socket backend, 0.0.0.0:%s)\n' "$runtime_label" "$SERVICE_URL" "$SERVICE_PORT"
			return 0
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
		is_backend_socket_listening && fail "backend socket is owned by an unrecognized process: $SERVICE_BACKEND_SOCKET"
		rm -f -- "$SERVICE_BACKEND_SOCKET"
		ACTIVE_RUNTIME_ROOT="$(resolve_runtime_link "$SERVICE_CURRENT_LINK" || true)"
		return 0
	fi
	is_recognized_service_session || fail "tmux session $SERVICE_SESSION is not owned by this deployment entry point"

	running_runtime="$(service_runtime_root)"
	ACTIVE_RUNTIME_ALLOW_LEGACY_LINKS=false
	if [[ "$running_runtime" == "$SOURCE_ROOT" ]]; then
		validate_runtime_root "$running_runtime" || fail "running legacy service uses an incomplete source runtime: $running_runtime"
	else
		validate_caddy_runtime_root "$running_runtime" || fail "running service is not a complete Caddy runtime: $running_runtime"
	fi

	if [[ "$(health_status)" != '200' ]] || ! has_public_listener || [[ "$(backend_health_status)" != '200' ]]; then
		ACTIVE_RUNTIME_ROOT="$(resolve_runtime_link "$SERVICE_CURRENT_LINK" || true)"
		return 0
	fi

	if [[ "$running_runtime" != "$SOURCE_ROOT" ]]; then
		ACTIVE_RUNTIME_ROOT="$running_runtime"
		if validate_runtime_links "$running_runtime"; then
			set_runtime_link "$SERVICE_CURRENT_LINK" "$ACTIVE_RUNTIME_ROOT"
		else
			# A pre-invariant release may remain the rollback anchor only because this exact
			# process passed both health boundaries. New candidates and snapshot restarts stay
			# strict, and a successful promotion removes this compatibility path.
			ACTIVE_RUNTIME_ALLOW_LEGACY_LINKS=true
			printf 'Running release has legacy runtime links; retaining it only as the verified rollback anchor.\n' >&2
		fi
		return 0
	fi

	printf 'Migrating the legacy source-tree service to an immutable runtime snapshot...\n'
	create_runtime_snapshot bootstrap_runtime
	stop_service
	if start_service "$bootstrap_runtime" "$workspace_path" && wait_until_ready 'last-known-good bootstrap runtime' "$bootstrap_runtime"; then
		ACTIVE_RUNTIME_ROOT="$bootstrap_runtime"
		set_runtime_link "$SERVICE_CURRENT_LINK" "$ACTIVE_RUNTIME_ROOT"
		return 0
	fi

	print_log_tail
	stop_service
	fail 'could not activate the immutable Caddy bootstrap runtime; direct-TLS fallback is disabled'
}

is_release_runtime() {
	local releases_root
	local runtime_root="$1"

	[[ -d "$SERVICE_RELEASES_ROOT" ]] || return 1
	releases_root="$(realpath -e -- "$SERVICE_RELEASES_ROOT")" || return 1
	runtime_root="$(realpath -e -- "$runtime_root")" || return 1
	[[ "$runtime_root" == "$releases_root/"* ]] && validate_candidate_runtime_root "$runtime_root"
}

prepare_snapshot_restart() {
	local result_variable="$1"
	local running_runtime
	local selected_runtime

	selected_runtime="$(resolve_runtime_link "$SERVICE_CURRENT_LINK" || true)"
	[[ -n "$selected_runtime" ]] || fail 'snapshot mode has no selected release; rerun with --update-snapshot'
	is_release_runtime "$selected_runtime" || fail "selected snapshot is not an immutable release: $selected_runtime"
	ACTIVE_RUNTIME_ROOT=
	ACTIVE_RUNTIME_ALLOW_LEGACY_LINKS=false
	if tmux has-session -t "$SERVICE_SESSION" 2>/dev/null; then
		is_recognized_service_session || fail "tmux session $SERVICE_SESSION is not owned by this deployment entry point"
		running_runtime="$(service_runtime_root)"
		is_release_runtime "$running_runtime" || fail "running snapshot is not an immutable Caddy release: $running_runtime"
		if [[ "$(health_status)" == '200' ]] && has_public_listener && [[ "$(backend_health_status)" == '200' ]]; then
			ACTIVE_RUNTIME_ROOT="$running_runtime"
		fi
	else
		is_port_listening && fail "port $SERVICE_PORT is owned by an unrecognized process"
		is_backend_socket_listening && fail "backend socket is owned by an unrecognized process: $SERVICE_BACKEND_SOCKET"
	fi
	printf -v "$result_variable" '%s' "$selected_runtime"
}

promote_runtime() {
	local candidate_runtime="$1"
	local previous_runtime="$2"
	local release_root

	if [[ -n "$previous_runtime" && "$previous_runtime" == "$SERVICE_RELEASES_ROOT/"* && "$previous_runtime" != "$candidate_runtime" ]] && validate_candidate_runtime_root "$previous_runtime"; then
		set_runtime_link "$SERVICE_PREVIOUS_LINK" "$previous_runtime"
	else
		rm -f -- "$SERVICE_PREVIOUS_LINK"
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

	validate_candidate_runtime_root "$candidate_runtime" || fail "candidate runtime is incomplete or depends on state outside its immutable release: $candidate_runtime"
	stop_service
	if start_service "$candidate_runtime" "$workspace_path" && wait_until_ready 'candidate runtime' "$candidate_runtime"; then
		promote_runtime "$candidate_runtime" "$ACTIVE_RUNTIME_ROOT"
		printf 'Vibe VS Code deployment is ready: %s (0.0.0.0:%s)\n' "$SERVICE_URL" "$SERVICE_PORT"
		return 0
	fi

	print_log_tail
	printf 'Candidate runtime failed; restoring last-known-good runtime...\n' >&2
	stop_service
	if [[ -n "$ACTIVE_RUNTIME_ROOT" ]] && start_service "$ACTIVE_RUNTIME_ROOT" "$workspace_path" "$ACTIVE_RUNTIME_ALLOW_LEGACY_LINKS" && wait_until_ready 'restored last-known-good runtime' "$ACTIVE_RUNTIME_ROOT"; then
		if [[ "$ACTIVE_RUNTIME_ALLOW_LEGACY_LINKS" != true ]]; then
			set_runtime_link "$SERVICE_CURRENT_LINK" "$ACTIVE_RUNTIME_ROOT"
		fi
		fail 'candidate runtime failed health checks; restored last-known-good runtime'
	fi

	print_log_tail
	fail 'candidate runtime failed and last-known-good runtime could not be restored'
}

require_common_commands() {
	local command
	local -a commands=(awk basename chmod curl dirname env find flock grep ln mkdir mv readlink realpath rm sleep ss tmux tr)

	for command in "${commands[@]}"; do
		require_command "$command"
	done
}

require_update_commands() {
	local command
	local -a commands=(cp rsync sha256sum sha512sum tar tee uname)

	for command in "${commands[@]}"; do
		require_command "$command"
	done
}

run_deployment_action() {
	local action="$1"
	local candidate_runtime
	local workspace_path="$2"

	case "$action" in
	restart)
		prepare_snapshot_restart candidate_runtime
		activate_candidate_runtime "$candidate_runtime" "$workspace_path"
		;;
	update)
		require_update_commands
		ensure_caddy_binary
		require_source_tree
		prepare_active_runtime "$workspace_path"
		printf 'Building and deploying from %s...\n' "$SOURCE_ROOT"
		build_current
		candidate_runtime=
		create_runtime_snapshot candidate_runtime
		activate_candidate_runtime "$candidate_runtime" "$workspace_path"
		;;
	*)
		fail "unsupported deployment action: $action"
		;;
	esac
}

main() {
	local action
	local deploy_mode="$DEFAULT_DEPLOY_MODE"
	local update_snapshot=false
	local workspace_path

	if [[ "${1:-}" == '--internal-run' ]]; then
		[[ "$#" -eq 3 ]] || fail 'invalid internal service arguments'
		run_service "$2" "$3" false
		return $?
	fi
	if [[ "${1:-}" == '--internal-run-legacy-links' ]]; then
		[[ "$#" -eq 3 ]] || fail 'invalid internal legacy service arguments'
		run_service "$2" "$3" true
		return $?
	fi

	while (( $# > 0 )); do
		case "$1" in
		--mode)
			[[ "$#" -ge 2 ]] || fail 'missing value for --mode'
			deploy_mode="$2"
			shift 2
			;;
		--mode=*)
			deploy_mode="${1#--mode=}"
			shift
			;;
		--update-snapshot)
			update_snapshot=true
			shift
			;;
		--help | -h)
			print_usage
			return 0
			;;
		*)
			fail "unknown argument: $1"
			;;
		esac
	done

	action="$(resolve_deploy_action "$deploy_mode" "$update_snapshot")"
	[[ "$DEPLOY_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail 'VIBE_VSCODE_DEPLOY_TIMEOUT_SECONDS must be a positive integer'
	require_common_commands
	acquire_deployment_lock || return $?
	trap cleanup_staging_runtime EXIT
	require_service_state
	workspace_path="$(resolve_workspace_path)"
	printf 'Vibe VS Code deployment mode: %s (%s).\n' "$deploy_mode" "$action"
	run_deployment_action "$action" "$workspace_path"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	main "$@"
fi
