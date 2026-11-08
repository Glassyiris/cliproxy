#!/usr/bin/env node
// `npm run measure`: DOM measurement of the rewritten pages against the roles table (DESIGN.md
// "Roles"). A browser check, run once per milestone; not part of `npm run check`.
//
//   npx vite build && npm run measure [-- --routes overview,accounts] [--out <dir>]
//     [--answer route=selector]... [--measures route=tableRow,rowAction,...]...
//
// Serves dist with `vite preview` against the mock Management API and, for each route at
// 1440x900 and 390x844, signs in on that route and reads the role values once the page is ready.
// API responses are held 300 ms so the skeleton stays on screen for some frames. Every measured
// route needs an answer selector and its list of OPTIONAL measurements, from ROUTES or from
// --answer and --measures (which win). Fails when either is missing, a required measurement has
// no sample, a button role's elements differ in height within a route, a role differs between
// routes at one viewport, CLS during load is over 0.02, the first region moves more than 2 px from
// skeleton to content, a route's answer is outside the viewport, or a route takes more than 60 s.
// Screenshots and report.json go to --out.
//
// Exit codes: 0 pass, 1 a measurement failed, 2 could not run.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { installProbe, isReady, readPage } from "./page.mjs";

// Every route renders PageFrame, whose LayoutHeader holds its h1 (DESIGN.md "Pages"), so these
// always apply.
const ALWAYS = ["h1Size", "h1Weight", "h1Left", "h1Top", "contentInset", "hScroll", "cls"];
// What a page may have; a route lists the ones its page draws, and each then needs a sample.
const OPTIONAL = [
  "tableRow",
  "primaryButton",
  "headerControl",
  "rowAction",
  "cardPadding",
  "skeletonShift",
];
// The six routes (DESIGN.md "Routes"), each with the element that answers its question (plan 五,
// checked to be in view) and its OPTIONAL measurements. `pending` names the rewrite that still owns
// a route's content (R1 to R5): until then the frame's roles are measured and must hold, but the
// load limits (CLS, skeleton shift) belong to the content and are reported without failing, and
// Accounts, Activity and Server answer with their h1 until their rewrite gives them an answer.
const ROUTES = {
  overview: {
    answer: "#overview-attention a[href], #overview-attention-clear",
    measures: ["primaryButton", "cardPadding", "skeletonShift"],
  },
  accounts: {
    answer: "[role=main] tbody tr[data-account]",
    measures: ["primaryButton", "skeletonShift"],
  },
  clients: {
    answer: "[role=main] tbody tr",
    measures: ["primaryButton", "headerControl", "rowAction", "skeletonShift"],
  },
  models: {
    answer: "[role=main] tbody tr",
    measures: ["primaryButton", "headerControl", "rowAction", "skeletonShift"],
  },
  // The header's one control is the live view Switch, not a button.
  activity: {
    answer: "#activity-traffic",
    measures: ["cardPadding", "skeletonShift", "tableRow", "rowAction"],
  },
  // The group list needs no data, so the phone's first view has no skeleton to measure.
  settings: { answer: "#settings-nav", measures: ["primaryButton", "headerControl"] },
};

// The nbcards admin's values (p3/r/ref/nbcards/REPORT.md) each role must have, per viewport; the
// sidebar is 260 wide at 1440, so the h1 starts 24 inside the main area. A role not listed here is
// only required to agree across routes.
const EXPECTED = {
  "1440x900": {
    h1Size: "26px",
    h1Weight: "600",
    h1Left: 284,
    h1Top: 24,
    contentInset: "24px",
    hScroll: 0,
    primaryButton: 36,
    headerControl: 36,
    rowAction: 32,
    cardPadding: "20px",
  },
  "390x844": {
    h1Size: "26px",
    h1Weight: "600",
    h1Left: 16,
    contentInset: "16px",
    hScroll: 0,
    primaryButton: 36,
    headerControl: 36,
    rowAction: 32,
    cardPadding: "20px",
  },
};
// The measurements that must agree across routes; CLS and the skeleton shift are per-route limits.
const ROLES = [...ALWAYS, ...OPTIONAL].filter((name) => name !== "cls" && name !== "skeletonShift");

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
const LIMITS = { cls: 0.02, skeletonShift: 2, routeSeconds: 60 };
const API_DELAY_MS = 300;
const KEY = "mock";

