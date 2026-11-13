#!/usr/bin/env bash
# Idle cost of one server process on Linux, behind the idle numbers in docs/BENCHMARKS.md
# and the idle gates in CI.
#
#   bench/idle.sh <server binary> [auth files] [seconds]
#
# Starts the binary on a config with one OpenAI-compatible API key, one client key and
# <auth files> Claude credentials (default 1), uploaded through the management API, whose
# tokens are valid for 30 days, so nothing is due for refresh. After WARMUP seconds (default 30: the startup heap trim
# runs on the blocking pool 5 to 10 s after start, and its thread exits after a 10 s
# keep-alive) without any request, it samples for <seconds> (default 30) and
# prints one JSON line:
#
#   wakeups       context switches of all threads in the window, voluntary and not,
#                 summed from /proc/<pid>/task/*/status
#   cpu_ticks     user + system clock ticks (1/100 s) in the window
#   threads_start threads at the start of the window
#   threads       threads at the end of the window
#   exited        threads that ended inside the window (their wakeups are lost, so the
#                 script then exits non-zero)
#   rss_kb        VmRSS at the end of the window
#
# Per-thread context switches go to stderr, so a regression names its thread.
#
# External network is denied as in bench/run.sh: the script re-runs itself in a
# loopback-only network namespace, or points every proxy variable at a closed port.
set -euo pipefail

if [[ -z ${BENCH_ISOLATION:-} ]]; then
  if unshare -rn true 2>/dev/null; then
    BENCH_ISOLATION=netns exec unshare -rn bash -c \
      'ip link set lo up && exec unshare --user --map-user="$1" --map-group="$2" -- "${@:3}"' \
      _ "$(id -u)" "$(id -g)" "$0" "$@"
  fi
  export BENCH_ISOLATION=proxy-env HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 \
    ALL_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost,::1
  # curl and Go read the lowercase names first.
  export https_proxy=$HTTPS_PROXY http_proxy=$HTTP_PROXY all_proxy=$ALL_PROXY no_proxy=$NO_PROXY
fi

BIN=$(realpath "$1")
FILES=${2:-1}
SECONDS_=${3:-30}
WARMUP=${WARMUP:-30}
PORT=${PORT:-8341}
KEY=sk-bench-client-key
DIR=$(mktemp -d /tmp/cooker-idle.XXXXXX)
# Samples live outside DIR: a write next to config.yaml is a file event the server sees.
TMP=$(mktemp -d /tmp/cooker-idle-samples.XXXXXX)
trap 'kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; rm -rf "$DIR" "$TMP"' EXIT

mkdir -p "$DIR"
cat > "$DIR/config.yaml" <<EOF
config-version: 8
server:
  host: "127.0.0.1"
  port: $PORT
access:
  api-keys:
    - "$KEY"
api-keys:
  openai-compatibility:
    - name: bench
      base-url: "http://127.0.0.1:9/v1"
      keys:
        - api-key: "sk-bench-upstream"
      models:
        - name: "bench-model"
          alias: "bench-model"
EOF
# Credentials live in the database: they are uploaded through the management API once
# the server answers, not read from a directory.
expiry=$(date -u -d '+30 days' +%Y-%m-%dT%H:%M:%SZ)
MGMT=bench-management-key
{
  printf '{"documents":['
  for i in $(seq 1 "$FILES"); do
    ((i == 1)) || printf ','
    data=$(printf '{"type":"claude","email":"idle%d@example.com","access_token":"bench-access-%d","refresh_token":"bench-refresh-%d","expired":"%s"}\n' \
      "$i" "$i" "$i" "$expiry" | base64 -w0)
    printf '{"name":"claude-idle%d.json","data":"%s"}' "$i" "$data"
  done
  printf ']}'
} > "$TMP/credentials.json"

CK_MANAGEMENT_PASSWORD="$MGMT" CK_DB="$DIR/cooker.db" "$BIN" --config "$DIR/config.yaml" > "$DIR/server.log" 2>&1 &
PID=$!
ready=false
for _ in $(seq 1 400); do
  curl -sf -m 2 -o /dev/null -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/v1/models" && { ready=true; break; }
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.025
done
$ready || { echo "server did not answer" >&2; cat "$DIR/server.log" >&2; exit 1; }
curl -sf -m 60 -o /dev/null -H "Authorization: Bearer $MGMT" -H 'Content-Type: application/json' \
  --data-binary @"$TMP/credentials.json" "http://127.0.0.1:$PORT/admin/v1/credentials/batch" ||
  { echo "credential upload failed" >&2; cat "$DIR/server.log" >&2; exit 1; }
sleep "$WARMUP"

switches() { # "<tid> <name> <context switches>" per thread
  local t name n
  for t in /proc/"$PID"/task/*; do
    name=$(cat "$t/comm" 2>/dev/null) || continue
    n=$(awk '/ctxt_switches/ {s += $2} END {print s + 0}' "$t/status" 2>/dev/null) || continue
    echo "${t##*/} $name $n"
  done | sort
}
ticks() { awk '{print $14 + $15}' "/proc/$PID/stat"; }

switches > "$TMP/before"; c0=$(ticks)
threads_start=$(wc -l < "$TMP/before")
sleep "$SECONDS_"
switches > "$TMP/after"; c1=$(ticks)
threads=$(ls /proc/"$PID"/task | wc -l)
rss=$(awk '$1 == "VmRSS:" {print $2}' "/proc/$PID/status")

# Per-thread wakeups in the window, busiest first. A thread that started inside the
# window counts from zero; one that exited inside it is not seen.
join -a 2 -e 0 -o 2.1,2.2,1.3,2.3 "$TMP/before" "$TMP/after" |
  awk '{print $2 "/" $1, $4 - $3}' | sort -k2 -nr > "$TMP/window"
awk '{printf "  %-24s %d\n", $1, $2}' "$TMP/window" >&2
wakeups=$(awk '{s += $2} END {print s + 0}' "$TMP/window")
exited=$(join -v 1 "$TMP/before" "$TMP/after" | wc -l)
if (( exited > 0 )); then
  echo "threads that exited inside the window (their wakeups are not counted):" >&2
  join -v 1 "$TMP/before" "$TMP/after" | sed 's/^/  /' >&2
fi

printf '{"binary":"%s","auth_files":%d,"seconds":%d,"wakeups":%d,"cpu_ticks":%d,"threads_start":%d,"threads":%d,"exited":%d,"rss_kb":%d,"isolation":"%s"}\n' \
  "$(basename "$BIN")" "$FILES" "$SECONDS_" "$wakeups" $((c1 - c0)) "$threads_start" "$threads" "$exited" "$rss" "$BENCH_ISOLATION"
(( exited == 0 ))
