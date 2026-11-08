#!/usr/bin/env python3
"""Lane selection for ci.yml: which jobs a change needs.

    ci-lanes.py                       in the changes job: reads the GitHub event, writes
                                      <lane>=true|false and lanes=<JSON list> to
                                      $GITHUB_OUTPUT and a table to the job summary
    ci-lanes.py --diff <base> <head>  locally: the lanes for the commits between two refs
    ci-lanes.py --paths <path>...     locally: the lanes for a list of changed paths

A push to master, a manual run, the call from release.yml, a pull request labelled
`ci:full`, and any change this script cannot read run every lane. Otherwise each changed
path selects the lanes listed by the first rule it matches, and a path no rule matches
selects every lane, so a new top-level file or directory runs everything until a rule
says otherwise. A pull request is read as GitHub's test merge commit against its first
parent, the base branch tip: exactly what merging would change.

Lanes and the jobs they run:
  dashboard  dashboard checks and the committed-build comparison
  tests      the two Linux test shards and the test counts
  lint       fmt, clippy, the harness check and the media relay tests
  windows    clippy and the file writer tests on Windows
  perf       the size gate and both idle gates on the release binary
  workflows  actionlint over every workflow
  notices    THIRD-PARTY-NOTICES against the dependency set
"""
import json
import os
import re
import subprocess
import sys

LANES = ("dashboard", "tests", "lint", "windows", "perf", "workflows", "notices")
ALL = frozenset(LANES)
NONE = frozenset()
# Everything that compiles the workspace.
RUST = frozenset({"tests", "lint", "windows", "perf"})

# (pattern for the whole path, lanes); the first match wins.
RULES = (
    # This workflow, its pins and this selector: a change here can alter any lane.
    (r"\.github/workflows/ci\.yml|\.github/ci/.*|\.github/scripts/(ci-lanes|test_ci_lanes)\.py", ALL),
    # Build tools for the Linux jobs that compile (idle.yml and install.yml use it too
    # and run on their own path filters).
    (r"\.github/scripts/apt-install\.sh", frozenset({"tests", "lint", "perf"})),
    (r"\.github/scripts/test-counts\.py", frozenset({"tests"})),
    # The other workflows run on their own path filters; here only actionlint reads them.
    (r"\.github/workflows/[^/]+", frozenset({"workflows"})),
    # Installers workflow (install.yml) only.
    (r"\.github/scripts/(test-installers\.py|installer-fixture\.rs)", NONE),
    # Repository metadata that no job reads.
    (r"\.github/(ISSUE_TEMPLATE/.*|PULL_REQUEST_TEMPLATE/.*|pull_request_template[^/]*"
     r"|CODEOWNERS|dependabot\.yml|[^/]+\.md)", NONE),
    # Documentation. README.md, LICENSE, LICENSE-MIT and NOTICE also go into the archive the
    # size gate measures; their compressed bytes are far inside its 2% tolerance, and every
    # push to master measures them again.
    (r"[^/]+\.md|LICENSE[^/]*|NOTICE|CODEOWNERS|docs/.*|changes/.*|\.coderabbit\.yaml", NONE),
    # Installers, packaging and the image: install.yml, homebrew.yml and docker.yml.
    (r"install\.(sh|ps1)|packaging/.*|Dockerfile|\.dockerignore", NONE),
    # The dashboard job compares ui/dist with `git status`, which .gitignore can hide.
    (r"\.gitignore", frozenset({"dashboard"})),
    # crates/cpa-server/build.rs embeds ui/dist into the binary. The bytes change what the
    # size and idle gates measure, and the server tests serve those assets. Clippy and the
    # harness are not affected: the generated asset table has the same code for any file
    # set, so fmt, clippy (Linux and Windows) and the media relay tests see no change.
    (r"ui/dist/.*", frozenset({"dashboard", "tests", "perf"})),
    # THIRD-PARTY-NOTICES lists the npm packages the bundle pulls in, so the manifests, the
    # build config and the source (a new import can add a package) can each make it stale.
    (r"ui/(package(-lock)?\.json|vite\.config\.ts|tools/.*|src/.*)", frozenset({"dashboard", "notices"})),
    (r"ui/.*", frozenset({"dashboard"})),
    # Integration tests, examples and benches are test and clippy targets only; nothing
    # under them reaches the release binary (src/ includes fixtures from tests/ only in
    # #[cfg(test)] code), so the size and idle gates are not affected.
    (r"crates/[^/]+/(tests|examples|benches)/.*", frozenset({"tests", "lint", "windows"})),
    # The dependency set, which THIRD-PARTY-NOTICES lists (tools/third-party-notices.py).
    (r"Cargo\.(toml|lock)|crates/[^/]+/Cargo\.toml|vendor/.*", RUST | {"notices"}),
    (r"about\.toml|tools/third-party-notices\.py|THIRD-PARTY-NOTICES", frozenset({"notices"})),
    (r"crates/.*|\.config/.*|\.cargo/.*|clippy\.toml|rustfmt\.toml"
     r"|rust-toolchain(\.toml)?", RUST),
    # harness/rust is checked by the lint job only.
    (r"harness/.*", frozenset({"lint"})),
    # budgets.txt holds the heap gate's numbers (a test) and the size and idle budgets; the
    # gate scripts and the cache replay script (run by test shard 2) live here too.
    (r"bench/.*", frozenset({"tests", "perf"})),
)
_COMPILED = tuple((re.compile(pattern, re.DOTALL), lanes) for pattern, lanes in RULES)


