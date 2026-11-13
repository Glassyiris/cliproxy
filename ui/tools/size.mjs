// Bundle budget (REQUIREMENTS.md "Numbers"), run after `vite build`. Sizes are gzip bytes of
//   initialJs        the entry script, its static imports and the inline scripts of index.html
//   initialCss       the stylesheets index.html links
//   largestLazyChunk the biggest JS chunk outside the initial set (loaded on demand)
//   totalJs          every JS chunk and the inline scripts, initial and lazy
//   totalCss         every stylesheet, linked and lazy
// against tools/size-budget.json. A `null` or absent limit prints the measured size and passes.
//
// The limits are ceilings with headroom, raised only when a change needs it, not the last
// measurement: a pull request that grows the bundle does not edit them, and the CI report comment
// shows its change against master. Headroom over the committed build: about 8% for initial JS,
// 15% for initial CSS (CSS grows slowly) and 13% for the largest lazy chunk (the plotting library,
// which grows only with its upgrades). Totals are reported without a ceiling. Raising a ceiling
// needs a maintainer's approval.
//
//   node tools/size.mjs [dist] [--json <file>]
//
// --json also writes the measurements and ceilings to <file>.
// Exit codes: 0 within budget, 1 over budget, 2 no build output or unreadable budget.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ui = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const jsonAt = args.indexOf("--json");
const jsonFile = jsonAt === -1 ? null : args[jsonAt + 1];
if (jsonAt !== -1) args.splice(jsonAt, 2);
// The first argument names another build directory; the default is ui/dist.
const dist = resolve(ui, args[0] ?? "dist");
const budgetFile = fileURLToPath(new URL("./size-budget.json", import.meta.url));
const STATIC_IMPORT =
  /\b(?:import|export)\s*(?:\*\s*as\s+[\w$]+|\{[^}]*\}|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s*as\s+[\w$]+))?)?\s*(?:from\s*)?["'`]([^"'`]+\.js)["'`]/g;

const gzip = (data) => gzipSync(data).length;
const read = (name) => readFileSync(join(dist, name));

function cannotRun(message) {
  console.error(`check:size: cannot run: ${message}`);
  process.exit(2);
}

// References in index.html, attributes in any order: module scripts and preloads are JS,
// stylesheets are CSS. No module script means the entry was missed, which would measure 0 B.
function htmlAssets(html) {
  const tags = (name) =>
    [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "gi"))].map(([, attributes]) =>
      Object.fromEntries(
        [...attributes.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)].map(
          (a) => [a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? ""],
        ),
      ),
    );
  const asset = (path) => join("assets", path.replace(/^.*assets\//, ""));
  const rel = (tag, value) => (tag.rel ?? "").toLowerCase().split(/\s+/).includes(value);
  const links = tags("link");
  const scripts = tags("script").filter((tag) => tag.type === "module" && tag.src);
  if (scripts.length === 0) cannotRun('index.html has no <script type="module" src>');
  return {
    js: [
      ...scripts.map((tag) => asset(tag.src)),
      ...links.filter((tag) => rel(tag, "modulepreload") && tag.href).map((tag) => asset(tag.href)),
    ],
    css: links.filter((tag) => rel(tag, "stylesheet") && tag.href).map((tag) => asset(tag.href)),
  };
}

// Follows static imports between chunks; `import()` has a parenthesis and never matches.
function withStaticImports(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    for (const match of read(name).toString("utf8").matchAll(STATIC_IMPORT))
      queue.push(join(dirname(name), match[1]));
  }
  return seen;
}

function measure() {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const assets = htmlAssets(html);
  const initial = withStaticImports(assets.js);
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .join("\n");
  const sum = (names) => [...names].reduce((total, name) => total + gzip(read(name)), 0);
  const files = readdirSync(join(dist, "assets"));
  const all = (extension) =>
    files.filter((name) => name.endsWith(extension)).map((name) => join("assets", name));
  const lazy = files
    .filter((name) => name.endsWith(".js") && !initial.has(join("assets", name)))
    .map((name) => ({ name, size: gzip(read(join("assets", name))) }))
    .sort((a, b) => b.size - a.size);
  return {
    initialJs: sum(initial) + (inline ? gzip(inline) : 0),
    initialCss: sum(assets.css),
    largestLazyChunk: lazy[0]?.size ?? 0,
    totalJs: sum(all(".js")) + (inline ? gzip(inline) : 0),
    totalCss: sum(all(".css")),
    lazyName: lazy[0]?.name ?? "none",
  };
}

if (!existsSync(join(dist, "index.html")))
  cannotRun(`${dist}/index.html not found; run npm run build`);
let budget;
try {
  budget = JSON.parse(readFileSync(budgetFile, "utf8"));
} catch (error) {
  cannotRun(`size-budget.json: ${error.message}`);
}
const measured = measure();
if (jsonAt !== -1 && !jsonFile) cannotRun("--json needs a file");
const KINDS = ["initialJs", "initialCss", "largestLazyChunk", "totalJs", "totalCss"];
let over = false;
for (const kind of KINDS) {
  const limit = budget[kind] ?? null;
  if (limit !== null && !Number.isInteger(limit))
    cannotRun(`size-budget.json: ${kind} must be an integer or null`);
  const verdict =
    limit === null
      ? "no budget set"
      : measured[kind] > limit
        ? "OVER"
        : `${limit - measured[kind]} B spare`;
  over ||= limit !== null && measured[kind] > limit;
  const detail = kind === "largestLazyChunk" ? ` (${measured.lazyName})` : "";
  console.log(
    `${kind.padEnd(16)} ${String(measured[kind]).padStart(7)} B gzip  budget ${limit ?? "null"}  ${verdict}${detail}`,
  );
}
if (jsonFile) {
  const metrics = KINDS.map((kind) => ({
    key: kind,
    value: measured[kind],
    ceiling: budget[kind] ?? null,
    unit: "bytes",
    ...(kind === "largestLazyChunk" ? { detail: measured.lazyName } : {}),
  }));
  writeFileSync(
    resolve(jsonFile),
    `${JSON.stringify({ schema_version: 1, lane: "dashboard", metrics }, null, 2)}\n`,
  );
}
process.exit(over ? 1 : 0);
