import { Activity, UserCheck } from "lucide-react";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import type { Buckets } from "../../lib/credentials.ts";
import { currentLocale, t } from "../../lib/i18n.ts";
import { span } from "../../lib/time.ts";
import { layout } from "../../themes/site/layout.ts";
import { LineSkeleton } from "./LineSkeleton.tsx";
import { failures, type Summary } from "./summary.ts";

const number = (n: number) => new Intl.NumberFormat(currentLocale()).format(n);
/** One decimal, rounded up so any failure reads at least 0.1 %; only all failed reads 100 %. */
function percent(failed: number, total: number) {
  const shown = failed === total ? 1 : Math.min(0.999, Math.ceil((failed / total) * 1000) / 1000);
  return new Intl.NumberFormat(currentLocale(), {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(shown);
}

type Judgement = "good" | "attention" | "urgent" | "none";
const colour: Record<Judgement, IconProps["color"]> = {
  good: "success",
  attention: "warning",
  urgent: "error",
  none: "secondary",
};
const word = (j: Judgement) =>
  ({
    good: t("overview.tiles.good"),
    attention: t("overview.tiles.attention"),
    urgent: t("overview.tiles.urgent"),
    none: t("overview.tiles.none"),
  })[j];

type TileData = { judgement: Judgement; value: string; basis: string };

/**
 * One KPI tile as the template's KpiTile draws it: the tile's glyph in the judgement's colour
 * beside the label, the value, and one line of basis. `data` is undefined while loading; every
 * line keeps its height then.
 */
function Tile({
  label,
  icon,
  data,
  index,
}: {
  label: string;
  icon: IconProps["icon"];
  data?: TileData;
  index: number;
}) {
  const judgement = data?.judgement ?? "none";
  const lamp = data ? word(judgement) : t("overview.tiles.loading");
  return (
    <Card padding={4}>
      <VStack gap={2}>
        <HStack gap={2} vAlign="center" wrap="nowrap">
          <Icon icon={icon} size="sm" color={colour[judgement]} label={lamp} />
          <Text type="label" color="secondary" maxLines={1}>
            {label}
          </Text>
        </HStack>
        {data ? (
          <Text type="large" hasTabularNumbers>
            {data.value}
          </Text>
        ) : (
          <LineSkeleton role="metric" index={index} />
        )}
        {data ? (
          <Text type="supporting" color="secondary" maxLines={1}>
            {data.basis}
          </Text>
        ) : (
          <LineSkeleton role="supporting" index={index} />
        )}
      </VStack>
    </Card>
  );
}

function canServe(s: Summary): TileData {
  const cannot = s.total - s.ready;
  return {
    judgement: !s.ready ? "urgent" : s.failing ? "attention" : "good",
    value: t("overview.tiles.readyOf", { ready: s.ready, total: s.total }),
    basis: cannot
      ? t("overview.tiles.cannotServe", { count: cannot })
      : t("overview.tiles.allReady"),
  };
}

function cooling(s: Summary, now: number): TileData {
  const { count, soonest } = s.cooling;
  return {
    judgement: count ? "attention" : "good",
    value: number(count),
    basis:
      soonest === null
        ? t("overview.tiles.noneCooling")
        : t("overview.tiles.soonestBack", { time: span(Math.max(0, soonest - now)) }),
  };
}

const notReported = (): TileData => ({
  judgement: "none",
  value: "—",
  basis: t("overview.tiles.notReported"),
});

function requests(traffic: Buckets | null): TileData {
  if (!traffic) return notReported();
  const { total } = failures(traffic);
  return {
    judgement: total ? "good" : "none",
    value: number(total),
    basis: t("overview.tiles.lastBucket", { count: traffic.total.at(-1) ?? 0 }),
  };
}

function failureShare(traffic: Buckets | null): TileData {
  if (!traffic) return notReported();
  const { total, failed, share } = failures(traffic);
  if (share === null)
    return { judgement: "none", value: "—", basis: t("overview.tiles.noRequests") };
  return {
    // DESIGN.md "Colour": gold from 5 % failed, love from 50 %.
    judgement: share >= 0.5 ? "urgent" : share >= 0.05 ? "attention" : "good",
    value: percent(failed, total),
    basis: t("overview.tiles.failed", { count: failed }),
  };
}

/**
 * The four judgements: accounts that can serve, requests in the last 200 minutes, the failed
 * share, and accounts cooling down with the soonest back. `summary` is undefined while the
 * accounts load; `traffic` is undefined until the provider-key usage answers too.
 */
export function Tiles({
  summary,
  traffic,
  now,
}: {
  summary: Summary | undefined;
  traffic: Buckets | null | undefined;
  now: number;
}) {
  const tiles: { label: string; icon: IconProps["icon"]; data?: TileData }[] = [
    { label: t("overview.tiles.canServe"), icon: UserCheck, data: summary && canServe(summary) },
    {
      label: t("overview.tiles.requests"),
      icon: Activity,
      data: traffic === undefined ? undefined : requests(traffic),
    },
    {
      label: t("overview.tiles.failureShare"),
      icon: "error",
      data: traffic === undefined ? undefined : failureShare(traffic),
    },
    { label: t("overview.tiles.cooling"), icon: "clock", data: summary && cooling(summary, now) },
  ];
  return (
    <Grid
      columns={{ minWidth: layout.summaryTileMin, max: 4, repeat: "fit" }}
      gap={3}
      aria-label={t("overview.tiles.label")}
    >
      {tiles.map((tile, index) => (
        <Tile key={tile.label} {...tile} index={index} />
      ))}
    </Grid>
  );
}
