import { useMemo } from "react";
import { Plus } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useApiKeyUsage, useConfig, useCredentials, usePlugins } from "../../app/serverQueries.ts";
import { useSession } from "../../app/Session.tsx";
import { useAction } from "../../app/useAction.ts";
import { ReadError } from "../../components/ReadError.tsx";
import { StatusLamp } from "../../components/StatusLamp.tsx";
import type { Credential } from "../../lib/api/credentials.ts";
import { readPath } from "../../lib/config-path.ts";
import { buckets, sum } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { AttentionFeed } from "./Attention.tsx";
import { GetStarted, useFirstRun } from "./GetStarted.tsx";
import { LimitsSection } from "./Limits.tsx";
import { useErrorLogs } from "./queries.ts";
import { ServerFacts } from "./ServerFacts.tsx";
import { lampCounts, needsAttention, successRate, traffic } from "./summary.ts";
import { StatusTiles } from "./Tiles.tsx";
import { TrafficCard } from "./Traffic.tsx";

/** Undefined while a read is pending, null when it failed: the regions draw both. */
const pendingOr = (isError: boolean) => (isError ? null : undefined);

const hasServed = (files: Credential[]) =>
  files.some((a) => {
    const b = buckets(a);
    return a.success || a.failed || (b && sum(b.total));
  });

function Meta({ online, observedAt }: { online: boolean; observedAt?: string }) {
  return (
    <HStack gap={3} vAlign="center" wrap="wrap">
      <StatusLamp
        status={online ? "ready" : "failing"}
        label={
          online ? t("app.connection.connected", { host: location.host }) : t("app.connection.lost")
        }
      />
      {observedAt && (
        <Text type="supporting" color="secondary">
          {t("overview.page.updated")}{" "}
          <Timestamp value={observedAt} format="relative" type="inherit" color="inherit" isLive />
        </Text>
      )}
    </HStack>
  );
}

// 1024px at the default root size.
const RAIL_FOLDS = "(max-width: 64rem)";

/** Every read the page shows, and what the tiles, strips and rail derive from them. */
function useOverviewData() {
  const credentials = useCredentials({ poll: true });
  const keyUsage = useApiKeyUsage({ poll: true });
  const config = useConfig();
  const files = credentials.data?.files;
  const now = credentials.dataUpdatedAt;
  const failed = credentials.isError;
  // Key usage counts in every total, so the totals wait for it; a failed read leaves it out.
  const usage = keyUsage.isError ? null : keyUsage.data;
  const summary = useMemo(() => {
    // A failed poll keeps the last answer in the cache; those states are no longer current.
    if (failed || !files) {
      const blank = pendingOr(failed);
      return { counts: blank, traffic: blank, attention: blank };
    }
    return {
      counts: lampCounts(files, now),
      traffic: usage === undefined ? undefined : traffic(files, usage),
      attention: needsAttention(files, now),
    };
  }, [files, now, usage, failed]);
  const keys = config.data ? (readPath(config.data, "access/api-keys", []) as string[]) : undefined;
  const keyRead = keyUsage.isError
    ? { error: keyUsage.error, retry: () => void keyUsage.refetch() }
    : null;
  return { credentials, keyRead, config, files, now, summary, keys };
}

function ConnectButton() {
  return (
    <Button
      label={t("overview.page.connect")}
      variant="primary"
      href="#connect"
      icon={<Icon icon={Plus} />}
    />
  );
}

export default function Overview() {
  const { credentials, keyRead, config, files, now, summary, keys } = useOverviewData();
  const plugins = usePlugins();
  const errorLogs = useErrorLogs();
  const { online, version } = useSession();
  const action = useAction();
  const isNarrow = useMediaQuery(RAIL_FOLDS);
  const firstRun = useFirstRun(files?.length);

  const rail = (hasStickyHeader: boolean) => (
    <AttentionFeed
      rows={summary.attention}
      hasAccounts={!!files?.length}
      now={now}
      hasStickyHeader={hasStickyHeader}
    />
  );
  return (
    <PageFrame
      title={t("overview.page.title")}
      width="full"
      meta={<Meta online={online} observedAt={credentials.data?.observed_at} />}
      actions={<ConnectButton />}
      panel={
        isNarrow
          ? undefined
          : {
              label: t("overview.attention.heading"),
              content: rail(true),
              // The rail is part of the page, never closed.
              onClose: () => {},
            }
      }
    >
      <VStack gap={10}>
        {credentials.isError && (
          <ReadError
            error={credentials.error}
            what={t("overview.page.accounts")}
            retry={() => void credentials.refetch()}
          />
        )}
        {firstRun.isOpen && files && keys && (
          <GetStarted
            accounts={files.length}
            keys={keys}
            served={hasServed(files)}
            action={action}
            onFinish={firstRun.finish}
            onDismiss={firstRun.dismiss}
          />
        )}
        <StatusTiles
          counts={summary.counts}
          requests={summary.traffic ? successRate(summary.traffic.all) : summary.traffic}
          keys={keys ? keys.length : pendingOr(config.isError)}
        />
        <Divider />
        <TrafficCard traffic={summary.traffic} keyRead={keyRead} />
        {isNarrow && <Card padding={0}>{rail(false)}</Card>}
        {files && <LimitsSection files={files} now={now} action={action} />}
        <ServerFacts
          config={config}
          plugins={plugins}
          errorLogs={errorLogs}
          rust={version.startsWith("cliproxy-rs")}
        />
      </VStack>
    </PageFrame>
  );
}
