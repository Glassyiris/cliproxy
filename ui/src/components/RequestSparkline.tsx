// Requests over the server's ten-minute buckets as a number and a small bar sparkline, for the
// rows of Accounts and Provider keys (M1-MUST: the TrafficStrip is retired). Each bar's height is
// its bucket's requests against the row's busiest bucket; the failed part is stacked in love at
// the bar's foot. The bars stand on one baseline as wide as the strip, so empty buckets still mark
// their span and every row's timeline has the same length. The count sits in a slot of fixed width
// and the strip has a fixed width, so both start at the same x on every row. One tooltip on the
// whole strip names the bucket under the pointer, or the totals when nothing is under it (keyboard
// focus, touch).
import { useState, type PointerEvent } from "react";
import * as stylex from "@stylexjs/stylex";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import { sum, type Buckets } from "../lib/credentials.ts";
import { t } from "../lib/i18n.ts";
import { layout } from "../themes/site/layout.ts";

const styles = stylex.create({
  fixed: { flexShrink: 0 },
  strip: { height: spacingVars["--spacing-5"] },
  bars: { flexGrow: 1, minHeight: 0 },
  bar: { flexBasis: 0, flexGrow: 1, minWidth: 0 },
  baseline: {
    height: spacingVars["--spacing-0-5"],
    flexShrink: 0,
    backgroundColor: "var(--color-border)",
  },
  volume: (share: number) => ({
    height: `${share * 100}%`,
    backgroundColor: "var(--color-icon-disabled)",
  }),
  failed: (share: number) => ({ height: `${share * 100}%`, backgroundColor: "var(--color-error)" }),
});

/** One bucket's line, or the strip's totals when `index` is null. */
function describe(buckets: Buckets, times: readonly string[], index: number | null) {
  if (index === null)
    return t("accounts.traffic.strip", {
      total: sum(buckets.total),
      failed: sum(buckets.failed),
      minutes: buckets.total.length * 10,
    });
  return t("accounts.traffic.bucket", {
    time: times[index] ?? "",
    total: buckets.total[index] ?? 0,
    failed: buckets.failed[index] ?? 0,
  });
}

export function RequestSparkline({
  buckets,
  times = [],
}: {
  buckets: Buckets;
  /** Each bucket's span as the server writes it ("14:50-15:00"), oldest first. */
  times?: readonly string[];
}) {
  const [index, setIndex] = useState<number | null>(null);
  const max = Math.max(1, ...buckets.total);
  const total = sum(buckets.total);
  const point = (event: PointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const at = Math.floor(((event.clientX - box.left) / box.width) * buckets.total.length);
    setIndex(Math.min(buckets.total.length - 1, Math.max(0, at)));
  };
  return (
    <HStack gap={2} vAlign="center">
      <HStack width={layout.requests.count} hAlign="end" xstyle={styles.fixed}>
        <Text type="body" hasTabularNumbers>
          {total}
        </Text>
      </HStack>
      <Tooltip content={describe(buckets, times, index)}>
        <VStack
          gap={0}
          width={layout.requests.strip}
          xstyle={[styles.strip, styles.fixed]}
          role="img"
          aria-label={describe(buckets, times, null)}
          tabIndex={0}
          onPointerMove={point}
          onPointerLeave={() => setIndex(null)}
        >
          <HStack gap={0.5} vAlign="end" xstyle={styles.bars}>
            {buckets.total.map((n, i) => {
              const failed = Math.min(n, buckets.failed[i] ?? 0);
              return (
                <VStack key={i} vAlign="end" xstyle={styles.bar} height="100%">
                  <StackItem xstyle={styles.volume((n - failed) / max)} />
                  <StackItem xstyle={styles.failed(failed / max)} />
                </VStack>
              );
            })}
          </HStack>
          <StackItem xstyle={styles.baseline} />
        </VStack>
      </Tooltip>
    </HStack>
  );
}
