import { Icon } from "@astryxdesign/core/Icon";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { icons } from "../../components/icons.ts";
import { CardHeading } from "../../components/CardHeading.tsx";
import { placeholderRows } from "../../components/loadingRows.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import type { PluginStore, StorePlugin } from "../../lib/api/plugins.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { roles } from "../../themes/site/roles.ts";
import { plainText, pluginName } from "./rows.ts";

const verb = (p: StorePlugin) =>
  p.installed
    ? p.update_available
      ? t("plugins.store.update")
      : t("plugins.store.reinstall")
    : t("plugins.store.install");

type Install = (plugin: StorePlugin, verb: string) => void;

const skeleton = () => (
  <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
);

/** One store entry: name and version, what it does, and the one action it offers. */
function StoreCard({ plugin, onInstall }: { plugin: StorePlugin | null; onInstall: Install }) {
  return (
    <Card padding={roles.card.padding}>
      <VStack gap={roles.gap.card} height="100%">
        {plugin ? (
          <CardHeading
            title={pluginName(plugin)}
            description={
              <Text type={roles.textType.body} hasTabularNumbers>
                {plainText(plugin.version)}
              </Text>
            }
          />
        ) : (
          skeleton()
        )}
        <StackItem size="fill">
          <Text type="supporting" color="secondary">
            {plugin ? plainText(plugin.description) : skeleton()}
          </Text>
        </StackItem>
        <HStack>
          {plugin ? (
            <Button
              label={t("plugins.store.verbNamed", { verb: verb(plugin), name: pluginName(plugin) })}
              variant="secondary"
              size="sm"
              onClick={() => onInstall(plugin, verb(plugin))}
            >
              {verb(plugin)}
            </Button>
          ) : (
            skeleton()
          )}
        </HStack>
      </VStack>
    </Card>
  );
}

/** The store: the sources that failed, then one card per plugin; the installed list updates behind. */
export function StorePanel({
  store,
  error,
  retry,
  onInstall,
}: {
  /** Undefined while the store loads. */
  store: PluginStore | undefined;
  error: unknown;
  retry: () => void;
  onInstall: Install;
}) {
  if (error) return <ReadError error={error} what={t("plugins.store.what")} retry={retry} />;
  if (store && store.plugins.length === 0)
    return (
      <EmptyState
        icon={<Icon icon={icons.plugins} size="lg" />}
        title={t("plugins.store.empty")}
        headingLevel={3}
        isCompact
      />
    );
  return (
    <VStack gap={roles.gap.card}>
      {store?.source_errors?.map((e) => (
        <Banner
          key={e.source_id}
          status="error"
          title={t("plugins.store.sourceFailed", { source: plainText(e.source_name) })}
          description={plainText(e.message)}
        />
      ))}
      <Grid
        columns={{ minWidth: layout.settingsColumnMin, repeat: "fill" }}
        gap={roles.gap.card}
        aria-busy={!store}
      >
        {(store?.plugins ?? placeholderRows).map((p) =>
          "item" in p ? (
            <StoreCard key={p.id} plugin={null} onInstall={onInstall} />
          ) : (
            <StoreCard key={p.store_id} plugin={p} onInstall={onInstall} />
          ),
        )}
      </Grid>
    </VStack>
  );
}
