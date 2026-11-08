// Provider keys, from the table-grouped template: which upstream groups serve, and which key has a
// problem. The header holds the h1 with one line and the Add menu, the one primary action; the
// table groups the key groups by provider family; a group's keys open in the detail panel.
// Deviations from the template, each with its reason:
// - No PowerSearch and no grouping options: the families are the only grouping, and a server
//   holds a handful of groups, so the template's filters would filter nothing.
// - The Add button is a menu of families: a group is stored under its family, and the families
//   with no group yet are only reachable there (they have no header row to add from).
// - Group header rows are drawn by a row plugin on the data-driven Table, not hand-composed rows
//   with a styled colgroup (`style` is banned here; DESIGN.md "Not doing").
// - The detail is the shared detail panel (`roles.detailPanel`), as on Accounts, not the
//   template's own panel width.
import { useCallback, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Banner } from "@astryxdesign/core/Banner";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { PageFrame } from "../../app/PageFrame.tsx";
import { usePreferences } from "../../app/preferences.ts";
import { useApiKeyUsage, useConfig } from "../../app/serverQueries.ts";
import { useAction } from "../../app/useAction.ts";
import { useHashParams } from "../../app/useHashRoute.ts";
import { useListShape } from "../../components/listShape.ts";
import { ReadError } from "../../components/ReadError.tsx";
import { ApiError } from "../../lib/api/client.ts";
import { t } from "../../lib/i18n.ts";
import { roles } from "../../themes/site/roles.ts";
import { families, familyName, isFamily, type Family } from "../../components/keyFamilies.ts";
import { AddGroupDialog } from "./AddGroupDialog.tsx";
import { DeleteGroupDialog } from "./DeleteGroupDialog.tsx";
import { GroupPanel } from "./GroupPanel.tsx";
import { entriesOf, entryId, type Entry } from "./groups.ts";
import { ProviderTable, ProviderTableSkeleton } from "./ProviderTable.tsx";
import { useGroupWrites } from "./useGroupWrites.ts";

/** Every family's groups with their keys' traffic; undefined until the config is read. */
function useSections() {
  const config = useConfig();
  const usage = useApiKeyUsage({ poll: true });
  const { locale } = usePreferences();
  // A usage report kept from an earlier poll while the read is failing is stale: no traffic.
  const report = usage.isError ? undefined : usage.data;
  const sections = useMemo(
    () => config.data && entriesOf(config.data, report, (n) => t("providers.group.unnamed", { n })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locale changes what t() returns
    [config.data, report, locale],
  );
  return { config, usage, sections };
}

/** The family menu; the families with groups first, then the ones with none. */
function AddMenu({
  configured,
  onPick,
}: {
  configured: ReadonlySet<Family>;
  onPick: (family: Family) => void;
}) {
  const item = (f: Family) => ({ label: familyName(f), onClick: () => onPick(f) });
  const unused = families.filter((f) => !configured.has(f));
  return (
    <DropdownMenu
      button={{
        label: t("providers.page.add"),
        variant: roles.primaryAction.variant,
        icon: <Icon icon={Plus} size="sm" />,
      }}
      alignment="end"
      items={[
        ...(configured.size
          ? [
              {
                type: "section" as const,
                title: t("providers.add.configured"),
                items: families.filter((f) => configured.has(f)).map(item),
              },
            ]
          : []),
        ...(unused.length
          ? [
              {
                type: "section" as const,
                title: t("providers.add.unconfigured"),
                items: unused.map(item),
              },
            ]
          : []),
      ]}
    />
  );
}

/** The usage report failing leaves the groups listed without traffic; a server lacking it is a fact. */
function UsageNotice({ usage }: { usage: ReturnType<typeof useSections>["usage"] }) {
  if (!usage.isError) return null;
  if (usage.error instanceof ApiError && usage.error.notImplemented)
    return <Banner status="info" title={t("providers.usage.unavailable")} />;
  return (
    <ReadError
      error={usage.error}
      what={t("providers.usage.what")}
      retry={() => void usage.refetch()}
    />
  );
}

/** The open group, kept in the hash as `group=<family>:<index>`. */
function useOpenGroup(sections: [Family, Entry[]][] | undefined) {
  const [params, setParams] = useHashParams();
  const openId = params.group ?? "";
  const open = sections?.flatMap(([, list]) => list).find((e) => entryId(e) === openId);
  const go = useCallback(
    (entry: Entry | null) => setParams({ group: entry ? entryId(entry) : undefined }, "replace"),
    [setParams],
  );
  const onOpen = useCallback(
    (entry: Entry) => go(entryId(entry) === openId ? null : entry),
    [go, openId],
  );
  return { open, openId, go, onOpen };
}

/** The family whose add form is open, kept in the hash as `add=<family>` so Connect can open it. */
function useAdding() {
  const [params, setParams] = useHashParams();
  const adding = isFamily(params.add) ? params.add : null;
  const setAdding = useCallback(
    (family: Family | null) => setParams({ add: family ?? undefined }, "replace"),
    [setParams],
  );
  return [adding, setAdding] as const;
}

/** The families folded shut; every family starts open. */
function useCollapsed() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<Family>>(() => new Set());
  const toggle = useCallback(
    (f: Family) =>
      setCollapsed((s) => {
        const next = new Set(s);
        if (!next.delete(f)) next.add(f);
        return next;
      }),
    [],
  );
  return [collapsed, toggle] as const;
}

