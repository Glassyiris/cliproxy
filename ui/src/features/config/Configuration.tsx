import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Text } from "@astryxdesign/core/Text";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useConfig } from "../../app/serverQueries.ts";
import { useAction } from "../../app/useAction.ts";
import { useHashRoute } from "../../app/useHashRoute.ts";
import { ConfigEditor, type ConfigSource } from "../../components/ConfigEditor.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { t } from "../../lib/i18n.ts";
import { Region } from "./Region.tsx";
import { RoutingStrategy, RoutingStrategySkeleton } from "./RoutingStrategy.tsx";
import { SectionList, SectionListSkeleton } from "./SectionList.tsx";

const YAML = "config.yaml";

export default function Configuration() {
  const config = useConfig();
  const action = useAction();
  const editing = useHashRoute().arg;
  // The editor is unmounted before the hash moves, so a saved or discarded draft is not asked about twice.
  const [closedFor, setClosedFor] = useState<string | null>(null);
  if (closedFor !== null && closedFor !== editing) setClosedFor(null);
  useEffect(() => {
    if (closedFor !== null) location.hash = "#config";
  }, [closedFor]);
  const open = (name: string) => {
    location.hash = `#config/${encodeURIComponent(name)}`;
  };
  const source: ConfigSource | null =
    !editing || closedFor === editing
      ? null
      : editing === YAML
        ? { yaml: true }
        : { path: editing };

  const version = config.data?.["config-version"];
  const meta = config.data && (
    <Text type="supporting" color="secondary">
      {version ? t("config.page.layout", { version }) : t("config.page.legacy")}
    </Text>
  );

  return (
    <PageFrame
      title={t("config.page.title")}
      meta={meta}
      actions={
        <Button label={t("config.page.editYaml")} variant="primary" onClick={() => open(YAML)} />
      }
    >
      {config.isError && (
        <ReadError
          error={config.error}
          what={t("config.page.what")}
          retry={() => void config.refetch()}
        />
      )}
      {(config.data || !config.isError) && (
        <>
          <Region
            heading={t("config.routing.heading")}
            description={t("config.routing.description")}
          >
            {config.data ? (
              <RoutingStrategy config={config.data} action={action} />
            ) : (
              <RoutingStrategySkeleton />
            )}
          </Region>
          <Divider />
          <Region
            heading={t("config.sections.heading")}
            description={t("config.sections.description")}
          >
            {config.data ? (
              <SectionList config={config.data} onOpen={open} />
            ) : (
              <SectionListSkeleton />
            )}
          </Region>
          <Text type="supporting" color="secondary">
            {t("config.page.note")}
          </Text>
        </>
      )}
      <ConfigEditor
        source={source}
        title={editing === YAML ? t("config.page.editYaml") : editing}
        action={action}
        onClose={() => setClosedFor(editing)}
      />
    </PageFrame>
  );
}
