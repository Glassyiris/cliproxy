// `npm run check`: the fast gate (REQUIREMENTS row 26). Runs every gate in order, prints each
// step's time and the total, and fails when the total is over BUDGET_SECONDS. Each step may use
// only what is left of the budget; one that runs past it is killed, so a hung gate cannot stall
// the merge.
//
// Exit codes: 0 all green and in budget, 1 a gate found a violation or the budget is blown,
// 2 a gate could not run (the worst code of any step wins).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ui = fileURLToPath(new URL("..", import.meta.url));
const BUDGET_SECONDS = 90;
const TAIL_CHARS = 6000;

// Cheap, independent gates first so a typo fails in seconds; build before the two that read dist.
// `violation` lists the exit codes that mean "found a problem" (tsc reports errors with 2).
const STEPS = [
  { name: "typecheck", violation: [1, 2] },
  { name: "lint" },
  { name: "check:api" },
  { name: "check:i18n" },
  { name: "check:ui" },
  { name: "knip" },
  { name: "test" },
  { name: "build" },
  { name: "check:astryx", needs: "build" },
  { name: "check:size", needs: "build" },
];

function runStep(step, remainingMs) {
  const started = performance.now();
  if (remainingMs <= 0) return { code: 1, seconds: 0, output: "out of budget", outOfBudget: true };
  const result = spawnSync("npm", ["run", "--silent", step.name], {
    cwd: ui,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: Math.ceil(remainingMs),
    killSignal: "SIGKILL",
  });
  const seconds = (performance.now() - started) / 1000;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error?.code === "ETIMEDOUT")
    return {
      code: 1,
      seconds,
      output: `${output}\nkilled: ran out of the ${BUDGET_SECONDS}s budget`,
      outOfBudget: true,
    };
  if (result.error || result.status === null)
    return { code: 2, seconds, output: output || String(result.error) };
  if (result.status === 0) return { code: 0, seconds, output };
  return { code: (step.violation ?? [1]).includes(result.status) ? 1 : 2, seconds, output };
}

const LABEL = { 0: "ok", 1: "FAIL", 2: "ERROR" };
const outcomes = new Map();
const started = performance.now();
let outOfBudget = false;
for (const step of STEPS) {
  // Once the budget is spent the run has failed (exit 1); the rest is not started.
  if (outOfBudget) {
    console.log(`skip   ${step.name.padEnd(13)} (out of budget)`);
    outcomes.set(step.name, { code: 1, seconds: 0 });
    continue;
  }
  if (step.needs && outcomes.get(step.needs).code !== 0) {
    console.log(`skip   ${step.name.padEnd(13)} (${step.needs} did not pass)`);
    outcomes.set(step.name, { code: 2, seconds: 0 });
    continue;
  }
  const outcome = runStep(step, BUDGET_SECONDS * 1000 - (performance.now() - started));
  outcomes.set(step.name, outcome);
  outOfBudget = !!outcome.outOfBudget;
  console.log(
    `${LABEL[outcome.code].padEnd(6)} ${step.name.padEnd(13)} ${outcome.seconds.toFixed(1).padStart(5)}s`,
  );
  if (outcome.code !== 0)
    console.log(outcome.output.slice(-TAIL_CHARS).replaceAll(/^/gm, "       "));
}

const total = (performance.now() - started) / 1000;
const worst = Math.max(...[...outcomes.values()].map((outcome) => outcome.code));
console.log(`total  ${total.toFixed(1)}s (budget ${BUDGET_SECONDS}s)`);
if (total > BUDGET_SECONDS)
  console.log(`over budget: split the slowest step or drop what it does twice`);
process.exit(Math.max(worst, total > BUDGET_SECONDS ? 1 : 0));
