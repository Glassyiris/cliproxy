# Production stream storage gate

This standalone benchmark compares the production `ck-stream` public API with benchmark-only heap storage. It implements every G-storage row from `docs/INTERNAL-STREAM.md`, §9.3 and the S1 plan, §7. It does not contain a pool allocator.

## Run the gate

From the repository root on an otherwise idle Linux host:

```sh
bench/stream-gate.sh "$TMPFS" "$OUT"
```

`TMPFS` must be an existing private tmpfs directory. `OUT` must be an external evidence directory, not a repository path. The runner creates disposable private storage directories beneath `TMPFS` and removes them after each sample. The ENOSPC row mounts a private 64 MiB tmpfs with `unshare -Urm`; user and mount namespaces and the `mount` command must work. It creates the capped production pool before filling a second file on that same mount, then requires an actual growth error with errno 28 and a visible storage-exhausted reader terminal. The process must execute the post-error checks and emit its survivor PID.

The script builds offline with the checked-in lockfile in release mode, respects `CARGO_TARGET_DIR` (default `target/stream`) and defaults to two build jobs. Cached dependencies are required. No production quotas are increased. The total-cap row requires the derived default to be 85,899 frames; a smaller startup cap fails the row rather than being overridden. A tmpfs of at least 8 GiB and sufficient free tmpfs/cgroup memory are needed to reach that default.

The gate returns nonzero for build failures, missing samples, nonzero workload exits, missing metrics, timeouts, namespace failures and regressions. It attempts all rows after individual workload failures. A build/preflight failure writes every row as failed without claiming a measurement.

Output files:

- `raw.jsonl`: each measured subprocess result, errors, exit status, pair order, command and host load. Preflight failures are explicitly unmeasured.
- `medians.json`: metric minima, P25, median, P75 and maxima, with each row's failure reasons.
- `provenance.json`: revision, source/binary hashes, compiler, build flags, kernel, architecture, page size, affinity, filesystem and initial host load.
- `RESULTS.md`: row verdicts. `build.log` and per-sample stderr files retain diagnostics.

## Workload and comparison contracts

Every general comparison uses seven pool/heap pairs, reversing the first backend on successive pairs. The 4-reader, 64-byte, 1-MiB throughput row uses 101 pairs. Its pool median must reach heap P25; both IQRs and the median difference are reported. General lower-is-better metrics fail above heap's maximum; higher-is-better metrics fail below heap's minimum.

Small requests run 20,000 create/write/read/drop operations at 1/64 tasks. Responses remain cached after the client drops. To avoid treating 4,096 header slots as an unlimited request count, batches of at most 2,048 requests expire through `ManualClock` outside the timed region. The heap comparator uses the same batch lifecycle. Concurrent rows run 256/1,024 streams of 256 KiB, yielding every 16 appends. Throughput yields every 256 KiB. The 49,152-byte throughput and memory appends start on frame boundaries in both backends; 64/256-byte appends are packed.

Latency rows publish 20,000 timestamped 64-byte records, yielding between arrivals until 20 microseconds have elapsed. Readers verify record boundaries and report append-to-observe p50/p99 and TTFB p50/p99. Every throughput/small/concurrency reader checks all payload bytes. Both backends use 50,000-byte frames, complete-record publication and notification-before-recheck waiting. Heap uses safe mutex-protected frames and retains records until explicit expiry; it is not an implementation of the production allocator, cache-pressure policy or metadata ceiling.

Memory rows use an eight-worker runtime and eight producer tasks. They pin all records while holding 100 × 1 MiB or 10 × 64 MiB, advance `ManualClock` to expire the pool, release leases and sample after one full decay interval. A sample later than two intervals fails. The pool stays open during the sample. Each pool sample must meet the baseline + 4 MiB + 3,200,000-byte RSS/tmpfs allowance; the pool's post-decay RSS median must not exceed heap's. Raw and median reports include RssAnon, RssShmem, RssFile and cgroup charges. Shared-host tmpfs/cgroup measurements include other processes.

The total-cap row acquires an active lease after every frame append and retains all leases until all 17 streams have been attempted. Streams 1–16 must reach exactly 5,368 frames; stream 17 must stop within 11. Every refusal must expose a storage-exhausted terminal.

## Default metadata constraint

The production default metadata limit remains 1 MiB. Consecutive records with identical length, stride, type and correlation share a bounded run index; heterogeneous records still consume individual entries. The heap comparator retains individual coordinate/type/correlation entries. Both backends retain identical 50,000-byte payload frames and complete-record semantics. If either workload fails, the benchmark records the byte offset and counters, returns nonzero and still attempts subsequent rows. It never raises `max_metadata_bytes`, releases response prefixes or substitutes another pool to make a row run.

## Narrow verification

```sh
bash -n bench/stream-gate.sh
python3 -I bench/stream/gate.py --self-test
CARGO_TARGET_DIR=/scratch/ssd/s1b-target cargo build --release --locked --offline --manifest-path bench/stream/Cargo.toml
/scratch/ssd/s1b-target/release/ck-stream-bench pool smoke "$TMPFS"
/scratch/ssd/s1b-target/release/ck-stream-bench heap smoke "$TMPFS"
```

The self-test plants a regression, the stricter P25 failure, failed subprocess evidence and missing samples/metrics. These checks do not establish production performance. Run the full gate only after integration and without competing compilation.
