import { Fragment } from "react";
import { Divider } from "@astryxdesign/core/Divider";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import type { Buckets } from "../../lib/credentials.ts";
import { TrafficStrip } from "../TrafficStrip.tsx";

/** One traffic source as a row takes it: its name, one line about it, and its buckets. */
export type SourceTrafficRow = { key: string; label: string; detail: string; buckets: Buckets };

/**
 * One strip per source, as the dashboard-alert-rail template's "All services" roster lists
 * UptimeRow: the name and a supporting line above the strip, a divider between rows. Every strip
 * shades against the busiest bucket of all rows, so strips compare.
 */
export function SourceTraffic({ rows }: { rows: readonly SourceTrafficRow[] }) {
  const max = Math.max(0, ...rows.flatMap((row) => row.buckets.total));
  return (
    <VStack gap={6}>
      {rows.map((row, index) => (
        <Fragment key={row.key}>
          {index > 0 && <Divider />}
          <VStack gap={2}>
            <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
              <Heading level={4}>{row.label}</Heading>
              <Text type="supporting" color="secondary" hasTabularNumbers>
                {row.detail}
              </Text>
            </HStack>
            <TrafficStrip buckets={row.buckets} max={max} />
          </VStack>
        </Fragment>
      ))}
    </VStack>
  );
}
