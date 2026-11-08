// The Usage tab's second section: the requests this tab took off the server's usage queue while
// the live view ran, kept for one hour. Off and empty, it is one empty state with the start action.
import { Activity, Coins, Radio, Timer } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { proportional, Table, type TableColumn } from "@astryxdesign/core/Table";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Identifier } from "../../components/Identifier.tsx";
import { MetricCard } from "../../components/MetricCard.tsx";
import { MissingActions } from "../../components/MissingActions.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { SectionHeading } from "../../components/SectionHeading.tsx";
import { StatusLamp } from "../../components/StatusLamp.tsx";
import { routes } from "../../lib/api/routes.ts";
import { t } from "../../lib/i18n.ts";
import type { UsageEvent, usageStats } from "../../lib/usage.ts";
import { layout } from "../../themes/site/layout.ts";
import { roles } from "../../themes/site/roles.ts";

type Stats = ReturnType<typeof usageStats>;
type ModelRow = Stats["models"][number];

/** The latest requests shown, newest first; the rest stay in the per-model counts. */
const SHOWN = 30;

const metric = (value: string) => (
  <Text type={roles.textType.metric} hasTabularNumbers>
    {value}
  </Text>
);
const detail = (text: string) => (
  <Text type={roles.textType.supporting} color="secondary" hasTabularNumbers>
    {text}
  </Text>
);
const ms = (n: number | null) => (n === null ? t("usage.tiles.none") : t("usage.tiles.ms", { n }));

function Tiles({ stats }: { stats: Stats }) {
  return (
    <Grid
      columns={{ minWidth: layout.summaryTileMin, max: 3, repeat: "fit" }}
      gap={roles.gap.card}
      aria-label={t("usage.tiles.label")}
    >
      <MetricCard
        icon={Activity}
        label={t("usage.tiles.requests")}
        value={metric(t("usage.tiles.count", { n: stats.count }))}
        detail={detail(t("usage.tiles.failed", { count: stats.failed }))}
      />
      <MetricCard
        icon={Timer}
        label={t("usage.tiles.latency")}
        value={metric(ms(stats.latency))}
        detail={detail(t("usage.tiles.firstToken", { time: ms(stats.ttft) }))}
      />
      <MetricCard
        icon={Coins}
        label={t("usage.tiles.tokens")}
        value={metric(t("usage.tiles.count", { n: stats.input + stats.output }))}
        detail={detail(t("usage.tiles.inOut", { input: stats.input, output: stats.output }))}
      />
    </Grid>
  );
}

const SubHeading = ({ title }: { title: string }) => (
  <Heading level={roles.heading.inCard} accessibilityLevel={roles.heading.card}>
    {title}
  </Heading>
);

function EventItem({ event }: { event: UsageEvent }) {
  const word = event.failed ? t("usage.rail.failed") : t("usage.rail.succeeded");
  return (
    <ListItem
      label={<Text type={roles.textType.identifier}>{event.model}</Text>}
      description={
        <Text type={roles.textType.supporting} color="secondary" hasTabularNumbers>
          {event.failed
            ? t("usage.rail.failedLine", { latency: event.latency, status: event.status })
            : t("usage.rail.line", { latency: event.latency, tokens: event.input + event.output })}
        </Text>
      }
      startContent={<StatusDot variant={event.failed ? "error" : "success"} label={word} />}
      endContent={
        <VStack gap={0} hAlign="end">
          <Timestamp
            value={new Date(event.at).toISOString()}
            format="system_time"
            type={roles.textType.supporting}
            color="secondary"
          />
          {event.id && (
            <Link href={`#activity/${encodeURIComponent(event.id)}?view=logs`}>
              <Text type={roles.textType.identifier} color="secondary">
                {event.id}
              </Text>
            </Link>
          )}
        </VStack>
      }
    />
  );
}

function Latest({ events }: { events: UsageEvent[] }) {
  const latest = events.slice(-SHOWN).reverse();
  return (
    <VStack gap={3}>
      <SubHeading title={t("usage.rail.heading")} />
      <List density="compact" hasDividers>
        {latest.map((e, i) => (
          <EventItem key={e.id || `${e.at}:${i}`} event={e} />
        ))}
      </List>
    </VStack>
  );
}

const count = (n: number) => <Text hasTabularNumbers>{t("usage.tiles.count", { n })}</Text>;

const modelColumns = (): TableColumn<ModelRow>[] => [
  {
    key: "model",
    header: t("usage.models.model"),
    // Twice a count's share, and free to narrow to the counts' floor on a phone.
    width: proportional(2, { minWidth: layout.tableColumnFloor }),
    renderCell: (row) => <Identifier breakAt="name">{row.model}</Identifier>,
  },
  {
    key: "count",
    header: t("usage.models.requests"),
    align: "end",
    renderCell: (r) => count(r.count),
  },
  {
    key: "failed",
    header: t("usage.models.failed"),
    align: "end",
    renderCell: (r) => count(r.failed),
  },
  {
    key: "tokens",
    header: t("usage.models.tokens"),
    align: "end",
    renderCell: (r) => count(r.input + r.output),
  },
];

function Models({ models }: { models: ModelRow[] }) {
  return (
    <VStack gap={3}>
      <SubHeading title={t("usage.models.heading")} />
      <Table<ModelRow>
        data={models}
        columns={modelColumns()}
        idKey="model"
        density={roles.table.density}
        dividers="rows"
      />
    </VStack>
  );
}

export function LiveSection({
  live,
  events,
  stats,
  failure,
  onStart,
  onRetry,
  canStart,
}: {
  live: boolean;
  events: UsageEvent[];
  stats: Stats;
  failure: unknown;
  onStart: () => void;
  onRetry: () => void;
  canStart: boolean;
}) {
  return (
    <VStack gap={roles.gap.card}>
      <SectionHeading
        title={t("usage.live.heading")}
        actions={live && <StatusLamp status="ready" label={t("usage.live.listening")} isPulsing />}
      />
      {failure !== null && (
        <ReadError error={failure} what={t("usage.page.liveRead")} retry={onRetry} />
      )}
      <MissingActions
        actions={[{ route: routes.drainUsageQueue, label: t("usage.page.liveAction") }]}
      />
      {events.length ? (
        <>
          <Tiles stats={stats} />
          <Grid
            columns={{ minWidth: layout.settingsColumnMin, repeat: "fit" }}
            gap={roles.gap.section}
            align="start"
          >
            <Latest events={events} />
            <Models models={stats.models} />
          </Grid>
        </>
      ) : live ? (
        <EmptyState
          icon={<Icon icon={Radio} size="lg" />}
          title={t("usage.live.waiting")}
          headingLevel={3}
          isCompact
        />
      ) : (
        <EmptyState
          icon={<Icon icon={Radio} size="lg" />}
          title={t("usage.live.off")}
          description={t("usage.live.offDescription")}
          headingLevel={3}
          isCompact
          actions={canStart && <Button label={t("usage.page.start")} onClick={onStart} />}
        />
      )}
    </VStack>
  );
}
