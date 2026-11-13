#!/usr/bin/env python3
"""Check workspace dependency edges against the table in crates/AGENTS.md.

Reads `cargo metadata` and fails (exit 1) on any edge between workspace crates that the
"Allowed dependency directions" table does not list, on a workspace crate without a row, and
on metadata that lists no workspace members or lacks a package record for a member.
Normal, build and dev edges are checked alike, whatever their feature or target condition;
the one extra allowance is a crate naming itself as a dev dependency to turn on its own
test features. Usage: python3 -I tools/check-crate-deps.py [--metadata FILE]
"""

import argparse
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TABLE_FILE = ROOT / "crates" / "AGENTS.md"
TABLE_HEADER = "| Crate | May depend on |"


def parse_table(text):
    """Return {crate: set of allowed dependencies} from the table under TABLE_HEADER."""
    lines = [line.strip() for line in text.splitlines()]
    try:
        start = lines.index(TABLE_HEADER)
    except ValueError:
        raise SystemExit(f"{TABLE_FILE}: no table headed {TABLE_HEADER!r}")
    allowed = {}
    for line in lines[start + 2:]:
        if not line.startswith("|"):
            break
        cells = [c.strip() for c in line.strip("|").split("|")]
        crate = cells[0].strip("`")
        allowed[crate] = set(re.findall(r"`([^`]+)`", cells[1]))
    return allowed


def violations(metadata, allowed):
    members = set(metadata["workspace_members"])
    packages = [p for p in metadata["packages"] if p["id"] in members]
    names = {p["name"] for p in packages}
    found = []
    if not members:
        found.append("the metadata lists no workspace members")
    for member in sorted(members - {p["id"] for p in packages}):
        found.append(f"{member}: workspace member has no package record")
    for name in sorted(names - allowed.keys()):
        found.append(f"{name}: workspace crate missing from the table")
    for package in sorted(packages, key=lambda p: p["name"]):
        for dep in package["dependencies"]:
            target = dep["name"]
            if target not in names:
                continue
            kind = dep["kind"] or "normal"
            if kind == "dev" and target == package["name"]:
                continue
            if target in allowed.get(package["name"], set()):
                continue
            conditions = [c for c in (
                f"target {dep['target']}" if dep.get("target") else "",
                "optional" if dep.get("optional") else "",
            ) if c]
            suffix = f" ({', '.join(conditions)})" if conditions else ""
            found.append(f"{package['name']} -> {target}: forbidden {kind} dependency{suffix}")
    return found


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--metadata", help="read cargo metadata JSON from FILE instead of running cargo")
    args = parser.parse_args()
    if args.metadata:
        metadata = json.loads(pathlib.Path(args.metadata).read_text())
    else:
        metadata = json.loads(subprocess.run(
            ["cargo", "metadata", "--format-version", "1", "--no-deps", "--locked"],
            cwd=ROOT, check=True, capture_output=True, text=True).stdout)
    found = violations(metadata, parse_table(TABLE_FILE.read_text()))
    for line in found:
        print(line, file=sys.stderr)
    if found:
        print(f"{len(found)} edge(s) break the table in {TABLE_FILE.relative_to(ROOT)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
