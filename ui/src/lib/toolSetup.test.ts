import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { snippet } from "./toolSetup.ts";

test("tool setup points at this server with the chosen key", () => {
  const base = "https://proxy.example.test/cpa";
  assert.match(
    snippet("Claude Code", base, "sk-k", "m"),
    /^export ANTHROPIC_BASE_URL=https:\/\/proxy\.example\.test\/cpa\n/,
  );
  assert.match(
    snippet("Anthropic SDK", base, "sk-k", "m"),
    /base_url="https:\/\/proxy\.example\.test\/cpa"/,
  );
  for (const tool of ["Codex CLI", "Cursor", "OpenAI SDK", "curl"] as const)
    assert.ok(snippet(tool, base, "sk-k", "m").includes(`${base}/v1`), tool);
  assert.ok(snippet("OpenAI SDK", base, "sk-k", "claude-x").includes('model="claude-x"'));
  for (const tool of [
    "Claude Code",
    "Codex CLI",
    "Cursor",
    "OpenAI SDK",
    "Anthropic SDK",
    "curl",
  ] as const)
    assert.ok(snippet(tool, base, "sk-secret-key", "m").includes("sk-secret-key"), tool);
});

test("tool setup survives keys with shell and string metacharacters", (t) => {
  // Each language reads the value back itself; the expectation is the raw key, not our escaping.
  const key = `sk-'a"$HOME\`id\`\\n$(x)`;
  const model = `m"o'd\\el`;
  const base = "http://127.0.0.1:8317";
  const sh = (script: string) => {
    const r = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: "/nonexistent" },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const claude = snippet("Claude Code", base, key, model).replace(/\nclaude$/, "");
  assert.equal(
    sh(`${claude}\nprintf '%s|%s' "$ANTHROPIC_BASE_URL" "$ANTHROPIC_AUTH_TOKEN"`),
    `${base}|${key}`,
  );
  const codex = snippet("Codex CLI", base, key, model);
  const exportLine = codex.split("\n").find((l) => l.startsWith("export "))!;
  assert.equal(sh(`${exportLine}\nprintf '%s' "$CLIPROXY_API_KEY"`), key);
  const curl = snippet("curl", `${base}/a b`, key, model).replace(/^curl /, "printf '%s\\n' ");
  assert.equal(sh(curl), `${base}/a b/v1/models\n-H\nAuthorization: Bearer ${key}\n`);

  const py = spawnSync("python3", ["--version"]);
  if (py.status !== 0) return t.skip("python3 not installed");
  const run = (code: string, input: string) => {
    const r = spawnSync("python3", ["-c", code], { input, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const kwargs = `import ast, json, sys
print(json.dumps({k.arg: k.value.value for n in ast.walk(ast.parse(sys.stdin.read())) if isinstance(n, ast.Call)
  for k in n.keywords if isinstance(k.value, ast.Constant)}))`;
  for (const [tool, url] of [
    ["OpenAI SDK", `${base}/v1`],
    ["Anthropic SDK", base],
  ] as const) {
    const got = run(kwargs, snippet(tool, base, key, model));
    assert.equal(got.base_url, url, tool);
    assert.equal(got.api_key, key, tool);
    assert.equal(got.model, model, tool);
  }
  // tomllib arrived in Python 3.11; older versions skip only the TOML part.
  if (spawnSync("python3", ["-c", "import tomllib"]).status !== 0)
    return t.skip("python3 has no tomllib (before 3.11)");
  const toml = codex.slice(0, codex.indexOf("# then"));
  const parsed = run(
    "import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))",
    toml,
  );
  assert.equal(parsed.model_providers.cliproxy.base_url, `${base}/v1`);
  const odd = run(
    "import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))",
    snippet("Codex CLI", `http://h/p"\\q`, key, model).split("# then")[0],
  );
  assert.equal(odd.model_providers.cliproxy.base_url, `http://h/p"\\q/v1`);
});
