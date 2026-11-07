import type { ReactNode } from "react";
import { Activity, CircleCheck, KeyRound, Percent } from "lucide-react";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { currentLocale, list, t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import type { LampCounts } from "./summary.ts";

const number = (n: number) => new Intl.NumberFormat(currentLocale()).format(n);
/** One decimal, rounded down so a rate with failures never reads 100 %; a clean 100 % has none. */
const percent = (rate: number) => {
  const digits = rate === 1 ? 0 : 1;
  const shown = Math.floor(rate * 1000) / 1000;
  return new Intl.NumberFormat(currentLocale(), {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(shown);
};

/**
 * A number tile: the label with its icon, the value as a heading, a status dot beside it only
 * while the number asks for attention, and one supporting line. The label links to the page
 * that explains the number.
 */
function Tile({
  icon,
  label,
  href,
  value,
  sub,
  attention,
}: {
  icon: IconProps["icon"];
  label: string;
  href: string;
  /** Undefined while loading. */
  value: string | undefined;
  sub?: ReactNode;
  attention?: "warning" | "error";
}) {
  const note =
    attention && (attention === "error" ? t("overview.tiles.error") : t("overview.tiles.warning"));
  return (
    <Card padding={4} height="100%">
      <VStack gap={1}>
        <HStack gap={2} vAlign="center" wrap="nowrap">
          <Icon icon={icon} size="sm" color="secondary" />
          <Text type="label" color="secondary">
            <Link href={href}>{label}</Link>
          </Text>
        </HStack>
        {value === undefined ? (
          <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
        ) : (
          <HStack gap={2} vAlign="center">
            <Heading level={2}>{value}</Heading>
            {note && <StatusDot variant={attention} label={note} tooltip={note} />}
          </HStack>
        )}
        {sub && (
          <Text type="supporting" color="secondary">
            {sub}
          </Text>
        )}
      </VStack>
    </Card>
  );
}

export type TileData = {
  /** Account states; undefined while loading, null when the accounts could not be read. */
  counts: LampCounts | null | undefined;
  /** Requests in the last 200 minutes; null when nothing is reported. */
  requests: { total: number; failed: number; rate: number | null } | null | undefined;
  /** Client keys; null when the configuration could not be read. */
  keys: number | null | undefined;
};

const blank = "—";

function canServe(counts: TileData["counts"]) {
  if (!counts) return { value: counts === null ? blank : undefined };
  const total = counts.ok + counts.warn + counts.bad + counts.off;
  const states = [
    counts.warn && t("overview.tiles.cooling", { count: counts.warn }),
    counts.bad && t("overview.tiles.failing", { count: counts.bad }),
    counts.off && t("overview.tiles.disabled", { count: counts.off }),
  ].filter((s): s is string => !!s);
  return {
    value: t("overview.tiles.readyOf", { ready: counts.ok, total }),
    sub: !total
      ? t("overview.tiles.noAccounts")
      : states.length
        ? list(states)
        : t("overview.tiles.allReady"),
    attention:
      total && !counts.ok
        ? ("error" as const)
        : counts.warn || counts.bad
          ? ("warning" as const)
          : undefined,
  };
}

function successSub(requests: NonNullable<TileData["requests"]>) {
  if (requests.total)
    return t("overview.tiles.succeeded", {
      ok: requests.total - requests.failed,
      total: requests.total,
    });
  return (
    <>
      {t("overview.tiles.noRequests")} <Link href="#use">{t("overview.tiles.setUpTool")}</Link>
    </>
  );
}

/** Requests and success rate: loading, "—" (unread or unreported), or the numbers. */
function trafficTiles(requests: TileData["requests"], failedRead: boolean) {
  if (!requests) {
    const value = requests === undefined ? undefined : blank;
    const sub = requests === null && !failedRead ? t("overview.tiles.notReported") : undefined;
    return { requests: { value, sub }, success: { value, sub } };
  }
  return {
    requests: {
      value: number(requests.total),
      sub: t("overview.tiles.failed", { count: requests.failed }),
    },
    success: {
      value: requests.rate === null ? blank : percent(requests.rate),
      sub: successSub(requests),
    },
  };
}

function keyTile(keys: TileData["keys"]) {
  if (keys === undefined || keys === null) return { value: keys === null ? blank : undefined };
  return {
    value: number(keys),
    sub: keys ? t("overview.tiles.keysRequired") : t("overview.tiles.noKeys"),
    attention: keys ? undefined : ("warning" as const),
  };
}

export function StatusTiles({ counts, requests, keys }: TileData) {
  const tiles = trafficTiles(requests, counts === null);
  return (
    <Grid
      columns={{ minWidth: layout.summaryTileMin, max: 4, repeat: "fit" }}
      gap={3}
      aria-label={t("overview.tiles.label")}
    >
      <Tile
        icon={CircleCheck}
        label={t("overview.tiles.canServe")}
        href="#accounts?show=attention"
        {...canServe(counts)}
      />
      <Tile
        icon={Activity}
        label={t("overview.tiles.requests")}
        href="#usage"
        {...tiles.requests}
      />
      <Tile
        icon={Percent}
        label={t("overview.tiles.successRate")}
        href="#usage"
        {...tiles.success}
      />
      <Tile
        icon={KeyRound}
        label={t("overview.tiles.clientKeys")}
        href="#keys"
        {...keyTile(keys)}
      />
    </Grid>
  );
}
