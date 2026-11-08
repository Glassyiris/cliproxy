import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { icons } from "../../components/icons.ts";
import { CardHeading } from "../../components/CardHeading.tsx";
import { SourceChart, TrafficChart, type SourceRow } from "../../components/charts/index.ts";
import { ReadError } from "../../components/ReadError.tsx";
import { SectionHeading } from "../../components/SectionHeading.tsx";
import { label, type Buckets } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { SOURCE_BARS } from "../../themes/site/charts.ts";
import { layout } from "../../themes/site/layout.ts";
import { roles } from "../../themes/site/roles.ts";
import { failures, type Source } from "./summary.ts";

const NO_BUCKETS: Buckets = { total: [], failed: [] };
/** While loading, the source plot holds about the traffic plot's height, so the cards match. */
const LOADING_SOURCES: SourceRow[] = Array.from({ length: 7 }, (_, i) => ({
  key: String(i),
  label: "",
  total: 0,
  failed: 0,
}));
/** The server writes a bucket as "14:50-15:00"; a range takes an en dash. */
const span = (time: string) => time.replace("-", "–");

/** The written conclusion under the chart: totals, then the busiest ten minutes. */
function conclusion(traffic: Buckets, times: string[]) {
  const { total, failed } = failures(traffic);
  if (!total) return t("overview.chart.none");
  const peak = Math.max(...traffic.total);
  const at = traffic.total.indexOf(peak);
  return t("overview.chart.summary", { total, failed, peak, time: span(times[at] ?? "") });
}

/** The written conclusion under the source chart: the busiest source and its part of the total. */
function sourceConclusion(rows: SourceRow[]) {
  const total = rows.reduce((n, r) => n + r.total, 0);
  if (!total) return t("overview.chart.none");
  const top = rows.reduce((a, b) => (b.total > a.total ? b : a));
  return t("overview.sources.summary", { source: top.label, count: top.total, total });
}

export type Read = { error: unknown; what: string; retry: () => void };

function TrafficCard({
  traffic,
  times,
  reads,
}: {
  traffic: Buckets | null | undefined;
  times: string[];
  reads: Read[];
}) {
  const categories = useMemo(
    () => times.map((time) => ({ tick: time.split("-")[0] ?? "", full: span(time) })),
    [times],
  );
  const failedWithoutData = traffic === undefined && reads.length > 0;
  return (
    <Card padding={roles.card.padding} height="100%">
      <VStack gap={roles.gap.card}>
        <CardHeading icon={icons.traffic} title={t("overview.chart.label")} />
        {reads.map((read) => (
          <ReadError key={read.what} error={read.error} what={read.what} retry={read.retry} />
        ))}
        {traffic === null ? (
          <EmptyState title={t("overview.chart.notReported")} headingLevel={3} isCompact />
        ) : failedWithoutData ? null : (
          <TrafficChart
            categories={categories}
            buckets={traffic ?? NO_BUCKETS}
            names={{ requests: t("overview.chart.requests"), failed: t("overview.chart.failed") }}
            label={t("overview.chart.label")}
            summary={traffic ? conclusion(traffic, times) : t("overview.tiles.loading")}
            loading={!traffic}
          />
        )}
      </VStack>
    </Card>
  );
}

function SourcesCard({ sources, reads }: { sources: Source[] | null | undefined; reads: Read[] }) {
  // A source without requests in the window draws no bar; the Usage page lists every source.
  // Busiest first; past SOURCE_BARS the rest fold into one bar, and the Usage page lists them all.
  const rows = useMemo(() => {
    const busy = sources
      ?.filter((s) => s.total > 0)
      .sort((a, b) => b.total - a.total)
      .map((s) => ({
        key: `${s.kind}:${s.provider}`,
        label:
          s.kind === "accounts"
            ? t("overview.sources.accounts", { provider: label(s.provider) })
            : t("overview.sources.keys", { provider: label(s.provider) }),
        total: s.total,
        failed: s.failed,
        provider: s.provider,
      }));
    if (!busy || busy.length <= SOURCE_BARS) return busy;
    const rest = busy.slice(SOURCE_BARS - 1);
    return [
      ...busy.slice(0, SOURCE_BARS - 1),
      {
        key: "other",
        label: t("overview.sources.other", { count: rest.length }),
        total: rest.reduce((n, r) => n + r.total, 0),
        failed: rest.reduce((n, r) => n + r.failed, 0),
      },
    ];
  }, [sources]);
  return (
    <Card padding={roles.card.padding} height="100%">
      <VStack gap={roles.gap.card}>
        <CardHeading
          icon={icons.sources}
          title={t("overview.sources.heading")}
          actions={
            <Button
              label={t("overview.sources.usage")}
              variant={roles.rowAction.variant}
              size={roles.rowAction.size}
              endContent={<Icon icon={ChevronRight} />}
              href="#activity"
            />
          }
        />
        {sources === null ? (
          <EmptyState title={t("overview.chart.notReported")} headingLevel={3} isCompact />
        ) : rows?.length === 0 ? (
          <EmptyState title={t("overview.tiles.noRequests")} headingLevel={3} isCompact />
        ) : sources === undefined && reads.length > 0 ? null : (
          <SourceChart
            rows={rows ?? LOADING_SOURCES}
            names={{
              requests: t("overview.chart.requests"),
              failed: t("overview.chart.failed"),
              failedShare: t("overview.tiles.failureShare"),
            }}
            label={t("overview.sources.label")}
            summary={rows ? sourceConclusion(rows) : t("overview.tiles.loading")}
            loading={!rows}
          />
        )}
      </VStack>
    </Card>
  );
}

/**
 * The traffic section: its heading, then the template's two chart cards side by side at one plot
 * height, so they end level, stacked where they do not fit: requests per ten-minute bucket
 * with failures on top, and requests per source. `traffic` and `sources` are
 * undefined while loading and null when the server reports no history; `reads` are the failed
 * reads both depend on, shown in the traffic card.
 */
export function Charts({
  traffic,
  times,
  sources,
  reads,
}: {
  traffic: Buckets | null | undefined;
  times: string[];
  sources: Source[] | null | undefined;
  reads: Read[];
}) {
  return (
    <VStack gap={roles.gap.card}>
      <SectionHeading
        icon={icons.activity}
        title={t("overview.chart.heading")}
        hint={t("overview.chart.window")}
      />
      <Grid columns={{ minWidth: layout.settingsColumnMin, repeat: "fit" }} gap={roles.gap.card}>
        <TrafficCard traffic={traffic} times={times} reads={reads} />
        <SourcesCard sources={sources} reads={reads} />
      </Grid>
    </VStack>
  );
}
