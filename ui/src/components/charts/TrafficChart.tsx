import { Skeleton } from "@astryxdesign/core/Skeleton";
import type { Buckets } from "../../lib/credentials.ts";
import { chartPlot } from "../../themes/site/charts.ts";
import { ChartFrame } from "./ChartFrame.tsx";
import { usePlots } from "./loadPlots.ts";
import type { Names } from "./plots.tsx";

/**
 * Requests in the server's ten-minute buckets with failures marked, as the dashboard-alert-rail
 * template's MetricChart draws a series. A Skeleton of the plot's size holds the space while the
 * data or recharts is pending, so nothing shifts.
 */
export function TrafficChart({
  categories,
  buckets,
  names,
  label,
  summary,
  loading = false,
}: {
  /** One per bucket, oldest first: the axis label and the tooltip heading. */
  categories: readonly { tick: string; full: string }[];
  buckets: Buckets;
  names: Names;
  /** The chart's accessible name. */
  label: string;
  /** One sentence that says what the chart shows, under it and as its description. */
  summary: string;
  loading?: boolean;
}) {
  const plots = usePlots(!loading);
  const props = { categories, buckets, names };
  const placeholder = <Skeleton />;
  const plot = loading || !plots ? placeholder : <plots.TrafficPlot {...props} />;
  return (
    <ChartFrame
      label={label}
      summary={summary}
      plot={chartPlot.traffic}
      legend={[
        { series: "volume", label: names.requests },
        { series: "failed", label: names.failed },
      ]}
    >
      {plot}
    </ChartFrame>
  );
}
