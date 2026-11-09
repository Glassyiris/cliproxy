// The About panel of the preferences dialog (settings-dialog template, `?open=about`): one
// MetadataList of the build and the server, the release check, then the project's links.
// Deviation: the template's About panel is a product blurb; this one lists what an operator
// checks (DESIGN.md "Pages").
import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { useClipboard } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { icons } from "../../components/icons.ts";
import { useConfig } from "../../app/serverQueries.ts";
import { useSession } from "../../app/Session.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { StatusLamp } from "../../components/StatusLamp.tsx";
import { ApiError, base } from "../../lib/api/client.ts";
import type { Config } from "../../lib/api/config.ts";
import { readPath } from "../../lib/configPath.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";
import { repository } from "../../lib/repository.ts";
import { layout } from "../../themes/site/layout.ts";
import { useLatestVersion } from "./queries.ts";
import { releaseStatus } from "./version.ts";

const managementApi = `${base}/v8/management`;

const notReported = () => (
  <Text type="body" color="secondary">
    {t("system.facts.notReported")}
  </Text>
);
const valueSkeleton = () => (
  <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
);

function CommitValue({ commit }: { commit: string }) {
  const { copy, isCopied } = useClipboard({ announce: t("system.facts.commitCopied") });
  return (
    <HStack gap={1} vAlign="center">
      <Text type="body">{commit.slice(0, 7)}</Text>
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

function RemoteManagement({ config }: { config: Config }) {
  // The config cannot show the effective policy: MANAGEMENT_PASSWORD allows remote access too.
  if (readPath(config, "management/allow-remote", false))
    return <StatusLamp status="ready" label={t("system.config.remoteAllowed")} />;
  return (
    <VStack gap={0}>
      <StatusLamp status="disabled" label={t("system.config.remoteLocal")} />
      <Text type="supporting" color="secondary">
        {t("system.config.remoteLocalNote")}
      </Text>
    </VStack>
  );
}

// No icon before the label: with one, MetadataList drops every value 3 px below its label. Values are body text for the same reason: the code type sits
// 5 px lower again.
function Item({ label, children }: { label: string; children: ReactNode }) {
  return <MetadataListItem label={label}>{children}</MetadataListItem>;
}

/** The build from the session, then how this server takes management. */
function Facts({ config }: { config: UseQueryResult<Config> }) {
  const { version, commit, built } = useSession();
  // The server sends "none" and "unknown" when it was built without these values.
  const builtAt = Number.isNaN(Date.parse(built)) ? "" : built;
  const fromConfig = (render: (c: Config) => ReactNode) =>
    config.data
      ? (render(config.data) ?? notReported())
      : config.isError
        ? notReported()
        : valueSkeleton();
  return (
    <MetadataList aria-busy={config.isPending} label={{ width: layout.metadataLabelWidth }}>
      <Item label={t("system.facts.version")}>
        {version ? <Text type="body">{version}</Text> : notReported()}
      </Item>
      <Item label={t("system.facts.commit")}>
        {commit && commit !== "none" ? <CommitValue commit={commit} /> : notReported()}
      </Item>
      <Item label={t("system.facts.built")}>
        {builtAt ? (
          <Timestamp value={builtAt} format="relative" type="body" color="primary" />
        ) : (
          notReported()
        )}
      </Item>
      <Item label={t("system.config.remoteManagement")}>
        {fromConfig((c) => (
          <RemoteManagement config={c} />
        ))}
      </Item>
      {/* Where this page's code comes from: it runs with the management key. */}
      <Item label={t("system.config.managementApi")}>
        <Text type="body">{managementApi}</Text>
      </Item>
    </MetadataList>
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
        title={t("system.updates.disabled", { setting: "COOK_ROUTER_NO_UPDATE_CHECK=1" })}
      />
    );
  // The server answers 502 invalid_response when the repository has no release to redirect to.
  if (error instanceof ApiError && error.code === "invalid_response")
    return <Banner status="info" title={t("system.updates.noRelease")} />;
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

/** The project, its licence and the work it builds on; each opens in a new tab. */
function Links() {
  const link = (href: string, label: string) => (
    <Link href={href} target="_blank" isExternalLink>
      {label}
    </Link>
  );
  return (
    <MetadataList label={{ width: layout.metadataLabelWidth }}>
      <MetadataListItem label={t("system.links.repository")}>
        {link(repository.url, repository.name)}
      </MetadataListItem>
      <MetadataListItem label={t("system.links.licence")}>
        {link(`${repository.url}/blob/master/LICENSE`, "MIT")}
      </MetadataListItem>
      <MetadataListItem label={t("system.links.credits")}>
        <VStack gap={0}>
          {link("https://github.com/vayungodara/cliproxy-rs", "Vayun Godara")}
          {link("https://github.com/router-for-me/CLIProxyAPI", "CLIProxyAPI")}
        </VStack>
      </MetadataListItem>
    </MetadataList>
  );
}

export function About() {
  const config = useConfig();
  const latest = useLatestVersion();
  return (
    <VStack gap={4}>
      {config.isError && (
        <ReadError
          error={config.error}
          what={t("system.config.config")}
          retry={() => void config.refetch()}
        />
      )}
      <Facts config={config} />
      <Divider />
      <HStack>
        <Button
          label={t("system.updates.check")}
          variant="secondary"
          icon={<Icon icon={icons.refresh} />}
          isLoading={latest.isFetching}
          onClick={() => void latest.refetch()}
        />
      </HStack>
      <VStack role="status">
        <ReleaseResult latest={latest} />
      </VStack>
      <Divider />
      <Links />
    </VStack>
  );
}
