import { Fragment, type ReactNode } from "react";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Heading, Text } from "@astryxdesign/core/Text";
import { ReadError } from "../../components/ReadError.tsx";
import { TrafficStrip } from "../../components/TrafficStrip.tsx";
import { notImplemented } from "../../lib/api/client.ts";
import { label, sum, type Buckets } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import type { Traffic } from "./summary.ts";

const nameSkeleton = (
  <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
);

/** One row: the name and its totals, then the strip. */
function TrafficRow({
  name,
  href,
  buckets,
  max,
}: {
  name: string;
  href?: string;
  buckets: Buckets | null;
  max: number;
}) {
  return (
    <VStack gap={2}>
      <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
        <Heading level={4} accessibilityLevel={3}>
          {href ? <Link href={href}>{name}</Link> : name}
        </Heading>
        <Text type="supporting" color="secondary">
          {buckets
            ? t("overview.traffic.count", {
                total: sum(buckets.total),
                failed: sum(buckets.failed),
              })
            : t("overview.traffic.noHistory")}
        </Text>
      </HStack>
      {buckets && <TrafficStrip buckets={buckets} max={max} />}
    </VStack>
  );
}

function SkeletonRows() {
  return [0, 1, 2].map((i) => (
    <Fragment key={i}>
      {i > 0 && <Divider />}
      <VStack gap={2}>
        {nameSkeleton}
        <Skeleton height={layout.valueSkeleton.height} index={i} />
      </VStack>
    </Fragment>
  ));
}

export type KeyUsageRead = { error: unknown; retry: () => void } | null;

function rows(traffic: Traffic, keyRead: KeyUsageRead) {
  const list: { key: string; node: ReactNode }[] = [
    {
      key: "all",
      node: <TrafficRow name={t("overview.traffic.all")} buckets={traffic.all} max={traffic.max} />,
    },
    ...traffic.accounts.map((r) => ({
      key: `a:${r.provider}`,
      node: (
        <TrafficRow
          name={t("overview.traffic.accounts", { provider: label(r.provider) })}
          href={`#accounts?provider=${encodeURIComponent(r.provider)}`}
          buckets={r.buckets}
          max={traffic.max}
        />
      ),
    })),
  ];
  if (keyRead && notImplemented(keyRead.error))
    list.push({
      key: "keys",
      node: (
        <HStack gap={2} vAlign="center">
          <Icon icon="info" size="sm" color="info" />
          <Text type="supporting" color="secondary">
            {t("overview.traffic.keysNotReported")}
          </Text>
        </HStack>
      ),
    });
  else if (keyRead)
    list.push({
      key: "keys",
      node: (
        <ReadError
          error={keyRead.error}
          what={t("overview.traffic.keyUsage")}
          retry={keyRead.retry}
        />
      ),
    });
  else
    for (const r of traffic.keys)
      list.push({
        key: `k:${r.provider}`,
        node: (
          <TrafficRow
            name={t("overview.traffic.keys", { provider: label(r.provider) })}
            href={`#providers?family=${encodeURIComponent(r.provider)}`}
            buckets={r.buckets}
            max={traffic.max}
          />
        ),
      });
  return list;
}

/**
 * One strip per provider: all traffic first, then accounts and provider keys by provider.
 * `traffic` is undefined while the accounts or the key usage load, and null when the accounts
 * could not be read; the page banner says so.
 */
export function TrafficCard({
  traffic,
  keyRead,
}: {
  traffic: Traffic | null | undefined;
  keyRead: KeyUsageRead;
}) {
  const list = traffic ? rows(traffic, keyRead) : [];
  const isEmpty = traffic && !traffic.accounts.length && !traffic.keys.length && !keyRead;
  return (
    <VStack gap={6}>
      <VStack>
        <Heading level={2}>{t("overview.traffic.heading")}</Heading>
        <Text type="supporting" color="secondary">
          {t("overview.traffic.description")}
        </Text>
      </VStack>
      <Card padding={6}>
        {traffic === undefined ? (
          <VStack gap={6}>
            <SkeletonRows />
          </VStack>
        ) : traffic === null ? (
          <Text type="body" color="secondary">
            {t("overview.traffic.unavailable")}
          </Text>
        ) : isEmpty ? (
          <EmptyState title={t("overview.traffic.empty")} headingLevel={3} isCompact />
        ) : (
          <VStack gap={6}>
            {list.map((row, index) => (
              <Fragment key={row.key}>
                {index > 0 && <Divider />}
                {row.node}
              </Fragment>
            ))}
          </VStack>
        )}
      </Card>
    </VStack>
  );
}
