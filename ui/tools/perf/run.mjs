#!/usr/bin/env node
// Browser performance harness for the dashboard. See README.md.
//
//   node tools/perf/run.mjs --accounts 1000 --minutes 5 --dist /scratch/ssd/cliproxy-perf/dist-svelte
//
// Starts the mock Management API and `vite preview` of a built dashboard, signs in through the real
// login form in Chrome and measures M1 to M5 plus a pass over every page. UI-specific markup lives in
// adapters/<name>.mjs. Exit status: 0 when the harness ran to the end (numbers may still be bad),
// 2 when it could not (cannot sign in, a page never rendered, a server did not start).
import { parseArgs } from "node:util";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(here, "../..");
const { values: opt } = parseArgs({
  options: {
    accounts: { type: "string", default: "1000" },
    minutes: { type: "string", default: "5" },
    ui: { type: "string", default: "svelte" },
    out: { type: "string" },
    dist: { type: "string", default: path.join(uiRoot, "dist") },
    seed: { type: "string", default: "1" },
    key: { type: "string", default: "mock" },
    chrome: { type: "string" },
    idle: { type: "string", default: "60" },
    polls: { type: "string", default: "6" },
    loads: { type: "string", default: "3" },
    reps: { type: "string", default: "5" },
    headed: { type: "boolean", default: false },
    "strict-coverage": { type: "boolean", default: false },
  },
});
const N = Number(opt.accounts);
const MINUTES = Number(opt.minutes);
const IDLE_S = Number(opt.idle);
const POLLS = Number(opt.polls);
const LOADS = Number(opt.loads);
const REPS = Number(opt.reps);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = path.resolve(opt.out || `/scratch/ssd/cliproxy-perf/${stamp}`);
mkdirSync(out, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (v) => {
  const s = v.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r1 = (x) => (typeof x === "number" ? Math.round(x * 10) / 10 : x);
const r2 = (x) => (typeof x === "number" ? Math.round(x * 100) / 100 : x);

class HarnessError extends Error {}
const harnessErrors = [];
const fail = (msg) => {
  harnessErrors.push(msg);
  log("HARNESS ERROR:", msg);
};

const adapter = (await import(pathToFileURL(path.join(here, "adapters", `${opt.ui}.mjs`)).href)).default;

// --------------------------------------------------------------------------------------------
// Child processes: the mock API and `vite preview`, both killed by PID on the way out.
const children = [];
function start(name, cmd, args, env = {}) {
  const logFile = createWriteStream(path.join(out, `${name}.log`));
  const child = spawn(cmd, args, { cwd: uiRoot, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(logFile, { end: false });
  child.stderr.pipe(logFile, { end: false });
  child.exited = new Promise((r) => child.on("exit", r));
  children.push(child);
  return child;
}
async function stopAll() {
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  await Promise.race([Promise.all(children.map((c) => c.exited)), sleep(3000)]);
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
}
process.on("SIGINT", () => stopAll().then(() => process.exit(130)));
process.on("SIGTERM", () => stopAll().then(() => process.exit(143)));

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() > end) throw new HarnessError(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

// --------------------------------------------------------------------------------------------
// Browser helpers
const metricsOf = async (cdp) => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
async function heapOf(cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const m = await metricsOf(cdp);
  return { heapMB: m.JSHeapUsedSize / 1048576, nodes: m.Nodes, listeners: m.JSEventListeners };
}
async function processCpu(bcdp) {
  try {
    const { processInfo } = await bcdp.send("SystemInfo.getProcessInfo");
    const o = {};
    for (const p of processInfo) o[p.type] = (o[p.type] || 0) + p.cpuTime;
    return o;
  } catch {
    return null;
  }
}
const delta = (a, b, k) => (b[k] - a[k]) * 1000; // seconds to ms

const initScript = () => {
  window.__lt = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__lt.push(Math.round(e.duration * 10) / 10);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  document.addEventListener("submit", () => (window.__t0 = performance.now()), true);
  // The React sign-in submits from a type="button" Connect (Enter goes through onEnter), so no
  // submit event fires; its click is the same moment.
  document.addEventListener("click", (e) => { if (e.target.closest?.("form button")) window.__t0 ??= performance.now(); }, true);
};
const takeLongTasks = () => {
  const a = window.__lt || [];
  window.__lt = [];
  return a;
};

/** Network record shared by all phases: what /v8 answered, per phase window. */
const net = { window: null, all: [], consoleErrors: [] };
function watch(page) {
  const rec = (request, status, failure) => {
    const u = new URL(request.url());
    if (!u.pathname.startsWith("/v8/")) return;
    const e = { method: request.method(), url: u.pathname + u.search, status, postData: request.postData(), failure };
    e.expected = !failure && adapter.isExpectedProbe(e);
    net.all.push(e);
    net.window?.push(e);
  };
  page.on("response", (r) => rec(r.request(), r.status()));
  page.on("requestfailed", (r) => rec(r, 0, r.failure()?.errorText || "failed"));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) net.consoleErrors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => net.consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));
}

/** In-page wait: polls `expr` once per frame until true, then one more frame. Resolves ms since `from`. */
const waitFrames = ({ expr, ctx, timeout, from }) =>
  new Promise((resolve) => {
    const fn = new Function("ctx", `return (${expr})`);
    const begun = performance.now();
    const deadline = begun + timeout;
    const tick = () => {
      // From "submit": wait for the form to be submitted, and count from that moment.
      const t0 = from === "submit" ? window.__t0 : begun;
      let hit = false;
      try {
        hit = t0 !== undefined && fn(ctx);
      } catch {}
      if (hit) {
        const ready = performance.now() - t0;
        requestAnimationFrame(() => resolve({ ok: true, ready, paint: performance.now() - t0 }));
      } else if (performance.now() > deadline) resolve({ ok: false });
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

/** Opens a context, loads the app on `target`, signs in through the form and waits until it lists every account. */
async function signIn(browser, base, target, label) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.addInitScript(initScript);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");
  watch(page);
  await page.goto(`${base}/${adapter.hash(target)}`, { waitUntil: "load" });
  await page.fill(adapter.login.key, opt.key);
  const m0 = await metricsOf(cdp);
  const waiting = page.evaluate(waitFrames, { expr: adapter.listed[target], ctx: { n: N, title: adapter.pages.find((x) => x.id === target).title }, timeout: 60_000, from: "submit" });
  await page.click(adapter.login.submit);
  const r = await waiting;
  if (!r.ok) {
    const why = await page.locator(adapter.login.error).first().textContent({ timeout: 500 }).catch(() => null);
    await context.close();
    throw new HarnessError(`${label}: ${why ? `sign-in refused: ${why.trim()}` : `${target} never listed ${N} accounts within 60 s`}`);
  }
  const m1 = await metricsOf(cdp);
  const fetchEnd = await page.evaluate(() => {
    const e = performance.getEntriesByType("resource").filter((x) => x.name.endsWith("/v8/management/credentials")).pop();
    return e ? e.responseEnd - window.__t0 : null;
  });
  return {
    context,
    page,
    cdp,
    load: {
      ready: r1(r.ready),
      paint: r1(r.paint),
      fetchEnd: r1(fetchEnd),
      task: r1(delta(m0, m1, "TaskDuration")),
      script: r1(delta(m0, m1, "ScriptDuration")),
      layout: r1(delta(m0, m1, "LayoutDuration")),
      style: r1(delta(m0, m1, "RecalcStyleDuration")),
    },
  };
}

// --------------------------------------------------------------------------------------------
const report = { meta: {}, m1: {}, m2: {}, m3: {}, m4: {}, m5: {}, pages: [], coverage: {}, harnessErrors };

async function main() {
  if (!existsSync(path.join(opt.dist, "index.html"))) throw new HarnessError(`${opt.dist}/index.html not found: build the dashboard first (see README.md)`);
  const chromePath =
    opt.chrome ||
    ["/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find(existsSync) ||
    (() => {
      const root = path.join(os.homedir(), ".cache/ms-playwright");
      const dir = existsSync(root) && readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
      return dir && path.join(root, dir, "chrome-linux64/chrome");
    })();
  if (!chromePath || !existsSync(chromePath)) throw new HarnessError("no Chrome found; pass --chrome");

  // Servers.
  const mock = start("mock", process.execPath, [path.join(here, "../mock/server.mjs"), "--port", "0", "--accounts", String(N), "--seed", opt.seed, "--key", opt.key]);
  const mockUrl = await new Promise((resolve, reject) => {
    let buf = "";
    mock.stdout.on("data", (d) => {
      buf += d;
      const m = /listening (http:\/\/\S+)/.exec(buf);
      if (m) resolve(m[1]);
    });
    mock.exited.then(() => reject(new HarnessError("mock server exited early (see mock.log)")));
    setTimeout(() => reject(new HarnessError("mock server did not start")), 10_000);
  });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  start("preview", process.execPath, [path.join(uiRoot, "node_modules/vite/bin/vite.js"), "preview", "--outDir", path.resolve(opt.dist), "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { CPA_BACKEND: mockUrl });
  await until(async () => (await fetch(`${base}/`)).ok, 30_000, "vite preview");
  const probe = await fetch(`${base}/v8/management/config`, { headers: { Authorization: `Bearer ${opt.key}` } });
  if (!probe.ok || !(probe.headers.get("x-cpa-version") || "").startsWith("cliproxy-rs")) throw new HarnessError(`the /v8 proxy to the mock does not work (HTTP ${probe.status})`);
  log(`mock ${mockUrl}  ui ${base}  dist ${opt.dist}`);

  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: !opt.headed,
    args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
  });
  const bcdp = await browser.newBrowserCDPSession();
  const git = spawnSync("git", ["-C", uiRoot, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout?.trim();
  Object.assign(report.meta, {
    ui: opt.ui,
    adapter: adapter.label,
    accounts: N,
    minutes: MINUTES,
    seed: opt.seed,
    date: new Date().toISOString(),
    commit: git || null,
    chrome: browser.version(),
    node: process.version,
    cpus: `${os.cpus().length} x ${os.cpus()[0]?.model}`,
    loadavgAtStart: os.loadavg().map(r2),
    dist: opt.dist,
    out,
  });

  try {
    // ---- M1: sign-in to a fully listed page, cold context each time ------------------------
    for (const target of ["accounts", "overview"]) {
      const runs = [];
      for (let i = 0; i < LOADS; i++) {
        const s = await signIn(browser, base, target, `M1 ${target}`);
        runs.push(s.load);
        await s.context.close();
      }
      report.m1[target] = { runs, medianReadyMs: r1(median(runs.map((x) => x.ready))), medianPaintMs: r1(median(runs.map((x) => x.paint))), medianTaskMs: r1(median(runs.map((x) => x.task))), medianScriptMs: r1(median(runs.map((x) => x.script))) };
      log(`M1 ${target}: paint ${report.m1[target].medianPaintMs} ms (runs ${runs.map((x) => x.paint).join(", ")})`);
    }

    // ---- One long session on Accounts: M2, M3, M4, M5, then the page pass ------------------
    const { context, page, cdp } = await signIn(browser, base, "accounts", "session");
    const rowsNow = await page.evaluate((e) => new Function(`return (${e})`)(), adapter.rowCount);
    if (rowsNow < N) throw new HarnessError(`Accounts shows ${rowsNow} rows, expected ${N}`);
    await sleep(2000);
    const heaps = [{ tSec: 0, ...(await heapOf(cdp)) }];
    report.m3.afterLoad = heaps[0];

    // M2 + M3 growth: every poll (a GET /credentials) is measured from request start to 1.5 s after
    // its body arrived. The gap before it gives the idle rate, subtracted for the net cost.
    const isPoll = (r) => r.method() === "GET" && new URL(r.url()).pathname === "/v8/management/credentials";
    const polls = [];
    const began = Date.now();
    let lastHeap = began;
    let gap = { t: Date.now(), m: await metricsOf(cdp) };
    log(`M2/M3: polling for ${MINUTES} min`);
    while (Date.now() - began < MINUTES * 60_000 || polls.length < POLLS) {
      const req = await page.waitForRequest(isPoll, { timeout: 30_000 }).catch(() => {
        throw new HarnessError("no 10 s poll of GET /credentials seen within 30 s");
      });
      const t0 = Date.now();
      const m0 = await metricsOf(cdp);
      const gapLong = await page.evaluate(takeLongTasks);
      const gapSec = (t0 - gap.t) / 1000;
      const gapTask = (m0.TaskDuration - gap.m.TaskDuration) * 1000;
      const resp = await req.response();
      await resp?.finished();
      await sleep(1500);
      const m1 = await metricsOf(cdp);
      const long = await page.evaluate(takeLongTasks);
      const windowSec = (Date.now() - t0) / 1000;
      const gross = delta(m0, m1, "TaskDuration");
      const idleRate = gapTask / gapSec; // ms of main thread per second between polls
      polls.push({
        windowMs: r1(windowSec * 1000),
        taskMs: r1(gross),
        netTaskMs: r1(gross - idleRate * windowSec),
        scriptMs: r1(delta(m0, m1, "ScriptDuration")),
        layoutMs: r1(delta(m0, m1, "LayoutDuration")),
        styleMs: r1(delta(m0, m1, "RecalcStyleDuration")),
        longTasks: long.length,
        longTaskMaxMs: r1(Math.max(0, ...long)),
        idleMsPerSec: r2(idleRate),
        gapLongTasks: gapLong.length,
      });
      gap = { t: Date.now(), m: m1 };
      if (Date.now() - lastHeap >= 60_000) {
        heaps.push({ tSec: r1((Date.now() - began) / 1000), ...(await heapOf(cdp)) });
        lastHeap = Date.now();
        gap = { t: Date.now(), m: await metricsOf(cdp) };
      }
    }
    const final = { tSec: r1((Date.now() - began) / 1000), ...(await heapOf(cdp)) };
    heaps.push(final);
    const first = polls.slice(0, POLLS);
    report.m2 = {
      polls,
      measured: first.length,
      medianTaskMs: r1(median(first.map((p) => p.taskMs))),
      medianNetTaskMs: r1(median(first.map((p) => p.netTaskMs))),
      medianScriptMs: r1(median(first.map((p) => p.scriptMs))),
      medianLayoutMs: r1(median(first.map((p) => p.layoutMs))),
      medianStyleMs: r1(median(first.map((p) => p.styleMs))),
      medianLongTasks: median(first.map((p) => p.longTasks)),
      maxLongTaskMs: Math.max(0, ...polls.map((p) => p.longTaskMaxMs)),
      pollsOverWholeRun: polls.length,
    };
    report.m3 = {
      afterLoadMB: r1(heaps[0].heapMB),
      afterPollingMB: r1(final.heapMB),
      growthMB: r1(final.heapMB - heaps[0].heapMB),
      nodesAfterLoad: heaps[0].nodes,
      nodesAfterPolling: final.nodes,
      listenersAfterLoad: heaps[0].listeners,
      listenersAfterPolling: final.listeners,
      pollingMinutes: r1((Date.now() - began) / 60_000),
      series: heaps.map((h) => ({ tSec: h.tSec, heapMB: r1(h.heapMB), nodes: h.nodes })),
    };
    log(`M2: median ${report.m2.medianTaskMs} ms/poll (net ${report.m2.medianNetTaskMs}); M3: ${report.m3.afterLoadMB} -> ${report.m3.afterPollingMB} MB`);

    // ---- M4: idle on Accounts ---------------------------------------------------------------
    let pollsSeen = 0;
    const count = (r) => isPoll(r) && pollsSeen++;
    page.on("request", count);
    await sleep(1000);
    const a = { t: Date.now(), m: await metricsOf(cdp), p: await processCpu(bcdp) };
    await sleep(IDLE_S * 1000);
    const b = { t: Date.now(), m: await metricsOf(cdp), p: await processCpu(bcdp) };
    page.off("request", count);
    const wall = (b.t - a.t) / 1000;
    const proc = {};
    if (a.p && b.p) for (const k of Object.keys(b.p)) proc[k] = r2(((b.p[k] - (a.p[k] || 0)) / wall) * 100);
    report.m4 = {
      seconds: r1(wall),
      pollsDuringWindow: pollsSeen,
      mainThreadPctOfCore: r2(((b.m.TaskDuration - a.m.TaskDuration) / wall) * 100),
      scriptPctOfCore: r2(((b.m.ScriptDuration - a.m.ScriptDuration) / wall) * 100),
      betweenPollsPctOfCore: r2((median(polls.map((p) => p.idleMsPerSec)) ?? 0) / 10),
      processPctOfCore: proc,
    };
    log(`M4: ${report.m4.mainThreadPctOfCore}% of a core (between polls ${report.m4.betweenPollsPctOfCore}%)`);

    // ---- M5: interactions on Accounts -------------------------------------------------------
    await page.evaluate(() => scrollTo(0, 0));
    const steps = Object.fromEntries(adapter.interactions.map((s) => [s.name, []]));
    const stepTask = Object.fromEntries(adapter.interactions.map((s) => [s.name, []]));
    for (let rep = 0; rep < REPS; rep++) {
      for (const s of adapter.interactions) {
        await page.evaluate(
          ({ expr, ctx }) => {
            window.__im = new Promise((resolve) => {
              const fn = new Function("ctx", `return (${expr})`);
              const on = (e) => {
                removeEventListener("click", on, true);
                const t0 = e.timeStamp;
                const deadline = performance.now() + 15_000;
                const tick = () => {
                  if (fn(ctx)) requestAnimationFrame(() => resolve({ ok: true, ms: performance.now() - t0 }));
                  else if (performance.now() > deadline) resolve({ ok: false });
                  else requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
              };
              addEventListener("click", on, true);
            });
          },
          { expr: s.done, ctx: { n: N } },
        );
        const before = await metricsOf(cdp);
        await page.locator(s.target).first().click();
        const r = await page.evaluate(() => window.__im);
        const after = await metricsOf(cdp);
        if (!r.ok) throw new HarnessError(`M5 "${s.name}": the page never reached the expected state`);
        steps[s.name].push(r1(r.ms));
        stepTask[s.name].push(r1(delta(before, after, "TaskDuration")));
        await sleep(250);
      }
    }
    report.m5 = Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { medianMs: r1(median(v)), maxMs: Math.max(...v), runs: v, medianMainThreadMs: r1(median(stepTask[k])), mainThreadRuns: stepTask[k] }]));
    log("M5:", Object.entries(report.m5).map(([k, v]) => `${k} ${v.medianMs} ms`).join(", "));

    // ---- Pages: client-side navigation to each, every /v8 answer recorded -------------------
    for (const p of adapter.pages) {
      net.window = [];
      const errorsBefore = net.consoleErrors.length;
      const res = await page.evaluate(
        async ({ hash, expr, ctx, wf }) => {
          const wait = new Function(`return ${wf}`)();
          if (location.hash === hash) location.hash = "#overview";
          await new Promise((r) => setTimeout(r, 50));
          const p = wait({ expr, ctx, timeout: 30_000, from: "now" });
          location.hash = hash;
          return p;
        },
        { hash: adapter.hash(p.id), expr: adapter.pageReady, ctx: { title: p.title }, wf: waitFrames.toString() },
      );
      await sleep(700); // late reads and capability probes
      const reqs = net.window;
      net.window = null;
      const failed = reqs.filter((r) => r.status >= 400 || r.status === 0).filter((r) => !r.expected);
      const rec = {
        id: p.id,
        ok: res.ok,
        readyMs: res.ok ? r1(res.ready) : null,
        paintMs: res.ok ? r1(res.paint) : null,
        v8Requests: reqs.length,
        probes: reqs.filter((r) => r.expected).length,
        failed: failed.map((r) => `${r.method} ${r.url} -> ${r.status || r.failure}`),
        consoleErrors: net.consoleErrors.slice(errorsBefore),
      };
      report.pages.push(rec);
      if (!res.ok) fail(`page "${p.id}" never rendered its heading "${p.title}" within 30 s`);
      log(`page ${p.id}: ${rec.ok ? `${rec.readyMs} ms` : "NEVER RENDERED"}, ${rec.v8Requests} requests, ${rec.failed.length} failed`);
    }
    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }

}

function finalize() {
  const all = net.all.filter((r) => r.status >= 400 || r.status === 0);
  report.coverage = {
    v8Requests: net.all.length,
    expectedProbes: all.filter((r) => r.expected).length,
    unexpectedFailures: [...new Set(all.filter((r) => !r.expected).map((r) => `${r.method} ${r.url.split("?")[0]} -> ${r.status || r.failure}`))],
    consoleErrors: [...new Set(net.consoleErrors)],
  };
  if (opt["strict-coverage"] && report.coverage.unexpectedFailures.length) fail(`${report.coverage.unexpectedFailures.length} unexpected failed /v8 requests (--strict-coverage)`);
}

function markdown() {
  const m = report.meta;
  const L = [];
  L.push(`# Dashboard performance: ${m.ui}, ${m.accounts} accounts`, "");
  L.push(`${m.date} · commit ${m.commit} · ${m.chrome} · ${m.cpus} · load ${m.loadavgAtStart?.join(" / ") ?? "not recorded"} · seed ${m.seed} · polling ${report.m3.pollingMinutes ?? m.minutes} min`, "");
  L.push("| Metric | Result |", "| --- | --- |");
  const m1 = report.m1;
  if (m1.accounts) L.push(`| M1 sign-in to ${m.accounts} Accounts rows, painted | ${m1.accounts.medianPaintMs} ms (runs ${m1.accounts.runs.map((x) => x.paint).join(", ")}) |`);
  if (m1.accounts) L.push(`| M1 of which main-thread task / script | ${m1.accounts.medianTaskMs} / ${m1.accounts.medianScriptMs} ms |`);
  if (m1.overview) L.push(`| M1 sign-in to ${m.accounts} Overview rows, painted | ${m1.overview.medianPaintMs} ms (runs ${m1.overview.runs.map((x) => x.paint).join(", ")}) |`);
  const m2 = report.m2;
  if (m2.polls) {
    L.push(`| M2 poll, main thread (median of ${m2.measured}) | ${m2.medianTaskMs} ms gross, ${m2.medianNetTaskMs} ms net of idle; script ${m2.medianScriptMs}, layout ${m2.medianLayoutMs}, style ${m2.medianStyleMs} |`);
    L.push(`| M2 poll, long tasks (median per poll / longest in run) | ${m2.medianLongTasks} / ${m2.maxLongTaskMs} ms |`);
  }
  const m3 = report.m3;
  if (m3.afterLoadMB !== undefined) L.push(`| M3 JS heap after load -> after ${m3.pollingMinutes} min polling | ${m3.afterLoadMB} -> ${m3.afterPollingMB} MB (${m3.growthMB >= 0 ? "+" : ""}${m3.growthMB}); DOM nodes ${m3.nodesAfterLoad} -> ${m3.nodesAfterPolling} |`);
  const m4 = report.m4;
  if (m4.seconds) L.push(`| M4 idle on Accounts, ${m4.seconds} s, ${m4.pollsDuringWindow} polls inside | ${m4.mainThreadPctOfCore}% of one core on the main thread (${m4.betweenPollsPctOfCore}% between polls); processes ${JSON.stringify(m4.processPctOfCore)} |`);
  for (const [k, v] of Object.entries(report.m5)) L.push(`| M5 ${k} | median ${v.medianMs} ms to next frame (max ${v.maxMs}); main thread ${v.medianMainThreadMs} ms incl. the click itself |`);
  L.push("", "| Page | Ready | /v8 requests | Failed |", "| --- | --- | --- | --- |");
  for (const p of report.pages) L.push(`| ${p.id} | ${p.ok ? `${p.readyMs} ms` : "never rendered"} | ${p.v8Requests} (${p.probes} probes) | ${p.failed.length ? p.failed.join("; ") : "none"} |`);
  if (report.coverage.consoleErrors?.length) L.push("", `Console errors: ${report.coverage.consoleErrors.join(" | ")}`);
  if (harnessErrors.length) L.push("", `**Harness errors:** ${harnessErrors.join("; ")}`);
  L.push("", "Probes are the empty-body requests the dashboard sends to learn which routes a server has; the mock answers them 400 like a real route.");
  return L.join("\n") + "\n";
}

let code = 0;
try {
  await main();
} catch (e) {
  fail(e instanceof HarnessError ? e.message : `unexpected: ${e?.stack || e}`);
} finally {
  await stopAll();
  try {
    finalize();
    writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    writeFileSync(path.join(out, "report.md"), markdown());
    console.log("\n" + markdown());
    log(`report: ${path.join(out, "report.json")}`);
  } catch (e) {
    console.error("could not write the report", e);
    code = 2;
  }
}
if (harnessErrors.length) code = 2;
process.exit(code);
