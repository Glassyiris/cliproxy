import { lazy, Suspense, useEffect } from "react";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { chartPlot } from "../../themes/site/charts.ts";
import { ChartFrame } from "./ChartFrame.tsx";
import { loadedPlots, loadPlots } from "./loadPlots.ts";
import type { SourceNames, SourceRow } from "./plots.tsx";

const LazyPlot = lazy(() => loadPlots().then((plots) => ({ default: plots.SourcePlot })));

/**
 * Traffic sources compared by requests, busiest first, one bar each in a single series colour; the
 * tooltip adds failures and their share. A Skeleton of the plot's size holds the space while the
 * data or recharts is pending.
 */
export function SourceChart({
  rows,
  names,
  label,
  summary,
  loading = false,
}: {
  rows: readonly SourceRow[];
  names: SourceNames;
  /** The chart's accessible name. */
  label: string;
  /** One sentence that says what the chart shows, under it and as its description. */
  summary: string;
  loading?: boolean;
}) {
  useEffect(() => void loadPlots(), []);
  const plots = loadedPlots();
  const placeholder = <Skeleton />;
  const plot = loading ? (
    placeholder
  ) : plots ? (
    <plots.SourcePlot rows={rows} names={names} />
  ) : (
    <Suspense fallback={placeholder}>
      <LazyPlot rows={rows} names={names} />
    </Suspense>
  );
  return (
    <ChartFrame label={label} summary={summary} plot={chartPlot.sources(rows.length)}>
      {plot}
    </ChartFrame>
  );
}
