#!/usr/bin/env python3
"""Run under the benchmark lock; all evidence stays in the supplied directory."""

import copy
from decimal import Decimal
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import gate
import baseline_launcher

ARTIFACTS = Path(os.environ["CODEC_TEST_ARTIFACTS"]).resolve()


class Thresholds(unittest.TestCase):
    def test_every_metric_direction_and_exact_boundary(self):
        for name, (_, direction, tolerance) in gate.METRICS.items():
            with self.subTest(metric=name):
                if direction == "report":
                    self.assertTrue(gate.acceptable(Decimal(0), Decimal(1000), direction, tolerance))
                    continue
                boundary = Decimal(95 if direction == "higher" else 100 + tolerance)
                self.assertTrue(gate.acceptable(Decimal(100), boundary, direction, tolerance))
                outside = boundary + Decimal("-0.000001" if direction == "higher" else "0.000001")
                self.assertFalse(gate.acceptable(Decimal(100), outside, direction, tolerance))
                self.assertTrue(gate.acceptable(Decimal(0), Decimal(0), direction, tolerance))
                self.assertEqual(gate.acceptable(Decimal(0), Decimal("0.000001"), direction, tolerance),
                                 direction == "higher")

    def test_memory_and_storage_metrics_allow_no_regression(self):
        # INTERNAL-STREAM.md §9.2: allocated bytes/event, heap, RSS/PSS and charges allow 0%.
        for name in ("allocated_bytes_per_event", "heap_peak", "heap_retained", "rss", "pss",
                     "cgroup_charge", "total_charged"):
            self.assertEqual(gate.METRICS[name][1:], ("lower", 0), name)
        self.assertFalse(gate.acceptable(Decimal(100), Decimal("104.9"), "lower", 0))

    def test_sub_context_precision_regression_fails(self):
        self.assertFalse(gate.acceptable(Decimal(100),
                         Decimal("105.00000000000000000000000000001"), "lower", 5))
        self.assertFalse(gate.acceptable(Decimal(100),
                         Decimal("94.99999999999999999999999999999"), "higher", 5))

    def test_invalid_numbers(self):
        for value in (True, False, None, "100", -1, Decimal("NaN"), Decimal("Infinity")):
            with self.subTest(value=value), self.assertRaises(ValueError):
                gate.number(value)
        for value in ("NaN", "Infinity", '{"a": 1, "a": 2}'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                gate.loads(value)

    def test_record_coverage_units_and_identity(self):
        row = {"schema_version": 1, "workload_id": "required", "manifest_sha256": "sha",
               "round": 1, "metrics": {name: {"value": 100, "unit": unit}
                                         for name, (unit, _, _) in gate.METRICS.items()}}
        path = ARTIFACTS / "invalid-record.jsonl"
        cases = []
        missing = copy.deepcopy(row)
        del missing["metrics"]["cpu_ns_per_event"]
        cases.append([missing])
        wrong_unit = copy.deepcopy(row)
        wrong_unit["metrics"]["cpu_ns_per_event"]["unit"] = "s"
        cases.append([wrong_unit])
        unknown = copy.deepcopy(row)
        unknown["workload_id"] = "unrequested"
        cases.append([unknown])
        wrong_round = copy.deepcopy(row)
        wrong_round["round"] = 2
        cases.append([wrong_round])
        wrong_manifest = copy.deepcopy(row)
        wrong_manifest["manifest_sha256"] = "different"
        cases.append([wrong_manifest])
        wrong_version = copy.deepcopy(row)
        wrong_version["schema_version"] = True
        cases.append([wrong_version])
        unordered = copy.deepcopy(row)
        unordered["metrics"]["completion_p50"]["value"] = 101
        cases.append([unordered])
        cases.extend(([row, row], []))
        for records in cases:
            with self.subTest(records=records):
                path.write_text("".join(json.dumps(record) + "\n" for record in records))
                with self.assertRaises(ValueError):
                    gate.records(path, {"required"}, "sha", 1)

    def test_stream_headers_are_not_framing_fragments(self):
        case = {"path": "stream", "lines": ["event: message", 'data: {"type":"message"}']}
        self.assertEqual(gate.event_kinds(case), ["message"])
        case["lines"].extend(["event:", "data: {", "data: [DONE]"])
        self.assertEqual(gate.event_kinds(case), ["[DONE]", "framing-or-fragment", "message", "unnamed"])

    def test_leftover_cgroup_reports_exact_path_without_touching_members(self):
        directory = ARTIFACTS / "leftover-cgroup"
        directory.mkdir()
        members = directory / "cgroup.procs"
        members.write_text("12345\n")
        with patch.object(baseline_launcher, "Path", return_value=directory):
            with self.assertRaisesRegex(RuntimeError, f"leftover baseline cgroup: {directory}"):
                baseline_launcher.worker("unused", [], {}, 0)
        self.assertEqual(members.read_text(), "12345\n")


class GateControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.old = ARTIFACTS / "old-harness"
        cls.new = ARTIFACTS / "new-harness"
        fake = gate.HERE / "fake_harness.py"
        for side, path in (("old", cls.old), ("new", cls.new)):
            path.write_text(f'#!/usr/bin/env bash\nexport CODEC_FAKE_SIDE={side}\nexec python3 -B "{fake}" "$@"\n')
            path.chmod(0o700)

    def control(self, mode, expected):
        out = ARTIFACTS / mode
        process = subprocess.run([str(gate.HERE.parent / "codec-gate.sh"),
                                  str(self.old), str(self.new), str(out)],
                                 env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1",
                                      "CODEC_FAKE_MODE": mode,
                                      "CODEC_FAKE_STORAGE": str(ARTIFACTS)},
                                 capture_output=True, text=True, timeout=180)
        (ARTIFACTS / f"{mode}.stdout").write_text(process.stdout)
        (ARTIFACTS / f"{mode}.stderr").write_text(process.stderr)
        self.assertEqual(process.returncode, expected, process.stderr + process.stdout)
        return json.loads((out / "summary.json").read_text()), out

    def test_pass_boundary_and_medians(self):
        summary, out = self.control("pass", 0)
        self.assertEqual(summary["status"], "pass")
        self.assertEqual([(row["harness"], row["round"]) for row in summary["rounds"]],
                         [(side, number) for number in (1, 2, 3) for side in ("old", "new")])
        workloads = json.loads((out / "workloads.json").read_text())["workloads"]
        self.assertEqual({row["role"] for row in workloads},
                         {"client_decode+upstream_encode", "upstream_decode+client_encode"})
        self.assertEqual(len({row["fixture"] for row in workloads}), 30)
        self.assertTrue(all(row["cases"] and len(row["event_kinds"]) == 1 for row in workloads))
        token_cases = [case["input"] for row in workloads if row["mode"] == "token_count" for case in row["cases"]]
        self.assertTrue(any("count" in case for case in token_cases))
        self.assertTrue(any(case.get("bytes") for row in workloads for case in (item["input"] for item in row["cases"])))
        self.assertTrue(any(case.get("finalize") for row in workloads for case in (item["input"] for item in row["cases"])))
        cpu = next(row for row in summary["comparisons"] if row["metric"] == "cpu_ns_per_event")
        self.assertEqual(cpu["old_median"], "100")
        self.assertEqual(cpu["new_median"], "105")

    def test_regress_cpu_throughput_memory(self):
        summary, _ = self.control("regress", 1)
        failed = {row["metric"] for row in summary["comparisons"] if not row["pass"]}
        self.assertEqual(failed, {"cpu_ns_per_event", "throughput", "heap_retained"})

    def test_missing_empty_matrix_output(self):
        summary, _ = self.control("missing", 2)
        self.assertEqual(summary["status"], "error")
        self.assertIn("missing", summary["error"])

    def test_absent_old_harness_fails(self):
        out = ARTIFACTS / "absent"
        self.assertEqual(gate.run(str(ARTIFACTS / "absent-old-codec"), str(self.new), out), 2)
        self.assertIn("No such file", json.loads((out / "summary.json").read_text())["error"])

    def test_identical_executable_is_error_even_at_another_path(self):
        duplicate = ARTIFACTS / "duplicate-harness"
        duplicate.write_bytes(self.old.read_bytes())
        duplicate.chmod(0o700)
        out = ARTIFACTS / "same-executable"
        with patch.dict(os.environ, {"CODEC_FAKE_STORAGE": str(ARTIFACTS)}):
            self.assertEqual(gate.run(str(self.old), str(duplicate), out), 2)
        summary = json.loads((out / "summary.json").read_text())
        self.assertIn("executable sha256 is identical", summary["error"])
        self.assertEqual(summary["rounds"], [])

    def test_identical_source_is_error_with_different_executables(self):
        duplicate = ARTIFACTS / "same-source-harness"
        duplicate.write_bytes(self.old.read_bytes() + b"\n# Different wrapper, same source.\n")
        duplicate.chmod(0o700)
        out = ARTIFACTS / "same-source"
        with patch.dict(os.environ, {"CODEC_FAKE_STORAGE": str(ARTIFACTS)}):
            self.assertEqual(gate.run(str(self.old), str(duplicate), out), 2)
        summary = json.loads((out / "summary.json").read_text())
        self.assertIn("revision and source checksum are identical", summary["error"])
        self.assertNotEqual(*(summary["harnesses"][side]["executable_sha256"] for side in ("old", "new")))
        self.assertEqual(summary["rounds"], [])


if __name__ == "__main__":
    ARTIFACTS.mkdir(parents=True, exist_ok=False)
    unittest.main()
