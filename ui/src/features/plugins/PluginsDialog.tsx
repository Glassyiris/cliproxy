// Template: settings-dialog, as the preferences dialog (src/app/settings/SettingsDialog.tsx) frames
// it: a rail of two panels beside the panel at one frame size, and below the narrow breakpoint a
// title row, a tab strip and the panel. Panels: Installed (facts, then the flat list) and Store.
// Deviations:
// - Two panels instead of the template's six, and no account card in the rail: plugins have
//   nothing else to set.
// - The open panel is `?store=1` in the hash, so Back and links reach the store.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { Package, Store } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, Layout, LayoutContent, StackItem, VStack } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Switch } from "@astryxdesign/core/Switch";
import { Heading, Text } from "@astryxdesign/core/Text";
import { icons } from "../../components/icons.ts";
import { useConfig, usePlugins } from "../../app/serverQueries.ts";
import { PanelHeading } from "../../app/settings/PanelHeading.tsx";
import { useAction } from "../../app/useAction.ts";
import { useHashParams, useHashRoute } from "../../app/useHashRoute.ts";
import { PluginConfigEditor } from "../../components/PluginConfigEditor.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { InstalledTable } from "./InstalledTable.tsx";
import { usePluginWrites, useStore } from "./queries.ts";
import { pluginName, pluginState } from "./rows.ts";
import { StorePanel } from "./StorePanel.tsx";
import { deleteAsk, installAsk, useConfirmation } from "./useConfirmation.ts";

const styles = stylex.create({
  // SideNav sets a starting width but no flex-shrink, so the pane would squeeze the rail.
  sideNav: { flexShrink: 0 },
});

type PanelId = "installed" | "store";

const PANELS: { id: PanelId; label: () => string; icon: IconProps["icon"] }[] = [
  { id: "installed", label: () => t("plugins.panel.installed"), icon: Package },
  { id: "store", label: () => t("plugins.panel.store"), icon: Store },
];

const panelOf = (id: PanelId) => PANELS.find((p) => p.id === id) ?? PANELS[0];

/** Loaded and waiting for a restart, the two facts the dialog answers first. */
function Facts({ list }: { list: ReturnType<typeof usePlugins>["data"] }) {
  const states = list?.plugins.map(pluginState) ?? [];
  const count = (state: string) => (list ? states.filter((s) => s === state).length : undefined);
  const value = (n: number | undefined) => (
    <Text type="body" hasTabularNumbers>
      {n ?? "–"}
    </Text>
  );
  return (
    <MetadataList orientation="horizontal" aria-busy={!list}>
      <MetadataListItem label={t("plugins.facts.loaded")}>
        {value(count("loaded"))}
      </MetadataListItem>
      <MetadataListItem label={t("plugins.facts.restart")}>
        {value(count("restart"))}
      </MetadataListItem>
    </MetadataList>
  );
}

