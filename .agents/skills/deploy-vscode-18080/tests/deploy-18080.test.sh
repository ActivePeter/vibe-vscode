#!/usr/bin/env bash

set -euo pipefail

readonly TEST_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly DEPLOY_SCRIPT="$TEST_ROOT/../scripts/deploy-18080.sh"

fail_test() {
	printf 'deploy-18080.test: %s\n' "$1" >&2
	exit 1
}

assert_equal() {
	local expected="$1"
	local actual="$2"

	[[ "$actual" == "$expected" ]] || fail_test "expected '$expected', got '$actual'"
}

bash -n "$DEPLOY_SCRIPT"
custom_configuration="$(
	VIBE_VSCODE_DEPLOY_NAME=deploy-vscode-18084 \
	VIBE_VSCODE_SERVICE_SESSION=vibe_vscode_18084 \
	VIBE_VSCODE_SERVICE_PORT=18084 \
	VIBE_VSCODE_SOCKET_ROOT=/test/socket-18084 \
	VIBE_VSCODE_BACKEND_SOCKET=/test/socket-18084/backend-custom.sock \
	VIBE_VSCODE_SERVICE_STATE_ROOT=/test/state-18084 \
	VIBE_VSCODE_SERVICE_LOG=/test/log-18084.log \
	VIBE_VSCODE_SERVICE_RUNTIME_ROOT=/test/runtime-18084 \
	VIBE_VSCODE_DEPLOY_ENTRYPOINT="$DEPLOY_SCRIPT" \
		bash -c '
			source "$1"
			printf "%s|%s|%s|%s|%s|%s|%s|%s|%s\n" \
				"$SERVICE_DEPLOY_NAME" "$SERVICE_SESSION" "$SERVICE_PORT" "$SERVICE_SOCKET_ROOT" \
				"$SERVICE_BACKEND_SOCKET" "$SERVICE_STATE_ROOT" "$SERVICE_LOG" "$SERVICE_RUNTIME_ROOT" "$SCRIPT_PATH"
		' bash "$DEPLOY_SCRIPT"
)"
assert_equal "deploy-vscode-18084|vibe_vscode_18084|18084|/test/socket-18084|/test/socket-18084/backend-custom.sock|/test/state-18084|/test/log-18084.log|/test/runtime-18084|$DEPLOY_SCRIPT" "$custom_configuration"
source "$DEPLOY_SCRIPT"
assert_equal "$(cd -- "$TEST_ROOT/../../../.." && pwd -P)" "$SOURCE_ROOT"
host_mount_prefix='/mnt/'"ceph"
if grep -Fq "$host_mount_prefix" "$DEPLOY_SCRIPT"; then
	fail_test 'deployment script contains a machine-specific mount path'
fi
activate_definition="$(declare -f activate_candidate_runtime)"
eval "${activate_definition/activate_candidate_runtime/activate_real_candidate_runtime}"
snapshot_definition="$(declare -f prepare_snapshot_restart)"
eval "${snapshot_definition/prepare_snapshot_restart/prepare_real_snapshot_restart}"
active_definition="$(declare -f prepare_active_runtime)"
eval "${active_definition/prepare_active_runtime/prepare_real_active_runtime}"

assert_equal restart "$(resolve_deploy_action snapshot false)"
assert_equal update "$(resolve_deploy_action snapshot true)"
assert_equal update "$(resolve_deploy_action latest false)"
if (resolve_deploy_action invalid false) >/dev/null 2>&1; then
	fail_test 'invalid mode was accepted'
fi