def lanes_for(path):
    for pattern, lanes in _COMPILED:
        if pattern.fullmatch(path):
            return lanes
    return ALL


def classify(paths):
    """The lanes for a list of changed paths; none at all is unexpected and runs all."""
    paths = [path for path in paths if path]
    if not paths:
        return ALL
    selected = set()
    for path in paths:
        selected |= lanes_for(path)
    return frozenset(selected)


def changed_paths(base, head, git=None):
    """Both sides of every change between two commits, or None when git cannot say."""
    git = git or (lambda *args: subprocess.run(
        ("git", *args), check=True, capture_output=True, text=True).stdout)
    try:
        # --no-renames: a rename shows its old and its new path, and needs no blobs.
        out = git("diff", "--no-renames", "--name-only", "-z", base, head)
    except (OSError, subprocess.CalledProcessError):
        return None
    return [path for path in out.split("\0") if path]


def select(event_name, event, git=None):
    """(lanes, reason) for a workflow run."""
    if event_name != "pull_request":
        return ALL, f"{event_name or 'unknown'} event: every lane"
    labels = [label.get("name") for label in (event.get("pull_request") or {}).get("labels") or []]
    if "ci:full" in labels:
        return ALL, "ci:full label: every lane"
    git = git or (lambda *args: subprocess.run(
        ("git", *args), check=True, capture_output=True, text=True).stdout)
    try:
        parents = git("rev-list", "--parents", "-n", "1", "HEAD").split()
    except (OSError, subprocess.CalledProcessError):
        parents = []
    if len(parents) != 3:
        return ALL, "HEAD is not the test merge commit: every lane"
    paths = changed_paths("HEAD^1", "HEAD", git)
    if paths is None:
        return ALL, "git diff failed: every lane"
    if not paths:
        return ALL, "no changed paths: every lane"
    return classify(paths), f"{len(paths)} changed paths"


def write_outputs(lanes, reason):
    ordered = [lane for lane in LANES if lane in lanes]
    with open(os.environ["GITHUB_OUTPUT"], "a") as out:
        for lane in LANES:
            out.write(f"{lane}={'true' if lane in lanes else 'false'}\n")
        out.write(f"lanes={json.dumps(ordered)}\n")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as out:
            out.write(f"### Lanes\n\n{reason}\n\n| Lane | Runs |\n| --- | --- |\n")
            for lane in LANES:
                out.write(f"| {lane} | {'yes' if lane in lanes else 'no'} |\n")
    print(f"{reason}; lanes: {' '.join(ordered) or '(none)'}")


def main(argv):
    if argv[:1] == ["--paths"]:
        print(" ".join(lane for lane in LANES if lane in classify(argv[1:])) or "(none)")
        return 0
    if argv[:1] == ["--diff"] and len(argv) == 3:
        paths = changed_paths(argv[1], argv[2])
        lanes = ALL if paths is None else classify(paths)
        print(" ".join(lane for lane in LANES if lane in lanes) or "(none)")
        return 0
    if argv:
        print(__doc__, file=sys.stderr)
        return 2
    event_name = os.environ.get("GITHUB_EVENT_NAME", "")
    try:
        with open(os.environ["GITHUB_EVENT_PATH"]) as f:
            event = json.load(f)
    except (KeyError, OSError, ValueError):
        event = {}
        if event_name == "pull_request":
            write_outputs(ALL, "event payload unreadable: every lane")
            return 0
    lanes, reason = select(event_name, event)
    write_outputs(lanes, reason)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
