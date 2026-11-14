#!/usr/bin/env python3
"""Driver-owned external workloads and fail-closed codec comparisons."""

import datetime
from decimal import Decimal
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import statistics
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
BASELINE_REVISION = "b518060ea1e43ef4b266591986ca92321e6289b5"
# unit, direction, allowed regression percent; None means report only.
METRICS = {
    "cpu_ns_per_event": ("ns/event", "lower", 5),
    "allocations_per_event": ("allocations/event", "lower", 5),
    "allocated_bytes_per_event": ("B/event", "lower", 5),
    "encoded_bytes_per_event": ("B/event", "report", None),
    "decoded_bytes_per_event": ("B/event", "report", None),
    "cpu_ns_per_completion": ("ns/completion", "lower", 5),
    "throughput": ("events/s", "higher", 5),
    **{f"{kind}_p{percentile}": ("ns", "lower", 5)
       for kind in ("first_deliverable", "inter_event", "completion")
       for percentile in (50, 95, 99)},
    **{kind: ("B", "lower", 0) for kind in (
        "heap_peak", "heap_retained", "rss", "pss", "cgroup_charge", "total_charged")},
    **{kind: ("B", "report", None) for kind in (
        "rss_anon", "rss_shmem", "mapped_resident", "metadata", "tmpfs_charge")},
    **{kind: ("frames", "report", None) for kind in ("pool_reserved", "pool_used")},
    **{kind: ("faults", "report", None) for kind in ("minor_faults", "major_faults")},
}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def loads(text):
    return json.loads(text, parse_float=Decimal, object_pairs_hook=unique_object,
                      parse_constant=lambda value: (_ for _ in ()).throw(
                          ValueError(f"invalid JSON number: {value}")))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2, default=str) + "\n")


def event_kinds(case):
    """Partition on external wire kinds, never on a harness's claimed coverage."""
    if case["path"] != "stream":
        return [case["path"]]
    kinds = set()
    for line in case.get("lines", []):
        if line.startswith("event:"):
            kinds.add(line[6:].strip() or "unnamed")
            continue
        payload = line[5:].strip() if line.startswith("data:") else line
        if payload == "[DONE]":
            kinds.add("[DONE]")
            continue
        try:
            item = json.loads(payload)
        except (ValueError, TypeError):
            kinds.add("framing-or-fragment")
            continue
        if isinstance(item, dict):
            kinds.add(str(item.get("type", item.get("object", "json"))))
        else:
            kinds.add("json")
    if case.get("finalize"):
        kinds.add("finalize")
    return sorted(kinds or {"empty-stream"})


def manifest():
    pins = loads((HERE / "fixtures.json").read_text())
    if len(pins) != 30:
        raise ValueError("required 30-file corpus is incomplete")
    workloads = []
    for filename, expected in sorted(pins.items()):
        path = ROOT / "crates/ck-translate/tests/fixtures/pairs" / filename
        if digest(path) != expected:
            raise ValueError(f"immutable fixture checksum mismatch: {path}")
        corpus = loads(path.read_text())
        groups = {}
        for index, case in enumerate(corpus["fixtures"]):
            mode = case["path"]
            if mode not in {"request", "request_compat", "request_envelope",
                            "stream", "non_stream", "token_count"}:
                raise ValueError(f"unknown fixture mode: {mode}")
            kinds = tuple(event_kinds(case))
            # Expected output and old wire assertions are not workload input.
            inputs = {key: value for key, value in case.items() if key not in {
                "outputs", "dynamic", "unordered", "request_error", "tool_error",
                "variants", "stream_variants"}}
            for kind in kinds:
                groups.setdefault((mode, (kind,)), []).append({"index": index, "input": inputs})
        if not groups:
            raise ValueError(f"empty required corpus: {filename}")
        for (mode, kinds), cases in sorted(groups.items()):
            request = mode.startswith("request")
            role = "client_decode+upstream_encode" if request else "upstream_decode+client_encode"
            identity = f"{filename}:{mode}:{','.join(kinds)}:{role}"
            workloads.append({
                "id": hashlib.sha256(identity.encode()).hexdigest(),
                "fixture": str(path.relative_to(ROOT)), "fixture_sha256": expected,
                "client_protocol": corpus["client"], "upstream_protocol": corpus["upstream"],
                "protocol": f"{corpus['client']}->{corpus['upstream']}", "role": role,
                "direction": "request" if request else "response", "mode": mode,
                "event_kinds": kinds, "cases": cases,
            })
    return {"schema_version": 1, "corpus_revision": BASELINE_REVISION,
            "warmup_iterations": 10, "measured_iterations": 100,
            "retention": "release-at-completion", "workloads": workloads,
            "metrics": {key: {"unit": unit, "direction": direction,
                               "regression_percent": tolerance}
                        for key, (unit, direction, tolerance) in METRICS.items()}}