snapshot_selection="$(
	resolve_runtime_link() {
		[[ "$1" == "$SERVICE_CURRENT_LINK" ]] || fail_test "unexpected runtime pointer: $1"
		printf '/test/selected\n'
	}
	is_release_runtime() { :; }
	tmux() { [[ "$1" == has-session ]]; }
	is_recognized_service_session() { :; }
	service_runtime_root() { printf '/test/running\n'; }
	health_status() { printf '200\n'; }
	has_public_listener() { :; }
	backend_health_status() { printf '200\n'; }
	candidate_runtime=
	prepare_real_snapshot_restart candidate_runtime
	printf '%s|%s\n' "$candidate_runtime" "$ACTIVE_RUNTIME_ROOT"
)"
assert_equal '/test/selected|/test/running' "$snapshot_selection"

calls=()
prepare_snapshot_restart() {
	calls+=(prepare-snapshot)
	printf -v "$1" '%s' /test/selected
}
activate_candidate_runtime() { calls+=("activate:$1:$2"); }
for _ in {1..3}; do
	run_deployment_action restart /test/workspace.code-workspace
done
assert_equal 'prepare-snapshot activate:/test/selected:/test/workspace.code-workspace prepare-snapshot activate:/test/selected:/test/workspace.code-workspace prepare-snapshot activate:/test/selected:/test/workspace.code-workspace' "${calls[*]}"

calls=()
require_update_commands() { calls+=(require-update); }
ensure_caddy_binary() { calls+=(ensure-caddy); }
require_source_tree() { calls+=(require-source); }
prepare_active_runtime() { calls+=("prepare-active:$1"); }
build_current() { calls+=(build); }
create_runtime_snapshot() {
	calls+=(snapshot)
	printf -v "$1" '%s' /test/candidate
}
validate_runtime_dependencies() { calls+=("dependencies:$1"); }
activate_candidate_runtime() { calls+=("activate:$1:$2"); }
run_deployment_action update /test/workspace.code-workspace >/dev/null
assert_equal 'require-update ensure-caddy require-source prepare-active:/test/workspace.code-workspace build snapshot dependencies:/test/candidate activate:/test/candidate:/test/workspace.code-workspace' "${calls[*]}"

temporary_root="$(mktemp -d)"
holder_pid=
copy_test_root=
cleanup() {
	touch "$temporary_root/release" 2>/dev/null || true
	if [[ -n "$holder_pid" ]]; then
		wait "$holder_pid" 2>/dev/null || true
	fi
	rm -rf -- "$temporary_root"
	if [[ -n "$copy_test_root" ]]; then
		rm -rf -- "$copy_test_root"
	fi
}
trap cleanup EXIT

mkdir -p "$SOURCE_ROOT/.build"
copy_test_root="$(mktemp -d "$SOURCE_ROOT/.build/deploy-copy-test.XXXXXX")"
mkdir -p "$copy_test_root/source" "$copy_test_root/releases/previous/lib"
printf 'unchanged dependency\n' > "$copy_test_root/source/dependency.js"
cp -a "$copy_test_root/source/dependency.js" "$copy_test_root/releases/previous/lib/dependency.js"
VIBE_VSCODE_SERVICE_RUNTIME_ROOT="$copy_test_root" bash -c '
	source "$1"
	copy_runtime_tree "$2/source" "$2/candidate" "$2/releases/previous/lib"
	copy_runtime_tree "$2/source" "$2/mutable-candidate" "$2/source"
' bash "$DEPLOY_SCRIPT" "$copy_test_root"
[[ "$copy_test_root/candidate/dependency.js" -ef "$copy_test_root/releases/previous/lib/dependency.js" ]] || fail_test 'staging did not reuse an unchanged immutable dependency below the checkout'
[[ ! "$copy_test_root/mutable-candidate/dependency.js" -ef "$copy_test_root/source/dependency.js" ]] || fail_test 'staging linked to mutable source'

if grep -Eq -- 'run_legacy_server|--tls-(key|cert)-path' "$DEPLOY_SCRIPT"; then
	fail_test 'deployment script still contains a direct-TLS server path'
