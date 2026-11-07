import type { ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Layout, LayoutContent, LayoutHeader, VStack } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useSession } from "../../app/Session.tsx";
import { StatusLamp } from "../../components/StatusLamp.tsx";
import { ApiError, ConnectionError, base } from "../../lib/api/client.ts";
import type { Config } from "../../lib/api/config.ts";
import { readPath } from "../../lib/config-path.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { useConfig, useLatestVersion } from "./queries.ts";
import { releaseStatus } from "./version.ts";

// ponytail: shown, not requested. client.ts keeps its endpoint private; export it there to drop this.
const managementApi = `${new URL(base).pathname.replace(/\/$/, "")}/v8/management`;

const errorText = (error: unknown) =>
  error instanceof ConnectionError
    ? error.reason === "timeout"
      ? t("app.connection.timeout")
      : t("app.connection.unreachable")
    : error instanceof Error
      ? error.message
      : String(error);

/** A read that failed, or a route this server does not implement. */
function ReadError({ error, what, retry }: { error: unknown; what: string; retry: () => void }) {
  if (error instanceof ApiError && error.notImplemented)
    return (
      <Banner
        status="info"
        title={t("app.read.unavailable")}
        description={t("app.read.unimplemented", {
          method: error.method,
          path: error.path,
          status: error.status,
        })}
      />
    );
  return (
    <Banner
      status="error"
      title={t("app.read.failed", { what })}
      description={errorText(error)}
      endContent={
        <Button label={t("app.read.retry")} variant="secondary" size="sm" onClick={retry} />
      }
    />
  );
}

const code = (value: string) => <Text type="code">{value}</Text>;
const setting = (config: Config, path: string) => {
  const value: unknown = readPath(config, path);
  if (value === undefined || value === "") return t("system.facts.serverDefault");
  return code(typeof value === "string" ? value : JSON.stringify(value));
};

function ConfigFacts({ config }: { config: Config | undefined }) {
  const value = (render: (c: Config) => ReactNode) =>
    config ? (
      render(config)
    ) : (
      <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
    );
  return (
    <>
      <MetadataListItem label={t("system.facts.configLayout")}>
        {value((c) =>
          c["config-version"]
            ? t("system.facts.configVersion", { version: c["config-version"] })
            : t("system.facts.legacyLayout"),
        )}
      </MetadataListItem>
      <MetadataListItem label={t("system.facts.routingStrategy")}>
        {value((c) => setting(c, "routing/strategy"))}
      </MetadataListItem>
      <MetadataListItem label={t("system.facts.authDirectory")}>
        {value((c) => setting(c, "oauth/auth-dir"))}
      </MetadataListItem>
      {/* The config cannot show the effective policy: MANAGEMENT_PASSWORD allows remote access too. */}
      <MetadataListItem label={t("system.facts.remoteManagement")}>
        {value((c) =>
          readPath(c, "management/allow-remote", false)
            ? t("system.facts.remoteAllowed")
            : t("system.facts.remoteLocal"),
        )}
      </MetadataListItem>
    </>
  );
}

function Facts() {
  const { version, commit, built } = useSession();
  const config = useConfig();
  // The server sends "none" and "unknown" when it was built without these values.
  const builtAt = Date.parse(built);
  return (
    <VStack gap={4}>
      {config.isError ? (
        <ReadError
          error={config.error}
          what={t("system.facts.config")}
          retry={() => void config.refetch()}
        />
      ) : null}
      <MetadataList aria-busy={config.isPending && !config.isError}>
        <MetadataListItem label={t("system.facts.managementApi")}>
          {code(managementApi)}
        </MetadataListItem>
        <MetadataListItem label={t("system.facts.version")}>
          {version ? code(version) : t("system.facts.notReported")}
        </MetadataListItem>
        <MetadataListItem label={t("system.facts.commit")}>
          {commit && commit !== "none" ? code(commit) : t("system.facts.notReported")}
        </MetadataListItem>
        <MetadataListItem label={t("system.facts.built")}>
          {Number.isNaN(builtAt)
            ? t("system.facts.notReported")
            : t("system.facts.builtAt", { built: builtAt })}
        </MetadataListItem>
        {config.isError ? null : <ConfigFacts config={config.data} />}
        {/* Where this page's code comes from: it runs with the management key. */}
        <MetadataListItem label={t("system.facts.dashboard")}>
          {t("system.facts.builtIn")}
        </MetadataListItem>
      </MetadataList>
    </VStack>
  );
}

function Updates() {
  const { version } = useSession();
  const latest = useLatestVersion();
  const disabled =
    latest.error instanceof ApiError && latest.error.code === "update_check_disabled";
  const release = latest.data === undefined ? undefined : releaseStatus(latest.data, version);
  return (
    <VStack gap={4} hAlign="start">
      <Button
        label={t("system.updates.check")}
        variant="secondary"
        isLoading={latest.isFetching}
        isDisabled={disabled}
        onClick={() => void latest.refetch()}
      />
      {disabled ? (
        <Text role="status">
          {t("system.updates.disabled", { setting: "CLIPROXY_NO_UPDATE_CHECK=1" })}
        </Text>
      ) : latest.isError ? (
        <ReadError
          error={latest.error}
          what={t("system.updates.release")}
          retry={() => void latest.refetch()}
        />
      ) : latest.data !== undefined ? (
        <VStack gap={1} role="status">
          <StatusLamp
            status={release === "current" ? "ready" : "info"}
            label={
              release === "current"
                ? t("system.updates.upToDate")
                : release === "available"
                  ? t("system.updates.available")
                  : t("system.updates.cannotCompare")
            }
          />
          <Text>
            {t("system.updates.latest", { version: latest.data || t("system.updates.unknown") })}
          </Text>
        </VStack>
      ) : null}
    </VStack>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <VStack gap={4}>
      <VStack gap={1}>
        <Heading level={2}>{title}</Heading>
        <Text type="supporting">{description}</Text>
      </VStack>
      {children}
    </VStack>
  );
}

export default function System() {
  return (
    <Layout
      height="fill"
      contentWidth={layout.pageWidth}
      header={
        <LayoutHeader hasDivider>
          <VStack gap={1}>
            <Heading level={1}>{t("system.page.title")}</Heading>
            <Text type="supporting">{t("system.page.description")}</Text>
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={4}>
          <VStack gap={6}>
            <Section title={t("system.facts.heading")} description={t("system.facts.description")}>
              <Facts />
            </Section>
            <Divider />
            <Section
              title={t("system.updates.heading")}
              description={t("system.updates.description")}
            >
              <Updates />
            </Section>
          </VStack>
        </LayoutContent>
      }
    />
  );
}
