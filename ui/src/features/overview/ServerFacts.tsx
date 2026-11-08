import type { ReactNode } from "react";
import { FileWarning, Puzzle, Route } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { ReadError } from "../../components/ReadError.tsx";
import type { Config } from "../../lib/api/config.ts";
import type { ErrorLogFile } from "../../lib/api/logs.ts";
import type { PluginList } from "../../lib/api/plugins.ts";
import { readPath } from "../../lib/config-path.ts";
import { t } from "../../lib/i18n.ts";
import { strategy, strategyName } from "../../lib/routing.ts";
import { layout } from "../../themes/site/layout.ts";

/** Strategy, retries and session affinity; the typed config layer does not fix their shape. */
function routingLine(config: Config) {
  const parts = [strategyName(strategy(readPath(config, "routing/strategy") as unknown))];
  const retries = readPath(config, "routing/retry/request-retry") as unknown;
  if (retries !== undefined) parts.push(t("overview.facts.retries", { count: Number(retries) }));
  if (readPath(config, "routing/session-affinity")) parts.push(t("overview.facts.sessionAffinity"));
  return parts;
}

function newest(files: ErrorLogFile[]) {
  return Math.max(...files.map((f) => f.modified));
}

type Read<T> = UseQueryResult<T>;

/** A fact while its read is pending, failed (the region's banner says why) or answered. */
function fact<T>(read: Read<T>, render: (data: T) => ReactNode) {
  if (read.data !== undefined) return render(read.data);
  if (read.isError) return <Text type="body">—</Text>;
  return <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />;
}

export function ServerFacts({
  config,
  plugins,
  errorLogs,
}: {
  config: Read<Config>;
  plugins: Read<PluginList>;
  errorLogs: Read<{ files: ErrorLogFile[] }>;
}) {
  const failed = [
    { read: config, what: t("overview.facts.config") },
    { read: plugins, what: t("overview.facts.pluginList") },
    { read: errorLogs, what: t("overview.facts.logList") },
  ].filter((f) => f.read.isError);
  return (
    <VStack gap={4}>
      <Heading level={2}>{t("overview.facts.heading")}</Heading>
      {failed.map((f) => (
        <ReadError
          key={f.what}
          error={f.read.error}
          what={f.what}
          retry={() => void f.read.refetch()}
        />
      ))}
      <MetadataList orientation="horizontal">
        <MetadataListItem
          label={t("overview.facts.routing")}
          icon={<Icon icon={Route} size="sm" />}
        >
          {fact(config, (c) => (
            <Link href="#config">{routingLine(c).join(" · ")}</Link>
          ))}
        </MetadataListItem>
        <MetadataListItem
          label={t("overview.facts.plugins")}
          icon={<Icon icon={Puzzle} size="sm" />}
        >
          {fact(plugins, (p) => (
            <Link href="#plugins">
              {t("overview.facts.pluginsLoaded", {
                loaded: p.plugins.filter((x) => x.registered && x.effective_enabled).length,
                installed: p.plugins.length,
              })}
            </Link>
          ))}
        </MetadataListItem>
        <MetadataListItem
          label={t("overview.facts.errorLogs")}
          icon={<Icon icon={FileWarning} size="sm" />}
        >
          {fact(errorLogs, ({ files }) => (
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Link href="#logs?tab=errors">
                {t("overview.facts.logFiles", { count: files.length })}
              </Link>
              {files.length > 0 && (
                <Timestamp value={newest(files)} format="relative" color="secondary" />
              )}
            </HStack>
          ))}
        </MetadataListItem>
      </MetadataList>
    </VStack>
  );
}
