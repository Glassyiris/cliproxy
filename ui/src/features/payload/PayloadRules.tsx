// Payload rules tab, from the `table-grouped` template: which requests get changed, and how. The
// template's LayoutHeader is PageFrame's, with the search in its filter row; rules group by the
// model they match and a rule opens in the detail panel (a bottom sheet on phones).
// Deviations from the template:
// - No PowerSearch and no "View options" group-by popover: rules group by model only, and a plain
//   search over model names is the one filter the rules need.
// - No row menu: a rule has one action (Remove), so the row carries it as a ghost icon button.
// - Phones keep the table with two columns (pattern with its action and field count as a second
//   line, and Remove), as the Models tab does.
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Plus } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useHashParams } from "../../app/useHashRoute.ts";
import { ReadError } from "../../components/ReadError.tsx";
import { t } from "../../lib/i18n.ts";
import { roles } from "../../themes/site/roles.ts";
import { AddRuleDialog } from "./AddRuleDialog.tsx";
import { RemoveRuleDialog } from "./RemoveRuleDialog.tsx";
import { RulePanel } from "./RulePanel.tsx";
import { groupName, RuleTable, type RuleGroup } from "./RuleTable.tsx";
import { groupByModel, type Group } from "./rules.ts";
import { useRemoveRule } from "./useRemoveRule.ts";
import { editHref, useRules } from "./useRules.ts";

const search = (groups: RuleGroup[], query: string) => {
  const q = query.trim().toLowerCase();
  return q ? groups.filter((g) => groupName(g.name).toLowerCase().includes(q)) : groups;
};

function NotListBanners({ groups }: { groups: Group[] }) {
  return groups
    .filter((g) => g.notList)
    .map((g) => (
      <Banner
        key={g.kind}
        status="warning"
        title={t("payload.group.storedNotList", { kind: g.kind })}
        endContent={<Link href={editHref}>{t("payload.page.editLink")}</Link>}
      />
    ));
}

/** The tab's state: hash keys (search, open rule), the rules grouped by model, the removal. */
function usePayloadPage(addRef: RefObject<HTMLButtonElement | null>) {
  const [params, setParams] = useHashParams();
  const rules = useRules();
  const { groups, change, action } = rules;
  const [adding, setAdding] = useState(false);
  const removal = useRemoveRule({
    groups,
    busy: action.busy,
    addRef,
    remove: async (kind, index) => {
      const ok = await change(
        kind,
        (e) => e.filter((_, n) => n !== index),
        t("payload.remove.removed"),
      );
      // Every later entry of the kind moves up one place, so the open key no longer names it.
      if (ok) setParams({ rule: undefined }, "replace");
      return ok;
    },
  });
  const byModel = groups && groupByModel(groups);
  const total = groups?.reduce((sum, g) => sum + g.entries.length, 0);
  return {
    ...rules,
    query: params.q ?? "",
    setQuery: (q: string | undefined) => setParams({ q }, "replace"),
    setOpen: (key: string | undefined) => setParams({ rule: key }, "push"),
    adding,
    setAdding,
    removal,
    byModel,
    shown: byModel && search(byModel, params.q ?? ""),
    total,
    open: byModel?.flatMap((g) => g.rows).find((row) => row.key === params.rule),
    hasRules: !!total || !!groups?.some((g) => g.notList),
  };
}

type Page = ReturnType<typeof usePayloadPage>;

/** Read error, stored values that are not lists, the empty states, then the grouped table. */
function Body({ page, addButton }: { page: Page; addButton: ReactNode }) {
  const { config, groups, shown, hasRules, open, removal } = page;
  return (
    <>
      <Text type={roles.textType.supporting} color="secondary">
        {t("payload.page.intro")} <Link href={editHref}>{t("payload.page.editLink")}</Link>
      </Text>
      {config.isError && (
        <ReadError
          error={config.error}
          what={t("payload.page.what")}
          retry={() => void config.refetch()}
        />
      )}
      {groups && <NotListBanners groups={groups} />}
      {groups && !hasRules && (
        <EmptyState
          title={t("payload.empty.title")}
          description={t("payload.empty.description")}
          headingLevel={roles.heading.section}
          actions={addButton}
        />
      )}
      {shown && hasRules && !shown.length && (
        <EmptyState
          title={t("payload.empty.noMatch")}
          headingLevel={roles.heading.section}
          actions={
            <Button
              label={t("payload.empty.clear")}
              variant="secondary"
              onClick={() => page.setQuery(undefined)}
            />
          }
        />
      )}
      {(config.isPending || !!shown?.length) && (
        <RuleTable
          groups={shown}
          openKey={open?.key}
          focus={removal.focus}
          onOpen={(row) => page.setOpen(row.key)}
          onRemove={(row) => removal.request(row.kind, row.index)}
        />
      )}
    </>
  );
}

const panelOf = (page: Page) => {
  const { open, removal } = page;
  if (!open) return undefined;
  const onClose = () => page.setOpen(undefined);
  return {
    label: t("payload.panel.label"),
    content: (
      <RulePanel
        row={open}
        onRemove={() => removal.request(open.kind, open.index)}
        onClose={onClose}
      />
    ),
    onClose,
  };
};

export default function PayloadRules() {
  const addRef = useRef<HTMLButtonElement>(null);
  const page = usePayloadPage(addRef);
  const { groups, action, change, removal, byModel, hasRules } = page;
  const addButton = (
    <Button
      ref={addRef}
      label={t("payload.page.add")}
      variant={roles.primaryAction.variant}
      icon={<Icon icon={Plus} />}
      onClick={() => page.setAdding(true)}
    />
  );

  return (
    <PageFrame
      title={t("payload.page.title")}
      width="full"
      meta={
        byModel && (
          <Text type={roles.textType.supporting} color="secondary">
            {t("payload.page.meta", { rules: page.total ?? 0, models: byModel.length })}
          </Text>
        )
      }
      actions={hasRules ? addButton : undefined}
      toolbar={
        (page.config.isPending || hasRules) && (
          <TextInput
            type="search"
            label={t("payload.page.search")}
            isLabelHidden
            placeholder={t("payload.page.search")}
            value={page.query}
            onChange={page.setQuery}
            startIcon={<Icon icon="search" size="sm" />}
            hasClear
          />
        )
      }
      panel={panelOf(page)}
    >
      <Body page={page} addButton={addButton} />
      {page.adding && groups && (
        <AddRuleDialog
          busy={action.busy}
          notList={groups.filter((g) => g.notList).map((g) => g.kind)}
          add={(kind, rule) =>
            change(kind, (entries) => [...entries, rule], t("payload.add.added"))
          }
          onClose={() => page.setAdding(false)}
        />
      )}
      <RemoveRuleDialog
        dialogRef={removal.dialogRef}
        target={removal.target}
        busy={action.busy}
        onConfirm={() => void removal.confirm()}
        onClose={removal.close}
      />
    </PageFrame>
  );
}
