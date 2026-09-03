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
unset VIBE_VSCODE_PUBLIC_PORT
source "$DEPLOY_SCRIPT"
assert_equal "$(cd -- "$TEST_ROOT/../../../.." && pwd -P)" "$SOURCE_ROOT"
assert_equal 18080 "$SERVICE_PORT"
assert_equal vibe_vscode_latest "$SERVICE_SESSION"
assert_equal vibe-vscode-18080 "${SERVICE_SOCKET_ROOT##*/}"
assert_equal vibe-vscode-18080 "${SERVICE_RUNTIME_ROOT##*/}"
alternate_configuration="$(
	VIBE_VSCODE_PUBLIC_PORT=18082 bash -c '
		set -euo pipefail
		source "$1"
		validate_service_port
		printf "%s|%s|%s|%s\n" "$SERVICE_PORT" "$SERVICE_SESSION" "${SERVICE_SOCKET_ROOT##*/}" "${SERVICE_RUNTIME_ROOT##*/}"
	' bash "$DEPLOY_SCRIPT"
)"
assert_equal '18082|vibe_vscode_18082|vibe-vscode-18082|vibe-vscode-18082' "$alternate_configuration"
if VIBE_VSCODE_PUBLIC_PORT=65536 bash -c 'source "$1"; validate_service_port' bash "$DEPLOY_SCRIPT" >/dev/null 2>&1; then
	fail_test 'deployment accepted an out-of-range alternate port'
fi
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

start_command="$(
	validate_candidate_runtime_root() { :; }
	tmux() { printf '%s\n' "$*"; }
	start_service /test/runtime /test/workspace.code-workspace
)"
for propagated_input in VIBE_VSCODE_PUBLIC_PORT VIBE_VSCODE_SOCKET_ROOT VIBE_VSCODE_SERVICE_STATE_ROOT VIBE_VSCODE_SERVICE_LOG VIBE_VSCODE_TLS_CERT_PATH VIBE_VSCODE_TLS_KEY_PATH; do
	[[ "$start_command" == *"$propagated_input="* ]] || fail_test "service start omitted $propagated_input"
done

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
activate_candidate_runtime() { calls+=("activate:$1:$2"); }
run_deployment_action update /test/workspace.code-workspace >/dev/null
assert_equal 'require-update ensure-caddy require-source prepare-active:/test/workspace.code-workspace build snapshot activate:/test/candidate:/test/workspace.code-workspace' "${calls[*]}"

temporary_root="$(mktemp -d)"
holder_pid=
cleanup() {
	touch "$temporary_root/release" 2>/dev/null || true
	if [[ -n "$holder_pid" ]]; then
		wait "$holder_pid" 2>/dev/null || true
	fi
	rm -rf -- "$temporary_root"
}
trap cleanup EXIT

if grep -Eq -- 'run_legacy_server|--tls-(key|cert)-path' "$DEPLOY_SCRIPT"; then
	fail_test 'deployment script still contains a direct-TLS server path'
fi

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
	run_gateway_stack() { printf '%s|%s\n' "$1" "$2"; }
	run_service /test/caddy-runtime /test/workspace.code-workspace
)"
assert_equal '/test/caddy-runtime|/test/workspace.code-workspace' "$gateway_call"

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

legacy_anchor="$({
	tmux() { [[ "$1" == has-session ]]; }
	is_recognized_service_session() { :; }
	service_runtime_root() { printf '/test/running\n'; }
	validate_caddy_runtime_root() { :; }
	validate_runtime_links() { return 1; }
	health_status() { printf '200\n'; }
	has_public_listener() { :; }
	backend_health_status() { printf '200\n'; }
	set_runtime_link() { fail_test 'legacy runtime became the strict selected snapshot'; }
	ACTIVE_RUNTIME_ROOT=
	ACTIVE_RUNTIME_ALLOW_LEGACY_LINKS=false
	prepare_real_active_runtime /test/workspace.code-workspace
	printf '%s|%s\n' "$ACTIVE_RUNTIME_ROOT" "$ACTIVE_RUNTIME_ALLOW_LEGACY_LINKS"
} 2>/dev/null)"
assert_equal '/test/running|true' "$legacy_anchor"

set +e
(
	trap - EXIT
	ACTIVE_RUNTIME_ROOT=/test/running
	ACTIVE_RUNTIME_ALLOW_LEGACY_LINKS=true
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
