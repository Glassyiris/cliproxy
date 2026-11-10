// Overview, from the Astryx template dashboard-alert-rail, on the shared PageFrame with the card-v2
// admin's sizes (DESIGN.md "Roles"). Deviations from the template, one per line with its reason:
// - The header and content padding are the page roles (24, 16 on a phone), not the template's own,
//   so the h1 sits where every other page has it.
// - KPI values are Text at the metric size (display-3) with tabular figures, not Heading level 2:
//   roles "Numbers".
// - No time-window, environment or region controls: the server keeps 200 minutes for one proxy.
// - No header line: "Updated <time>" would arrive with the data and push the header on a phone,
//   and the sidebar footer already shows the server and whether it answers.
// - The primary action is default size, not lg: roles.primaryAction.
// - Tiles: three judgements with one basis line each, no delta and no sparkline (the chart below
//   has the series); at least layout.summaryTileMin wide, not 240, so a phone shows two per row.
// - No alert rail: the reasons are a fixed, small set, so they are the card-v2 admin's "Open work"
//   cards under the tiles, one per reason with accounts, each linking to where it is fixed. The content takes the full width.
// - Two chart cards as the template has, bar charts instead of line charts: requests per ten
//   minutes with failures on top, and requests per source; the API reports no latency. Each card
//   keeps its own height, aligned at the top.
// - The chart grid's columns are at least layout.settingsColumnMin wide (320, the template's
//   value): check:ui keeps size literals in the theme and that is the theme's 320 two-column floor.
// - Tile labels lead with a status-coloured icon instead of the StatusDot, which would repeat it.
// - First run: three step cards on the attention cards' grid, from the moment the server has no
//   accounts until the steps are done or dismissed; while it has none they replace the rest.
import { useMemo } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { icons } from "../../components/icons.ts";
import { useConnectAccount } from "../../app/connectEntry.ts";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useApiKeyUsage, useConfig, useCredentials } from "../../app/serverQueries.ts";
import { ReadError } from "../../components/ReadError.tsx";
import { readPath } from "../../lib/configPath.ts";
import { t } from "../../lib/i18n.ts";
import { roles } from "../../themes/site/roles.ts";
import { Attention } from "./Attention.tsx";
import { FirstRun, useFirstRun } from "./FirstRun.tsx";
import { bucketTimes, sources, summarize, totalTraffic } from "./summary.ts";
import { Tiles } from "./Tiles.tsx";
import { Charts, type Read } from "./Traffic.tsx";

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
  const clients = config.data && readPath(config.data, "access/api-keys", []);
  const keys = config.data ? (Array.isArray(clients) ? clients.length : 0) : undefined;
  // Key usage counts in every total, so the totals wait for it; a failed read leaves it out.
  const usage = keyUsage.isError ? null : keyUsage.data;
  const summary = useMemo(() => files && summarize(files, keys, now), [files, keys, now]);
  const traffic = useMemo(
    () => (files && usage !== undefined ? totalTraffic(files, usage) : undefined),
    [files, usage],
  );
  const bySource = useMemo(
    () => (traffic ? files && sources(files, usage ?? null) : traffic),
    [files, usage, traffic],
  );
  const times = useMemo(
    () => (files && traffic ? bucketTimes(files, traffic.total.length, usage ?? null) : []),
    [files, traffic, usage],
  );
  const accounts = failedRead(credentials, t("overview.read.accounts"));
  return {
    files,
    keys,
    now,
    summary,
    traffic,
    bySource,
    times,
    accounts,
    // With no accounts on screen, each region says why; with stale ones, the rail does.
    unread: files ? null : accounts,
    keyUsage: failedRead(keyUsage, t("overview.read.keyUsage")),
    config: failedRead(config, t("overview.read.config")),
  };
}

export default function Overview() {
  const data = useOverviewData();
  const connect = useConnectAccount();
  const firstRun = useFirstRun(data.files, data.keys);
  // While the server has no accounts, or before that is known, the steps are the whole page.
  const isFirstRun = firstRun.isShown && !data.files?.length;
  return (
    <PageFrame
      title={t("overview.page.title")}
      width="full"
      actions={
        <Button
          label={t("overview.page.connect")}
          variant={roles.primaryAction.variant}
          size={roles.primaryAction.size}
          icon={<Icon icon={icons.add} />}
          onClick={connect}
        />
      }
    >
      {firstRun.isShown && (
        <FirstRun
          done={firstRun.done}
          // With the rest of the page shown, its own regions report these.
          reads={isFirstRun ? present([data.unread, data.config]) : []}
          connect={connect}
          onDismiss={firstRun.dismiss}
        />
      )}
      {isFirstRun ? null : data.unread ? (
        <ReadError {...data.unread} />
      ) : (
        <Tiles summary={data.summary} traffic={data.traffic} />
      )}
      {!isFirstRun && (
        <Attention
          summary={data.summary}
          now={data.now}
          reads={present([data.accounts, data.config])}
        />
      )}
      {!isFirstRun && (
        <Charts
          traffic={data.traffic}
          times={data.times}
          sources={data.bySource}
          reads={present([data.unread, data.keyUsage])}
        />
      )}
    </PageFrame>
  );
}