def command(args):
    return subprocess.check_output(args, text=True, timeout=30).strip()


def snapshot(storage):
    return {"utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "hostname": platform.node(), "architecture": platform.machine(),
            "kernel": platform.release(), "page_size": os.sysconf("SC_PAGE_SIZE"),
            "affinity": sorted(os.sched_getaffinity(0)),
            "load": Path("/proc/loadavg").read_text().strip(),
            "cpu": Path("/proc/cpuinfo").read_text(),
            "filesystems": {str(path): command([
                "findmnt", "--json", "--target", str(path), "--output", "TARGET,SOURCE,FSTYPE,OPTIONS"])
                for path in storage}}


def describe(executable, out, label):
    raw, stderr = out / f"{label}-describe.json", out / f"{label}-describe.stderr"
    with raw.open("w") as stdout, stderr.open("w") as err:
        subprocess.run([str(executable), "--describe"], stdout=stdout, stderr=err,
                       check=True, timeout=30)
    value = loads(raw.read_text())
    if (not isinstance(value, dict) or type(value.get("schema_version")) is not int
            or value["schema_version"] != 1):
        raise ValueError(f"{label}: unsupported description")
    if not re.fullmatch(r"[0-9a-f]{40}", value.get("revision", "")):
        raise ValueError(f"{label}: missing source revision")
    for field in ("compiler", "target", "source_checksum"):
        if not isinstance(value.get(field), str) or not value[field].strip():
            raise ValueError(f"{label}: missing {field}")
    if not re.fullmatch(r"[0-9a-f]{64}", value["source_checksum"]):
        raise ValueError(f"{label}: invalid source checksum")
    if value.get("profile") != "release":
        raise ValueError(f"{label}: release profile required")
    for field in ("features", "build_flags"):
        if not isinstance(value.get(field), list) or any(
                not isinstance(item, str) or not item for item in value[field]):
            raise ValueError(f"{label}: invalid {field}")
    if not isinstance(value.get("config"), dict) or not value["config"]:
        raise ValueError(f"{label}: nonempty configuration required")
    storage = Path(value.get("storage_directory", ""))
    if not storage.is_absolute() or not storage.is_dir():
        raise ValueError(f"{label}: existing absolute storage_directory required")
    value["executable"] = str(executable)
    value["executable_sha256"] = digest(executable)
    return value


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
        raise ValueError(f"metric must be a JSON number: {value!r}")
    value = Decimal(value)
    if not value.is_finite() or value < 0:
        raise ValueError(f"metric must be finite and nonnegative: {value}")
    return value


def records(path, required, checksum, round_number):
    result = {}
    for line_number, line in enumerate(path.read_text().splitlines(), 1):
        row = loads(line)
        if not isinstance(row, dict) or set(row) != {
                "schema_version", "workload_id", "manifest_sha256", "round", "metrics"}:
            raise ValueError(f"{path}:{line_number}: invalid record schema")
        key = row["workload_id"]
        if not isinstance(key, str) or key not in required or key in result:
            raise ValueError(f"{path}:{line_number}: unknown or duplicate workload")
        if (type(row["schema_version"]) is not int or row["schema_version"] != 1
                or type(row["round"]) is not int or row["round"] != round_number
                or row["manifest_sha256"] != checksum):
            raise ValueError(f"{path}:{line_number}: wrong version, round or manifest")
        metrics = row["metrics"]
        if not isinstance(metrics, dict) or set(metrics) != set(METRICS):
            raise ValueError(f"{path}:{line_number}: missing or extra metrics")
        values = {}
        for name, (unit, _, _) in METRICS.items():
            metric = metrics[name]
            if not isinstance(metric, dict) or set(metric) != {"value", "unit"} or metric["unit"] != unit:
                raise ValueError(f"{path}:{line_number}: invalid unit/schema for {name}")
            values[name] = number(metric["value"])
        for kind in ("first_deliverable", "inter_event", "completion"):
            if not values[f"{kind}_p50"] <= values[f"{kind}_p95"] <= values[f"{kind}_p99"]:
                raise ValueError(f"{path}:{line_number}: unordered {kind} percentiles")
        result[key] = values
    missing = required - result.keys()
    if missing:
        raise ValueError(f"{path}: missing {len(missing)} required workloads")
    return result


