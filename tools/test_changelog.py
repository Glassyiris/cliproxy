"""Tests for tools/changelog.py. Run: python3 -I -m unittest discover -s tools"""

import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

import changelog
from changelog import FRAGMENT_NOTE, FragmentError, parse_fragment, release, render

HISTORY = (
    "\n## [1.0.0] - 2026-09-30\n\n### Fixed\n\n- Previous fix. (#7)\n\n"
    "[Unreleased]: https://github.com/example/project/compare/v1.0.0...HEAD\n"
    "[1.0.0]: https://github.com/example/project/releases/tag/v1.0.0\n"
)


def git(root, *args):
    return subprocess.run(
        ["git", *args], cwd=root, capture_output=True, text=True, check=True
    ).stdout.strip()


def offline(program, args, cwd=None):
    raise RuntimeError(f"{program} unavailable")


class Repo(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="cliproxy-changelog-")
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        (self.root / "changes").mkdir()
        (self.root / "changes/README.md").write_text("# Not a fragment\n")
        self.changelog = self.root / "CHANGELOG.md"
        self.write_changelog(f"# Changelog\n\n## [Unreleased]\n\n{FRAGMENT_NOTE}\n{HISTORY}")
        git(self.root, "init", "-q")
        git(self.root, "config", "user.name", "Changelog test")
        git(self.root, "config", "user.email", "changelog@example.invalid")
        git(self.root, "config", "commit.gpgsign", "false")
        git(self.root, "add", ".")
        git(self.root, "commit", "-qm", "initial release")

    def write_changelog(self, text):
        self.changelog.write_text(text)

    def add(self, name, text):
        (self.root / "changes" / name).write_text(text)
        git(self.root, "add", "changes")
        git(self.root, "commit", "-qm", "add fragment")
        return git(self.root, "rev-parse", "HEAD")

    def git_runner(self, numbers=None):
        """Run real git; answer gh from `numbers` (sha -> PR number)."""

        def runner(program, args, cwd=None):
            if program == "git":
                return subprocess.run(
                    ["git", *args], cwd=self.root, capture_output=True, text=True, check=True
                ).stdout
            sha = re.search(r"commits/([a-f0-9]+)/pulls$", args[1]).group(1)
            if sha not in numbers:
                raise RuntimeError("wrong commit")
            return json.dumps([{"number": 99, "merged_at": None}, {"number": numbers[sha], "merged_at": "2026-10-01"}])

        return runner


class ParseFragment(unittest.TestCase):
    def test_accepts_every_type_and_blank_lines(self):
        for kind in changelog.TYPES:
            self.assertEqual(
                parse_fragment(f"{kind}\n\n- One.\n\n- Two.\n", "x.md"), (kind, ["- One.", "- Two."])
            )

    def test_rejects_malformed_fragments_with_filename(self):
        for text in ["Other\n- Entry.", "Fixed", "Fixed\nEntry.", "Fixed\n- ", "- Entry.", "", "fixed\n- Entry."]:
            with self.subTest(text=text):
                with self.assertRaisesRegex(FragmentError, r"^bad\.md: expected a changelog type"):
                    parse_fragment(text, "bad.md")


