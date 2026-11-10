"""Tests for pr-title.py; the title job in changes.yml runs them before it checks the title.

    python3 -I -m unittest discover -s .github/scripts -p 'test_pr_title.py'
"""
import importlib.util
import pathlib
import unittest

_spec = importlib.util.spec_from_file_location(
    "pr_title", pathlib.Path(__file__).with_name("pr-title.py"))
pr_title = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pr_title)


class Titles(unittest.TestCase):
    def test_valid_titles_pass(self):
        for title in ("ui: keep Overview tiles whole on a phone",
                      "exec: retry a reset Claude stream once",
                      "installer, docs: reuse ~/.cliproxy-rs from before the rename",
                      "deps: bump the cargo group across 2 directories with 10 updates",
                      "server: OAuth sign-ins keep their state",
                      "store: SQLite keeps config and credentials",
                      "ci: run `cargo test` once"):
            self.assertEqual(pr_title.problems(title), [], title)

    def test_dependabot_titles_pass(self):
        self.assertEqual(pr_title.problems("deps: bump the actions group with 4 updates"), [])

    def test_missing_or_unknown_area_fails(self):
        self.assertTrue(pr_title.problems("Keep Overview tiles whole"))
        self.assertTrue(pr_title.problems("Dashboard: keep Overview tiles whole"))
        self.assertTrue(pr_title.problems("fix(ui): keep Overview tiles whole"))
        self.assertIn("Unknown area dashboard", pr_title.problems("dashboard: keep tiles whole")[0])
        self.assertTrue(pr_title.problems("ui,server: two areas need a space"))

    def test_subject_rules(self):
        self.assertTrue(pr_title.problems("ui: Keep Overview tiles whole"))
        self.assertTrue(pr_title.problems("ui: keep Overview tiles whole."))
        self.assertTrue(pr_title.problems("ui: WIP tiles"))
        self.assertTrue(pr_title.problems("ui: fixup! tiles"))
        self.assertTrue(pr_title.problems("ui:keep tiles"))
        self.assertTrue(pr_title.problems(" ui: keep tiles"))

    def test_length_leaves_room_for_the_pull_request_number(self):
        title = "ui: " + "a" * (pr_title.MAX_LENGTH - 4)
        self.assertEqual(pr_title.problems(title), [])
        self.assertTrue(pr_title.problems(title + "a"))

    def test_main_reads_the_environment(self):
        import contextlib, io, os
        os.environ["PR_TITLE"] = "ui: keep tiles whole"
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(pr_title.main(["pr-title.py"]), 0)
            self.assertEqual(pr_title.main(["pr-title.py", "Keep tiles"]), 1)


if __name__ == "__main__":
    unittest.main()
