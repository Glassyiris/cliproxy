// The Usage tab's first section: requests per ten minutes for every source or the chosen one, then
// the sources compared, each count beside the share it makes up.
import { useMemo, type ReactNode } from "react";
import { ChartColumn } from "lucide-react";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Selector } from "@astryxdesign/core/Selector";
import { proportional, Table, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { useApiKeyUsage, useCredentials } from "../../app/serverQueries.ts";
import { CardHeading } from "../../components/CardHeading.tsx";
import { TrafficChart } from "../../components/charts/index.ts";
import { loadingCell, placeholderRows, type LoadingRow } from "../../components/loadingRows.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { SectionHeading } from "../../components/SectionHeading.tsx";
import { notImplemented } from "../../lib/api/client.ts";
import { label, type Buckets } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { roles } from "../../themes/site/roles.ts";
import { bucketTimes, leaders, peaks, sources, trafficOf, type Source } from "./summary.ts";

type Read = { error: unknown; retry: () => void } | null;

/** Both traffic reads; a failed poll keeps the cached answer, so a failure drops its rows. */
export function useSources() {
  const credentials = useCredentials({ poll: true });
  const keyUsage = useApiKeyUsage({ poll: true });
  const files = credentials.isError ? null : credentials.data?.files;
  const usage = keyUsage.isError ? null : keyUsage.data;
  const rows = useMemo(
    () => (files === undefined || usage === undefined ? undefined : sources(files, usage)),
    [files, usage],
  );
  return {
    rows,
    files: files ?? null,
    accountRead: credentials.isError
      ? { error: credentials.error, retry: () => void credentials.refetch() }
      : null,
    keyRead: keyUsage.isError
      ? { error: keyUsage.error, retry: () => void keyUsage.refetch() }
      : null,
  };
}

const nameOf = (s: Source) =>
  s.via === "accounts"
    ? t("usage.sources.accounts", { provider: label(s.provider) })
    : t("usage.sources.keys", { provider: label(s.provider) });

/** The server writes a bucket as "14:50-15:00"; a range takes an en dash. */
const span = (time: string) => time.replace("-", "–");

function trafficSummary(b: Buckets, times: string[]) {
  const p = peaks(b);
  if (!p.busiest) return t("usage.traffic.none");
  const busy = { total: p.total, time: span(times[p.busiest.at] ?? ""), peak: p.busiest.count };
  return p.worst
    ? t("usage.traffic.summary", {
        ...busy,
        failed: p.failed,
        failTime: span(times[p.worst.at] ?? ""),
        failPeak: p.worst.count,
      })
    : t("usage.traffic.summaryCalm", busy);
}

function sourcesSummary(rows: Source[]) {
  const lead = leaders(rows);
  if (!lead) return t("usage.traffic.none");
  return lead.worst
    ? t("usage.sources.summary", { source: nameOf(lead.busiest), worst: nameOf(lead.worst) })
    : t("usage.sources.summaryCalm", { source: nameOf(lead.busiest) });
}

const NO_BUCKETS: Buckets = { total: [], failed: [] };

function TrafficCard({
  rows,
  times,
  choice,
  onChoose,
}: {
  rows: Source[] | undefined;
  times: string[];
  choice: Source | undefined;
  onChoose: (key: string) => void;
}) {
  const traffic = rows && trafficOf(rows, choice?.key ?? "");
  const categories = useMemo(
    () => times.map((time) => ({ tick: time.split("-")[0] ?? "", full: span(time) })),
    [times],
  );
  const name = choice ? nameOf(choice) : t("usage.traffic.all");
  return (
    <Card padding={roles.card.padding}>
      <VStack gap={roles.gap.card} id="activity-traffic">
        <CardHeading
          icon={ChartColumn}
          title={t("usage.traffic.heading")}
          description={t("usage.page.window")}
          actions={
            <Selector
              label={t("usage.traffic.source")}
              isLabelHidden
              value={choice?.key ?? ""}
              onChange={onChoose}
              options={[
                { value: "", label: t("usage.traffic.all") },
                ...(rows ?? [])
                  .filter((r) => r.buckets)
                  .map((r) => ({ value: r.key, label: nameOf(r) })),
              ]}
            />
          }
        />
        {traffic === null ? (
          <EmptyState title={t("usage.sources.notReported")} headingLevel={4} isCompact />
        ) : (
          <TrafficChart
            categories={categories}
            buckets={traffic ?? NO_BUCKETS}
            names={{ requests: t("usage.traffic.requests"), failed: t("usage.traffic.failed") }}
            label={t("usage.traffic.label", { source: name })}
            summary={traffic ? trafficSummary(traffic, times) : t("usage.traffic.loading")}
            loading={!traffic}
          />
        )}
      </VStack>
    </Card>
  );
}

const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

/** A source's part of all requests: the template's acquisition bar and the share beside it. */
function ShareBar({ source, all }: { source: Source; all: number }) {
  return (
    <HStack gap={3} vAlign="center" wrap="nowrap">
      <StackItem size="fill">
        <ProgressBar
          label={t("usage.sources.shareOf", { source: nameOf(source) })}
          isLabelHidden
          value={source.total}
          max={Math.max(all, 1)}
          variant="neutral"
        />
      </StackItem>
      <Text hasTabularNumbers textWrap="nowrap">
        {t("usage.sources.percent", { n: share(source.total, all) })}
      </Text>
    </HStack>
  );
}

type ChooseSource = (key: string) => void;

function ChartToggle({
  source,
  isChosen,
  onChoose,
}: {
  source: Source;
  isChosen: boolean;
  onChoose: ChooseSource;
}) {
  const name = nameOf(source);
  return (
    <ToggleButton
      label={t("usage.sources.show", { source: name })}
      isIconOnly
      size={roles.rowAction.size}
      isPressed={isChosen}
      icon={<Icon icon={ChartColumn} size="sm" />}
      onPressedChange={(pressed) => onChoose(pressed ? source.key : "")}
    />
  );
}

type Row = LoadingRow<Source>;

const count = (n: number) => <Text hasTabularNumbers>{t("usage.tiles.count", { n })}</Text>;

const name = (s: Source) => <Text weight={roles.textWeight.emphasis}>{nameOf(s)}</Text>;

const notReported = (
  <Text type={roles.textType.supporting} color="secondary">
    {t("usage.sources.notReported")}
  </Text>
);

/** On a phone the numbers sit under the name, so the row keeps the screen's width. */
function PhoneSource({ source: s, all }: { source: Source; all: number }) {
  return (
    <VStack gap={2}>
      {name(s)}
      {s.buckets ? (
        <>
          <ShareBar source={s} all={all} />
          <Text type={roles.textType.supporting} color="secondary" hasTabularNumbers>
            {t("usage.sources.line", {
              total: s.total,
              failed: s.failed,
              failedShare: share(s.failed, s.total),
            })}
          </Text>
        </>
      ) : (
        notReported
      )}
    </VStack>
  );
}

const known = (render: (s: Source) => ReactNode) =>
  loadingCell((s: Source) => (s.buckets ? render(s) : null));

/** Requests, its share of all requests, failed, and its share of the source's requests. */
const numberColumns = (all: number): TableColumn<Row>[] => [
  {
    key: "requests",
    header: t("usage.sources.requests"),
    align: "end",
    renderCell: known((s) => count(s.total)),
  },
  {
    key: "share",
    header: t("usage.sources.share"),
    width: proportional(2, { minWidth: layout.tableColumnFloor }),
    renderCell: known((s) => <ShareBar source={s} all={all} />),
  },
  {
    key: "failed",
    header: t("usage.sources.failed"),
    align: "end",
    renderCell: known((s) => count(s.failed)),
  },
  {
    key: "failedShare",
    header: t("usage.sources.failedShare"),
    align: "end",
    renderCell: known((s) => (
      <Text hasTabularNumbers>{t("usage.sources.percent", { n: share(s.failed, s.total) })}</Text>
    )),
  },
];

/** Wide: the source, its numbers, the chart toggle; on a phone, the source with its numbers. */
function sourceColumns(
  all: number,
  chosen: string,
  onChoose: ChooseSource,
  isPhone: boolean,
): TableColumn<Row>[] {
  const source: TableColumn<Row> = {
    key: "source",
    header: t("usage.sources.source"),
    width: proportional(isPhone ? 4 : 2, { minWidth: layout.tableColumnFloor }),
    renderCell: loadingCell((s) =>
      isPhone ? (
        <PhoneSource source={s} all={all} />
      ) : (
        <VStack gap={0}>
          {name(s)}
          {!s.buckets && notReported}
        </VStack>
      ),
    ),
  };
  const toggle: TableColumn<Row> = {
    key: "chart",
    header: t("usage.sources.chart"),
    align: "end",
    renderCell: known((s) => (
      <ChartToggle source={s} isChosen={s.key === chosen} onChoose={onChoose} />
    )),
  };
  return isPhone ? [source, toggle] : [source, ...numberColumns(all), toggle];
}

function SourceTable({
  rows,
  chosen,
  onChoose,
}: {
  rows: Source[] | undefined;
  chosen: string;
  onChoose: (key: string) => void;
}) {
  const isPhone = useAppShellMobile().isMobile;
  const all = rows?.reduce((n, r) => n + r.total, 0) ?? 0;
  const data: Row[] = rows ? rows.map((s) => ({ id: s.key, item: s })) : placeholderRows;
  return (
    <VStack gap={3}>
      <Table<Row>
        data={data}
        columns={sourceColumns(all, chosen, onChoose, isPhone)}
        idKey="id"
        density={roles.table.density}
        dividers="rows"
      />
      {rows && (
        <Text type={roles.textType.supporting} color="secondary">
          {sourcesSummary(rows)}
        </Text>
      )}
    </VStack>
  );
}

function KeyUsageNote({ read }: { read: NonNullable<Read> }) {
  if (notImplemented(read.error))
    return (
      <HStack gap={2} vAlign="center">
        <Icon icon="info" size="sm" color="info" />
        <Text type={roles.textType.supporting} color="secondary">
          {t("usage.sources.keysNotReported")}
        </Text>
      </HStack>
    );
  return <ReadError error={read.error} what={t("usage.sources.keyUsage")} retry={read.retry} />;
}

/**
 * The traffic section. `rows` is undefined while either read is pending, so a source still
 * loading never reads as no traffic; a read that already failed shows its banner meanwhile.
 */
export function TrafficSection({
  traffic,
  chosen,
  onChoose,
}: {
  traffic: ReturnType<typeof useSources>;
  chosen: string;
  onChoose: (key: string) => void;
}) {
  const { rows, files, accountRead, keyRead } = traffic;
  const length = rows?.find((r) => r.buckets)?.buckets?.total.length ?? 0;
  const times = useMemo(() => bucketTimes(files, length), [files, length]);
  const choice = rows?.find((r) => r.key === chosen && r.buckets);
  const keysAnswered = !keyRead || notImplemented(keyRead.error);
  // With no rows, a failed account read's banner says why; nothing read at all is the empty state.
  const body =
    rows?.length !== 0 ? (
      <>
        <TrafficCard rows={rows} times={times} choice={choice} onChoose={onChoose} />
        <SourceTable rows={rows} chosen={choice?.key ?? ""} onChoose={onChoose} />
      </>
    ) : (
      !accountRead &&
      keysAnswered && <EmptyState title={t("usage.sources.empty")} headingLevel={3} isCompact />
    );
  return (
    <VStack gap={roles.gap.card}>
      <SectionHeading title={t("usage.sources.heading")} />
      {accountRead && (
        <ReadError
          error={accountRead.error}
          what={t("usage.sources.accountsRead")}
          retry={accountRead.retry}
        />
      )}
      {keyRead && <KeyUsageNote read={keyRead} />}
      {body}
    </VStack>
  );
}