const ui = fileURLToPath(new URL("../..", import.meta.url));
const { values: opt } = parseArgs({
  options: {
    routes: { type: "string" },
    dist: { type: "string", default: path.join(ui, "dist") },
    out: { type: "string" },
    chrome: { type: "string" },
    answer: { type: "string", multiple: true, default: [] },
    measures: { type: "string", multiple: true, default: [] },
  },
});
const routes = opt.routes ? opt.routes.split(",").filter(Boolean) : Object.keys(ROUTES);
const out = path.resolve(
  opt.out ??
    path.join(os.tmpdir(), "cliproxy-measure", new Date().toISOString().replace(/[:.]/g, "-")),
);
const children = [];

class CannotRun extends Error {}

/** `route=value` pairs from a repeated flag; the value may itself hold "=". */
function pairs(flag, values) {
  return Object.fromEntries(
    values.map((pair) => {
      const at = pair.indexOf("=");
      if (at < 1) throw new CannotRun(`--${flag} takes route=value, not "${pair}"`);
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
  );
}

/** Each route's answer selector and required measurements; undefined where none is declared. */
function declarations() {
  const answers = pairs("answer", opt.answer);
  const measures = pairs("measures", opt.measures);
  return Object.fromEntries(
    routes.map((route) => {
      const listed = route in measures ? measures[route].split(",") : ROUTES[route]?.measures;
      for (const name of listed ?? [])
        if (!OPTIONAL.includes(name))
          throw new CannotRun(`${route}: unknown measurement "${name}" (${OPTIONAL.join(", ")})`);
      const required = listed && [...ALWAYS, ...listed];
      const answer = answers[route] ?? ROUTES[route]?.answer;
      return [route, { answer, required, pending: ROUTES[route]?.pending }];
    }),
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chromePath() {
  const root = path.join(os.homedir(), ".cache/ms-playwright");
  const bundled =
    existsSync(root) &&
    readdirSync(root)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort()
      .pop();
  const found = [
    opt.chrome,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    bundled && path.join(root, bundled, "chrome-linux64/chrome"),
  ].find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new CannotRun("no Chrome found; pass --chrome");
  return found;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Starts a child and resolves with the first match of `ready` in its output. */
function start(args, env, ready, what) {
  const child = spawn(process.execPath, args, {
    cwd: ui,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = "";
    const read = (chunk) => {
      output += chunk;
      const match = ready.exec(output);
      if (match) resolve(match[1]);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("exit", () => reject(new CannotRun(`${what} exited: ${output.slice(-500)}`)));
    setTimeout(() => reject(new CannotRun(`${what} did not start`)), 30_000);
  });
}

async function startServers() {
  const mock = await start(
    ["tools/mock/server.mjs", "--port", "0", "--accounts", "1000", "--key", KEY],
    {},
    /listening (http:\/\/\S+)/,
    "mock server",
  );
  const port = await freePort();
  const vite = path.join(ui, "node_modules/vite/bin/vite.js");
  const args = [vite, "preview", "--outDir", opt.dist, "--host", "127.0.0.1", "--port"];
  await start([...args, String(port), "--strictPort"], { CPA_BACKEND: mock }, /(Local)/, "preview");
  return `http://127.0.0.1:${port}`;
}

/** Signs in on `route` in a fresh context and reads the page once it is ready. */
async function measure(browser, base, route, viewport, answer) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: "dark" });
  try {
    await context.route("**/v8/management/**", async (request) => {
      await sleep(API_DELAY_MS);
      await request.continue();
    });
    const page = await context.newPage();
    await page.addInitScript(installProbe);
    await page.goto(`${base}/#${route}`, { waitUntil: "load" });
    await page.fill("input[type=password]", KEY);
    const from = await page.evaluate(() => performance.now());
    await page.click('form button:has-text("Connect")');
    // Park the pointer, so no chart tooltip under it is measured as a card.
    await page.mouse.move(0, 0);
    await page.waitForFunction(isReady, null, { timeout: 30_000, polling: "raf" });
    await sleep(1000);
    const result = await page.evaluate(readPage, { from, answer });
    await page.screenshot({
      path: path.join(out, `${route}-${viewport.width}x${viewport.height}.png`),
    });
    return result;
  } finally {
    await context.close();
  }
}

/** The declared role values one route measured, and the roles that vary within it. */
function roleValues(label, route, result, required) {
  const failures = [];
  const values = {};
  // Only what the route declares: a page not yet rewritten may draw a legacy value elsewhere.
  for (const name of ROLES.filter((role) => required.includes(role))) {
    const value = result[name];
    if (Array.isArray(value) && value.length > 1)
      failures.push(`${label} ${route}: ${name} varies within the route: ${value.join(", ")}`);
    else if (value !== null) values[name] = Array.isArray(value) ? value[0] : value;
  }
  return { failures, values };
}

/** One route's failures at one viewport, and the declared role values it measured. */
function judgeRoute(label, route, result, { answer, required = ALWAYS, pending }) {
  const { failures, values } = roleValues(label, route, result, required);
  for (const name of required)
    if (result[name] === null) failures.push(`${label} ${route}: no sample of ${name}`);
  for (const [name, want] of Object.entries(EXPECTED[label] ?? {}))
    if (name in values && values[name] !== want)
      failures.push(`${label} ${route}: ${name} is ${values[name]}, not ${want}`);
  const load = [];
  if (result.cls > LIMITS.cls) load.push(`${label} ${route}: CLS ${result.cls} > ${LIMITS.cls}`);
  if (result.skeletonShift > LIMITS.skeletonShift)
    load.push(`${label} ${route}: first region moved ${result.skeletonShift} px from its skeleton`);
  if (pending) for (const line of load) console.log(`NOTE (content, ${pending}) ${line}`);
  else failures.push(...load);
  if (result.answer === false) failures.push(`${label} ${route}: answer ${answer} is not in view`);
  return { failures, values };
}

/** Failure lines for one viewport: samples, limits and nbcards values per route, then roles across routes. */
function judge(label, results, declared) {
  const failures = [];
  const values = {};
  for (const [route, result] of Object.entries(results)) {
    const judged = judgeRoute(label, route, result, declared[route]);
    failures.push(...judged.failures);
    values[route] = judged.values;
  }
  for (const name of ROLES) {
    const sampled = Object.entries(values).filter(([, route]) => name in route);
    if (new Set(sampled.map(([, route]) => route[name])).size > 1)
      failures.push(
        `${label} ${name} differs: ${sampled.map(([route, value]) => `${route} ${value[name]}`).join(", ")}`,
      );
  }
  return failures;
}

async function main() {
  if (routes.length === 0) {
    console.log("measure: no rewritten route yet; pass --routes to measure others");
    return 0;
  }
  if (!existsSync(path.join(opt.dist, "index.html")))
    throw new CannotRun(`${opt.dist}/index.html not found: run npx vite build first`);
  const declared = declarations();
  const failures = [];
  for (const [route, { answer, required }] of Object.entries(declared)) {
    if (!answer)
      failures.push(
        `${route}: no answer selector; add it to ROUTES or pass --answer ${route}=<selector>`,
      );
    if (!required)
      failures.push(
        `${route}: no measurement list; add it to ROUTES or pass --measures ${route}=<names>`,
      );
  }
  mkdirSync(out, { recursive: true });
  const base = await startServers();
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const report = {};
  try {
    for (const route of routes) {
      const started = performance.now();
      for (const viewport of VIEWPORTS) {
        const label = `${viewport.width}x${viewport.height}`;
        report[label] ??= {};
        report[label][route] = await measure(
          browser,
          base,
          route,
          viewport,
          declared[route].answer,
        );
        console.log(`${label} ${route} ${JSON.stringify(report[label][route])}`);
      }
      const seconds = (performance.now() - started) / 1000;
      if (seconds > LIMITS.routeSeconds) failures.push(`${route}: took ${seconds.toFixed(0)} s`);
    }
  } finally {
    await browser.close();
  }
  for (const [label, results] of Object.entries(report))
    failures.push(...judge(label, results, declared));
  writeFileSync(path.join(out, "report.json"), JSON.stringify({ report, failures }, null, 2));
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`measure: ${failures.length} failures, ${routes.length} routes; output in ${out}`);
  return failures.length > 0 ? 1 : 0;
}

let code;
try {
  code = await main();
} catch (error) {
  console.error(`measure: cannot run: ${error instanceof CannotRun ? error.message : error.stack}`);
  code = 2;
}
for (const child of children) child.kill();
process.exit(code);
