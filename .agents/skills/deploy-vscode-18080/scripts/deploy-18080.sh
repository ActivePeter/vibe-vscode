#!/usr/bin/env bash

set -euo pipefail

readonly SOURCE_ROOT=/mnt/ceph/vibe-vscode
readonly SERVICE_SESSION=vibe_vscode_latest
readonly SERVICE_PORT=18080
readonly SERVICE_URL="https://127.0.0.1:${SERVICE_PORT}/"
readonly SERVICE_SOCKET_ROOT="${VIBE_VSCODE_SOCKET_ROOT:-${XDG_RUNTIME_DIR:-/tmp}/vibe-vscode-18080}"
readonly SERVICE_BACKEND_SOCKET="$SERVICE_SOCKET_ROOT/backend.sock"
readonly SERVICE_STATE_ROOT=/mnt/ceph/dever_for_dev/.dever/vscode-services/state/latest
readonly SERVICE_LOG=/mnt/ceph/dever_for_dev/.dever/vscode-services/logs/latest.log
readonly SERVICE_RUNTIME_ROOT="$SOURCE_ROOT/.build/vibe-vscode-18080"
readonly SERVICE_RELEASES_ROOT="$SERVICE_RUNTIME_ROOT/releases"
readonly SERVICE_CURRENT_LINK="$SERVICE_RUNTIME_ROOT/last-known-good"
readonly SERVICE_PREVIOUS_LINK="$SERVICE_RUNTIME_ROOT/previous"
readonly TLS_KEY_PATH=/mnt/ceph/dever_for_dev/.dever/https/localhost-key.pem
readonly TLS_CERT_PATH=/mnt/ceph/dever_for_dev/.dever/https/localhost-cert.pem
readonly CADDY_VERSION=2.11.4
readonly CADDY_CACHE_ROOT="$SERVICE_RUNTIME_ROOT/tools/caddy/$CADDY_VERSION"
readonly CADDY_BINARY="$CADDY_CACHE_ROOT/caddy"
readonly CADDY_CONFIG_RELATIVE_PATH=resources/server/vibe-vscode/Caddyfile
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

trap cleanup_staging_runtime EXIT

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
	done < <(find "$SERVICE_STATE_ROOT" -maxdepth 1 -type f -name '*.code-workspace' -print0)

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

