#!/usr/bin/env python3
"""Changelog fragments: preview, check and release.

    python3 -I tools/changelog.py render
    python3 -I tools/changelog.py release <version> <YYYY-MM-DD>
    python3 -I tools/changelog.py check [--base REV --head REV] [--label NAME ...]

Format and policy: changes/README.md. Standard library only.
"""

from __future__ import annotations

import datetime
import json
import os
import re
import subprocess
import sys
from pathlib import Path

TYPES = ["Added", "Changed", "Fixed", "Removed", "Security", "Internal"]
FRAGMENT_NOTE = "Entries live in [changes/](changes/) until release."
REPO_URL = "https://github.com/prep-cook/cooker"
SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\.md")
SHA = re.compile(r"[a-f0-9]{40,64}")
NO_CHANGELOG = "no-changelog"

# Paths whose changes reach users: the Rust workspace, the dashboard sources, the
# Dockerfile, vendored code and the manifests.
SHIPPED = re.compile(
    r"^(?:crates/|ui/src/|ui/public/|vendor/)"
    r"|^(?:ui/index\.html|Dockerfile|Cargo\.toml|Cargo\.lock)$"
)
# Tests and examples under a shipped prefix. Markdown is exempt separately.
EXEMPT = re.compile(
    r"^crates/[^/]+/(?:tests|examples)/|\.(?:test|spec)\.tsx?$"
)


class FragmentError(ValueError):
    pass


def parse_fragment(text: str, file: str) -> tuple[str, list[str]]:
    """Return (type, bullets); raise FragmentError when the layout is wrong."""
    lines = text.strip().splitlines()
    kind = lines[0] if lines else ""
    bullets = [line for line in lines[1:] if line.strip()]
    if kind not in TYPES or not bullets or any(not re.match(r"- \S", b) for b in bullets):
        raise FragmentError(
            f"{file}: expected a changelog type ({', '.join(TYPES)}) followed by one or more '- ' bullet lines"
        )
    return kind, bullets


def run(program: str, args: list[str], cwd: Path | str | None = None) -> str:
    done = subprocess.run(
        [program, *args], cwd=cwd, capture_output=True, text=True, timeout=30, check=False
    )
    if done.returncode:
        raise RuntimeError((done.stderr.strip() or f"{program} exited {done.returncode}"))
    return done.stdout


def warn_stderr(message: str) -> None:
    print(message, file=sys.stderr)


def fragments(root: Path) -> list[tuple[str, str, list[str]]]:
    """Return sorted (path, type, bullets) for every fragment under changes/."""
    found = []
    for path in sorted((root / "changes").glob("*.md")):
        if path.name == "README.md":
            continue
        if not SLUG.fullmatch(path.name):
            raise FragmentError(f"{path.name}: use a lowercase branch slug")
        kind, bullets = parse_fragment(path.read_text(encoding="utf-8"), path.name)
        found.append((f"changes/{path.name}", kind, bullets))
    return found


def pr_number(file: str, root: Path, runner) -> int:
    sha = runner("git", ["log", "--diff-filter=A", "--format=%H", "-1", "--", file], root).strip()
    if not SHA.fullmatch(sha):
        raise RuntimeError("no commit adding this fragment in local history")
    pulls = json.loads(runner("gh", ["api", f"repos/{{owner}}/{{repo}}/commits/{sha}/pulls"], root))
    pull = next((p for p in pulls if p.get("merged_at")), pulls[0] if pulls else None)
    number = pull.get("number") if pull else None
    if not isinstance(number, int) or isinstance(number, bool) or number < 1:
        raise RuntimeError("no associated PR found")
    return number


NUMBERED = re.compile(r"\(#\d+\)$")


def render(root: Path, runner=run, warn=warn_stderr) -> tuple[str, list[str]]:
    found = fragments(root)
    groups: dict[str, list[str]] = {kind: [] for kind in TYPES}
    for file, kind, bullets in found:
        bullets = [b.rstrip() for b in bullets]
        suffix = ""
        # A bullet that already ends with "(#N)" keeps it: fragments written after their PR
        # merged (a backfill) name the PR the change came from, not the one that added them.
        if not all(NUMBERED.search(b) for b in bullets):
            try:
                suffix = f" (#{pr_number(file, root, runner)})"
            except Exception as error:  # git or gh missing, offline, no PR yet
                warn(f"changelog: {file}: omitting PR number: {error}")
        groups[kind].extend(b if NUMBERED.search(b) else f"{b}{suffix}" for b in bullets)
    sections = [f"### {kind}\n\n" + "\n".join(groups[kind]) for kind in TYPES if groups[kind]]
    return "\n\n".join(["## [Unreleased]", *sections]) + "\n", [f for f, _, _ in found]