def acceptable(old, new, direction, tolerance):
    if direction == "report":
        return True
    old, new = Fraction(old), Fraction(new)
    if direction == "higher":
        return new * 100 >= old * (100 - tolerance)
    return new * 100 <= old * (100 + tolerance)


def compare(workloads, rounds):
    comparisons = []
    for workload in workloads:
        key = workload["id"]
        for metric, (unit, direction, tolerance) in METRICS.items():
            old = statistics.median([row[key][metric] for row in rounds["old"]])
            new = statistics.median([row[key][metric] for row in rounds["new"]])
            comparisons.append({"workload_id": key, "metric": metric, "unit": unit,
                                "old_median": old, "new_median": new,
                                "direction": direction, "regression_percent": tolerance,
                                "pass": acceptable(old, new, direction, tolerance)})
    return comparisons


def run(old, new, out):
    out = Path(out).resolve()
    if out == ROOT or ROOT in out.parents:
        raise ValueError("OUT must be outside the repository")
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        raise ValueError("OUT must be empty; raw evidence is never overwritten")
    summary = {"schema_version": 1, "status": "error", "rounds": []}
    try:
        executables = {"old": Path(old).resolve(strict=True), "new": Path(new).resolve(strict=True)}
        descriptions = {label: describe(path, out, label) for label, path in executables.items()}
        summary["harnesses"] = descriptions
        if descriptions["old"]["executable_sha256"] == descriptions["new"]["executable_sha256"]:
            raise ValueError("old/new executable sha256 is identical")
        if all(descriptions["old"][field] == descriptions["new"][field]
               for field in ("revision", "source_checksum")):
            raise ValueError("old/new revision and source checksum are identical")
        if descriptions["old"]["revision"] != BASELINE_REVISION:
            raise ValueError(f"old source must be pinned to {BASELINE_REVISION}")
        if descriptions["old"]["config"] != descriptions["new"]["config"]:
            raise ValueError("old/new configuration differs")
        data = manifest()
        path = out / "workloads.json"
        save(path, data)
        checksum = digest(path)
        required = {row["id"] for row in data["workloads"]}
        if len(required) != len(data["workloads"]) or not required:
            raise ValueError("empty or duplicate required matrix")
        summary.update({"manifest_sha256": checksum, "workload_count": len(required),
                        "driver_sha256": digest(Path(__file__)),
                        "fixture_pins_sha256": digest(HERE / "fixtures.json")})
        storage = [out, *(Path(value["storage_directory"]) for value in descriptions.values())]
        summary["host"] = snapshot(storage)
        rounds = {"old": [], "new": []}
        for round_number in (1, 2, 3):
            for label in ("old", "new"):
                raw = out / f"{label}-{round_number}.jsonl"
                state = {"harness": label, "round": round_number, "raw": raw.name,
                         "before": snapshot(storage)}
                summary["rounds"].append(state)
                with raw.open("w") as stdout, (out / f"{label}-{round_number}.stderr").open("w") as stderr:
                    process = subprocess.run([
                        str(executables[label]), "--run", str(path), "--round", str(round_number)],
                        stdout=stdout, stderr=stderr, timeout=600, check=False,
                        env={**os.environ, "CODEC_EVIDENCE_DIR": str(out / f"{label}-{round_number}-evidence")})
                state.update({"exit_code": process.returncode, "after": snapshot(storage),
                              "raw_sha256": digest(raw)})
                if process.returncode:
                    raise ValueError(f"{label} round {round_number}: harness exited {process.returncode}")
                if digest(path) != checksum:
                    raise ValueError("harness modified immutable workload manifest")
                if digest(executables[label]) != descriptions[label]["executable_sha256"]:
                    raise ValueError("harness executable changed during run")
                rounds[label].append(records(raw, required, checksum, round_number))
        comparisons = compare(data["workloads"], rounds)
        summary["comparisons"] = comparisons
        summary["failed_metrics"] = sum(not row["pass"] for row in comparisons)
        summary["status"] = "fail" if summary["failed_metrics"] else "pass"
        return 1 if summary["failed_metrics"] else 0
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        summary["error"] = str(error)
        return 2
    finally:
        save(out / "summary.json", summary)
        print(f"codec gate: {summary['status']}; {out / 'summary.json'}")


def main():
    if len(sys.argv) != 4:
        print("usage: bench/codec-gate.sh OLD_CODEC NEW_CODEC OUT", file=sys.stderr)
        return 2
    try:
        return run(*sys.argv[1:])
    except (OSError, ValueError) as error:
        print(f"codec gate: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
