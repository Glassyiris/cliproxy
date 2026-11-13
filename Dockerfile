# syntax=docker/dockerfile:1

# Every check and the image are stages of this file, so `docker buildx build --target <stage> .`
# runs the same gate locally and in CI (.github/workflows/ci.yml):
#
#   dashboard  the dashboard's checks and build (npm run check)
#   check      fmt, clippy, actionlint, THIRD-PARTY-NOTICES, the harness build and script tests
#   test       the workspace tests with no network; SHARD and SHARDS split them
#   build      the release binary, with the dashboard embedded
#   perf       the size and idle gates on that binary
#   runtime    the image that ships (the default target)
#
# A failing gate fails its RUN, and so the build. On small machines pass
# --build-arg BUILD_JOBS=1; the final link needs about 2 GB of memory.

# Toolchains, pinned by version and digest: the size, idle and heap budgets are exact numbers
# from one compiler and std (bench/budgets.txt). Bumping Rust means re-measuring them.
FROM golang:1.26.11-bookworm@sha256:dc40a13b61304647ed7e5d581d246b86413dfc29d63c6d018310feb93cd98fc0 AS go
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node

FROM rust:1.99.0-bookworm@sha256:114c7a4425406451c2866b6aafe69fe29b1b298832db1277d411ac73c82d04d6 AS base
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
# BoringSSL (through btls-sys) needs cmake, clang and perl; bindgen needs libclang. The gates
# need jq and binutils (size), actionlint runs shellcheck, and the scripts run on Python.
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake clang libclang-dev perl python3 jq shellcheck binutils \
 && rm -rf /var/lib/apt/lists/*
# The plugin tests build Go plugins with cgo; the dashboard builds with Node.
COPY --from=go /usr/local/go /usr/local/go
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
ENV PATH=/usr/local/go/bin:$PATH GOTOOLCHAIN=local
RUN rustup component add rustfmt clippy \
 && cargo install --locked cargo-nextest --version 0.9.148
# Pinned with their checksums in .github/ci/pins.env. Without --features cli, cargo-about
# installs no binary and still exits 0.
COPY .github/ci/pins.env /tmp/pins.env
ARG TARGETARCH
RUN . /tmp/pins.env \
 && cargo install --locked cargo-about --version "$CARGO_ABOUT_VERSION" --features cli \
 && sha="ACTIONLINT_SHA256_${TARGETARCH^^}" \
 && archive="actionlint_${ACTIONLINT_VERSION}_linux_${TARGETARCH}.tar.gz" \
 && curl -fsSL --retry 3 -o "/tmp/$archive" "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/$archive" \
 && echo "${!sha}  /tmp/$archive" | sha256sum -c - \
 && tar -xzf "/tmp/$archive" -C /usr/local/bin actionlint \
 && rm -rf "/tmp/$archive" /tmp/pins.env "$CARGO_HOME/registry"
# The checks run as an ordinary user: as root, file-permission tests pass for the wrong reason.
RUN useradd --create-home --uid 1000 builder && install -d -o builder -g builder /src
USER builder
WORKDIR /src
ENV CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=always GOFLAGS=-modcacherw

# The dashboard's packages, in their own layer so a source edit does not reinstall them.
FROM base AS deps
COPY --chown=builder:builder ui/package.json ui/package-lock.json ui/
RUN --mount=type=cache,id=cook-router-npm,target=/home/builder/.npm,uid=1000,gid=1000 \
    cd ui && npm ci --no-audit --no-fund

# Type check, lint, API and i18n checks, unit tests, build, design and bundle-size gates. The
# API check reads the Rust routes, so the whole tree is copied.
FROM deps AS dashboard
COPY --chown=builder:builder . .
RUN cd ui && npm run check

# The tree with the dashboard build that the binary embeds (crates/cpa-server/build.rs), and
# every dependency fetched, so the stages below build offline.
FROM deps AS source
COPY --chown=builder:builder . .
COPY --from=dashboard --chown=builder:builder /src/ui/dist ui/dist
RUN --mount=type=cache,id=cook-router-cargo-registry,target=/usr/local/cargo/registry,uid=1000,gid=1000 \
    --mount=type=cache,id=cook-router-go-mod,target=/home/builder/go/pkg/mod,uid=1000,gid=1000 \
    cargo fetch --locked \
 && cargo fetch --locked --manifest-path vendor/gjson/Cargo.toml \
 && cargo fetch --locked --manifest-path harness/rust/Cargo.toml \
 && (cd crates/cpa-plugin/tests/goplugins && go mod download)
# No debug info in test builds: linking about 55 test binaries with full debug info was most
# of a warm build. Panic messages keep their file and line.
ENV CARGO_NET_OFFLINE=true CARGO_PROFILE_TEST_DEBUG=0 GOPROXY=off

FROM source AS check
RUN --mount=type=cache,id=cook-router-cargo-registry,target=/usr/local/cargo/registry,uid=1000,gid=1000 \
    --mount=type=cache,id=cook-router-target-check,target=/src/target,uid=1000,gid=1000 <<'EOF'
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo clippy -p cpa-server --all-targets --features media-relay,pprof --locked -- -D warnings
cargo check --locked --manifest-path harness/rust/Cargo.toml --target-dir target
actionlint -version
# Every workflow by name: without .git in the context, actionlint finds no project.
actionlint .github/workflows/*.yml
python3 -I tools/third-party-notices.py --check
python3 -I -m unittest discover -s tools
python3 -I -m unittest discover -s .github/scripts -p 'test_*.py'
EOF

# The workspace tests with no network: a test that tries to reach a real provider fails
# instead of sending anything. Nextest assigns each test to one of SHARDS shards by a hash
# of its name (.config/nextest.toml sets the exclusive and setup-script tests); the last
# shard also runs the doc tests, the patched gjson in vendor/, which is outside the
# workspace, and the cache replay script's tests, and the first the media relay and CPU
# profiler tests. CPA_TEST_NO_SKIP turns a skip for a missing Go toolchain into a failure.
# /home/builder/out holds the list and counts the test-report stage exports for
# .github/scripts/test-counts.py. CI_COMMIT changes on every commit, so a cached run cannot
# stand in for a new commit's. Nextest runs one test per CPU; on a large shared machine pass
# --build-arg TEST_THREADS=8, as tests with lock and wall-clock bounds time out when
# dozens run at once.
FROM source AS test
ARG SHARD=1 SHARDS=1 CI_COMMIT= TEST_THREADS
ENV CPA_TEST_NO_SKIP=1
RUN --network=none \
    --mount=type=cache,id=cook-router-cargo-registry,target=/usr/local/cargo/registry,uid=1000,gid=1000 \
    --mount=type=cache,id=cook-router-go-mod,target=/home/builder/go/pkg/mod,uid=1000,gid=1000 \
    --mount=type=cache,id=cook-router-target-test,target=/src/target,uid=1000,gid=1000 <<'EOF'
echo "commit ${CI_COMMIT:-local}, shard $SHARD of $SHARDS"
out=/home/builder/out && mkdir -p "$out"
partition="--partition hash:$SHARD/$SHARDS"
threads=${TEST_THREADS:+--test-threads $TEST_THREADS}
cargo nextest run --workspace --locked --profile ci $partition $threads 2>&1 | tee "$out/test.log"
cargo nextest list --workspace --locked --profile ci $partition --message-format json > "$out/nextest-list.json"
if [ "$SHARD" = "$SHARDS" ]; then
  cargo test --workspace --doc --locked 2>&1 | tee -a "$out/test.log"
  cargo test --locked --manifest-path vendor/gjson/Cargo.toml --target-dir target 2>&1 | tee -a "$out/test.log"
  python3 bench/test-claude-cache-replay.py 2>&1 | tee -a "$out/test.log"
fi
if [ "$SHARD" = 1 ]; then
  cargo nextest run -p cpa-server --features media-relay,pprof --lib --locked --profile ci $threads
fi
python3 .github/scripts/test-counts.py shard "$SHARD" "$out/nextest-list.json" "$out/test.log" > "$out/counts-$SHARD.json"
cat "$out/counts-$SHARD.json"
EOF

FROM scratch AS test-report
COPY --from=test /home/builder/out/ /

# The release binary. The default build excludes the CPU profiler and its symbol resolver.
FROM source AS build
ARG BUILD_JOBS
RUN --mount=type=cache,id=cook-router-cargo-registry,target=/usr/local/cargo/registry,uid=1000,gid=1000 \
    --mount=type=cache,id=cook-router-target-release,target=/src/target,uid=1000,gid=1000 <<'EOF'
if cargo tree --locked -p cook-router --edges normal --prefix none | grep -E '^(pprof|backtrace) v'; then
  echo 'Release binaries must exclude CPU profiling and symbol resolution'
  exit 1
fi
cargo build --release --locked -p cook-router ${BUILD_JOBS:+--jobs "$BUILD_JOBS"}
install -D -m 0755 target/release/cook-router /home/builder/out/cook-router
EOF

# Bytes and counts against bench/budgets.txt, never elapsed time, with no network and nothing
# else building. A target without budget lines (aarch64 so far) is measured and printed only.
FROM build AS perf
ARG CI_COMMIT=
RUN --network=none \
    --mount=type=cache,id=cook-router-cargo-registry,target=/usr/local/cargo/registry,uid=1000,gid=1000 <<'EOF'
echo "commit ${CI_COMMIT:-local}"
target=$(rustc -vV | sed -n 's/^host: //p')
# Every gate runs, so one failure does not hide another's numbers.
failed=0
bench/gate.sh size "$target" /home/builder/out/cook-router || failed=1
bench/gate.sh idle linux /home/builder/out/cook-router 1 || failed=1
bench/gate.sh idle linux /home/builder/out/cook-router 2000 || failed=1
exit "$failed"
EOF

# The image. The binary links glibc and libstdc++, so a slim Debian base is the smallest image
# that runs it unchanged.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS runtime
# Links the GitHub package to this repository, so release.yml can push with its token.
LABEL org.opencontainers.image.source=https://github.com/prep-cook/cook-router
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 cook-router \
 && useradd --system --uid 10001 --gid 10001 --home-dir /data --shell /usr/sbin/nologin cook-router \
 && mkdir -p /data \
 && chown cook-router:cook-router /data
COPY --from=build /home/builder/out/cook-router /usr/local/bin/cook-router
# The license, the MIT notices it carries forward, and the third-party licenses the binary needs.
COPY LICENSE LICENSE-MIT NOTICE THIRD-PARTY-NOTICES /usr/share/doc/cook-router/
USER cook-router
# Config and credentials live in /data; mount a volume there. No VOLUME instruction:
# some hosts, Railway among them, refuse to build a Dockerfile that has one.
WORKDIR /data
EXPOSE 8317
ENTRYPOINT ["cook-router"]
CMD ["--config", "/data/config.yaml"]