def release(version: str, date: str, root: Path, runner=run, warn=warn_stderr) -> None:
    number = r"(?:0|[1-9]\d*)"
    ident = r"(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"
    semver = re.compile(
        rf"^{number}\.{number}\.{number}(?:-{ident}(?:\.{ident})*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
    )
    if not semver.match(version or ""):
        raise ValueError("release requires a SemVer version without a leading v")
    try:
        valid = re.fullmatch(r"\d{4}-\d{2}-\d{2}", date or "") and datetime.date.fromisoformat(date)
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("release requires a valid YYYY-MM-DD date")

    path = root / "CHANGELOG.md"
    changelog = path.read_text(encoding="utf-8")
    if f"## [{version}]" in changelog:
        raise ValueError(f"version {version} is already in CHANGELOG.md")
    unreleased = re.search(r"^## \[Unreleased\]\n(.*?)(?=^## \[|^\[[^\]]+\]: |\Z)", changelog, re.M | re.S)
    if not unreleased:
        raise ValueError("CHANGELOG.md has no Unreleased section")
    if unreleased.group(1).strip() not in (FRAGMENT_NOTE, ""):
        raise ValueError("release handwritten Unreleased entries before collecting fragments")
    section, files = render(root, runner, warn)
    if not files:
        raise ValueError("no changelog fragments to release")

    released = section.replace("## [Unreleased]", f"## [{version}] - {date}", 1)
    body = f"## [Unreleased]\n\n{FRAGMENT_NOTE}\n\n{released}\n"
    link = re.search(r"^\[Unreleased\]: (https://\S+/compare/)(\S+)\.\.\.HEAD$", changelog, re.M)
    if link:
        new_links = (
            f"[Unreleased]: {link.group(1)}v{version}...HEAD\n"
            f"[{version}]: {link.group(1)}{link.group(2)}...v{version}"
        )
        updated = changelog[: unreleased.start()] + body + changelog[unreleased.end():]
        updated = updated.replace(link.group(0), new_links, 1)
    else:
        # First release: no earlier tag to compare against.
        updated = changelog[: unreleased.start()] + body + changelog[unreleased.end():]
        updated = updated.rstrip("\n") + (
            f"\n\n[Unreleased]: {REPO_URL}/compare/v{version}...HEAD\n"
            f"[{version}]: {REPO_URL}/releases/tag/v{version}\n"
        )
    path.write_text(updated, encoding="utf-8")
    for file in files:
        (root / file).unlink()


def needs_fragment(paths: list[str]) -> bool:
    for path in paths:
        if not SHIPPED.search(path) or EXEMPT.search(path):
            continue
        if path.endswith(".md") and os.path.basename(path) != "CHANGELOG.md":
            continue
        return True
    return False


def parse_diff(diff: str) -> tuple[list[str], list[str], bool]:
    """Parse `git diff --name-status -z -M` output.

    Return (touched paths, fragments to validate, whether a new fragment was added).
    """
    if diff and not diff.endswith("\0"):
        raise ValueError("unrecognised git diff output")
    fields = diff[:-1].split("\0") if diff else []
    paths: list[str] = []
    to_validate: list[str] = []
    added = False
    while fields:
        status = fields.pop(0)
        count = 2 if re.fullmatch(r"[RC]\d+", status) else 1 if re.fullmatch(r"[ADMTUXB]", status) else 0
        if not count or len(fields) < count:
            raise ValueError(f"unrecognised git diff status {status!r}")
        changed = [fields.pop(0) for _ in range(count)]
        paths.extend(changed)
        file = changed[-1]
        if status != "D" and re.fullmatch(r"changes/[^/]+\.md", file) and file != "changes/README.md":
            to_validate.append(file)
        if status == "A" and re.fullmatch(r"changes/" + SLUG.pattern, changed[0]):
            added = True
    return paths, to_validate, added


def check_pull_request(base: str, head: str, labels: list[str], root: Path, runner=run) -> None:
    if not (base and head):
        raise ValueError("check needs both --base and --head")
    base, head = (runner("git", ["rev-parse", "--verify", f"{rev}^{{commit}}"], root).strip() for rev in (base, head))
    try:
        ancestor = runner("git", ["merge-base", base, head], root).strip()
    except RuntimeError:
        runner("git", ["fetch", "--no-tags", "--depth=64", "origin", base, head], root)
        ancestor = runner("git", ["merge-base", base, head], root).strip()
    diff = runner("git", ["diff", "--name-status", "-z", "-M", ancestor, head], root)
    paths, to_validate, added = parse_diff(diff)
    for file in to_validate:
        name = file.split("/", 1)[1]
        if not SLUG.fullmatch(name):
            raise FragmentError(f"{name}: use a lowercase branch slug")
        parse_fragment(runner("git", ["show", f"{head}:{file}"], root), name)
    if needs_fragment(paths) and not added and NO_CHANGELOG not in labels:
        raise FragmentError(
            "PRs touching shipped paths (crates/, ui/src/, ui/public/, ui/index.html, "
            "Dockerfile, vendor/, Cargo.toml, Cargo.lock) must add a new "
            f"changes/<branch-slug>.md fragment, or carry the {NO_CHANGELOG} label."
        )


def check(root: Path, base: str | None, head: str | None, labels: list[str]) -> None:
    if os.environ.get("GITHUB_EVENT_NAME") == "pull_request" and not (base or head):
        with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as handle:
            pull = json.load(handle)["pull_request"]
        base, head = pull["base"]["sha"], pull["head"]["sha"]
        labels = labels + [label["name"] for label in pull.get("labels", [])]
    fragments(root)  # every fragment in the tree must parse
    if base or head:
        check_pull_request(base or "", head or "", labels, root)


def main(argv: list[str]) -> int:
    root = Path.cwd()
    action, args = (argv[0] if argv else ""), argv[1:]
    try:
        if action == "render" and not args:
            sys.stdout.write(render(root)[0])
        elif action == "release" and len(args) == 2:
            release(args[0], args[1], root)
        elif action == "check":
            base = head = None
            labels: list[str] = []
            it = iter(args)
            for flag in it:
                value = next(it, None)
                if flag == "--base" and value:
                    base = value
                elif flag == "--head" and value:
                    head = value
                elif flag == "--label" and value:
                    labels.append(value)
                else:
                    raise ValueError("usage: changelog.py check [--base REV --head REV] [--label NAME ...]")
            check(root, base, head, labels)
        else:
            raise ValueError(
                "usage: changelog.py render | release <version> <date> | check [--base REV --head REV]"
            )
    except (ValueError, RuntimeError, OSError, KeyError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        print(f"changelog: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
