#!/usr/bin/env bash
set -u -o pipefail
if [[ $# != 2 ]]; then
    printf 'usage: %s TMPFS OUT\n' "$0" >&2
    exit 2
fi
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
tmpfs=$(realpath -- "$1") || exit 2
mkdir -p -- "$2" || exit 2
out=$(realpath -- "$2") || exit 2
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-"$root/target/stream"}
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2}
failed=()
if ! cargo build --release --locked --offline --manifest-path "$root/bench/stream/Cargo.toml" >"$out/build.log" 2>&1; then
    failed=(--build-failed)
fi
exec python3 -I "$root/bench/stream/gate.py" "$tmpfs" "$out" \
    --binary "$CARGO_TARGET_DIR/release/ck-stream-bench" "${failed[@]}"
