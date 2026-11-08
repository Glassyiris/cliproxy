// Overview, from the Astryx template dashboard-alert-rail: header | tiles and chart | alert rail.
// Deviations from the template, one per line with its reason:
// - Header padding 4, not 6: roles.header (DESIGN.md "Roles"), so the h1 and content share a line.
// - Content padding 4, not 6: roles.content, for the same line.
// - KPI values are Text type="large" hasTabularNumbers, not Heading level 2: roles "Numbers".
// - No time-window, environment or region controls: the server keeps 200 minutes for one proxy.
// - Header line: the server host and whether it answers, not "Updated <time>"; the time would
//   arrive with the data and push the header on a phone.
// - The header lamp does not pulse: DESIGN.md "Motion" keeps pulses for live streams.
// - The primary action is default size, not lg: roles.primaryAction.
// - Tiles: four judgements with one basis line each, no delta and no sparkline (the chart below
//   has the series); at least layout.summaryTileMin wide, not 240, so a phone shows two per row
//   and the first alert stays in the first screen.
// - One chart card (requests with failures on top) instead of two: the API reports nothing else.
// - No uptime roster and no service breakdown in the rail: per-source detail lives on Traffic
//   analysis (#usage), linked from the chart card.
// - The rail is layout.detailPanel.defaultSize wide, not 400: check:ui keeps size literals in the
//   theme, and that is the shared panel width.
// - Below 1024 px the rail folds in under the tiles, not at the end, so on a phone the first alert
//   is in the first screen (DESIGN.md "Routes").
// - Alerts are rows that link to where they are fixed, without state Tokens or timestamps: the
//   server reports states, not alert events.
// - First run (no accounts): the template's EmptyState, in a card, replaces the tiles and chart.
import { useMemo } from "react";
import { Plus } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutHeader,
  LayoutPanel,
  VStack,
} from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useConnectAccount } from "../../app/connect-entry.ts";
import { useApiKeyUsage, useConfig, useCredentials } from "../../app/serverQueries.ts";
import { useSession } from "../../app/Session.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { readPath } from "../../lib/config-path.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { roles } from "../../themes/site/roles.ts";
import { AttentionFeed } from "./Attention.tsx";
import { FirstRun } from "./FirstRun.tsx";
import { bucketTimes, summarize, totalTraffic } from "./summary.ts";
import { Tiles } from "./Tiles.tsx";
import { TrafficCard, type Read } from "./Traffic.tsx";

const failedRead = (
  query: { isError: boolean; error: unknown; refetch: () => unknown },
  what: string,
): Read | null =>
  query.isError ? { error: query.error, what, retry: () => void query.refetch() } : null;

const present = (reads: (Read | null)[]) => reads.filter((r): r is Read => r !== null);

/**
 * Every read the page shows and what the regions derive from them. A failed poll keeps the last
 * answer on screen; the failure is shown beside it.
 */
function useOverviewData() {
  const credentials = useCredentials({ poll: true });
  const keyUsage = useApiKeyUsage({ poll: true });
  const config = useConfig();
  const files = credentials.data?.files;
  const now = credentials.dataUpdatedAt;
  const keys = config.data
    ? (readPath(config.data, "access/api-keys", []) as string[]).length
    : undefined;
  // Key usage counts in every total, so the totals wait for it; a failed read leaves it out.
  const usage = keyUsage.isError ? null : keyUsage.data;
  const summary = useMemo(() => files && summarize(files, keys, now), [files, keys, now]);
  const traffic = useMemo(
    () => (files && usage !== undefined ? totalTraffic(files, usage) : undefined),
    [files, usage],
  );
  const times = useMemo(
    () => (files && traffic ? bucketTimes(files, traffic.total.length) : []),
    [files, traffic],
  );
  const accounts = failedRead(credentials, t("overview.read.accounts"));
  return {
    files,
    now,
    summary,
    traffic,
    times,
    accounts,
    // With no accounts on screen, each region says why; with stale ones, the rail does.
    unread: files ? null : accounts,
    keyUsage: failedRead(keyUsage, t("overview.read.keyUsage")),
    config: failedRead(config, t("overview.read.config")),
  };
}

function Header({ connect }: { connect: () => void }) {
  const { online } = useSession();
  const reachability = t("overview.page.server", {
    host: location.host,
    state: online ? "up" : "down",
  });
  return (
    <LayoutHeader padding={roles.header.padding} hasDivider>
      <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
        <VStack gap={0} vAlign="center">
          <Heading level={roles.heading.page}>{t("overview.page.title")}</Heading>
          <HStack gap={2} vAlign="center">
            <StatusDot variant={online ? "success" : "error"} label={reachability} />
            <Text type="supporting" color="secondary">
              {reachability}
            </Text>
          </HStack>
        </VStack>
        <Button
          label={t("overview.page.connect")}
          variant={roles.primaryAction.variant}
          size={roles.primaryAction.size}
          icon={<Icon icon={Plus} />}
          onClick={connect}
        />
      </HStack>
    </LayoutHeader>
  );
}

export default function Overview() {
  const data = useOverviewData();
  const connect = useConnectAccount();
  const isNarrow = useMediaQuery(layout.railFolds);
  const isFirstRun = data.files?.length === 0;
  const rail = (hasStickyHeader: boolean) => (
    <AttentionFeed
      summary={data.summary}
      now={data.now}
      reads={present([data.accounts, data.config])}
      hasStickyHeader={hasStickyHeader}
    />
  );
  return (
    <Layout
      height="fill"
      header={<Header connect={connect} />}
      content={
        <LayoutContent padding={roles.content.padding}>
          <VStack gap={6}>
            {isFirstRun ? (
              <FirstRun connect={connect} />
            ) : data.unread ? (
              <ReadError {...data.unread} />
            ) : (
              <Tiles summary={data.summary} traffic={data.traffic} now={data.now} />
            )}
            {isNarrow && <Card padding={0}>{rail(false)}</Card>}
            {/* Folded, the rail grows from its skeleton to its rows, so on a phone the chart
                waits for them rather than being pushed down. */}
            {!isFirstRun && (!isNarrow || data.summary) && (
              <TrafficCard
                traffic={data.traffic}
                times={data.times}
                reads={present([data.unread, data.keyUsage])}
              />
            )}
          </VStack>
        </LayoutContent>
      }
      end={
        isNarrow ? undefined : (
          <LayoutPanel
            width={layout.detailPanel.defaultSize}
            padding={0}
            hasDivider
            role="complementary"
            label={t("overview.attention.heading")}
            isScrollable
          >
            {rail(true)}
          </LayoutPanel>
        )
      }
    />
  );
}
