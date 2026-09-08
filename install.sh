#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.

set -euo pipefail
umask 0077
ROOT="$HOME/.vibe-vscode"
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
	runtime="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
	if [[ "$(basename -- "$(dirname -- "$runtime")")" == releases ]]; then ROOT="$(dirname -- "$(dirname -- "$runtime")")"; fi
fi
TAG=''
ROLLBACK=false
STAGING=''
VALIDATED=false
TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
while [[ $# -gt 0 ]]; do
	case "$1" in
	--tag | --root)
		[[ $# -ge 2 && -n "$2" ]] || fail "$1 requires a value"
		if [[ "$1" == --tag ]]; then TAG="$2"; else ROOT="$2"; fi
		shift 2 ;;
	--rollback) ROLLBACK=true; shift ;;
	--help | -h)
		printf 'Usage: install.sh --tag <vMAJOR.MINOR.PATCH> [--root <directory>]\n       install.sh --rollback [--root <directory>]\n'
		exit 0 ;;
	*) fail "unknown option: $1" ;;
	esac
done
if [[ "$ROLLBACK" == true ]]; then
	[[ -z "$TAG" ]] || fail '--rollback cannot be combined with --tag'
else
	[[ "$TAG" =~ $TAG_PATTERN ]] || fail '--tag requires a vMAJOR.MINOR.PATCH release tag'
fi
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || fail 'this release supports Linux x64 only'
for required in curl tar sha256sum flock realpath find; do command -v "$required" >/dev/null || fail "missing command: $required"; done
mkdir -p -- "$ROOT"
ROOT="$(realpath -e -- "$ROOT")"
exec 9>"$ROOT/install.lock"
flock -n 9 || fail "another installation is using $ROOT"
mkdir -p -- "$ROOT/releases"
[[ ! -L "$ROOT/releases" ]] || fail 'releases must not be a symlink'

cleanup() {
	[[ -z "$STAGING" ]] || rm -rf -- "$STAGING"
	rm -f -- "$ROOT/.current.$$" "$ROOT/.previous.$$"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

selected() {
	local link="$ROOT/$1" target version
	if [[ ! -e "$link" && ! -L "$link" ]]; then return; fi
	[[ -L "$link" ]] || fail "$link is not a managed release pointer"
	target="$(realpath -e -- "$link")" || fail "broken release pointer: $link"
	version="${target#"$ROOT/releases/"}"
	[[ "$target" != "$version" && "$version" =~ $TAG_PATTERN && -d "$target" ]] || fail "$link points outside this installation"
	printf '%s\n' "$target"
}

replace_pointer() {
	ln -s -- "releases/$(basename -- "$2")" "$ROOT/.$1.$$" || return
	mv -Tf -- "$ROOT/.$1.$$" "$ROOT/$1"
}

validate_runtime() {
	local candidate="$1"
	[[ -d "$candidate" && ! -L "$candidate" && -x "$candidate/bin/vibe-vscode" && -x "$candidate/caddy" ]] || fail 'incomplete or unmanaged release directory'
	"$candidate/node" -e 'const m = require(process.argv[1]); if (m.version !== process.argv[2] || m.mode !== "production" || m.platform !== "linux" || m.arch !== "x64" || m.authentication !== "embedded-cli-v1") process.exit(1);' "$candidate/vibe-release.json" "$TAG" || fail 'release metadata does not match the requested version'
	"$candidate/bin/vibe-vscode-server" --version
	"$candidate/caddy" version
}

current="$(selected current)"
previous="$(selected previous)"
if [[ "$ROLLBACK" == true ]]; then
	[[ -n "$current" && -n "$previous" && "$current" != "$previous" ]] || fail 'no previous release is available'
	CANDIDATE="$previous"
	TAG="$(basename -- "$CANDIDATE")"
else
	CANDIDATE="$ROOT/releases/$TAG"
	if [[ ! -e "$CANDIDATE" && ! -L "$CANDIDATE" ]]; then
		STAGING="$(mktemp -d "$ROOT/.install.XXXXXXXX")"
		ASSET="vibe-vscode-server-$TAG-linux-x64.tar.gz"
		URL="https://github.com/ActivePeter/vibe-vscode/releases/download/$TAG"
		for name in "$ASSET" "$ASSET.sha256"; do
			curl --fail --location --retry 3 --silent --show-error --proto '=https' --proto-redir '=https' --output "$STAGING/$name" "$URL/$name"
		done
		read -r checksum name extra < "$STAGING/$ASSET.sha256"
		[[ "$checksum" =~ ^[0-9a-fA-F]{64}$ && "$name" == "$ASSET" && -z "$extra" && "$(wc -l < "$STAGING/$ASSET.sha256")" -eq 1 ]] || fail 'invalid archive checksum file'
		actual="$(sha256sum -- "$STAGING/$ASSET")"
		[[ "${actual%% *}" == "${checksum,,}" ]] || fail 'archive checksum mismatch; current is unchanged'
		# Reject traversal before extraction. GNU tar also rejects unsafe link extraction.
		tar -tzf "$STAGING/$ASSET" > "$STAGING/members"
		while IFS= read -r member; do
			case "/$member/" in //* | */../*) fail 'archive contains an unsafe path' ;; esac
		done < "$STAGING/members"
		mkdir "$STAGING/runtime"
		tar -xzf "$STAGING/$ASSET" --no-same-owner --no-same-permissions -C "$STAGING/runtime"
		find "$STAGING/runtime" -type l -print0 > "$STAGING/links"
		while IFS= read -r -d '' link; do
			target="$(realpath -e -- "$link")" || fail 'archive contains a broken link'
			[[ "$target" == "$STAGING/runtime/"* ]] || fail 'archive link escapes its runtime'
		done < "$STAGING/links"
		# Validate before publication, without opening any authentication or workspace state.
		validate_runtime "$STAGING/runtime"
		mv -T -- "$STAGING/runtime" "$CANDIDATE"
		VALIDATED=true
	fi
fi
[[ "$VALIDATED" == true ]] || validate_runtime "$CANDIDATE"

if [[ "$current" != "$CANDIDATE" ]]; then
	if [[ -n "$current" ]]; then replace_pointer previous "$current"; fi
	if ! replace_pointer current "$CANDIDATE"; then
		if [[ -n "$previous" ]]; then replace_pointer previous "$previous"; else rm -f -- "$ROOT/previous"; fi
		fail 'could not select the release; current is unchanged'
	fi
fi
# The default state directory is created here so configuration can be written before the first start.
if ! mkdir -p -- "$ROOT/state" 2>/dev/null || ! chmod 0700 -- "$ROOT/state" 2>/dev/null; then
	fail "cannot create the state directory $ROOT/state; create it, make it writable by $(id -un), then rerun"
fi
printf 'Selected %s. Existing releases and persistent state were preserved.\n' "$TAG"
printf 'Next: %q start --origin https://<browser-visible-host>:18080\n' "$ROOT/current/bin/vibe-vscode"
printf 'If an instance is running, stop and restart it to use the selected release.\n'
