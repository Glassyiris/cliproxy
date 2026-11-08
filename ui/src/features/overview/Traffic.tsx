import { useMemo } from "react";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TrafficChart } from "../../components/charts/index.ts";
import { ReadError } from "../../components/ReadError.tsx";
import type { Buckets } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { failures } from "./summary.ts";

const NO_BUCKETS: Buckets = { total: [], failed: [] };
/** The server writes a bucket as "14:50-15:00"; a range takes an en dash. */
const span = (time: string) => time.replace("-", "\u2013");

/** The written conclusion under the chart: totals, then the busiest ten minutes. */
function conclusion(traffic: Buckets, times: string[]) {
  const { total, failed } = failures(traffic);
  if (!total) return t("overview.chart.none");
  const peak = Math.max(...traffic.total);
  const at = traffic.total.indexOf(peak);
  return t("overview.chart.summary", { total, failed, peak, time: span(times[at] ?? "") });
}

export type Read = { error: unknown; what: string; retry: () => void };

/**
 * The template's chart card: requests per ten-minute bucket over 200 minutes with failures on
 * top, its one-sentence conclusion, and the way to the per-source detail on Traffic analysis.
 * `traffic` is undefined while loading and null when the server reports no history; `reads` are
 * the failed reads it depends on.
 */
export function TrafficCard({
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
        <HStack gap={3} vAlign="start" hAlign="between" wrap="wrap">
          <VStack gap={1}>
            <Heading level={3} accessibilityLevel={2}>
              {t("overview.chart.heading")}
            </Heading>
            <Text type="supporting" color="secondary">
              {t("overview.chart.description")}
            </Text>
          </VStack>
          <Link href="#usage">{t("overview.chart.bySource")}</Link>
        </HStack>
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
