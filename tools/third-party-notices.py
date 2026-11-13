#!/usr/bin/env python3
"""Generate THIRD-PARTY-NOTICES from the Rust and npm dependencies that ship in the binary.

Usage (run with `python3 -I tools/third-party-notices.py`):
  (no flag)   rewrite THIRD-PARTY-NOTICES
  --check     exit 1 when the committed file differs from what the lockfiles produce

Needs cargo-about (CARGO_ABOUT overrides the lookup on PATH), cargo, and `npm ci` done in ui/.
Rust: cargo-about reads about.toml, runs offline against the locked dependency set, and covers the
normal dependencies of the `cooker` binary for the Linux release targets. npm: ui/vite.config.ts
loads ui/tools/notices-plugin.ts, which writes the license of every package bundled into the
dashboard when CK_NOTICES_OUT is set; the build goes to a temporary directory, so ui/dist
is not touched.
"""

import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "THIRD-PARTY-NOTICES"
RULE = "=" * 78

# C code that a -sys crate compiles into the binary. cargo-about reads the crate's own license
# files only, so the license files of the bundled upstream sources are added here:
# crate -> [(component, path relative to the crate directory)].
BUNDLED = {
    "btls-sys": [("BoringSSL", "deps/boringssl/LICENSE")],
    "zstd-sys": [("Zstandard", "zstd/LICENSE")],
}

# Crates whose package has no usable license file, so cargo-about prints the SPDX template
# ("<year> <owner>") instead of the real notice. A string is the upstream LICENSE text; a Path
# is a file in the crate's directory that cargo-about did not recognise. The script fails when a
# template placeholder survives, so a new such crate cannot slip in unnoticed.
PLACEHOLDER = re.compile(r"<year>|<owner>|<copyright holders>")
MIT_TIKTOKEN = """MIT License

Copyright (c) 2023 Roger Zurawicki

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE."""
BSD3_DROPBOX = """Copyright (c) 2016 Dropbox, Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE."""
RUST_OVERRIDES = {
    "alloc-stdlib": BSD3_DROPBOX,  # https://github.com/dropbox/rust-alloc-no-stdlib/blob/master/LICENSE
    "tiktoken-rs": MIT_TIKTOKEN,  # https://github.com/zurawiki/tiktoken-rs/blob/main/LICENSE
    "sha1_smol": Path("LICENSE"),
}

# npm packages that ship no license file. The text is the one the package's own repository or its
# sibling package carries; the copyright line comes from the files' headers (stylex) or the
# sibling's LICENSE (astryx).
MIT_META = """MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE."""
NPM_FALLBACK = {
    "@stylexjs/stylex": MIT_META,
    "@astryxdesign/core": MIT_META.replace("(c) Meta Platforms, Inc. and affiliates", "(c) 2026 Meta Platforms, Inc"),
}


def run(cmd, **kwargs):
    result = subprocess.run(cmd, capture_output=True, text=True, **kwargs)
    if result.returncode != 0:
        sys.exit(f"{' '.join(map(str, cmd))} failed ({result.returncode}):\n{result.stderr[-3000:]}")
    return result


def clean(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.rstrip() for line in text.strip().split("\n"))


SPLIT = re.compile(r"END OF TERMS AND CONDITIONS")


def squash(text):
    return re.sub(r"\s+", " ", text).strip()


def group(entries):
    """entries: [(label, text)] -> [(sorted labels, text)], one block per distinct text.

    An Apache-2.0 text is split at "END OF TERMS AND CONDITIONS": the terms are printed once, and
    the part after it, which carries the appendix and any copyright line, once per distinct text.
    """
    plain, terms = {}, {}
    for label, text in entries:
        cut = SPLIT.search(text)
        if cut and "Apache License" in text[: cut.start()]:
            body, tail = text[: cut.start()], text[cut.start() :]
            unit = terms.setdefault(squash(body), [set(), clean(body), {}])
            unit[0].add(label)
            unit[2].setdefault(squash(tail), (set(), clean(tail)))[0].add(label)
        else:
            plain.setdefault(squash(text), (set(), clean(text)))[0].add(label)
    units = [[(sorted(labels), text)] for labels, text in plain.values()]
    for labels, body, tails in terms.values():
        blocks = sorted(((sorted(l), t) for l, t in tails.values()), key=lambda b: (-len(b[0]), b[0][0]))
        units.append([(sorted(labels), body)] + blocks)
    units.sort(key=lambda u: (-len(u[0][0]), u[0][0][0]))
    return [block for unit in units for block in unit]