class Render(Repo):
    def test_groups_in_changelog_order_and_uses_the_adding_commit(self):
        internal = self.add("a-internal.md", "Internal\n\n- Contributor tooling.\n")
        fixed = self.add("z-fix.md", "Fixed\n\n- First fix.\n- Second fix.\n")
        added = self.add("b-add.md", "Added\n\n- New feature.\n")
        (self.root / "changes/z-fix.md").write_text("Fixed\n\n- Edited fix.\n- Second fix.\n")
        git(self.root, "commit", "-qam", "edit fragment")
        runner = self.git_runner({internal: 10, fixed: 11, added: 12})
        self.assertEqual(
            render(self.root, runner)[0],
            "## [Unreleased]\n\n### Added\n\n- New feature. (#12)\n\n### Fixed\n\n"
            "- Edited fix. (#11)\n- Second fix. (#11)\n\n### Internal\n\n- Contributor tooling. (#10)\n",
        )

    def test_warns_and_omits_numbers_when_github_is_unavailable(self):
        self.add("fix.md", "Fixed\n\n- Offline fix.\n")
        warnings = []

        def runner(program, args, cwd=None):
            if program == "git":
                return git(self.root, *args)
            raise RuntimeError("offline")

        section, _ = render(self.root, runner, warnings.append)
        self.assertEqual(section, "## [Unreleased]\n\n### Fixed\n\n- Offline fix.\n")
        self.assertRegex(warnings[0], r"changes/fix\.md: omitting PR number: offline")

    def test_warns_when_no_pr_is_associated(self):
        self.add("fix.md", "Fixed\n\n- Fix.\n")

        def runner(program, args, cwd=None):
            return git(self.root, *args) if program == "git" else "[]"

        warnings = []
        self.assertNotIn("(#", render(self.root, runner, warnings.append)[0])
        self.assertRegex(warnings[0], "no associated PR found")

    def test_backfilled_numbers_are_kept(self):
        backfill = self.add("old.md", "Changed\n\n- Earlier change. (#3)\n- Another one. (#3)\n")
        mixed = self.add("mixed.md", "Fixed\n\n- Named fix. (#4)\n- New fix.\n")
        asked = []
        runner = self.git_runner({backfill: 20, mixed: 21})

        def counting(program, args, cwd=None):
            if program == "gh":
                asked.append(args[1])
            return runner(program, args, cwd)

        self.assertEqual(
            render(self.root, counting)[0],
            "## [Unreleased]\n\n### Changed\n\n- Earlier change. (#3)\n- Another one. (#3)\n\n"
            "### Fixed\n\n- Named fix. (#4)\n- New fix. (#21)\n",
        )
        # A fragment whose bullets all carry a number needs no lookup.
        self.assertEqual(asked, [f"repos/{{owner}}/{{repo}}/commits/{mixed}/pulls"])

    def test_empty_directory_and_uncommitted_fragment(self):
        self.assertEqual(render(self.root, offline, lambda _: None)[0], "## [Unreleased]\n")
        (self.root / "changes/new.md").write_text("Added\n\n- Uncommitted change.\n")
        warnings = []
        section, _ = render(self.root, self.git_runner({}), warnings.append)
        self.assertIn("- Uncommitted change.\n", section)
        self.assertRegex(warnings[0], "no commit adding this fragment")

    def test_every_type_in_order_and_filenames_sorted_within_a_type(self):
        for kind in ["Internal", "Security", "Removed", "Fixed", "Changed", "Added"]:
            (self.root / f"changes/z-{kind.lower()}.md").write_text(f"{kind}\n\n- {kind} entry.\n")
        (self.root / "changes/a-fixed.md").write_text("Fixed\n\n- Earlier filename.\n")
        section, _ = render(self.root, offline, lambda _: None)
        self.assertEqual(
            re.findall(r"^### .+$", section, re.M),
            ["### Added", "### Changed", "### Fixed", "### Removed", "### Security", "### Internal"],
        )
        self.assertIn("### Fixed\n\n- Earlier filename.\n- Fixed entry.", section)

    def test_rejects_a_filename_that_is_not_a_slug(self):
        (self.root / "changes/Bad_Name.md").write_text("Fixed\n\n- Fix.\n")
        with self.assertRaisesRegex(FragmentError, "Bad_Name.md: use a lowercase branch slug"):
            render(self.root, offline, lambda _: None)


