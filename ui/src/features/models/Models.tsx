// Models tab, from the `table-filter` template: which models a client can ask for, and where each
// goes. The template's LayoutHeader is PageFrame's: the search, the family filter and the view
// switch sit in it as the template's filter row; the detail docks at the end (a bottom sheet on
// phones). The catalog and its rules (aliases, exclusion patterns) are two views of one table.
// Deviations from the template:
// - No PowerSearch, saved views, selection, density switch or infinite batches: the catalog is
//   short and static; a plain search and one family filter answer the question, and long lists
//   page at 20 rows (DESIGN.md "Pages").
// - The view switch (Models / Rules) is a SegmentedControl in the filter row: a choice inside one
//   view, not a tab strip (the side nav switches between Models and Payload rules).
// - Phones keep the table with two columns (model with its family and status as a second line,
//   and the row menu) instead of the template's card list: the rows stay one pattern.
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Ban, Plus } from "lucide-react";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useHashParams } from "../../app/useHashRoute.ts";
import { ReadError } from "../../components/ReadError.tsx";
import { t } from "../../lib/i18n.ts";
import { roles } from "../../themes/site/roles.ts";
import { AddAliasDialog, type DialogStart } from "./AddAliasDialog.tsx";
import { CatalogTable, type ModelActions } from "./CatalogTable.tsx";
import { ExcludeDialog } from "./ExcludeDialog.tsx";
import { channels, isChannel, type Channel, type ModelRow, type RuleRow } from "./modelConfig.ts";
import { ModelPanel } from "./ModelPanel.tsx";
import { RulesTable } from "./RulesTable.tsx";
import { Toolbar, type View } from "./Toolbar.tsx";
import { useModelRows } from "./useModelRows.ts";
import { useModelSettings, type ModelSettings } from "./useModelSettings.ts";
import { useRuleRemoval } from "./useRuleRemoval.tsx";

type Dialog = { kind: "alias" | "exclude"; start: DialogStart };

/** The hash keys of this tab: filters, view, page and the open model, so Back restores them. */
function useModelParams() {
  const [params, setParams] = useHashParams();
  const family = isChannel(params.channel) ? params.channel : undefined;
  return {
    family,
    query: params.q ?? "",
    view: params.list === "rules" ? ("rules" as const) : ("models" as const),
    page: Number(params.page) || 1,
    openKey: params.model,
    // A new filter or view starts at its first page.
    set: (changes: Record<string, string | undefined>, mode: "push" | "replace" = "push") =>
      setParams({ page: undefined, ...changes }, mode),
    setPage: (page: number) => setParams({ page: page > 1 ? String(page) : undefined }, "push"),
    setOpen: (key: string | undefined) => setParams({ model: key }, "push"),
  };
}

const allowRow = (row: ModelRow, excluded: string[]): RuleRow => ({
  key: `${row.channel}/excluded`,
  channel: row.channel,
  kind: "excluded",
  index: excluded.indexOf(row.excludedBy ?? ""),
  pattern: row.excludedBy ?? "",
});

export default function Models() {
  const p = useModelParams();
  const settings = useModelSettings();
  const data = useModelRows(settings, p.family, p.query);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const removal = useRuleRemoval(settings.busy, settings.removeRule);
  const open = data.models?.find((row) => row.key === p.openKey);
  const start = (model?: ModelRow): DialogStart => ({
    channel: model?.channel ?? p.family ?? channels[0],
    model: model?.id,
  });
  const actions: ModelActions = {
    onAlias: (row) => setDialog({ kind: "alias", start: start(row) }),
    onExclude: (row) => setDialog({ kind: "exclude", start: start(row) }),
    onAllow: (row) => void removal.ask(allowRow(row, settings.excluded(row.channel) ?? [])),
  };
  const clear = () => p.set({ q: undefined, channel: undefined });
  const isFiltered = !!p.query || !!p.family;

  return (
    <PageFrame
      title={t("models.page.title")}
      width="full"
      meta={metaLine(p.view, data.models, data.rules)}
      actions={
        <HeaderActions
          addButton={addButton}
          onExclude={() => setDialog({ kind: "exclude", start: start() })}
          onAdd={() => setDialog({ kind: "alias", start: start() })}
        />
      }
      toolbar={
        <Toolbar
          query={p.query}
          family={p.family}
          view={p.view}
          onQuery={(q) => p.set({ q }, "replace")}
          onFamily={(family) => p.set({ channel: family, model: undefined })}
          onView={(view) => p.set({ list: view === "rules" ? view : undefined, model: undefined })}
        />
      }
      panel={p.view === "models" ? panelOf(open, actions, () => p.setOpen(undefined)) : undefined}
    >
      <ReadErrors settings={settings} data={data} view={p.view} />
      {p.view === "models" ? (
        <CatalogTable
          rows={data.models}
          isFiltered={isFiltered}
          page={p.page}
          openKey={open?.key}
          actions={actions}
          onOpen={(row) => p.setOpen(row.key)}
          onPage={p.setPage}
          onClear={clear}
        />
      ) : (
        <RulesTable
          rows={data.rules}
          isFiltered={isFiltered}
          page={p.page}
          fallback={addButton}
          onRemove={removal.ask}
          onPage={p.setPage}
          onClear={clear}
        />
      )}
      <Dialogs
        dialog={dialog}
        settings={settings}
        modelsOf={data.modelsOf}
        onClose={() => setDialog(null)}
      />
      {removal.dialog}
    </PageFrame>
  );
}

