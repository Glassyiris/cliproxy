#!/usr/bin/env python3
"""Check a pull request title, which becomes the squash commit's subject (CONTRIBUTING.md).

    PR_TITLE='ui: keep Overview tiles whole' pr-title.py
    pr-title.py 'ui: keep Overview tiles whole'

The title is `<area>: <subject>`, or `<area>, <area>: <subject>` for a change that spans
areas. Each area comes from AREAS. The subject is an imperative phrase that starts in lower
case (a first word such as `OAuth` or `TLS`, with a capital after its first letter, may keep
its case) and does not end with a full stop. The whole title fits in MAX_LENGTH characters,
leaving room for the ` (#123)` GitHub appends.
"""
import os
import re
import sys

AREAS = {
    "cli": "the cook-router binary: command line, TUI, discovery, Home node (crates/cook-router)",
    "server": "HTTP routes, client auth, credential selection, management API (crates/cpa-server)",
    "exec": "upstream provider executors (crates/cpa-exec)",
    "translate": "request and response translation (crates/cpa-translate)",
    "core": "config, credentials, formats, shared helpers (crates/cpa-core, crates/cpa-common)",
    "plugin": "the native plugin host and plugin store (crates/cpa-plugin)",
    "store": "remote and local config and auth stores (crates/cpa-store)",
    "home": "the Home control-plane client (crates/cpa-home)",
    "ui": "the dashboard (ui/)",
    "installer": "install.sh and install.ps1",
    "docker": "the Dockerfile and image",
    "packaging": "Homebrew, winget and AUR manifests (packaging/)",
    "ci": "workflows and CI scripts (.github/)",
    "docs": "README, docs/ and other documentation",
    "deps": "dependency updates",
    "bench": "benchmarks, gates and the harness (bench/, harness/)",
    "tools": "repository tools (tools/)",
    "release": "release preparation: version, changelog",
}
MAX_LENGTH = 72
TITLE = re.compile(r"(?P<areas>[a-z]+(?:, [a-z]+)*): (?P<subject>\S.*)")


def problems(title):
    """Every rule the title breaks, as sentences; empty when it is valid."""
    found = []
    if title != title.strip():
        found.append("Remove the spaces around the title.")
    title = title.strip()
    if len(title) > MAX_LENGTH:
        found.append(f"Shorten the title to {MAX_LENGTH} characters; it has {len(title)}.")
    match = TITLE.fullmatch(title)
    if not match:
        found.append("Start the title with an area and a colon, such as `ui: keep Overview tiles whole`.")
        return found
    unknown = [a for a in match["areas"].split(", ") if a not in AREAS]
    if unknown:
        found.append(f"Unknown area {', '.join(unknown)}; use one of: {', '.join(AREAS)}.")
    subject = match["subject"]
    word = subject.split()[0]
    if word[0].isupper() and not any(c.isupper() for c in word[1:]):
        found.append(f"Start the subject in lower case: {word[0].lower()}{word[1:]}.")
    if subject.endswith("."):
        found.append("Drop the full stop at the end.")
    if re.match(r"wip\b|fixup!|squash!", subject, re.IGNORECASE):
        found.append("Finish the change before the title says it is done; drop WIP, fixup! or squash!.")
    return found


def main(argv):
    title = argv[1] if len(argv) > 1 else os.environ.get("PR_TITLE", "")
    found = problems(title)
    for problem in found:
        print(f"::error title=Pull request title::{problem}")
    if found:
        print(f"Title: {title!r}. Rules: CONTRIBUTING.md, Commits and pull request titles.")
        return 1
    print(f"Title OK: {title}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
