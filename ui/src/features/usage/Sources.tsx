import { Fragment } from "react";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Heading, Text } from "@astryxdesign/core/Text";
import { ReadError } from "../../components/ReadError.tsx";
import { TrafficStrip } from "../../components/TrafficStrip.tsx";
import { notImplemented } from "../../lib/api/client.ts";
import { label, sum } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import type { Source } from "./summary.ts";

/** One source: its name and totals, then the strip, as the template's uptime row. */
function SourceRow({ source, max }: { source: Source; max: number }) {
  const name = label(source.provider);
  const b = source.buckets;
  return (
    <VStack gap={2}>
      <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
        <Heading level={4} accessibilityLevel={3}>
          {source.via === "accounts"
            ? t("usage.sources.accounts", { provider: name })
            : t("usage.sources.keys", { provider: name })}
        </Heading>
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {b
            ? t("usage.sources.count", { total: sum(b.total), failed: sum(b.failed) })
            : t("usage.sources.notReported")}
        </Text>
      </HStack>
      {b && <TrafficStrip buckets={b} max={max} />}
    </VStack>
  );
}

function SkeletonRows() {
  return [0, 1, 2].map((i) => (
    <Fragment key={i}>
      {i > 0 && <Divider />}
      <VStack gap={2}>
        <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
        <Skeleton height={layout.valueSkeleton.height} index={i} />
      </VStack>
    </Fragment>
  ));
}

/** A source read that failed, drawn in place of its rows; null when it answered. */
export type SourceRead = { error: unknown; retry: () => void } | null;

function KeyUsageNote({ read }: { read: NonNullable<SourceRead> }) {
  if (notImplemented(read.error))
    return (
      <HStack gap={2} vAlign="center">
        <Icon icon="info" size="sm" color="info" />
        <Text type="supporting" color="secondary">
          {t("usage.sources.keysNotReported")}
        </Text>
      </HStack>
    );
  return <ReadError error={read.error} what={t("usage.sources.keyUsage")} retry={read.retry} />;
}

/**
 * The template's "All services" roster: one strip per source. `rows` is undefined while either
 * read is pending, so a source still loading never reads as no traffic; a read that already
 * failed shows its banner meanwhile.
 */
export function SourcesCard({
  rows,
  max,
  accountRead,
  keyRead,
}: {
  rows: Source[] | undefined;
  max: number;
  accountRead: SourceRead;
  keyRead: SourceRead;
}) {
  const notes = [
    accountRead && (
      <ReadError
        key="accounts"
        error={accountRead.error}
        what={t("usage.sources.accountsRead")}
        retry={accountRead.retry}
      />
    ),
    keyRead && <KeyUsageNote key="keys" read={keyRead} />,
  ].filter(Boolean);
  return (
    <VStack gap={6}>
      <VStack>
        <Heading level={2}>{t("usage.sources.heading")}</Heading>
        <Text type="supporting" color="secondary">
          {t("usage.sources.description")}
        </Text>
      </VStack>
      <Card padding={6}>
        <VStack gap={6}>
          {notes}
          {rows === undefined ? (
            <SkeletonRows />
          ) : (
            <>
              {!rows.length && !accountRead && (!keyRead || notImplemented(keyRead.error)) && (
                <EmptyState title={t("usage.sources.empty")} headingLevel={3} isCompact />
              )}
              {rows.map((source, index) => (
                <Fragment key={`${source.via}:${source.provider}`}>
                  {index > 0 && <Divider />}
                  <SourceRow source={source} max={max} />
                </Fragment>
              ))}
            </>
          )}
        </VStack>
      </Card>
    </VStack>
  );
}