fi
grep -Fq -- 'local -a server=("$runtime_root/bin/vibe-vscode-server")' "$DEPLOY_SCRIPT" || fail_test 'deployment does not use the shared runtime launcher'
grep -Fq -- '"$SOURCE_ROOT/build/web-release.ts" prepare' "$DEPLOY_SCRIPT" || fail_test 'deployment does not use the consolidated preparation command'
grep -Fq -- '"$STAGING_RUNTIME_ROOT" "$release_id" "$(git -C "$SOURCE_ROOT" rev-parse HEAD)" --development' "$DEPLOY_SCRIPT" || fail_test 'deployment does not stamp source identity and the development profile inside staging'

(
	# Both source staging and production archives satisfy the same runtime contract.
	# Only Caddy validation is replaced; the launcher, metadata, links, and preflight are real gates.
	validate_caddy_runtime_root() { validate_runtime_root "$1"; }
	runtime_root="$temporary_root/candidate"
	mkdir -p "$runtime_root/bin" "$runtime_root/node_modules" "$runtime_root/out/vs/code/browser/workbench" "$runtime_root/extensions/vibe-vscode/dist/browser"
	touch "$runtime_root/package.json" "$runtime_root/product.json" "$runtime_root/out/server-main.js" \
		"$runtime_root/extensions/vibe-vscode/package.json" "$runtime_root/extensions/vibe-vscode/dist/browser/extension.js" \
		"$runtime_root/out/vs/code/browser/workbench/workbench.html"
	validate_runtime_root "$runtime_root" || fail_test 'production layout unexpectedly requires development-only paths'
	if validate_candidate_runtime_root "$runtime_root"; then
		fail_test 'pre-launcher runtime was accepted as a new candidate'
	fi
	printf '#!/bin/sh\n[ "$1" = "--version" ]\n' > "$runtime_root/bin/vibe-vscode-server"
	chmod +x "$runtime_root/bin/vibe-vscode-server"
	if validate_candidate_runtime_root "$runtime_root"; then
		fail_test 'candidate without release metadata was accepted'
	fi
	printf '{}\n' > "$runtime_root/vibe-release.json"
	validate_candidate_runtime_root "$runtime_root" || fail_test 'complete runtime failed the shared launcher preflight'
	mv "$runtime_root/out/vs/code/browser/workbench/workbench.html" "$runtime_root/out/vs/code/browser/workbench/workbench-dev.html"
	validate_candidate_runtime_root "$runtime_root" || fail_test 'source layout failed the shared runtime contract'
	printf '#!/bin/sh\nexit 17\n' > "$runtime_root/bin/vibe-vscode-server"
	if validate_candidate_runtime_root "$runtime_root"; then
		fail_test 'unlaunchable candidate passed the pre-stop preflight'
	fi
)

set +e
(
	trap - EXIT
	validate_candidate_runtime_root() { return 1; }
	run_gateway_stack() { touch "$temporary_root/gateway-with-invalid-runtime"; }
	run_service /test/missing-caddy /test/workspace.code-workspace
) >"$temporary_root/caddy-only.log" 2>&1
caddy_only_status=$?
set -e
assert_equal 1 "$caddy_only_status"
[[ ! -e "$temporary_root/gateway-with-invalid-runtime" ]] || fail_test 'invalid runtime reached the Caddy gateway'

gateway_call="$(
	validate_candidate_runtime_root() { :; }
	run_gateway_stack() { printf '%s|%s|%s\n' "$1" "$2" "$3"; }
	run_service /test/caddy-runtime /test/workspace.code-workspace
)"
assert_equal '/test/caddy-runtime|/test/workspace.code-workspace|false' "$gateway_call"

legacy_gateway_call="$(
	validate_caddy_runtime_root() { :; }
	validate_candidate_runtime_root() { fail_test 'verified legacy rollback was treated as a new candidate'; }
	run_gateway_stack() { printf '%s|%s|%s\n' "$1" "$2" "$3"; }
	run_service /test/pre-launcher-runtime /test/workspace.code-workspace true
)"
assert_equal '/test/pre-launcher-runtime|/test/workspace.code-workspace|true' "$legacy_gateway_call"

