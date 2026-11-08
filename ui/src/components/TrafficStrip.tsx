import { HStack, StackItem } from "@astryxdesign/core/Layout";
import { level, sum, type Buckets } from "../lib/credentials.ts";
import { t } from "../lib/i18n.ts";
import { traffic } from "../themes/site/traffic.ts";
import { bucketTone, toneCounts } from "./trafficTone.ts";

const levels = [traffic.level0, traffic.level1, traffic.level2, traffic.level3, traffic.level4];

function fill(total: number, failed: number, max: number) {
  const tone = bucketTone(total, failed);
  if (tone === "failing") return traffic.failing;
  if (tone === "degraded") return traffic.degraded;
  return levels[level(total, max)];
}

/**
 * Requests in the server's ten-minute buckets, oldest first: one box per bucket, darker for more
 * requests; gold for a bucket where some requests failed and love where at least half did
 * (`trafficTone.ts`). `max` is the busiest bucket of the whole list, so strips side by side
 * compare. One image to assistive tech, with its totals and those buckets as the label.
 */
export function TrafficStrip({ buckets, max }: { buckets: Buckets; max: number }) {
  const summary = t("app.traffic.summary", {
    total: sum(buckets.total),
    failed: sum(buckets.failed),
    minutes: buckets.total.length * 10,
    ...toneCounts(buckets.total, buckets.failed),
  });
  return (
    <HStack gap={0.5} role="img" aria-label={summary}>
      {buckets.total.map((n, i) => (
        <StackItem key={i} xstyle={[traffic.bucket, fill(n, buckets.failed[i] ?? 0, max)]} />
      ))}
    </HStack>
  );
}
