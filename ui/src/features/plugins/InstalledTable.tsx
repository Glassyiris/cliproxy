import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Switch } from "@astryxdesign/core/Switch";
import { proportional, Table, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { loadingCell, placeholderRows, type LoadingRow } from "../../components/loadingRows.tsx";
import { StatusLamp } from "../../components/StatusLamp.tsx";
import type { Plugin } from "../../lib/api/plugins.ts";
import { t } from "../../lib/i18n.ts";
import type { Status } from "../../themes/site/index.ts";
import { roles } from "../../themes/site/roles.ts";
import { capabilities, plainText, pluginName, pluginState, type PluginState } from "./rows.ts";

const lamp = {
  loaded: "ready",
  restart: "cooling",
  disabled: "disabled",
} as const satisfies Record<PluginState, Status>;

const stateWord = {
  loaded: () => t("plugins.status.loaded"),
  restart: () => t("plugins.status.restart"),
  disabled: () => t("plugins.status.disabled"),
} as const satisfies Record<PluginState, () => string>;

const capabilityWord = {
  signIn: () => t("plugins.cap.signIn"),
  quota: () => t("plugins.cap.quota"),
} as const;

function Capabilities({ plugin }: { plugin: Plugin }) {
  const caps = capabilities(plugin).map((c) => capabilityWord[c]());
  return (
    <Text type="supporting" color="secondary">
      {caps.length ? caps.join(t("plugins.cap.separator")) : t("plugins.cap.none")}
    </Text>
  );
}

/** The name, then the id when it differs and what the plugin adds. */
function Name({ plugin }: { plugin: Plugin }) {
  const name = pluginName(plugin);
  return (
    <VStack gap={0.5}>
      <Text type="body" weight="semibold">
        {name}
      </Text>
      <HStack gap={2} vAlign="center" wrap="wrap">
        {name !== plugin.id && (
          <Text type={roles.textType.identifier} color="secondary">
            {plugin.id}
          </Text>
        )}
        <Capabilities plugin={plugin} />
      </HStack>
    </VStack>
  );
}

function RowMenu({
  plugin,
  onConfigure,
  onDelete,
}: {
  plugin: Plugin;
  onConfigure: (plugin: Plugin) => void;
  onDelete: (plugin: Plugin) => void;
}) {
  return (
    <MoreMenu
      label={t("plugins.row.menu", { name: pluginName(plugin) })}
      size="sm"
      items={[
        { label: t("plugins.row.configure"), onClick: () => onConfigure(plugin) },
        {
          label: t("plugins.row.delete"),
          variant: "destructive",
          onClick: () => onDelete(plugin),
        },
      ]}
    />
  );
}

type Row = LoadingRow<Plugin>;

type Handlers = {
  canSwitch: boolean;
  isLoading: (id: string) => boolean;
  onSwitch: (plugin: Plugin) => void;
  onConfigure: (plugin: Plugin) => void;
  onDelete: (plugin: Plugin) => void;
};

const cell = loadingCell<Plugin>;

const Lamp = ({ plugin }: { plugin: Plugin }) => {
  const state = pluginState(plugin);
  return <StatusLamp status={lamp[state]} label={stateWord[state]()} />;
};

const Version = ({ plugin }: { plugin: Plugin }) =>
  plugin.metadata ? (
    <Text type={roles.textType.body} hasTabularNumbers>
      {plainText(plugin.metadata.version)}
    </Text>
  ) : null;

/** The switch and the menu, the same in both layouts. */
const actionsColumn = (h: Handlers): TableColumn<Row> => ({
  key: "actions",
  header: t("plugins.table.actions"),
  align: "end",
  renderCell: cell((p) => (
    <HStack gap={2} vAlign="center" hAlign="end">
      <Switch
        label={t("plugins.row.enabled", { name: pluginName(p) })}
        isLabelHidden
        size="sm"
        value={p.enabled}
        isLoading={h.isLoading(p.id)}
        isDisabled={!h.canSwitch}
        onChange={() => h.onSwitch(p)}
      />
      <RowMenu plugin={p} onConfigure={h.onConfigure} onDelete={h.onDelete} />
    </HStack>
  )),
});

const wideColumns = (h: Handlers): TableColumn<Row>[] => [
  { key: "name", header: t("plugins.table.name"), renderCell: cell((p) => <Name plugin={p} />) },
  {
    key: "version",
    header: t("plugins.table.version"),
    renderCell: cell((p) => <Version plugin={p} />),
  },
  {
    key: "status",
    header: t("plugins.table.status"),
    renderCell: cell((p) => <Lamp plugin={p} />),
  },
  actionsColumn(h),
];

// On a phone the facts about a plugin stack in one column, so the actions keep theirs.
const narrowColumns = (h: Handlers): TableColumn<Row>[] => [
  {
    key: "name",
    header: t("plugins.table.name"),
    width: proportional(2),
    renderCell: cell((p) => (
      <VStack gap={1}>
        <Name plugin={p} />
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Lamp plugin={p} />
          <Version plugin={p} />
        </HStack>
      </VStack>
    )),
  },
  actionsColumn(h),
];

/** `plugins` is undefined while the list loads: placeholder rows in the table's shape. */
export function InstalledTable({
  plugins,
  ...handlers
}: { plugins: Plugin[] | undefined } & Handlers) {
  const isMobile = useAppShellMobile().isMobile;
  const columns = isMobile ? narrowColumns(handlers) : wideColumns(handlers);
  const data: Row[] =
    plugins?.map((plugin) => ({ id: plugin.id, item: plugin })) ?? placeholderRows;
  return <Table<Row> data={data} columns={columns} idKey="id" hasHover={!!plugins} />;
}