runtime_links_root="$temporary_root/runtime-links"
external_links_root="$temporary_root/external-links"
mkdir -p "$runtime_links_root/lib" "$external_links_root"
touch "$runtime_links_root/lib/internal" "$external_links_root/external"
ln -s lib/internal "$runtime_links_root/internal-link"
validate_runtime_links "$runtime_links_root"
ln -s "$external_links_root/external" "$runtime_links_root/external-link"
if validate_runtime_links "$runtime_links_root" >/dev/null 2>&1; then
	fail_test 'runtime accepted a symbolic link outside its immutable release'
fi
rm "$runtime_links_root/external-link"
mkdir -p "$runtime_links_root/node_modules/.bin"
ln -s missing-build-tool "$runtime_links_root/node_modules/.bin/missing-build-tool"
ln -s missing-runtime-entry "$runtime_links_root/broken-runtime-link"
if validate_runtime_links "$runtime_links_root" >/dev/null 2>&1; then
	fail_test 'runtime accepted an unresolved symbolic link'
fi
remove_unresolved_package_bin_links "$runtime_links_root"
[[ ! -e "$runtime_links_root/node_modules/.bin/missing-build-tool" && ! -L "$runtime_links_root/node_modules/.bin/missing-build-tool" ]] || fail_test 'staging cleanup retained an omitted build-tool shim'
[[ -L "$runtime_links_root/broken-runtime-link" ]] || fail_test 'staging cleanup removed an unresolved runtime link'
if validate_runtime_links "$runtime_links_root" >/dev/null 2>&1; then
	fail_test 'runtime accepted an unresolved non-.bin link after staging cleanup'
fi
rm "$runtime_links_root/broken-runtime-link"
validate_runtime_links "$runtime_links_root"

for valid_legacy_links in true false; do
	legacy_anchor="$({
		tmux() { [[ "$1" == has-session ]]; }
		is_recognized_service_session() { :; }
		service_runtime_root() { printf '/test/running\n'; }
		validate_caddy_runtime_root() { :; }
		validate_runtime_links() { "$valid_legacy_links"; }
		health_status() { printf '200\n'; }
		has_public_listener() { :; }
		backend_health_status() { printf '200\n'; }
		set_runtime_link() { fail_test 'legacy runtime became the strict selected snapshot'; }
		ACTIVE_RUNTIME_ROOT=
		ACTIVE_RUNTIME_ALLOW_LEGACY_RUNTIME=false
		prepare_real_active_runtime /test/workspace.code-workspace
		printf '%s|%s\n' "$ACTIVE_RUNTIME_ROOT" "$ACTIVE_RUNTIME_ALLOW_LEGACY_RUNTIME"
	} 2>/dev/null)"
	assert_equal '/test/running|true' "$legacy_anchor"
done

set +e
(
	trap - EXIT
	ACTIVE_RUNTIME_ROOT=/test/running
	ACTIVE_RUNTIME_ALLOW_LEGACY_RUNTIME=true
	validate_candidate_runtime_root() { :; }
	stop_service() { printf 'stop\n' >> "$temporary_root/rollback.calls"; }
	start_service() { printf 'start:%s:%s\n' "$1" "${3:-false}" >> "$temporary_root/rollback.calls"; }
	wait_until_ready() {
		printf 'wait:%s:%s\n' "$1" "$2" >> "$temporary_root/rollback.calls"
		[[ "$1" == 'restored last-known-good runtime' ]]
	}
	print_log_tail() { :; }
	set_runtime_link() { printf 'link:%s:%s\n' "$1" "$2" >> "$temporary_root/rollback.calls"; }
	activate_real_candidate_runtime /test/candidate /test/workspace.code-workspace
) >"$temporary_root/rollback.log" 2>&1
rollback_status=$?
set -e
assert_equal 1 "$rollback_status"
grep -Fxq 'start:/test/running:true' "$temporary_root/rollback.calls" || fail_test 'rollback did not restart the verified legacy runtime through the bounded compatibility path'
if grep -Fq "link:$SERVICE_CURRENT_LINK:/test/running" "$temporary_root/rollback.calls"; then
	fail_test 'legacy rollback runtime became the strict selected snapshot'
