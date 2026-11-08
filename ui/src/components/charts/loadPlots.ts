// recharts loads once a chart has its data, the page has painted and the browser is idle, so it is
// never on a page's critical path and does not share the network with the page's own reads: the
// plot's Skeleton holds the box until then. The plot renders in a transition,
// which React splits into short tasks instead of one long one. Once loaded, a chart renders the
// plot directly.
import { startTransition, useEffect, useState } from "react";
import type * as Plots from "./plots.tsx";

type PlotsModule = typeof Plots;

/** How long an idle callback may wait before it runs anyway, so a busy page still gets its chart. */
const IDLE_LIMIT = 1500;

let loaded: PlotsModule | null = null;
let pending: Promise<PlotsModule> | null = null;

/** The next frame after the current one has painted, then idle time. */
function afterPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      if ("requestIdleCallback" in window)
        requestIdleCallback(() => resolve(), { timeout: IDLE_LIMIT });
      else setTimeout(resolve, 0);
    });
  });
}

/** Charts render one per idle turn, so two charts on a page are two short tasks, not one long one. */
let turns = Promise.resolve();
function nextTurn() {
  turns = turns.then(afterPaint);
  return turns;
}

function loadPlots() {
  pending ??= afterPaint()
    .then(() => import("./plots.tsx"))
    .then((plots) => (loaded = plots));
  return pending;
}

/**
 * The plot components, or null until recharts is in; nothing is fetched until `wanted` (the chart
 * has its data). A failed load is thrown on render, so the page's error boundary reports it as it
 * does a failed page chunk.
 */
export function usePlots(wanted: boolean) {
  const [plots, setPlots] = useState(loaded);
  const [failed, setFailed] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
    if (plots || !wanted) return;
    let live = true;
    loadPlots()
      .then((next) => nextTurn().then(() => next))
      .then(
        (next) => live && startTransition(() => setPlots(next)),
        (error: unknown) => live && setFailed({ error }),
      );
    return () => {
      live = false;
    };
  }, [plots, wanted]);
  if (failed) throw failed.error;
  return plots;
}