class Release(Repo):
    def test_collects_fragments_updates_links_and_keeps_history(self):
        self.add("fix.md", "Fixed\n\n- Released fix.\n")
        self.add("internal.md", "Internal\n\n- Tooling change.\n")
        release("1.1.0-beta.1", "2026-10-03", self.root, offline, lambda _: None)
        self.assertEqual(
            self.changelog.read_text(),
            f"# Changelog\n\n## [Unreleased]\n\n{FRAGMENT_NOTE}\n\n## [1.1.0-beta.1] - 2026-10-03\n\n"
            "### Fixed\n\n- Released fix.\n\n### Internal\n\n- Tooling change.\n"
            + HISTORY.replace(
                "[Unreleased]: https://github.com/example/project/compare/v1.0.0...HEAD",
                "[Unreleased]: https://github.com/example/project/compare/v1.1.0-beta.1...HEAD\n"
                "[1.1.0-beta.1]: https://github.com/example/project/compare/v1.0.0...v1.1.0-beta.1",
            ),
        )
        self.assertEqual([p.name for p in (self.root / "changes").iterdir()], ["README.md"])

    def test_first_release_has_no_earlier_tag_to_compare(self):
        self.write_changelog(f"# Changelog\n\n## [Unreleased]\n\n{FRAGMENT_NOTE}\n")
        self.add("add.md", "Added\n\n- First feature.\n")
        release("0.1.0", "2026-11-09", self.root, offline, lambda _: None)
        text = self.changelog.read_text()
        self.assertIn("## [0.1.0] - 2026-11-09\n\n### Added\n\n- First feature.\n", text)
        self.assertTrue(
            text.endswith(
                f"[Unreleased]: {changelog.REPO_URL}/compare/v0.1.0...HEAD\n"
                f"[0.1.0]: {changelog.REPO_URL}/releases/tag/v0.1.0\n"
            )
        )

    def test_literal_replacement_tokens_survive(self):
        bullet = "- Keep `\\1`, `\\g<0>` and `$&` as written."
        self.add("tokens.md", f"Fixed\n\n{bullet}\n")
        release("1.1.0", "2026-10-03", self.root, offline, lambda _: None)
        self.assertIn(bullet, self.changelog.read_text())

    def test_refuses_invalid_or_duplicate_versions_without_consuming_fragments(self):
        self.add("fix.md", "Fixed\n\n- Keep this fix.\n")
        before = self.changelog.read_text()
        for version, date in [("v1.1.0", "2026-10-03"), ("1.01.0", "2026-10-03"), ("1.1.0", "2026-02-30"), ("1.0.0", "2026-10-03")]:
            with self.subTest(version=version, date=date):
                with self.assertRaises(ValueError):
                    release(version, date, self.root, offline, lambda _: None)
                self.assertEqual(self.changelog.read_text(), before)
                self.assertTrue((self.root / "changes/fix.md").exists())

    def test_refuses_handwritten_entries_and_empty_releases(self):
        with self.assertRaisesRegex(ValueError, "no changelog fragments"):
            release("1.1.0", "2026-10-03", self.root, offline, lambda _: None)
        self.add("fix.md", "Fixed\n\n- Keep this fix.\n")
        handwritten = f"# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Existing entry.\n{HISTORY}"
        self.write_changelog(handwritten)
        with self.assertRaisesRegex(ValueError, "handwritten Unreleased"):
            release("1.1.0", "2026-10-03", self.root, offline, lambda _: None)
        self.assertEqual(self.changelog.read_text(), handwritten)

    def test_a_malformed_fragment_blocks_the_release(self):
        (self.root / "changes/good.md").write_text("Fixed\n\n- Keep this fix.\n")
        (self.root / "changes/bad.md").write_text("Typo\n\n- Invalid entry.\n")
        before = self.changelog.read_text()
        with self.assertRaisesRegex(FragmentError, "bad.md: expected a changelog type"):
            release("1.1.0", "2026-10-03", self.root, offline, lambda _: None)
        self.assertEqual(self.changelog.read_text(), before)
        self.assertTrue((self.root / "changes/good.md").exists())