/** The facts, the switch for all plugins, and what could not be read. */
function InstalledFacts({
  list,
  config,
  writes,
}: {
  list: ReturnType<typeof usePlugins>;
  config: ReturnType<typeof useConfig>;
  writes: ReturnType<typeof usePluginWrites>;
}) {
  return (
    <>
      <HStack gap={4} vAlign="center" hAlign="between" wrap="wrap">
        <Facts list={list.data} />
        {list.data && (
          <Switch
            label={list.data.plugins_enabled ? t("plugins.page.on") : t("plugins.page.off")}
            value={list.data.plugins_enabled}
            isLoading={writes.loading()}
            isDisabled={!config.data}
            onChange={(on) => void writes.all(on)}
          />
        )}
      </HStack>
      {list.data && !list.data.plugins_enabled && (
        <Banner status="info" title={t("plugins.page.offNote")} />
      )}
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

function InstalledPanel({ onBrowse }: { onBrowse: () => void }) {
  const list = usePlugins();
  const config = useConfig();
  const action = useAction();
  const writes = usePluginWrites(action, config.data);
  const confirmation = useConfirmation(action.busy);
  const [, setParams] = useHashParams();
  // The open plugin is `?plugin=`: SettingsPage scopes the route argument to it.
  const editing = useHashRoute().arg;
  // A link that opens the dialog with `&plugin=` mounts both in one commit, and the inner editor's
  // showModal would run before the outer dialog's and end up under it; the editor waits a frame.
  const [isShown, setShown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const panelRef = useRef<HTMLElement>(null);
  const plugins = list.data?.plugins;
  const edited = plugins?.find((p) => p.id === editing);
  const open = (id: string | undefined) => {
    if (!action.busy) setParams({ plugin: id }, id ? "push" : "replace");
  };

  return (
    <VStack gap={4} ref={panelRef}>
      <InstalledFacts list={list} config={config} writes={writes} />
      {plugins && !plugins.length ? (
        <EmptyState
          icon={<Icon icon={icons.plugins} size="lg" />}
          title={t("plugins.empty.title")}
          headingLevel={3}
          actions={<Button label={t("plugins.page.browse")} variant="primary" onClick={onBrowse} />}
        />
      ) : (
        !list.isError && (
          <InstalledTable
            plugins={plugins}
            canSwitch={!!config.data}
            isLoading={writes.loading}
            onSwitch={(p) => void writes.one(p)}
            onConfigure={(p) => open(p.id)}
            onDelete={(p) =>
              confirmation.ask(deleteAsk(p, writes.remove, () => panelRef.current?.focus()))
            }
          />
        )
      )}
      <ConfirmDialog
        dialogRef={confirmation.dialogRef}
        confirmation={confirmation.asking}
        busy={action.busy}
        onConfirm={() => void confirmation.confirm()}
        onClose={confirmation.close}
      />
      <PluginConfigEditor
        id={editing && isShown ? editing : null}
        title={t("plugins.row.configureTitle", { name: edited ? pluginName(edited) : editing })}
        hashKey="plugin"
        action={action}
        onClose={() => open(undefined)}
      />
    </VStack>
  );
}

function StoreBody() {
  const config = useConfig();
  const action = useAction();
  const writes = usePluginWrites(action, config.data);
  const confirmation = useConfirmation(action.busy);
  const { store } = useStore();
  return (
    <>
      <StorePanel
        store={store.data}
        error={store.error}
        retry={() => void store.refetch()}
        onInstall={(p, verb) => confirmation.ask(installAsk(p, verb, writes.install))}
      />
      <ConfirmDialog
        dialogRef={confirmation.dialogRef}
        confirmation={confirmation.asking}
        busy={action.busy}
        onConfirm={() => void confirmation.confirm()}
        onClose={confirmation.close}
      />
    </>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <IconButton
      label={t("plugins.dialog.close")}
      variant="ghost"
      size="sm"
      icon={<Icon icon="close" size="sm" />}
      onClick={onClose}
    />
  );
}

type ShellProps = {
  titleId: string;
  active: PanelId;
  onSelect: (panel: PanelId) => void;
  onClose: () => void;
  body: ReactNode;
};

function WideShell({ titleId, active, onSelect, onClose, body }: ShellProps) {
  return (
    <Layout
      start={
        <SideNav
          aria-label={t("plugins.panel.sections")}
          xstyle={styles.sideNav}
          header={
            <HStack
              gap={2}
              vAlign="center"
              paddingInline={2}
              minHeight={layout.settingsDialog.headingRow}
            >
              <Heading level={4} id={titleId}>
                {t("app.nav.plugins")}
              </Heading>
            </HStack>
          }
        >
          <SideNavSection title={t("plugins.panel.sections")} isHeaderHidden>
            {PANELS.map((panel) => (
              <SideNavItem
                key={panel.id}
                label={panel.label()}
                icon={<Icon icon={panel.icon} size="sm" color="primary" />}
                isSelected={panel.id === active}
                onClick={() => onSelect(panel.id)}
              />
            ))}
          </SideNavSection>
        </SideNav>
      }
      content={
        <LayoutContent isScrollable padding={4}>
          <VStack gap={4}>
            <HStack gap={2} vAlign="start">
              <StackItem size="fill">
                <PanelHeading>{panelOf(active).label()}</PanelHeading>
              </StackItem>
              <CloseButton onClose={onClose} />
            </HStack>
            {body}
          </VStack>
        </LayoutContent>
      }
    />
  );
}

function NarrowShell({ titleId, active, onSelect, onClose, body }: ShellProps) {
  return (
    <VStack gap={0} height="100%">
      <HStack gap={2} vAlign="center" paddingInline={3} paddingBlock={3}>
        <StackItem size="fill">
          <Text type="label" id={titleId}>
            {t("app.nav.plugins")}
          </Text>
        </StackItem>
        <CloseButton onClose={onClose} />
      </HStack>
      <Divider />
      <HStack
        as="nav"
        aria-label={t("plugins.panel.sections")}
        gap={1}
        paddingInline={3}
        paddingBlock={2}
      >
        {PANELS.map((panel) => (
          <Button
            key={panel.id}
            label={panel.label()}
            icon={<Icon icon={panel.icon} size="sm" />}
            variant={panel.id === active ? "secondary" : "ghost"}
            size="sm"
            aria-current={panel.id === active ? "page" : undefined}
            onClick={() => onSelect(panel.id)}
          />
        ))}
      </HStack>
      <Divider />
      <StackItem size="fill">
        <VStack gap={4} padding={4} isScrollable height="100%">
          <PanelHeading>{panelOf(active).label()}</PanelHeading>
          {body}
        </VStack>
      </StackItem>
    </VStack>
  );
}

/** The plugins dialog over Settings: `?open=plugins`, the store `&store=1`, an open editor `&plugin=`. */
export function PluginsDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const titleId = useId();
  const isNarrow = useMediaQuery(layout.settingsDialog.narrowViewport);
  const store = useStore();
  const active: PanelId = store.isOpen ? "store" : "installed";
  const shell: ShellProps = {
    titleId,
    active,
    onSelect: (panel) => store.show(panel === "store"),
    onClose,
    body: active === "store" ? <StoreBody /> : <InstalledPanel onBrowse={() => store.show(true)} />,
  };
  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => !open && onClose()}
      purpose="form"
      width={layout.settingsDialog.width}
      maxHeight={layout.settingsDialog.height}
      padding={0}
      aria-labelledby={titleId}
    >
      {/* One height for both panels: the panel scrolls, the frame does not grow. */}
      <VStack height={layout.settingsDialog.height}>
        {isOpen && (isNarrow ? <NarrowShell {...shell} /> : <WideShell {...shell} />)}
      </VStack>
    </Dialog>
  );
}