validate_candidate_runtime_root() {
	local runtime_root="$1"
	local link_path
	local resolved_link
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

	# A last-known-good release must survive replacement or removal of the canonical dependency
	# trees. Relative links contained inside a copied node_modules tree are allowed, but no link
	# may resolve back into the mutable source checkout.
	while IFS= read -r -d '' link_path; do
		resolved_link="$(readlink -f -- "$link_path" 2>/dev/null || true)"
		case "$resolved_link" in
		"$runtime_root" | "$runtime_root"/*) ;;
		"$SOURCE_ROOT" | "$SOURCE_ROOT"/*)
			printf 'Runtime link escapes into mutable source: %s -> %s\n' "$link_path" "$resolved_link" >&2
			return 1
			;;
		esac
	done < <(find "$runtime_root" -type l -print0)
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

	validate_candidate_runtime_root "$STAGING_RUNTIME_ROOT" || fail "staged runtime is incomplete or depends on mutable source: $STAGING_RUNTIME_ROOT"
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
		is_backend_socket_listening && fail "backend socket is owned by an unrecognized process: $SERVICE_BACKEND_SOCKET"
		rm -f -- "$SERVICE_BACKEND_SOCKET"
		return 0
	fi

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

run_legacy_server() {
	local runtime_root="$1"
	local workspace_path="$2"
	local runtime_node="$NODE_BIN"

	if [[ -x "$runtime_root/node" ]]; then
		runtime_node="$runtime_root/node"
	fi

	mkdir -p -- "$SERVICE_STATE_ROOT/server" "$(dirname -- "$SERVICE_LOG")"
	exec >> "$SERVICE_LOG" 2>&1
	log "Starting legacy direct-TLS Vibe VS Code runtime from $runtime_root on 0.0.0.0:$SERVICE_PORT."
	cd -- "$runtime_root"
	exec env NODE_ENV=development VSCODE_DEV=1 \
		"$runtime_node" out/server-main.js \
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

	if [[ -x "$runtime_root/caddy" && -f "$runtime_root/$CADDY_CONFIG_RELATIVE_PATH" ]]; then
		run_gateway_stack "$runtime_root" "$workspace_path"
	else
		run_legacy_server "$runtime_root" "$workspace_path"
	fi
}

start_service() {
	local runtime_root="$1"
	local workspace_path="$2"
	local tmux_command

	validate_runtime_root "$runtime_root" || return 1
	printf -v tmux_command 'exec env VIBE_VSCODE_SOCKET_ROOT=%q %q %q %q %q' "$SERVICE_SOCKET_ROOT" "$SCRIPT_PATH" --internal-run "$runtime_root" "$workspace_path"
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
			if [[ -x "$expected_runtime_root/caddy" && "$(backend_health_status)" != '200' ]]; then
				printf 'Caddy is healthy but the private VS Code backend is not reachable through %s.\n' "$SERVICE_BACKEND_SOCKET" >&2
				return 1
			fi
			if [[ -x "$expected_runtime_root/caddy" ]]; then
				printf 'Vibe VS Code runtime is ready: %s (%s, Caddy HTTPS, anonymous access, private Unix-socket backend, 0.0.0.0:%s)\n' "$runtime_label" "$SERVICE_URL" "$SERVICE_PORT"
			else
				printf 'Vibe VS Code runtime is ready: %s (%s, legacy direct TLS, anonymous access, 0.0.0.0:%s)\n' "$runtime_label" "$SERVICE_URL" "$SERVICE_PORT"
			fi
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
	if start_service "$bootstrap_runtime" "$workspace_path" && wait_until_ready 'last-known-good bootstrap runtime' "$bootstrap_runtime"; then
		ACTIVE_RUNTIME_ROOT="$bootstrap_runtime"
		set_runtime_link "$SERVICE_CURRENT_LINK" "$ACTIVE_RUNTIME_ROOT"
		return 0
	fi

	print_log_tail
	stop_service
	if start_service "$SOURCE_ROOT" "$workspace_path" && wait_until_ready 'restored legacy source runtime' "$SOURCE_ROOT"; then
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

	validate_candidate_runtime_root "$candidate_runtime" || fail "candidate runtime is incomplete or depends on mutable source: $candidate_runtime"
	stop_service
	if start_service "$candidate_runtime" "$workspace_path" && wait_until_ready 'candidate runtime' "$candidate_runtime"; then
		promote_runtime "$candidate_runtime" "$ACTIVE_RUNTIME_ROOT"
		printf 'Vibe VS Code deployment is ready: %s (0.0.0.0:%s)\n' "$SERVICE_URL" "$SERVICE_PORT"
		return 0
	fi

	print_log_tail
	printf 'Candidate runtime failed; restoring last-known-good runtime...\n' >&2
	stop_service
	if [[ -n "$ACTIVE_RUNTIME_ROOT" ]] && start_service "$ACTIVE_RUNTIME_ROOT" "$workspace_path" && wait_until_ready 'restored last-known-good runtime' "$ACTIVE_RUNTIME_ROOT"; then
		fail 'candidate runtime failed health checks; restored last-known-good runtime'
	fi

	print_log_tail
	fail 'candidate runtime failed and last-known-good runtime could not be restored'
}

case "${1:-}" in
	--internal-run)
		[[ "$#" -eq 3 ]] || fail 'invalid internal service arguments'
		run_service "$2" "$3"
		exit $?
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
require_command chmod
require_command cp
require_command curl
require_command env
require_command find
require_command grep
require_command ln
require_command mv
require_command readlink
require_command realpath
require_command rm
require_command rsync
require_command sha256sum
require_command sha512sum
require_command ss
require_command tar
require_command tee
require_command tmux
require_command tr
require_command uname
ensure_caddy_binary
require_source_tree
require_service_state

readonly WORKSPACE_PATH="$(resolve_workspace_path)"
prepare_active_runtime "$WORKSPACE_PATH"
printf 'Building and deploying from %s...\n' "$SOURCE_ROOT"
build_current
candidate_runtime=
create_runtime_snapshot candidate_runtime
activate_candidate_runtime "$candidate_runtime" "$WORKSPACE_PATH"