class NeedsFragment(unittest.TestCase):
    def test_shipped_paths_need_a_fragment(self):
        for path in [
            "crates/cpa-server/src/lib.rs", "ui/src/app/App.tsx", "ui/dist/assets/a.js", "ui/index.html",
            "ui/public/favicon.svg", "install.sh", "install.ps1", "Dockerfile", "vendor/gjson/a.go",
            "Cargo.toml", "Cargo.lock", "crates/cliproxy/Cargo.toml",
        ]:
            with self.subTest(path=path):
                self.assertTrue(changelog.needs_fragment([path]))

    def test_tests_docs_and_tooling_are_exempt(self):
        for path in [
            "crates/cpa-server/tests/alloc_budget.rs", "crates/cpa-server/tests/ws_fixtures/a.json",
            "crates/cliproxy/examples/x.rs", "ui/src/app/useAction.test.ts", "ui/src/a/B.test.tsx",
            "ui/src/a/README.md", "crates/cliproxy/README.md", "docs/INSTALL.md", "README.md", "CONTRIBUTING.md",
            "bench/budgets.txt", "harness/run", ".github/workflows/ci.yml", "ui/scripts/x.mjs",
            "ui/package.json", "tools/changelog.py", "changes/fix.md", "packaging/aur/PKGBUILD",
        ]:
            with self.subTest(path=path):
                self.assertFalse(changelog.needs_fragment([path]))

    def test_one_shipped_path_among_exempt_ones_is_enough(self):
        self.assertTrue(changelog.needs_fragment(["README.md", "crates/cpa-core/src/lib.rs", "docs/a.md"]))


class ParseDiff(unittest.TestCase):
    def test_collects_paths_fragments_and_added_flag(self):
        diff = "A\0changes/fix.md\0M\0crates/a/src/lib.rs\0R100\0changes/old.md\0changes/new.md\0D\0changes/gone.md\0"
        paths, validate, added = changelog.parse_diff(diff)
        self.assertEqual(validate, ["changes/fix.md", "changes/new.md"])
        self.assertTrue(added)
        self.assertIn("changes/old.md", paths)

    def test_edit_or_rename_alone_does_not_count_as_added(self):
        _, _, added = changelog.parse_diff("M\0changes/fix.md\0R100\0changes/a.md\0changes/b.md\0")
        self.assertFalse(added)

    def test_rejects_truncated_or_unknown_output(self):
        for diff in ["M\0a", "Z\0a\0", "R100\0a\0"]:
            with self.subTest(diff=diff):
                with self.assertRaises(ValueError):
                    changelog.parse_diff(diff)


class CheckPullRequest(Repo):
    def commit(self, files):
        for name, text in files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        git(self.root, "add", ".")
        git(self.root, "commit", "-qm", "change")

    def run_check(self, labels=()):
        changelog.check_pull_request("HEAD~1", "HEAD", list(labels), self.root, self.git_runner())

    def test_shipped_change_without_fragment_fails_unless_labelled(self):
        self.commit({"crates/a/src/lib.rs": "fn main() {}\n"})
        with self.assertRaisesRegex(FragmentError, "must add a new changes/<branch-slug>.md"):
            self.run_check()
        self.run_check(["no-changelog"])

    def test_shipped_change_with_a_new_fragment_passes(self):
        self.commit({"crates/a/src/lib.rs": "x\n", "changes/fix-a.md": "Fixed\n\n- Fix.\n"})
        self.run_check()

    def test_docs_only_change_needs_no_fragment(self):
        self.commit({"docs/a.md": "x\n"})
        self.run_check()

    def test_bad_fragment_fails_even_with_the_label_and_names_the_file(self):
        self.commit({"changes/fix-a.md": "Oops\n\n- Fix.\n"})
        with self.assertRaisesRegex(FragmentError, r"^fix-a\.md: expected a changelog type"):
            self.run_check(["no-changelog"])

    def test_bad_filename_fails(self):
        self.commit({"changes/Fix_A.md": "Fixed\n\n- Fix.\n"})
        with self.assertRaisesRegex(FragmentError, "Fix_A.md: use a lowercase branch slug"):
            self.run_check()


if __name__ == "__main__":
    unittest.main()
