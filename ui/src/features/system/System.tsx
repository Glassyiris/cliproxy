import type { ReactNode } from "react";
import { Folder, GitCommitHorizontal, Globe, LayoutDashboard, Route, Tag } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { useClipboard } from "@astryxdesign/core/hooks";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, Section, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useConfig } from "../../app/serverQueries.ts";
import { useSession } from "../../app/Session.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { StatusLamp } from "../../components/StatusLamp.tsx";
import { ApiError } from "../../lib/api/client.ts";
import type { Config } from "../../lib/api/config.ts";
import { readPath } from "../../lib/config-path.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";
import { repository } from "../../lib/repository.ts";
import { layout } from "../../themes/site/layout.ts";
import { useLatestVersion } from "./queries.ts";
import { releaseStatus } from "./version.ts";

const notReported = () => (
  <Text type="body" color="secondary">
    {t("system.facts.notReported")}
  </Text>
);
const valueSkeleton = () => (
  <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
);

/** The label row of a tile: icon and text, as the detail-page template's header metadata. */
function TileLabel({ icon, label }: { icon: IconProps["icon"]; label: string }) {
  return (
    <HStack gap={1} vAlign="center">
      <Icon icon={icon} size="sm" color="secondary" />
      <Text type="supporting" color="secondary">
        {label}
      </Text>
    </HStack>
  );
}

function Tile({
  icon,
  label,
  children,
}: {
  icon: IconProps["icon"];
  label: string;
  children: ReactNode;
}) {
  return (
    <Card padding={4}>
      <VStack gap={1}>
        <TileLabel icon={icon} label={label} />
        {children}
      </VStack>
    </Card>
  );
}

function CommitValue({ commit }: { commit: string }) {
  const { copy, isCopied } = useClipboard({ announce: t("system.facts.commitCopied") });
  return (
    <HStack gap={1} vAlign="center">
      <Text type="code" weight="semibold">
        {commit.slice(0, 7)}
      </Text>
      <IconButton
        label={t("system.facts.copyCommit")}
        tooltip={t("system.facts.copyCommit")}
        size="sm"
        variant="ghost"
        icon={<Icon icon={isCopied ? "check" : "copy"} size="sm" />}
        onClick={() =>
          void copy(commit).then((ok) => ok || notify("error", t("system.facts.copyFailed")))
        }
      />
    </HStack>
  );
}

function Summary({ config }: { config: UseQueryResult<Config> }) {
  const { version, commit, built } = useSession();
  // The server sends "none" and "unknown" when it was built without these values.
  const builtAt = Number.isNaN(Date.parse(built)) ? "" : built;
  const configVersion = config.data?.["config-version"];
  return (
    <Grid
      columns={{ minWidth: layout.summaryTileMin, max: 4, repeat: "fit" }}
      gap={4}
      aria-label={t("system.facts.summary")}
    >
      <Tile icon={Tag} label={t("system.facts.version")}>
        {version ? (
          <Text type="code" weight="semibold">
            {version}
          </Text>
        ) : (
          notReported()
        )}
      </Tile>
      <Tile icon={GitCommitHorizontal} label={t("system.facts.commit")}>
        {commit && commit !== "none" ? <CommitValue commit={commit} /> : notReported()}
      </Tile>
      <Tile icon="calendar" label={t("system.facts.built")}>
        {builtAt ? (
          <Timestamp value={builtAt} format="relative" type="body" color="primary" />
        ) : (
          notReported()
        )}
      </Tile>
      <Tile icon="wrench" label={t("system.facts.configLayout")}>
        {config.isPending && !config.isError ? (
          valueSkeleton()
        ) : config.isError ? (
          notReported()
        ) : (
          <Text type="body" weight="semibold">
            {configVersion
              ? t("system.facts.configVersion", { version: configVersion })
              : t("system.facts.legacyLayout")}
          </Text>
        )}
      </Tile>
    </Grid>
  );
}

const setting = (config: Config, path: string) => {
  const value: unknown = readPath(config, path);
  if (value === undefined || value === "") return t("system.config.serverDefault");
  return <Text type="code">{typeof value === "string" ? value : JSON.stringify(value)}</Text>;
};

