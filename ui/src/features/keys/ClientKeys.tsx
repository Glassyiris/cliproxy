// Client keys, on the `table-page` template in its minimal form: one flat table of uniform rows
// under the page's title and its actions. Deviations from the template, one per line:
// - The masthead is PageFrame's LayoutHeader, not a scrolling VStack: every route keeps its h1 in
//   the one frame (DESIGN.md "Pages").
// - No search, scope toggle, column filters, sorting, totals or record facts: a server holds a
//   handful of keys and the API gives a key no field to sort or filter by.
// - No name, created, last-used or request columns, and no Rename: the server stores client keys as
//   a plain list of strings (config `access/api-keys`) and counts usage per upstream key only.
// - Row dividers stay on (Table's default `rows`), not the template's `none`: lists are flat with
//   hairline dividers (DESIGN.md "Pages").
// - The empty state has the add action and no warning banner: Overview's attention card already
//   says when no key exists and links here.
import { useState, type ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { icons } from "../../components/icons.ts";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useConfig, useConfigWrite } from "../../app/serverQueries.ts";
import { useAction } from "../../app/useAction.ts";
import { useHashParams } from "../../app/useHashRoute.ts";
import { ReadError } from "../../components/ReadError.tsx";
import { readPath } from "../../lib/configPath.ts";
import { t } from "../../lib/i18n.ts";
import { roles } from "../../themes/site/roles.ts";
import { AddKeyDialog } from "./AddKeyDialog.tsx";
import { KeyTable } from "./KeyTable.tsx";
import { RevokeKeyDialog } from "./RevokeKeyDialog.tsx";

const KEYS_PATH = "access/api-keys";

/**
 * Add key unless the list is known to be empty (the empty state has it); Use with a tool always: it
 * can create one. While loading it shows, as the table does, so a phone header does not wrap later.
 */
function HeaderActions({
  showAdd,
  onUse,
  add,
}: {
  showAdd: boolean;
  onUse: () => void;
  add: ReactNode;
}) {
  return (
    <>
      <Button
        label={t("app.nav.use")}
        variant="secondary"
        icon={<Icon icon={icons.use} />}
        onClick={onUse}
      />
      {showAdd && add}
    </>
  );
}

/** Opens "Use with a tool" over the page, with a key row's own key when given its position. */
function useOpenUse() {
  const [, setParams] = useHashParams();
  return (index?: number) =>
    setParams({ open: "use", key: index === undefined ? undefined : String(index) }, "push");
}

/** The add-key dialog is `?open=new`, so Overview's first run can open it from another page. */
function useAdding() {
  const [params, setParams] = useHashParams();
  return [
    params.open === "new",
    (open: boolean) => setParams({ open: open ? "new" : undefined }, "push"),
  ] as const;
}

export default function ClientKeys() {
  const config = useConfig();
  const action = useAction();
  const write = useConfigWrite(action);
  const [adding, setAdding] = useAdding();
  const [revoking, setRevoking] = useState<string | null>(null);
  // A key the file lacks and an explicit null both show as no keys.
  const keys = config.data ? (readPath(config.data, KEYS_PATH, []) as string[]) : undefined;
  const hasKeys = !!keys?.length;
  const openUse = useOpenUse();
  const addButton = (
    <Button
      label={t("keys.page.add")}
      variant={roles.primaryAction.variant}
      icon={<Icon icon={icons.add} />}
      onClick={() => setAdding(true)}
    />
  );

  const revoke = async () => {
    if (keys && revoking !== null)
      await write(
        KEYS_PATH,
        keys.filter((k) => k !== revoking),
        t("keys.revoke.revoked"),
      );
    setRevoking(null);
  };

  return (
    <PageFrame
      title={t("keys.page.title")}
      width="full"
      actions={
        <HeaderActions
          showAdd={config.isPending || hasKeys}
          onUse={() => openUse()}
          add={addButton}
        />
      }
    >
      {config.isError && (
        <ReadError
          error={config.error}
          what={t("keys.page.what")}
          retry={() => void config.refetch()}
        />
      )}
      {keys?.length === 0 && (
        <EmptyState
          icon={<Icon icon={icons.clientKeys} size="lg" />}
          title={t("keys.empty.title")}
          headingLevel={roles.heading.section}
          actions={addButton}
        />
      )}
      {(config.isPending || hasKeys) && (
        <KeyTable keys={keys} onUse={openUse} onRevoke={setRevoking} />
      )}
      {adding && keys && (
        <AddKeyDialog
          keys={keys}
          busy={action.busy}
          add={(key) => write(KEYS_PATH, [...keys, key], t("keys.add.added"))}
          onClose={() => setAdding(false)}
        />
      )}
      <RevokeKeyDialog
        target={revoking}
        busy={action.busy}
        onConfirm={() => void revoke()}
        onClose={() => setRevoking(null)}
      />
    </PageFrame>
  );
}
