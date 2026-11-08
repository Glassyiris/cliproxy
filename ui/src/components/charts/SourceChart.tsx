import { Skeleton } from "@astryxdesign/core/Skeleton";
import { chartPlot } from "../../themes/site/charts.ts";
import { ChartFrame } from "./ChartFrame.tsx";
import { usePlots } from "./loadPlots.ts";
import type { SourceNames, SourceRow } from "./plots.tsx";

/**
 * Traffic sources compared by requests, one bar each in a single series colour, in the order
 * given; the tooltip adds failures and their share. A Skeleton of the plot's size holds the space while the
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
  const plots = usePlots(!loading);
  const placeholder = <Skeleton />;
  const plot = loading || !plots ? placeholder : <plots.SourcePlot rows={rows} names={names} />;
  return (
    <ChartFrame
      label={label}
      summary={summary}
      legend={[{ series: "volume", label: names.requests }]}
      plot={chartPlot.plot}
    >
      {plot}
    </ChartFrame>
  );
}
