import { useMemo, type ReactNode } from "react";
import { ChartBarDecreasing, ChartColumn } from "lucide-react";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Heading, Text } from "@astryxdesign/core/Text";
import { SourceChart, TrafficChart, type SourceRow } from "../../components/charts/index.ts";
import { ReadError } from "../../components/ReadError.tsx";
import { label, type Buckets } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
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

/** A chart card's head as the template's MetricChart writes it, with the card's glyph. */
function CardTitle({
  icon,
  title,
  description,
  end,
}: {
  icon: IconProps["icon"];
  title: string;
  description: string;
  end?: ReactNode;
}) {
  return (
    <HStack gap={3} vAlign="start" hAlign="between" wrap="wrap">
      <VStack gap={1}>
        <HStack gap={2} vAlign="center">
          <Icon icon={icon} size="sm" color="secondary" />
          <Heading level={3} accessibilityLevel={2}>
            {title}
          </Heading>
        </HStack>
        <Text type="supporting" color="secondary">
          {description}
        </Text>
      </VStack>
      {end}
    </HStack>
  );
}

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
    <Card padding={6}>
      <VStack gap={4}>
        <CardTitle
          icon={ChartColumn}
          title={t("overview.chart.heading")}
          description={t("overview.chart.description")}
        />
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
  const rows = useMemo(
    () =>
      sources
        ?.filter((s) => s.total > 0)
        .map((s) => ({
          key: `${s.kind}:${s.provider}`,
          label:
            s.kind === "accounts"
              ? t("overview.sources.accounts", { provider: label(s.provider) })
              : t("overview.sources.keys", { provider: label(s.provider) }),
          total: s.total,
          failed: s.failed,
        })),
    [sources],
  );
  return (
    <Card padding={6}>
      <VStack gap={4}>
        <CardTitle
          icon={ChartBarDecreasing}
          title={t("overview.sources.heading")}
          description={t("overview.sources.description")}
          end={<Link href="#usage">{t("overview.sources.usage")}</Link>}
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
 * The template's two chart cards side by side, stacked where they do not fit: requests per
 * ten-minute bucket with failures on top, and requests per source. `traffic` and `sources` are
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
    <Grid columns={{ minWidth: layout.settingsColumnMin, repeat: "fit" }} gap={3}>
      <TrafficCard traffic={traffic} times={times} reads={reads} />
      <SourcesCard sources={sources} reads={reads} />
    </Grid>
  );
}
