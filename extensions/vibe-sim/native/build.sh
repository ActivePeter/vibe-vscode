#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
set -euo pipefail

native_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_root="$(cd -- "$native_root/../../.." && pwd -P)"
mkdir -p -- "$source_root/.build/vibe-sim"
exec flock --nonblock "$source_root/.build/vibe-sim/build.lock" node "$native_root/build.mts" "$@"
