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
import { providerIcon } from "../ProviderIcon.tsx";
import { currentLocale } from "../../lib/i18n.ts";
import { chartGeometry, MARK_GAP, series } from "../../themes/site/charts.ts";
import { LegendDot, type Series } from "./ChartFrame.tsx";

export type Names = { requests: string; failed: string };
/** The comparison tooltip also gives each source's failed share. */
export type SourceNames = Names & { failedShare: string };

/** One traffic source as the comparison chart takes it. */
export type SourceRow = {
  key: string;
  label: string;
  total: number;
  failed: number;
  /** The provider whose mark sits beside the label on the axis. */
  provider?: string;
};

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

/** The mark beside a source's axis label and the gap between mark and name, in em of the tick. */
const MARK_EM = 1.15;
const MARK_GAP_EM = 0.45;

type TickProps = {
  x?: number | string;
  y?: number | string;
  index?: number;
  /** recharts' tick class: it measures the elements carrying it for the axis's auto width. */
  className?: string;
};

/**
 * A source's axis label with its provider's mark between the name and the bar, so the marks line
 * up in one column. Sized in em so it follows the tick's font size.
 */
function sourceTick(rows: readonly SourceRow[]) {
  return function SourceTick({ x = 0, y = 0, index = 0, className }: TickProps) {
    const provider = rows[index]?.provider;
    const Mark = provider ? providerIcon(provider) : undefined;
    const name = shorten(rows[index]?.label ?? "");
    return (
      <g
        transform={`translate(${x},${y})`}
        className={className}
        color={tick.fill}
        fontSize={tick.fontSize}
      >
        {Mark && (
          <Mark
            x={`-${MARK_EM}em`}
            y={`-${MARK_EM / 2}em`}
            width={`${MARK_EM}em`}
            height={`${MARK_EM}em`}
            aria-hidden
          />
        )}
        <text
          x={Mark ? `-${MARK_EM + MARK_GAP_EM}em` : 0}
          dy="0.35em"
          textAnchor="end"
          fill="currentColor"
        >
          {name}
        </text>
      </g>
    );
  };
}

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

/** Sources side by side in the order given, one bar each in the volume colour. */
export function SourcePlot({ rows, names }: { rows: readonly SourceRow[]; names: SourceNames }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} layout="vertical" margin={margin}>
        <CartesianGrid vertical horizontal={false} stroke={grid} />
        <XAxis type="number" allowDecimals={false} tickFormatter={count} {...axis} />
        <YAxis
          type="category"
          dataKey="label"
          width="auto"
          {...axis}
          tickMargin={MARK_GAP}
          tick={sourceTick(rows)}
        />
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
