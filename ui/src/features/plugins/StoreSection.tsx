import { useEffect, useRef } from "react";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { proportional, Table, type TableColumn } from "@astryxdesign/core/Table";
import { Heading, Text } from "@astryxdesign/core/Text";
import { loadingCell, placeholderRows, type LoadingRow } from "../../components/loadingRows.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import type { PluginStore, StorePlugin } from "../../lib/api/plugins.ts";
import { t } from "../../lib/i18n.ts";
import { plainText, pluginName } from "./rows.ts";

const verb = (p: StorePlugin) =>
  p.installed
    ? p.update_available
      ? t("plugins.store.update")
      : t("plugins.store.reinstall")
    : t("plugins.store.install");

type Row = LoadingRow<StorePlugin>;

type Install = (plugin: StorePlugin, verb: string) => void;

const cell = loadingCell<StorePlugin>;

const Name = ({ plugin }: { plugin: StorePlugin }) => (
  <Text type="body" weight="semibold">
    {pluginName(plugin)}
  </Text>
);

const Version = ({ plugin }: { plugin: StorePlugin }) => <Code>{plainText(plugin.version)}</Code>;

const Description = ({ plugin }: { plugin: StorePlugin }) => (
  <Text type="supporting" color="secondary">
    {plainText(plugin.description)}
  </Text>
);

const installColumn = (onInstall: Install): TableColumn<Row> => ({
  key: "actions",
  header: t("plugins.table.actions"),
  align: "end",
  renderCell: cell((p) => (
    <Button
      label={t("plugins.store.verbNamed", { verb: verb(p), name: pluginName(p) })}
      variant="secondary"
      size="sm"
      onClick={() => onInstall(p, verb(p))}
    >
      {verb(p)}
    </Button>
  )),
});

const wideColumns = (onInstall: Install): TableColumn<Row>[] => [
  { key: "name", header: t("plugins.table.name"), renderCell: cell((p) => <Name plugin={p} />) },
  {
    key: "version",
    header: t("plugins.table.version"),
    renderCell: cell((p) => <Version plugin={p} />),
  },
  {
    key: "description",
    header: t("plugins.table.description"),
    renderCell: cell((p) => <Description plugin={p} />),
  },
  installColumn(onInstall),
];

// On a phone name, version and description stack in one column, so the button keeps its own.
const narrowColumns = (onInstall: Install): TableColumn<Row>[] => [
  {
    key: "name",
    header: t("plugins.table.name"),
    width: proportional(2),
    renderCell: cell((p) => (
      <VStack gap={1}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Name plugin={p} />
          <Version plugin={p} />
        </HStack>
        <Description plugin={p} />
      </VStack>
    )),
  },
  installColumn(onInstall),
];

function StoreTable({
  plugins,
  onInstall,
}: {
  plugins: StorePlugin[] | undefined;
  onInstall: Install;
}) {
  const isMobile = useAppShellMobile().isMobile;
  const columns = isMobile ? narrowColumns(onInstall) : wideColumns(onInstall);
  const data: Row[] =
    plugins?.map((plugin) => ({ id: plugin.store_id, item: plugin })) ?? placeholderRows;
  return <Table<Row> data={data} columns={columns} idKey="id" hasHover={!!plugins} />;
}

/** The store under the installed list: loading, the sources that failed, then what they offer. */
export function StoreSection({
  store,
  error,
  reveal,
  retry,
  onInstall,
}: {
  /** Undefined while the store loads. */
  store: PluginStore | undefined;
  error: unknown;
  /** Changes with each Browse press: the section scrolls into view and takes focus. */
  reveal: number;
  retry: () => void;
  onInstall: Install;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const el = heading.current;
    if (!reveal || !el) return;
    // A heading is a reading position, not a control: no focus ring around it.
    el.tabIndex = -1;
    el.scrollIntoView({ block: "start" });
    el.focus({ focusVisible: false, preventScroll: true });
  }, [reveal]);
  return (
    <VStack gap={3}>
      <Heading ref={heading} level={2}>
        {t("plugins.store.heading")}
      </Heading>
      {error ? (
        <ReadError error={error} what={t("plugins.store.what")} retry={retry} />
      ) : (
        <>
          {store?.source_errors?.map((e) => (
            <Banner
              key={e.source_id}
              status="error"
              title={t("plugins.store.sourceFailed", { source: plainText(e.source_name) })}
              description={plainText(e.message)}
            />
          ))}
          {store && store.plugins.length === 0 ? (
            <EmptyState title={t("plugins.store.empty")} headingLevel={3} isCompact />
          ) : (
            <StoreTable plugins={store?.plugins} onInstall={onInstall} />
          )}
        </>
      )}
    </VStack>
  );
}