function RemoteManagement({ config }: { config: Config }) {
  // The config cannot show the effective policy: MANAGEMENT_PASSWORD allows remote access too.
  if (readPath(config, "management/allow-remote", false))
    return <StatusLamp status="ready" label={t("system.config.remoteAllowed")} />;
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <StatusLamp status="disabled" label={t("system.config.remoteLocal")} />
      <Text type="supporting" color="secondary">
        {t("system.config.remoteLocalNote")}
      </Text>
    </HStack>
  );
}

function Configuration({ config }: { config: UseQueryResult<Config> }) {
  const value = (render: (c: Config) => ReactNode) =>
    config.data ? render(config.data) : valueSkeleton();
  return (
    <Section padding={4}>
      <VStack gap={4}>
        <Heading level={2}>{t("system.config.heading")}</Heading>
        {config.isError ? (
          <ReadError
            error={config.error}
            what={t("system.config.config")}
            retry={() => void config.refetch()}
          />
        ) : (
          <MetadataList aria-busy={config.isPending}>
            <MetadataListItem
              label={t("system.config.routingStrategy")}
              icon={<Icon icon={Route} size="sm" />}
            >
              {value((c) => setting(c, "routing/strategy"))}
            </MetadataListItem>
            <MetadataListItem
              label={t("system.config.authDirectory")}
              icon={<Icon icon={Folder} size="sm" />}
            >
              {value((c) => setting(c, "oauth/auth-dir"))}
            </MetadataListItem>
            <MetadataListItem
              label={t("system.config.remoteManagement")}
              icon={<Icon icon={Globe} size="sm" />}
            >
              {value((c) => (
                <RemoteManagement config={c} />
              ))}
            </MetadataListItem>
            {/* Where this page's code comes from: it runs with the management key. */}
            <MetadataListItem
              label={t("system.config.dashboard")}
              icon={<Icon icon={LayoutDashboard} size="sm" />}
            >
              {t("system.config.builtIn")}
            </MetadataListItem>
          </MetadataList>
        )}
      </VStack>
    </Section>
  );
}

/** The outcome of the last update check, as one banner under the page header. */
function ReleaseResult({ latest }: { latest: UseQueryResult<string> }) {
  const { version } = useSession();
  const error = latest.error;
  if (error instanceof ApiError && error.code === "update_check_disabled")
    return (
      <Banner
        status="info"
        title={t("system.updates.disabled", { setting: "CLIPROXY_NO_UPDATE_CHECK=1" })}
      />
    );
  // The server answers 502 invalid_response when the repository has no release to redirect to.
  if (error instanceof ApiError && error.code === "invalid_response")
    return (
      <Banner
        status="info"
        title={t("system.updates.noRelease")}
        description={t("system.updates.noReleaseDetail", {
          repository: repository.name,
        })}
      />
    );
  if (latest.isError)
    return (
      <ReadError
        error={error}
        what={t("system.updates.release")}
        retry={() => void latest.refetch()}
      />
    );
  if (latest.data === undefined) return null;
  const tag = latest.data || t("system.facts.notReported");
  const status = releaseStatus(latest.data, version);
  if (status === "current")
    return (
      <Banner
        status="success"
        title={t("system.updates.upToDate")}
        description={t("system.updates.latest", { version: tag })}
      />
    );
  if (status === "available")
    return (
      <Banner
        status="info"
        title={t("system.updates.available", { version: tag })}
        endContent={
          <Link href={`${repository.url}/releases`} target="_blank" isExternalLink>
            {t("system.updates.releases")}
          </Link>
        }
      />
    );
  return (
    <Banner
      status="info"
      title={t("system.updates.cannotCompare")}
      description={t("system.updates.compareDetail", {
        version: tag,
        server: version || t("system.facts.notReported"),
      })}
    />
  );
}

export default function System() {
  const config = useConfig();
  const latest = useLatestVersion();
  return (
    <PageFrame
      title={t("system.page.title")}
      meta={
        <Text type="supporting" color="secondary">
          {t("system.page.description")}
        </Text>
      }
      actions={
        <Button
          label={t("system.updates.check")}
          variant="primary"
          isLoading={latest.isFetching}
          onClick={() => void latest.refetch()}
        />
      }
    >
      <VStack role="status">
        <ReleaseResult latest={latest} />
      </VStack>
      <Summary config={config} />
      <Configuration config={config} />
      <Text type="supporting" color="secondary">
        {t("system.page.note")}
      </Text>
    </PageFrame>
  );
}
