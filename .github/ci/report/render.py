#!/usr/bin/env python3
"""Renders the size report comment for a pull request (.github/workflows/report.yml).

    render.py --candidate DIR [--baseline DIR] --context FILE --out FILE

DIR holds one `<lane>.json` per lane that ran (schema.md); a missing baseline directory means
no baseline. FILE is the context the workflow builds from the GitHub API: the head commit,
the baseline commit or why there is none, and each CI job's conclusion. Every input is data
from a pull request's run: nothing in it is executed, and only validated keys, numbers and
file names reach the comment. Standard library only.
"""
import argparse
import json
import pathlib
import re
import sys

SCHEMA_VERSION = 1
MARKER = "<!-- cliproxy-size-report -->"
MAX_FILE_BYTES = 256 * 1024
MAX_METRICS = 64
LANE_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
KEY = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}")
DETAIL = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}")
SHA = re.compile(r"[0-9a-f]{7,64}")
BRANCH = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,99}")
RUN_URL = re.compile(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[0-9]+")
UNITS = ("bytes", "kB", "ms", "count")

# The lanes that write a report, the ci.yml job that writes it, and what it measures.
LANES = {
    "perf-1": ("size and idle gates, 1 auth file (Linux)", "Release binary and idle with 1 auth file"),
    "perf-2000": ("idle gate, 2,000 auth files (Linux)", "Idle with 2,000 auth files"),
    "dashboard": ("dashboard (checks and committed build)", "Dashboard bundle"),
}
# One table each, in this order; a metric no pattern of its lane matches goes under "Other".
SECTIONS = (
    ("Release binary, Linux x86_64", "perf-1", re.compile(r"(size|deps)\..+")),
    ("Dashboard bundle, gzip", "dashboard", re.compile(r".+")),
    ("Idle, Linux, 1 auth file", "perf-1", re.compile(r"idle\.linux\.1\..+")),
    ("Idle, Linux, 2,000 auth files", "perf-2000", re.compile(r"idle\.linux\.2000\..+")),
)
# By the last dotted component of the key.
LABELS = {
    "binary_bytes": "Binary",
    "text_bytes": "`.text`",
    "rodata_bytes": "`.rodata`",
    "archive_bytes": "Archive (`.tar.gz`)",
    "duplicate_crates": "Crates in two or more versions",
    "rss_kb": "RSS",
    "wakeups": "Wakeups",
    "cpu_ticks": "CPU ticks",
    "threads": "Threads",
    "initialJs": "Initial JS",
    "initialCss": "Initial CSS",
    "largestLazyChunk": "Largest lazy chunk",
    "totalJs": "All JS",
    "totalCss": "All CSS",
}


class Invalid(Exception):
    pass


def count(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 2**53


def parse(stem, data):
    """The metrics of one lane file, by key in file order; Invalid when it breaks schema.md."""
    if not isinstance(data, dict):
        raise Invalid("not a JSON object")
    if data.get("schema_version") != SCHEMA_VERSION or isinstance(data.get("schema_version"), bool):
        raise Invalid(f"schema_version is not {SCHEMA_VERSION}")
    if data.get("lane") != stem:
        raise Invalid("lane does not match the file name")
    if stem not in LANES:
        raise Invalid("unknown lane")
    metrics = data.get("metrics")
    if not isinstance(metrics, list) or len(metrics) > MAX_METRICS:
        raise Invalid(f"metrics is not a list of at most {MAX_METRICS}")
    parsed = {}
    for metric in metrics:
        if not isinstance(metric, dict):
            raise Invalid("a metric is not an object")
        key = metric.get("key")
        if not isinstance(key, str) or not KEY.fullmatch(key):
            raise Invalid("a metric has an invalid key")
        if key in parsed:
            raise Invalid("a metric key repeats")
        value, ceiling, unit = metric.get("value"), metric.get("ceiling"), metric.get("unit")
        if not (value is None or count(value)) or not (ceiling is None or count(ceiling)):
            raise Invalid(f"{key}: value and ceiling must be nonnegative integers or null")
        if unit not in UNITS:
            raise Invalid(f"{key}: unknown unit")
        detail = metric.get("detail")
        if detail is not None and not (isinstance(detail, str) and DETAIL.fullmatch(detail)):
            raise Invalid(f"{key}: invalid detail")
        parsed[key] = {"value": value, "ceiling": ceiling, "unit": unit, "detail": detail}
    return parsed


def clean(text):
    """Text for a code span: printable ASCII without backticks, pipes or angle brackets."""
    text = re.sub(r"[^\x20-\x7e]|[`|<>\\]", " ", str(text))
    return re.sub(r" +", " ", text).strip()[:200] or "invalid"


def load(directory):
    """({lane: metrics}, [problem], {rejected lane}) for a directory of lane files."""
    lanes, problems, rejected = {}, [], set()
    if directory is None or not directory.is_dir():
        return lanes, problems, rejected
    for path in sorted(directory.glob("*.json")):
        stem = path.stem
        shown = f"`{stem}.json`" if LANE_NAME.fullmatch(stem) else "a file with an invalid name"
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                raise Invalid("larger than 256 KiB")
            data = json.loads(path.read_text(encoding="utf-8"))
            # Written by the workflow when it rejects an artifact before reading it.
            if isinstance(data, dict) and "artifact_validation_error" in data:
                problems.append(f"an artifact: `{clean(data['artifact_validation_error'])}`")
                continue
            lanes[stem] = parse(stem, data)
        except (OSError, UnicodeDecodeError, ValueError, Invalid) as error:
            problems.append(f"{shown}: `{clean(error)}`")
            rejected.add(stem)
    return lanes, problems, rejected


def fmt(value, unit):
    if unit == "bytes":
        size = abs(value)
        if size >= 1_000_000:
            return f"{value / 1e6:.3f} MB"
        if size >= 1_000:
            return f"{value / 1e3:.1f} KB"
        return f"{value} B"
    if unit == "count":
        return f"{value:,}"
    return f"{value:,} {unit}"


def change(base, value, unit):
    delta = value - base
    if delta == 0:
        return "0"
    text = ("+" if delta > 0 else "-") + fmt(abs(delta), unit)
    if base > 0:
        percent = delta / base * 100
        text += f" ({percent:+.2f}%)" if abs(percent) < 10 else f" ({percent:+.1f}%)"
    return text


def label(key, detail=None):
    text = LABELS.get(key.rsplit(".", 1)[-1], f"`{key}`")
    return f"{text} (`{detail}`)" if detail else text


def lane_status(lane, jobs, rejected):
    if lane in rejected:
        return "its report was ignored, see below"
    conclusion = jobs.get(LANES[lane][0], "absent")
    if conclusion == "absent":
        return "not run"
    if conclusion == "skipped":
        return "not run (the changed paths do not reach it)"
    if conclusion == "success":
        return "no report uploaded"
    if conclusion is None:
        return "no report (the job had not finished)"
    return f"no report (the job ended with `{clean(conclusion)}`)"


def sections(candidate, baseline):
    """[(title, lane, [key])] for the lanes with a candidate report, keys in report order."""
    out = []
    for lane in LANES:
        if lane not in candidate:
            continue
        keys = list(candidate[lane]) + [k for k in baseline.get(lane, {}) if k not in candidate[lane]]
        claimed = set()
        for title, owner, pattern in SECTIONS:
            if owner != lane:
                continue
            mine = [k for k in keys if k not in claimed and pattern.fullmatch(k)]
            claimed.update(mine)
            if mine:
                out.append((title, lane, mine))
        rest = [k for k in keys if k not in claimed]
        if rest:
            out.append((f"Other, {lane}", lane, rest))
    order = {lane: i for i, lane in enumerate(LANES)}
    titles = [title for title, _, _ in SECTIONS]
    return sorted(out, key=lambda s: titles.index(s[0]) if s[0] in titles else len(titles) + order[s[1]])


def render(candidate_dir, baseline_dir, context):
    candidate, candidate_problems, rejected = load(candidate_dir)
    baseline, baseline_problems, _ = load(baseline_dir)
    head = context.get("head_sha")
    head = f"`{head[:7]}`" if isinstance(head, str) and SHA.fullmatch(head) else "this pull request"
    branch = context.get("base")
    branch = branch if isinstance(branch, str) and BRANCH.fullmatch(branch) else "master"
    base_info = context.get("baseline") if isinstance(context.get("baseline"), dict) else {}
    base_sha = base_info.get("sha")
    has_baseline = isinstance(base_sha, str) and bool(SHA.fullmatch(base_sha))
    if not has_baseline:
        baseline = {}
    jobs = context.get("jobs") if isinstance(context.get("jobs"), dict) else {}

    over, unmeasured, tables = [], [], []
    for title, lane, keys in sections(candidate, baseline):
        rows = [f"#### {title}", "", f"| Metric | `{branch}` | This PR | Change | Ceiling | Room |",
                "|---|--:|--:|--:|--:|--:|"]
        for key in keys:
            metric = candidate[lane].get(key)
            old = baseline.get(lane, {}).get(key)
            unit = (metric or old)["unit"]
            base_value = old["value"] if old and old["unit"] == unit else None
            base_cell = fmt(base_value, unit) if base_value is not None else "—"
            if metric is None:
                rows.append(f"| {label(key)} | {base_cell} | not reported | — | — | — |")
                continue
            value, ceiling = metric["value"], metric["ceiling"]
            name = label(key, metric["detail"])
            if value is None:
                unmeasured.append(f"{label(key)} ({title})")
                rows.append(f"| {name} | {base_cell} | **not measured** | — | "
                            f"{fmt(ceiling, unit) if ceiling is not None else 'none'} | — |")
                continue
            if base_value is not None:
                delta = change(base_value, value, unit)
            else:
                delta = "new" if lane in baseline else "—"
            if ceiling is None:
                ceiling_cell, room = "none", "—"
            elif value > ceiling:
                ceiling_cell, room = fmt(ceiling, unit), f"**over by {fmt(value - ceiling, unit)}**"
                text = f"**{label(key)} {fmt(value, unit)}** ({title}), ceiling {fmt(ceiling, unit)}"
                if base_value is not None:
                    text += f", `{branch}` {fmt(base_value, unit)}"
                over.append(text)
            elif value == ceiling:
                ceiling_cell, room = fmt(ceiling, unit), "at the ceiling"
            else:
                ceiling_cell = fmt(ceiling, unit)
                room = f"{(ceiling - value) / ceiling * 100:.1f}%"
            shown = f"**{fmt(value, unit)}**" if ceiling is not None and value > ceiling else fmt(value, unit)
            rows.append(f"| {name} | {base_cell} | {shown} | {delta} | {ceiling_cell} | {room} |")
        tables.append("\n".join(rows))

    compared = (f"Compared with `{branch}` at `{base_sha[:7]}`." if has_baseline
                else f"No `{branch}` baseline: {clean(base_info.get('reason', 'unknown'))}.")
    if over:
        verdict = (f"{len(over)} measurement over its ceiling" if len(over) == 1
                   else f"{len(over)} measurements over their ceilings")
    elif unmeasured:
        verdict = "a measurement is missing"
    elif not candidate:
        verdict = "no size lane reported"
    else:
        verdict = "every measurement within its ceiling"
    run_url = context.get("run_url")
    run = f" ([run]({run_url}))" if isinstance(run_url, str) and RUN_URL.fullmatch(run_url) else ""
    out = [f"**Size report** for {head}: {verdict}. {compared}{run}", ""]
    if over or unmeasured:
        out += [f"- {item}" for item in over] + [f"- **not measured:** {item}" for item in unmeasured]
        out.append("")
    for table in tables:
        out += [table, ""]
    missing = [f"- {LANES[lane][1]}: {lane_status(lane, jobs, rejected)}"
               for lane in LANES if lane not in candidate]
    if missing:
        out += ["**Not measured in this run**", ""] + missing + [""]
    problems = ([f"- {p}" for p in candidate_problems]
                + [f"- baseline {p}" for p in baseline_problems if has_baseline])
    if problems:
        out += ["**Ignored reports**", ""] + problems + [""]
    out.append(f"<sub>Ceilings: `bench/budgets.txt` and `ui/tools/size-budget.json`; raising one needs "
               f"a maintainer's approval. Baseline: the latest successful CI run of a push to `{branch}` "
               f"before this run.</sub>")
    out.append(MARKER)
    return "\n".join(out) + "\n"


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--candidate", type=pathlib.Path, required=True)
    parser.add_argument("--baseline", type=pathlib.Path)
    parser.add_argument("--context", type=pathlib.Path, required=True)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    args = parser.parse_args(argv)
    try:
        context = json.loads(args.context.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        print(f"render.py: cannot read the context: {error}", file=sys.stderr)
        return 2
    if not isinstance(context, dict):
        context = {}
    args.out.write_text(render(args.candidate, args.baseline, context), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
