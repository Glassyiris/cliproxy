import { useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useHashParams } from "../../app/useHashRoute.ts";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { AddAliasDialog } from "./AddAliasDialog.tsx";
import { ChannelPicker } from "./ChannelPicker.tsx";
import { AliasSection } from "./AliasSection.tsx";
import { CatalogSection } from "./CatalogSection.tsx";
import { ExcludedSection } from "./ExcludedSection.tsx";
import { catalogRow, channels, isChannel } from "./modelConfig.ts";
import { useCatalog } from "./queries.ts";
import { useModelSettings } from "./useModelSettings.ts";

export default function Models() {
  const [params, setParams] = useHashParams();
  const channel = isChannel(params.channel) ? params.channel : channels[0];
  const settings = useModelSettings(channel);
  const catalog = useCatalog(channel);
  const [adding, setAdding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const rows = useMemo(() => catalog.data?.map(catalogRow), [catalog.data]);
  const channelName = label(channel);

  return (
    <PageFrame
      title={t("models.page.title")}
      meta={
        rows && (
          <Text type="supporting" color="secondary">
            {t("models.page.meta", { count: rows.length, channel: channelName })}
          </Text>
        )
      }
      actions={
        settings.aliases && (
          <Button
            ref={addButton}
            label={t("models.page.add")}
            variant="primary"
            icon={<Icon icon={Plus} />}
            onClick={() => setAdding(true)}
          />
        )
      }
    >
      <ChannelPicker channel={channel} onChange={(value) => setParams({ channel: value })} />
      <AliasSection
        config={settings.config}
        aliases={settings.aliases}
        busy={settings.busy}
        onRemove={settings.removeAlias}
        addButton={addButton}
      />
      <ExcludedSection
        channel={channel}
        config={settings.config}
        excluded={settings.excluded}
        busy={settings.busy}
        exclude={settings.exclude}
        onAllow={settings.allow}
      />
      <CatalogSection
        channelName={channelName}
        rows={rows}
        failure={
          catalog.isError
            ? { error: catalog.error, retry: () => void catalog.refetch() }
            : undefined
        }
        query={params.q ?? ""}
        onQuery={(q) => setParams({ q })}
      />
      {adding && settings.aliases && (
        <AddAliasDialog
          models={rows?.map((row) => row.id) ?? []}
          aliases={settings.aliases}
          busy={settings.busy}
          add={settings.addAlias}
          onClose={() => setAdding(false)}
        />
      )}
    </PageFrame>
  );
}
