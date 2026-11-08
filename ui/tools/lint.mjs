// `npm run lint`: ESLint, then a Prettier check.
//
// ESLint findings are counted per rule and file and compared with tools/lint-ratchet.json, which
// lists permitted debt ({ "<rule>": { "<path>": count } }), so a
// new finding in one file cannot hide behind a fix in another. A rule or file absent from it is
// allowed zero. The check fails when a count rises and also when it falls, so a fixed finding
// forces the file to be lowered and the debt cannot come back.
//
// Exit codes: 0 clean, 1 violation, 2 cannot run (bad config, unreadable ratchet file).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const ui = fileURLToPath(new URL("..", import.meta.url));
const ratchetFile = fileURLToPath(new URL("./lint-ratchet.json", import.meta.url));
const ESLINT_TARGETS = ["src", "tools", "eslint.config.js", "vite.config.ts"];
const NO_RULE = "(no rule)";

function prettierCheck() {
  const bin = createRequire(import.meta.url).resolve("prettier/bin/prettier.cjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, "--check", "."], {
      cwd: ui,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ code: 2, output: String(error) }));
    child.on("close", (code) => resolve({ code: code ?? 2, output }));
  });
}

const key = (rule, path) => `${rule} in ${path}`;

function readRatchet() {
  const parsed = JSON.parse(readFileSync(ratchetFile, "utf8"));
  const allowed = new Map();
  for (const [rule, files] of Object.entries(parsed)) {
    if (typeof files !== "object" || files === null || Array.isArray(files))
      throw new Error(`lint-ratchet.json: ${rule} must map file paths to counts`);
    for (const [path, count] of Object.entries(files)) {
      if (!Number.isInteger(count) || count < 1)
        throw new Error(
          `lint-ratchet.json: ${rule} ${path} must be a positive integer, delete the entry at 0`,
        );
      allowed.set(key(rule, path), count);
    }
  }
  return allowed;
}

const problems = [];
let ratchet;
let results;
try {
  ratchet = readRatchet();
  const prettier = prettierCheck();
  const eslint = new ESLint({ cwd: ui });
  results = await eslint.lintFiles(ESLINT_TARGETS);
  const formatted = await prettier;
  if (formatted.code === 2) throw new Error(`prettier could not run: ${formatted.output}`);
  if (formatted.code !== 0) problems.push(`prettier --check failed\n${formatted.output.trim()}`);
} catch (error) {
  console.error(`lint: cannot run: ${error instanceof Error ? error.message : error}`);
  process.exit(2);
}

const found = new Map();
for (const file of results) {
  const path = file.filePath.slice(ui.length);
  for (const message of file.messages) {
    const id = key(message.ruleId ?? NO_RULE, path);
    const list = found.get(id) ?? [];
    list.push(`${path}:${message.line}:${message.column} ${message.message}`);
    found.set(id, list);
  }
}

for (const id of new Set([...found.keys(), ...ratchet.keys()])) {
  const list = found.get(id) ?? [];
  const allowed = ratchet.get(id) ?? 0;
  if (list.length > allowed) {
    problems.push(
      `${id}: ${list.length} findings, ratchet allows ${allowed}\n  ${list.join("\n  ")}`,
    );
  } else if (list.length < allowed) {
    problems.push(
      `${id}: ${list.length} findings, ratchet still says ${allowed}; ` +
        `lower it in tools/lint-ratchet.json${list.length === 0 ? " (delete the entry)" : ""}`,
    );
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n\n"));
  process.exit(1);
}
const debt = [...found.values()].reduce((sum, list) => sum + list.length, 0);
console.log(`lint ok: eslint and prettier clean; ratcheted debt ${debt} findings`);
