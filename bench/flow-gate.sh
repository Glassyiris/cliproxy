#!/usr/bin/env bash
# Run from the repository root; OUT must be a new external output directory.
set -euo pipefail
HERE=$(cd -- "$(dirname -- "$0")" && pwd)
exec python3 -I "$HERE/flow/driver.py" "$@"