const panelOf = (open: ModelRow | undefined, actions: ModelActions, onClose: () => void) =>
  open && {
    label: t("models.panel.label", { model: open.id }),
    content: <ModelPanel row={open} actions={actions} onClose={onClose} />,
    onClose,
  };

/** A failed config read, and the families whose catalog could not be read, each with Retry. */
function ReadErrors({
  settings,
  data,
  view,
}: {
  settings: ModelSettings;
  data: ReturnType<typeof useModelRows>;
  view: View;
}) {
  return (
    <>
      {settings.config.isError && (
        <ReadError
          error={settings.config.error}
          what={t("models.read.config")}
          retry={() => void settings.config.refetch()}
        />
      )}
      {data.failed.length > 0 && view === "models" && (
        <ReadError
          error={data.failure}
          what={t("models.read.catalog", { families: data.failedNames })}
          retry={data.retry}
        />
      )}
    </>
  );
}

function HeaderActions({
  addButton,
  onExclude,
  onAdd,
}: {
  addButton: RefObject<HTMLButtonElement | null>;
  onExclude: () => void;
  onAdd: () => void;
}) {
  // On phones the secondary action is icon-only, so the title, its count line and both buttons
  // share one row whether or not the count has loaded.
  const isMobile = useAppShellMobile().isMobile;
  return (
    <>
      <Button
        label={t("models.page.exclude")}
        icon={<Icon icon={Ban} />}
        isIconOnly={isMobile}
        tooltip={isMobile ? t("models.page.exclude") : undefined}
        onClick={onExclude}
      />
      <Button
        ref={addButton}
        label={t("models.page.add")}
        variant={roles.primaryAction.variant}
        icon={<Icon icon={Plus} />}
        onClick={onAdd}
      />
    </>
  );
}

function Dialogs({
  dialog,
  settings,
  modelsOf,
  onClose,
}: {
  dialog: Dialog | null;
  settings: ModelSettings;
  modelsOf: (channel: Channel) => string[];
  onClose: () => void;
}): ReactNode {
  if (dialog?.kind === "alias")
    return (
      <AddAliasDialog
        start={dialog.start}
        modelsOf={modelsOf}
        aliasesOf={(channel) => settings.aliases(channel) ?? []}
        busy={settings.busy}
        add={settings.addAlias}
        onClose={onClose}
      />
    );
  if (dialog?.kind === "exclude")
    return (
      <ExcludeDialog
        start={dialog.start}
        excludedOf={(channel) => settings.excluded(channel) ?? []}
        busy={settings.busy}
        exclude={settings.exclude}
        onClose={onClose}
      />
    );
  return null;
}

/**
 * The one line under the title: what the view lists, counted once on the screen. Null while
 * loading, so PageFrame holds the line and nothing moves.
 */
function metaLine(view: View, models: ModelRow[] | undefined, rules: RuleRow[] | undefined) {
  if (view === "models" && models) {
    const excluded = models.filter((row) => row.excludedBy).length;
    return (
      <Text type={roles.textType.supporting} color="secondary">
        {t("models.page.meta", { count: models.length, excluded })}
      </Text>
    );
  }
  if (view === "rules" && rules) {
    const aliases = rules.filter((row) => row.kind === "alias").length;
    return (
      <Text type={roles.textType.supporting} color="secondary">
        {t("models.page.rulesMeta", { aliases, patterns: rules.length - aliases })}
      </Text>
    );
  }
  return null;
}