function Meta() {
  return (
    <Link href="#settings?section=advanced&key=api-keys" type="supporting">
      {t("providers.page.edit")}
      <Icon icon="chevronRight" size="sm" />
    </Link>
  );
}

function Dialogs({
  adding,
  onAdded,
  busy,
  writes,
  onDeleted,
}: {
  adding: Family | null;
  onAdded: () => void;
  busy: boolean;
  writes: ReturnType<typeof useGroupWrites>;
  onDeleted: () => void;
}) {
  return (
    <>
      {adding && (
        <AddGroupDialog
          family={adding}
          busy={busy}
          add={(group) => writes.add(adding, group)}
          onClose={onAdded}
        />
      )}
      <DeleteGroupDialog
        target={writes.deleting}
        busy={busy}
        onConfirm={() =>
          // Indexes shift after a delete, so the open group is closed rather than followed.
          void writes.confirmDelete().then((ok) => ok && onDeleted())
        }
        onClose={writes.cancelDelete}
      />
    </>
  );
}

export default function ProviderKeys() {
  const action = useAction();
  const { config, usage, sections } = useSections();
  const { open, openId, go, onOpen } = useOpenGroup(sections);
  const [adding, setAdding] = useAdding();
  const [collapsed, onToggleFamily] = useCollapsed();
  const [listRef, listShape] = useListShape();
  const { isMobile } = useAppShellMobile();
  const byFamily = useMemo(() => new Map(sections ?? []), [sections]);
  const configured = useMemo(() => new Set(byFamily.keys()), [byFamily]);
  const writes = useGroupWrites(
    action,
    (f) => (config.data ? (byFamily.get(f)?.map((e) => e.group) ?? []) : undefined),
    (f, i) => byFamily.get(f)?.[i]?.name ?? "",
    () => listRef.current?.querySelector<HTMLElement>("tbody tr[tabindex]")?.focus(),
  );
  const addMenu = sections && <AddMenu configured={configured} onPick={setAdding} />;
  const panel = open && {
    label: t("providers.panel.label", { name: open.name }),
    content: (
      <GroupPanel
        key={entryId(open)}
        entry={open}
        busy={action.busy}
        onAction={writes.press}
        onClose={() => go(null)}
      />
    ),
    onClose: () => go(null),
  };
  return (
    <PageFrame
      title={t("providers.page.title")}
      width="full"
      meta={<Meta />}
      actions={!!sections?.length && addMenu}
      panel={panel}
    >
      {config.isError && (
        <ReadError
          error={config.error}
          what={t("providers.page.what")}
          retry={() => void config.refetch()}
        />
      )}
      <UsageNotice usage={usage} />
      <VStack gap={0} ref={listRef}>
        {config.isPending && <ProviderTableSkeleton />}
        {sections?.length === 0 && (
          <EmptyState
            title={t("providers.empty.title")}
            headingLevel={roles.heading.section}
            actions={addMenu}
          />
        )}
        {!!sections?.length && (
          <ProviderTable
            sections={sections}
            collapsed={collapsed}
            onToggleFamily={onToggleFamily}
            openId={openId}
            onOpen={onOpen}
            trafficPending={usage.isPending}
            toggling={writes.toggling}
            onAction={writes.press}
            shape={isMobile ? "stacked" : listShape}
          />
        )}
      </VStack>
      <Dialogs
        adding={adding}
        onAdded={() => setAdding(null)}
        busy={action.busy}
        writes={writes}
        onDeleted={() => go(null)}
      />
    </PageFrame>
  );
}
