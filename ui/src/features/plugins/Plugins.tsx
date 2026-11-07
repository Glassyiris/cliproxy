import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Store } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Switch } from "@astryxdesign/core/Switch";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useConfig, usePlugins } from "../../app/serverQueries.ts";
import { useAction } from "../../app/useAction.ts";
import { useHashRoute } from "../../app/useHashRoute.ts";
import { ConfigEditor } from "../../components/ConfigEditor.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { t } from "../../lib/i18n.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { InstalledTable } from "./InstalledTable.tsx";
import { useBrowse, usePluginWrites } from "./queries.ts";
import { pluginName } from "./rows.ts";
import { StoreSection } from "./StoreSection.tsx";
import { deleteAsk, installAsk, useConfirmation } from "./useConfirmation.ts";

function PluginsSwitch({
  on,
  isLoading,
  isDisabled,
  onChange,
}: {
  on: boolean;
  isLoading: boolean;
  isDisabled: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <Switch
      label={on ? t("plugins.page.on") : t("plugins.page.off")}
      size="sm"
      value={on}
      isLoading={isLoading}
      isDisabled={isDisabled}
      onChange={onChange}
    />
  );
}

function ReadErrors({
  list,
  config,
}: {
  list: ReturnType<typeof usePlugins>;
  config: ReturnType<typeof useConfig>;
}) {
  return (
    <>
      {list.isError && (
        <ReadError
          error={list.error}
          what={t("plugins.page.what")}
          retry={() => void list.refetch()}
        />
      )}
      {config.isError && (
        <ReadError
          error={config.error}
          what={t("plugins.page.configWhat")}
          retry={() => void config.refetch()}
        />
      )}
    </>
  );
}

function BrowseButton({
  ref,
  isLoading,
  onClick,
}: {
  ref: Ref<HTMLButtonElement>;
  isLoading: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      ref={ref}
      label={t("plugins.page.browse")}
      variant="primary"
      icon={<Icon icon={Store} />}
      isLoading={isLoading}
      onClick={onClick}
    />
  );
}

function NoPlugins({ browse }: { browse: ReactNode }) {
  return (
    <EmptyState
      title={t("plugins.empty.title")}
      description={t("plugins.empty.description")}
      headingLevel={2}
      actions={browse}
    />
  );
}

/**
 * The open editor is the route argument (`#plugins/<id>`), so Back, reload and the unsaved guard
 * see it. A press while a write is pending opens nothing.
 */
function useEditor(busy: boolean) {
  const id = useHashRoute().arg;
  // The editor is unmounted before the hash moves, so a saved or discarded draft is not asked about twice.
  const [closedFor, setClosedFor] = useState<string | null>(null);
  if (closedFor !== null && closedFor !== id) setClosedFor(null);
  useEffect(() => {
    if (closedFor !== null) location.hash = "#plugins";
  }, [closedFor]);
  return {
    id,
    source: id && closedFor !== id ? { path: `plugins/configs/${id}` } : null,
    open: (plugin: string) => {
      if (!busy) location.hash = `#plugins/${encodeURIComponent(plugin)}`;
    },
    close: () => setClosedFor(id),
  };
}

export default function Plugins() {
  const list = usePlugins();
  const config = useConfig();
  const action = useAction();
  const writes = usePluginWrites(action, config.data);
  const confirmation = useConfirmation(action.busy);
  const browse = useBrowse();
  const browseRef = useRef<HTMLButtonElement>(null);

  const plugins = list.data?.plugins;
  const hasPlugins = !!plugins?.length;
  const editor = useEditor(action.busy);
  const editing = plugins?.find((p) => p.id === editor.id);

  const browseButton = (
    <BrowseButton
      ref={browseRef}
      isLoading={browse.browsing && browse.store.isFetching}
      onClick={browse.press}
    />
  );

  return (
    <PageFrame
      title={t("plugins.page.title")}
      meta={
        list.data && (
          <PluginsSwitch
            on={list.data.plugins_enabled}
            isLoading={writes.loading()}
            isDisabled={!config.data}
            onChange={(on) => void writes.all(on)}
          />
        )
      }
      actions={plugins && !hasPlugins ? undefined : browseButton}
    >
      <ReadErrors list={list} config={config} />
      {plugins && !hasPlugins && <NoPlugins browse={browseButton} />}
      {(list.isPending || hasPlugins) && (
        <InstalledTable
          plugins={plugins}
          canSwitch={!!config.data}
          isLoading={writes.loading}
          onSwitch={(p) => void writes.one(p)}
          onConfigure={(p) => editor.open(p.id)}
          onDelete={(p) =>
            confirmation.ask(deleteAsk(p, writes.remove, () => browseRef.current?.focus()))
          }
        />
      )}
      {browse.browsing && (
        <StoreSection
          store={browse.store.data}
          error={browse.store.error}
          reveal={browse.reveal}
          retry={() => void browse.store.refetch()}
          onInstall={(p, verb) => confirmation.ask(installAsk(p, verb, writes.install))}
        />
      )}
      <ConfirmDialog
        dialogRef={confirmation.dialogRef}
        confirmation={confirmation.asking}
        busy={action.busy}
        onConfirm={() => void confirmation.confirm()}
        onClose={confirmation.close}
      />
      <ConfigEditor
        source={editor.source}
        title={t("plugins.row.configureTitle", {
          name: editing ? pluginName(editing) : editor.id,
        })}
        action={action}
        onClose={editor.close}
      />
    </PageFrame>
  );
}
