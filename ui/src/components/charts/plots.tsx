/**
 * The recharts-backed plots, loaded on demand through `loadPlots.ts` so recharts stays out of the
 * first paint. Hovering a plot, or focusing it and pressing the arrow keys (recharts' keyboard
 * layer), shows one tooltip for that bucket or source. Animation is off: the data refreshes every
 * 10 s and must not replay.
 */
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card } from "@astryxdesign/core/Card";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import type { Buckets } from "../../lib/credentials.ts";
import { currentLocale } from "../../lib/i18n.ts";
import { chartGeometry, series } from "../../themes/site/charts.ts";
import { LegendDot, type Series } from "./ChartFrame.tsx";

export type Names = { requests: string; failed: string };
/** The comparison tooltip also gives each source's failed share. */
export type SourceNames = Names & { failedShare: string };

/** One traffic source as the comparison chart takes it. */
export type SourceRow = { key: string; label: string; total: number; failed: number };

type TipItem = { label: string; value: string; series?: Series };

/** Source names longer than this are cut on the axis; the tooltip shows them whole. */
const AXIS_LABEL_CHARS = 20;

const count = (n: number) => new Intl.NumberFormat(currentLocale()).format(n);
const share = (n: number) =>
  new Intl.NumberFormat(currentLocale(), { style: "percent", maximumFractionDigits: 1 }).format(n);

const shorten = (label: string) =>
  label.length > AXIS_LABEL_CHARS ? `${label.slice(0, AXIS_LABEL_CHARS - 1)}…` : label;

function ChartTip({ heading, items }: { heading?: string; items?: TipItem[] }) {
  if (heading === undefined || !items) return null;
  return (
    <VStack aria-live="polite">
      <Card padding={3} elevation="med">
        <VStack gap={1}>
          <Text type="supporting" color="secondary">
            {heading}
          </Text>
          {items.map((item) => (
            <HStack key={item.label} gap={4} vAlign="center" justify="between" wrap="nowrap">
              {item.series ? (
                <LegendDot series={item.series} label={item.label} />
              ) : (
                <Text type="supporting" color="secondary" textWrap="nowrap">
                  {item.label}
                </Text>
              )}
              <Text weight="semibold" hasTabularNumbers textWrap="nowrap">
                {item.value}
              </Text>
            </HStack>
          ))}
        </VStack>
      </Card>
    </VStack>
  );
}

const { margin, tick, grid, cursor, minTickGap } = chartGeometry;
const axis = { tick, axisLine: false, tickLine: false } as const;

type BucketRow = { tick: string; full: string; ok: number; failed: number };

/** Requests per bucket, oldest first: the succeeded part in the volume colour, failures on top. */
export function TrafficPlot({
  categories,
  buckets,
  names,
}: {
  /** One per bucket: the axis label and the tooltip heading. */
  categories: readonly { tick: string; full: string }[];
  buckets: Buckets;
  names: Names;
}) {
  const rows: BucketRow[] = categories.map((category, i) => {
    const failed = buckets.failed[i] ?? 0;
    return { ...category, ok: (buckets.total[i] ?? 0) - failed, failed };
  });
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} margin={margin}>
        <CartesianGrid horizontal vertical={false} stroke={grid} />
        <XAxis
          dataKey="tick"
          interval="equidistantPreserveStart"
          minTickGap={minTickGap}
          {...axis}
        />
        <YAxis width="auto" allowDecimals={false} tickFormatter={count} {...axis} />
        <Tooltip
          isAnimationActive={false}
          cursor={{ fill: cursor }}
          content={({ active, payload }) => {
            const row = active ? (payload?.[0]?.payload as BucketRow | undefined) : undefined;
            return (
              <ChartTip
                heading={row?.full}
                items={
                  row && [
                    { label: names.requests, value: count(row.ok + row.failed), series: "volume" },
                    { label: names.failed, value: count(row.failed), series: "failed" },
                  ]
                }
              />
            );
          }}
        />
        <Bar dataKey="ok" stackId="requests" fill={series.volume} isAnimationActive={false} />
        <Bar dataKey="failed" stackId="requests" fill={series.failed} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Sources side by side, busiest first, one bar each in the volume colour. */
export function SourcePlot({ rows, names }: { rows: readonly SourceRow[]; names: SourceNames }) {
  const sorted = [...rows].sort((a, b) => b.total - a.total);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={sorted} layout="vertical" margin={margin}>
        <CartesianGrid vertical horizontal={false} stroke={grid} />
        <XAxis type="number" allowDecimals={false} tickFormatter={count} {...axis} />
        <YAxis type="category" dataKey="label" width="auto" tickFormatter={shorten} {...axis} />
        <Tooltip
          isAnimationActive={false}
          cursor={{ fill: cursor }}
          content={({ active, payload }) => {
            const row = active ? (payload?.[0]?.payload as SourceRow | undefined) : undefined;
            return (
              <ChartTip
                heading={row?.label}
                items={
                  row && [
                    { label: names.requests, value: count(row.total), series: "volume" },
                    { label: names.failed, value: count(row.failed) },
                    {
                      label: names.failedShare,
                      value: share(row.total > 0 ? row.failed / row.total : 0),
                    },
                  ]
                }
              />
            );
          }}
        />
        <Bar dataKey="total" fill={series.volume} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}
