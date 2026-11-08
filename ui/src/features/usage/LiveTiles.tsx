import { Activity, Coins, Timer } from "lucide-react";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/Code";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { proportional, Table, type TableColumn } from "@astryxdesign/core/Table";
import { Heading, Text } from "@astryxdesign/core/Text";
import { currentLocale, t } from "../../lib/i18n.ts";
import type { usageStats } from "../../lib/usage.ts";
import { layout } from "../../themes/site/layout.ts";

type Stats = ReturnType<typeof usageStats>;
type ModelRow = Stats["models"][number];

const number = (n: number) => new Intl.NumberFormat(currentLocale()).format(n);

/** The template's KPI tile without its sparkline and delta: label with its icon, value, one line. */
function Tile({
  icon,
  label,
  value,
  sub,
}: {
  icon: IconProps["icon"];
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <Card padding={4} height="100%">
      <VStack gap={2}>
        <HStack gap={2} vAlign="center">
          <Icon icon={icon} size="sm" color="secondary" />
          <Text type="label" color="secondary">
            {label}
          </Text>
        </HStack>
        <Heading level={2}>{value}</Heading>
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {sub}
        </Text>
      </VStack>
    </Card>
  );
}

const ms = (n: number | null) => (n === null ? t("usage.tiles.none") : t("usage.tiles.ms", { n }));

export function LiveTiles({ stats }: { stats: Stats }) {
  return (
    <Grid
      columns={{ minWidth: layout.summaryTileMin, max: 3, repeat: "fit" }}
      gap={3}
      aria-label={t("usage.tiles.label")}
    >
      <Tile
        icon={Activity}
        label={t("usage.tiles.requests")}
        value={number(stats.count)}
        sub={t("usage.tiles.failed", { count: stats.failed })}
      />
      <Tile
        icon={Timer}
        label={t("usage.tiles.latency")}
        value={ms(stats.latency)}
        sub={t("usage.tiles.firstToken", { time: ms(stats.ttft) })}
      />
      <Tile
        icon={Coins}
        label={t("usage.tiles.tokens")}
        value={number(stats.input + stats.output)}
        sub={t("usage.tiles.inOut", { input: stats.input, output: stats.output })}
      />
    </Grid>
  );
}

const count = (n: number) => <Text hasTabularNumbers>{number(n)}</Text>;

const modelColumns = (): TableColumn<ModelRow>[] => [
  {
    key: "model",
    header: t("usage.models.model"),
    // Twice a count's share, and free to narrow to the counts' floor on a phone.
    width: proportional(2, { minWidth: layout.tableColumnFloor }),
    renderCell: (row) => <Code>{row.model}</Code>,
  },
  {
    key: "count",
    header: t("usage.models.requests"),
    align: "end",
    renderCell: (row) => count(row.count),
  },
  {
    key: "failed",
    header: t("usage.models.failed"),
    align: "end",
    renderCell: (row) => count(row.failed),
  },
  {
    key: "tokens",
    header: t("usage.models.tokens"),
    align: "end",
    renderCell: (row) => count(row.input + row.output),
  },
];

export function ModelTable({ models }: { models: ModelRow[] }) {
  return (
    <VStack gap={6}>
      <VStack>
        <Heading level={2}>{t("usage.models.heading")}</Heading>
        <Text type="supporting" color="secondary">
          {t("usage.models.description")}
        </Text>
      </VStack>
      <Table<ModelRow> data={models} columns={modelColumns()} idKey="model" />
    </VStack>
  );
}