fi

set +e
(
	trap - EXIT
	set -e
	require_update_commands() { :; }
	ensure_caddy_binary() { :; }
	require_source_tree() { :; }
	prepare_active_runtime() { :; }
	build_current() { return 42; }
	create_runtime_snapshot() { touch "$temporary_root/snapshot-after-failed-build"; }
	activate_candidate_runtime() { touch "$temporary_root/activation-after-failed-build"; }
	run_deployment_action update /test/workspace.code-workspace
) >"$temporary_root/build-failure.log" 2>&1
build_failure_status=$?
set -e
assert_equal 42 "$build_failure_status"
[[ ! -e "$temporary_root/snapshot-after-failed-build" && ! -e "$temporary_root/activation-after-failed-build" ]] || fail_test 'failed build reached service activation'

set +e
(
	trap - EXIT
	set -e
	require_update_commands() { :; }
	ensure_caddy_binary() { :; }
	require_source_tree() { :; }
	prepare_active_runtime() { :; }
	build_current() { :; }
	create_runtime_snapshot() { printf -v "$1" '%s' /test/candidate; }
	validate_runtime_dependencies() { return 1; }
	activate_candidate_runtime() { touch "$temporary_root/activation-after-failed-dependencies"; }
	run_deployment_action update /test/workspace.code-workspace
) >"$temporary_root/dependency-failure.log" 2>&1
dependency_failure_status=$?
set -e
assert_equal 1 "$dependency_failure_status"
[[ ! -e "$temporary_root/activation-after-failed-dependencies" ]] || fail_test 'unloadable runtime dependencies reached service activation'

acquire_definition="$(declare -f acquire_deployment_lock)"
eval "${acquire_definition/acquire_deployment_lock/acquire_real_deployment_lock}"
require_common_commands() { :; }
acquire_deployment_lock() { acquire_real_deployment_lock "$temporary_root/deploy.lock"; }
require_service_state() { :; }
resolve_workspace_path() { printf '/test/workspace.code-workspace\n'; }
run_deployment_action() {
	printf '%s\n' "$BASHPID" >> "$temporary_root/actions"
	touch "$temporary_root/ready"
	while [[ ! -e "$temporary_root/release" ]]; do
		sleep 0.05
	done
}

(
	trap - EXIT
	main --mode snapshot
) >"$temporary_root/first.log" 2>&1 &
holder_pid=$!

for _ in {1..100}; do
	[[ -e "$temporary_root/ready" ]] && break
	sleep 0.05
done
[[ -e "$temporary_root/ready" ]] || fail_test 'timed out waiting for lock holder'

set +e
(
	trap - EXIT
	main --mode snapshot
) >"$temporary_root/contention.log" 2>&1
contention_status=$?
set -e
assert_equal 75 "$contention_status"
assert_equal 1 "$(grep -c '^' "$temporary_root/actions")"

touch "$temporary_root/release"
wait "$holder_pid"
holder_pid=

ownership_calls="$temporary_root/ownership.calls"
set +e
(
	trap - EXIT
	tmux() {
		printf '%s\n' "$*" >> "$ownership_calls"
		case "$1" in
		has-session)
			return 0
			;;
		display-message)
			printf 'exec /unrecognized/service\n'
			return 0
			;;
		kill-session)
			return 0
			;;
		esac
	}
	stop_service
) >"$temporary_root/ownership.log" 2>&1
ownership_status=$?
set -e
assert_equal 1 "$ownership_status"
if grep -q '^kill-session' "$ownership_calls"; then
	fail_test 'unrecognized tmux session was killed'
fi

printf 'deploy-18080 tests passed\n'
