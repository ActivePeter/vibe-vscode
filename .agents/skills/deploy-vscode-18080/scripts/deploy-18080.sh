#!/usr/bin/env bash

set -euo pipefail

readonly CONTROL_SCRIPT=/mnt/ceph/dever_for_dev/third_party/vscode/scripts/dever-service-latest.sh
readonly SOURCE_ROOT=/mnt/ceph/vibe-vscode
readonly SERVICE_SESSION=dever_vscode_latest
readonly SERVICE_PORT=18080
readonly SERVICE_URL="https://127.0.0.1:${SERVICE_PORT}/"
readonly SERVICE_LOG=/mnt/ceph/dever_for_dev/.dever/vscode-services/logs/latest.log
readonly DEPLOY_TIMEOUT_SECONDS="${VIBE_VSCODE_DEPLOY_TIMEOUT_SECONDS:-900}"

fail() {
	printf 'deploy-vscode-18080: %s\n' "$1" >&2
	exit 1
}

health_status() {
	curl --insecure --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 2 "$SERVICE_URL" 2>/dev/null || true
}

print_log_tail() {
	if [[ -f "$SERVICE_LOG" ]]; then
		printf '\nLast 80 lines from %s:\n' "$SERVICE_LOG" >&2
		tail -n 80 -- "$SERVICE_LOG" >&2
	fi
}

[[ -d "$SOURCE_ROOT" ]] || fail "canonical source checkout is missing: $SOURCE_ROOT"
[[ -x "$CONTROL_SCRIPT" ]] || fail "service control entry is missing or not executable: $CONTROL_SCRIPT"
[[ "$DEPLOY_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail 'VIBE_VSCODE_DEPLOY_TIMEOUT_SECONDS must be a positive integer'

command -v curl >/dev/null 2>&1 || fail 'missing required command: curl'
command -v tmux >/dev/null 2>&1 || fail 'missing required command: tmux'

if tmux has-session -t "$SERVICE_SESSION" 2>/dev/null; then
	printf 'Stopping existing VS Code service on port %s...\n' "$SERVICE_PORT"
	"$CONTROL_SCRIPT" --stop
elif [[ "$(health_status)" != '000' ]]; then
	fail "port $SERVICE_PORT responds without canonical tmux session $SERVICE_SESSION; refusing to stop an unknown process"
fi

printf 'Starting rebuild and deployment from %s...\n' "$SOURCE_ROOT"
"$CONTROL_SCRIPT"

readonly deadline=$((SECONDS + DEPLOY_TIMEOUT_SECONDS))
while (( SECONDS < deadline )); do
	if [[ "$(health_status)" == '200' ]]; then
		printf 'Vibe VS Code deployment is ready: %s\n' "$SERVICE_URL"
		exit 0
	fi

	if ! tmux has-session -t "$SERVICE_SESSION" 2>/dev/null; then
		print_log_tail
		fail "service session exited before port $SERVICE_PORT became healthy"
	fi

	sleep 2
done

print_log_tail
fail "timed out after ${DEPLOY_TIMEOUT_SECONDS}s waiting for $SERVICE_URL"
