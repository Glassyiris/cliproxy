// Provider keys, on the Accounts frame (table-inbox): which upstream key groups serve, and which
// key has a problem. Both pages list upstream credentials, so they share one design. The header holds the h1, the
// jump to Settings and the Add menu, the one primary action; the filter row holds the views, the
// family and status Selectors and the search, as on Accounts; a group opens in the detail panel
// (a bottom sheet on phones). Deviations from the template, each with its reason:
// - The views and filters are Accounts' (SegmentedControl and Selectors in the filter row, not a
//   TabList), for the reasons Accounts.tsx gives.
// - The Add button is a menu of families: a group is stored under its family, so the family comes
//   first.
// - No selection and no batch band: a write replaces one family's list (`useGroupWrites.ts`), so
//   a batch over several families would be several unrelated writes.
// - The detail is the shared detail panel (`roles.detailPanel`), as on Accounts.
import { useCallback, useMemo } from "react";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Banner } from "@astryxdesign/core/Banner";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { icons } from "../../components/icons.ts";
import { PageFrame } from "../../app/PageFrame.tsx";
import { usePreferences } from "../../app/preferences.ts";
import { useApiKeyUsage, useConfig } from "../../app/serverQueries.ts";
import { useAction } from "../../app/useAction.ts";
import { useHashParams } from "../../app/useHashRoute.ts";
import { families, familyName, isFamily, type Family } from "../../components/keyFamilies.ts";
import { useListShape, type ListShape } from "../../components/listShape.ts";
import { providerIcon } from "../../components/ProviderIcon.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { SettingsLink } from "../../components/SettingsLink.tsx";
import { ApiError } from "../../lib/api/client.ts";
import { t } from "../../lib/i18n.ts";
import { roles } from "../../themes/site/roles.ts";
import { AddGroupDialog } from "./AddGroupDialog.tsx";
import { DeleteGroupDialog } from "./DeleteGroupDialog.tsx";
import { FilterRow, ProviderList } from "./FilterRow.tsx";
import { GroupPanel } from "./GroupPanel.tsx";
import { entriesOf, entryId, type Entry } from "./groups.ts";
import { inScope, inView, isShow, showOf, type Filters } from "./list.ts";
import { useGroupWrites } from "./useGroupWrites.ts";
import { layout } from "../../themes/site/layout.ts";

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
  isDisabled,
}: {
  configured: ReadonlySet<Family>;
  onPick: (family: Family) => void;
  isDisabled: boolean;
}) {
  const item = (f: Family) => ({
    label: familyName(f),
    icon: providerIcon(f),
    onClick: () => onPick(f),
  });
  const unused = families.filter((f) => !configured.has(f));
  return (
    <DropdownMenu
      menuMaxHeight={layout.menuMaxHeight}
      button={{
        label: t("providers.page.add"),
        variant: roles.primaryAction.variant,
        icon: <Icon icon={icons.add} size="sm" />,
        isDisabled,
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

/**
 * The filters, the open group and the family being added, kept in the hash
 * (`#accounts?view=providers&provider=codex&list=all&show=failing&q=&group=<family>:<id>`,
 * `add=<family>` so Connect can open the add form). `list` is the inbox view, as on Accounts.
 */
function useHashState(entries: Entry[] | undefined) {
  const [params, setParams] = useHashParams();
  const filters: Filters = {
    provider: isFamily(params.provider) ? params.provider : "",
    view: params.list === "all" ? "all" : "needs",
    show: isShow(params.show) ? params.show : "",
    search: params.q ?? "",
  };
  const setFilters = (f: Partial<Filters>) =>
    setParams(
      {
        ...("provider" in f ? { provider: f.provider || undefined } : {}),
        ...(f.view ? { list: f.view === "all" ? "all" : undefined } : {}),
        ...("show" in f ? { show: f.show || undefined } : {}),
        ...("search" in f ? { q: f.search || undefined } : {}),
      },
      "replace",
    );
  const openId = params.group ?? "";
  const open = entries?.find((e) => entryId(e) === openId);
  const go = useCallback(
    (entry: Entry | null) => setParams({ group: entry ? entryId(entry) : undefined }, "replace"),
    [setParams],
  );
  const onOpen = useCallback(
    (entry: Entry) => go(entryId(entry) === openId ? null : entry),
    [go, openId],
  );
  const adding = isFamily(params.add) ? params.add : null;
  const setAdding = useCallback(
    (family: Family | null) => setParams({ add: family ?? undefined }, "replace"),
    [setParams],
  );
  return { filters, setFilters, open, openId, go, onOpen, adding, setAdding };
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

/** Everything the page reads and keeps, so the frame below only lays it out. */
function useProviderPage(listShape: ListShape, focusFirst: () => void) {
  const action = useAction();
  const { config, usage, sections } = useSections();
  const entries = useMemo(() => sections?.flatMap(([, list]) => list), [sections]);
  const hash = useHashState(entries);
  const { filters } = hash;
  const byFamily = useMemo(() => new Map(sections ?? []), [sections]);
  const configured = useMemo(() => new Set(byFamily.keys()), [byFamily]);
  const writes = useGroupWrites(
    action,
    (f) => (config.data ? (byFamily.get(f)?.map((e) => e.group) ?? []) : undefined),
    (f, i) => byFamily.get(f)?.[i]?.name ?? "",
    focusFirst,
  );
  const { provider, show, search, view } = filters;
  const scope = useMemo(
    () => inScope(entries ?? [], { provider, show, search }),
    [entries, provider, show, search],
  );
  const shown = useMemo(() => inView(scope, view), [scope, view]);
  const needs = scope.filter((e) => showOf(e) !== "ready").length;
  const { isMobile } = useAppShellMobile();
  const shape: ListShape = isMobile ? "stacked" : listShape;
  return {
    ...{ action, config, usage, entries, configured, writes, scope, shown, needs, isMobile, shape },
    ...hash,
  };
}

export type Page = ReturnType<typeof useProviderPage>;

export default function ProviderKeys() {
  const [listRef, listShape] = useListShape();
  const page = useProviderPage(listShape, () =>
    listRef.current?.querySelector<HTMLElement>("tbody tr[tabindex]")?.focus(),
  );
  const { config, usage, entries, open, go, writes, isMobile } = page;
  const addMenu = (
    <AddMenu configured={page.configured} onPick={page.setAdding} isDisabled={!entries} />
  );
  const panel = open && {
    label: t("providers.panel.label", { name: open.name }),
    content: (
      <GroupPanel
        key={entryId(open)}
        entry={open}
        busy={page.action.busy}
        toggling={writes.toggling === open.group["@id"]}
        onAction={writes.press}
        onClose={() => go(null)}
      />
    ),
    onClose: () => go(null),
  };
  // Drawn while the config loads too, so the rows land where the skeleton was.
  const band = (config.isPending || !!entries?.length) && <FilterRow page={page} />;
  return (
    <PageFrame
      title={t("providers.page.title")}
      width="full"
      actions={
        <>
          <SettingsLink />
          {/* The empty state carries Add itself, so the page keeps one primary action. Drawn,
              disabled, while the config loads, so the header does not grow when it arrives. */}
          {(config.isPending || !!entries?.length) && addMenu}
        </>
      }
      panel={panel}
      toolbar={!isMobile && band}
    >
      {config.isError && (
        <ReadError
          error={config.error}
          what={t("providers.page.what")}
          retry={() => void config.refetch()}
        />
      )}
      <UsageNotice usage={usage} />
      {isMobile && band}
      <VStack gap={0} ref={listRef}>
        <ProviderList page={page} addMenu={addMenu} />
      </VStack>
      <Dialogs
        adding={page.adding}
        onAdded={() => page.setAdding(null)}
        busy={page.action.busy}
        writes={writes}
        onDeleted={() => go(null)}
      />
    </PageFrame>
  );
}
