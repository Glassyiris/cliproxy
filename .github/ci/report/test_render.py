"""Tests for render.py; the changes job in ci.yml runs them on every run.

    python3 -I -m unittest discover -s .github/ci/report -p 'test_render.py'

Each directory under fixtures/ holds candidate/, an optional baseline/, context.json and the
comment it must render, expected.md, byte for byte.
"""
import importlib.util
import json
import pathlib
import tempfile
import unittest

HERE = pathlib.Path(__file__).parent
_spec = importlib.util.spec_from_file_location("render", HERE / "render.py")
render = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(render)

FIXTURES = sorted(path for path in (HERE / "fixtures").iterdir() if path.is_dir())


def rendered(fixture):
    context = json.loads((fixture / "context.json").read_text(encoding="utf-8"))
    baseline = fixture / "baseline"
    return render.render(fixture / "candidate", baseline if baseline.is_dir() else None, context)


class Fixtures(unittest.TestCase):
    def test_the_cases_are_covered(self):
        self.assertEqual({path.name for path in FIXTURES},
                         {"ordinary", "no-baseline", "lane-not-run", "over-ceiling"})

    def test_each_fixture_renders_its_expected_comment(self):
        for fixture in FIXTURES:
            with self.subTest(fixture=fixture.name):
                expected = (fixture / "expected.md").read_text(encoding="utf-8")
                self.assertEqual(rendered(fixture), expected)

    def test_every_comment_carries_the_marker_once(self):
        for fixture in FIXTURES:
            with self.subTest(fixture=fixture.name):
                self.assertEqual(rendered(fixture).count(render.MARKER), 1)


def lane(lane_name="dashboard", **metric):
    entry = {"key": "initialJs", "value": 1, "ceiling": 2, "unit": "bytes"} | metric
    return {"schema_version": 1, "lane": lane_name, "metrics": [entry]}


class Validation(unittest.TestCase):
    def check_rejected(self, data, stem="dashboard"):
        with self.assertRaises(render.Invalid):
            render.parse(stem, data)

    def test_a_valid_report_parses(self):
        self.assertEqual(render.parse("dashboard", lane()),
                         {"initialJs": {"value": 1, "ceiling": 2, "unit": "bytes", "detail": None}})

    def test_reports_that_break_the_schema_are_rejected(self):
        self.check_rejected([])
        self.check_rejected(lane() | {"schema_version": 2})
        self.check_rejected(lane() | {"schema_version": True})
        self.check_rejected(lane("perf-1"))
        self.check_rejected(lane("bogus"), stem="bogus")
        self.check_rejected(lane(value=True))
        self.check_rejected(lane(value=-1))
        self.check_rejected(lane(value=1.5))
        self.check_rejected(lane(ceiling="2"))
        self.check_rejected(lane(unit="MiB"))
        self.check_rejected(lane(key="a|b"))
        self.check_rejected(lane(key="x" * 101))
        self.check_rejected(lane(detail="<img>"))
        repeated = lane()
        repeated["metrics"] *= 2
        self.check_rejected(repeated)
        many = lane()
        many["metrics"] = [dict(many["metrics"][0], key=f"k{i}") for i in range(65)]
        self.check_rejected(many)

    def test_unreadable_files_become_problems_not_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "dashboard.json").write_text("{not json")
            (root / "perf-1.json").write_bytes(b" " * (render.MAX_FILE_BYTES + 1))
            (root / "Bad Name.json").write_text("[]")
            lanes, problems, rejected = render.load(root)
        self.assertEqual(lanes, {})
        self.assertEqual(rejected, {"dashboard", "perf-1", "Bad Name"})
        self.assertEqual(len(problems), 3)
        self.assertIn("a file with an invalid name", problems[0])

    def test_display_text_cannot_leave_its_code_span(self):
        self.assertEqual(render.clean("a`b|c<d>\n\\e"), "a b c d e")
        self.assertEqual(render.clean(""), "invalid")
        self.assertEqual(len(render.clean("x" * 500)), 200)

    def test_untrusted_context_fields_are_dropped(self):
        body = render.render(None, None, {"head_sha": "`x`", "base": "a b", "run_url": "https://evil",
                                          "baseline": {"sha": "zz"}, "jobs": []})
        self.assertIn("for this pull request: no size lane reported", body)
        self.assertNotIn("evil", body)
        self.assertIn("No `master` baseline", body)


class Formatting(unittest.TestCase):
    def test_units(self):
        self.assertEqual(render.fmt(45_858_704, "bytes"), "45.859 MB")
        self.assertEqual(render.fmt(333_632, "bytes"), "333.6 KB")
        self.assertEqual(render.fmt(419, "bytes"), "419 B")
        self.assertEqual(render.fmt(25_500, "kB"), "25,500 kB")
        self.assertEqual(render.fmt(11, "count"), "11")

    def test_changes(self):
        self.assertEqual(render.change(100, 100, "count"), "0")
        self.assertEqual(render.change(0, 3, "count"), "+3")
        self.assertEqual(render.change(45_858_704, 45_874_960, "bytes"), "+16.3 KB (+0.04%)")
        self.assertEqual(render.change(10, 5, "count"), "-5 (-50.0%)")


if __name__ == "__main__":
    unittest.main()
