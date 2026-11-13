import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location(
    "check_crate_deps", pathlib.Path(__file__).with_name("check-crate-deps.py"))
deps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deps)

TABLE = """
| Crate | May depend on |
| --- | --- |
| `low` | none |
| `high` | `low` |
"""


def metadata(edges):
    """edges: {package: [(dependency, kind, target, optional)]}"""
    packages = [{
        "id": name, "name": name,
        "dependencies": [{"name": d, "kind": k, "target": t, "optional": o} for d, k, t, o in deps_],
    } for name, deps_ in edges.items()]
    packages.append({"id": "serde", "name": "serde", "dependencies": []})
    return {"workspace_members": list(edges), "packages": packages}


class CrateDeps(unittest.TestCase):
    def test_parses_table(self):
        self.assertEqual(deps.parse_table(TABLE), {"low": set(), "high": {"low"}})

    def test_allowed_edges_pass(self):
        md = metadata({
            "low": [("serde", None, None, False), ("low", "dev", None, False)],
            "high": [("low", None, None, False), ("low", "build", None, False)],
        })
        self.assertEqual(deps.violations(md, deps.parse_table(TABLE)), [])

    def test_forbidden_edges_fail_for_every_kind_and_condition(self):
        md = metadata({
            "low": [
                ("high", None, None, False),
                ("high", "build", None, False),
                ("high", "dev", "cfg(unix)", True),
            ],
            "high": [],
        })
        self.assertEqual(deps.violations(md, deps.parse_table(TABLE)), [
            "low -> high: forbidden normal dependency",
            "low -> high: forbidden build dependency",
            "low -> high: forbidden dev dependency (target cfg(unix), optional)",
        ])

    def test_crate_without_row_fails(self):
        md = metadata({"low": [], "high": [], "new": []})
        self.assertEqual(deps.violations(md, deps.parse_table(TABLE)),
                         ["new: workspace crate missing from the table"])

    def test_empty_workspace_fails(self):
        md = {"workspace_members": [], "packages": []}
        self.assertEqual(deps.violations(md, deps.parse_table(TABLE)),
                         ["the metadata lists no workspace members"])

    def test_member_without_package_record_fails(self):
        md = metadata({"low": [], "high": []})
        md["workspace_members"].append("ghost")
        self.assertEqual(deps.violations(md, deps.parse_table(TABLE)),
                         ["ghost: workspace member has no package record"])

    def test_repository_table_covers_the_workspace_crates(self):
        allowed = deps.parse_table(deps.TABLE_FILE.read_text())
        crates = {p.parent.name for p in (deps.ROOT / "crates").glob("*/Cargo.toml")}
        self.assertEqual(set(allowed), crates)


if __name__ == "__main__":
    unittest.main()