def rust_entries():
    about = os.environ.get("CARGO_ABOUT") or shutil.which("cargo-about")
    if not about:
        sys.exit("cargo-about not found: cargo install cargo-about --locked --features cli")
    run(["cargo", "fetch", "--locked", "--manifest-path", ROOT / "crates/cooker/Cargo.toml"])
    out = run(
        [about, "generate", "--locked", "--offline", "--format", "json",
         "--config", ROOT / "about.toml", "--manifest-path", ROOT / "crates/cooker/Cargo.toml"],
        cwd=ROOT,
    ).stdout
    data = json.loads(out)
    crates = {}
    for item in data["crates"]:
        pkg = item["package"]
        crates[pkg["name"]] = (pkg["version"], Path(pkg["manifest_path"]).parent)
    entries = []
    for lic in data["licenses"]:
        for used in lic["used_by"]:
            crate = used["crate"]
            # The workspace crates are cooker itself, under the AGPL in LICENSE.
            if crate["source"] is None and crate["license"].startswith("AGPL-3.0"):
                continue
            text = lic["text"]
            if PLACEHOLDER.search(text):
                text = RUST_OVERRIDES.get(crate["name"]) or sys.exit(f"{crate['name']}: only the SPDX template was found; add it to RUST_OVERRIDES")
                if isinstance(text, Path):
                    text = (crates[crate["name"]][1] / text).read_text()
            entries.append((f"{crate['name']} {crate['version']}", text))
    bundled = []
    for name, files in BUNDLED.items():
        version, directory = crates[name]
        for component, rel in files:
            bundled.append((f"{component} (compiled into the binary by {name} {version})", (directory / rel).read_text()))
    return entries, bundled


def npm_entries():
    ui = ROOT / "ui"
    vite = ui / "node_modules/.bin/vite"
    if not vite.exists():
        sys.exit("ui/node_modules is missing: run `npm ci` in ui/")
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "notices.json"
        env = dict(os.environ, CK_NOTICES_OUT=str(out))
        run([vite, "build", "--outDir", Path(tmp) / "dist", "--emptyOutDir"], cwd=ui, env=env)
        packages = json.loads(out.read_text())
    entries = []
    for pkg in packages:
        text = pkg["text"] or NPM_FALLBACK.get(pkg["name"])
        if not text:
            sys.exit(f"{pkg['name']} ships no license file and has no entry in NPM_FALLBACK")
        entries.append((f"{pkg['name']} {pkg['version']}", text))
    return entries


def wrap(labels):
    return textwrap.fill(", ".join(labels), width=78, initial_indent="  ", subsequent_indent="  ", break_on_hyphens=False, break_long_words=False)


def section(title, intro, groups):
    lines = [RULE, title, RULE, "", intro, ""]
    for labels, text in groups:
        noun = "package" if len(labels) == 1 else "packages"
        lines += ["-" * 78, f"{len(labels)} {noun}:", wrap(labels), "-" * 78, "", text, ""]
    return lines


def render():
    crates, bundled = rust_entries()
    packages = npm_entries()
    head = [
        "THIRD-PARTY NOTICES",
        "",
        "cooker is licensed under the GNU Affero General Public License, version 3 or later",
        "(LICENSE; derived portions under the MIT License in NOTICE and LICENSE-MIT). The",
        "binary also contains the third-party software below, each under its own license.",
        "This file is generated by tools/third-party-notices.py; do not edit it by hand.",
        "",
        "Packages offered under a choice of licenses appear under each license; the recipient",
        "may use them under any one of them. The Rust list covers the normal dependencies of",
        "the cooker binary on the Linux release targets (x86_64 and aarch64). The npm list",
        "covers the packages bundled into the dashboard in ui/dist.",
        "",
    ]
    lines = head
    lines += section(
        f"PART 1: RUST CRATES ({len(set(l for l, _ in crates))})",
        "Each block lists the crates that carry the license text below it. The Apache License 2.0\nterms are printed once; the notice that follows END OF TERMS AND CONDITIONS is given per\ngroup of crates right after them.",
        group(crates),
    )
    lines += section(
        "PART 2: C CODE COMPILED INTO THE BINARY",
        "Upstream sources that the crates above bundle and build; their licenses are not part of the crates' own license files.",
        group(bundled),
    )
    lines += section(
        f"PART 3: NPM PACKAGES IN THE DASHBOARD ({len(set(l for l, _ in packages))})",
        "Each block lists the packages that carry the license text below it. The Figtree font files\n"
        "(@fontsource/figtree) are under the SIL Open Font License 1.1.",
        group(packages),
    )
    return "\n".join(lines).rstrip() + "\n"


def main():
    args = sys.argv[1:]
    if args not in ([], ["--check"]):
        sys.exit(__doc__)
    text = render()
    if args == ["--check"]:
        current = OUTPUT.read_text() if OUTPUT.exists() else ""
        if current == text:
            print("THIRD-PARTY-NOTICES is up to date")
            return
        diff = difflib.unified_diff(current.splitlines(), text.splitlines(), "committed", "generated", lineterm="", n=1)
        print("\n".join(list(diff)[:40]))
        sys.exit("THIRD-PARTY-NOTICES is stale: run `python3 -I tools/third-party-notices.py` and commit it")
    OUTPUT.write_text(text)
    print(f"wrote {OUTPUT.name}: {len(text)} bytes")


main()
