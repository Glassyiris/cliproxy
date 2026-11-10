import { useState } from "react";
import { useConfigWrite } from "../../app/serverQueries.ts";
import type { Action } from "../../app/useAction.ts";
import { t } from "../../lib/i18n.ts";
import type { Family } from "../../components/keyFamilies.ts";
import type { Group } from "./groups.ts";

type Write = ReturnType<typeof useConfigWrite>;

/** A press on a group's menu addresses its persisted identity, never its list position. */
export type GroupAction = { kind: "toggle" | "delete"; family: Family; id: string };

/**
 * What the delete confirmation showed when it opened: the family, its groups, the group's
 * persisted identity, and `write`, whose compare baseline is the config of that render. The delete writes
 * against this and nothing later, so a page that moved on underneath it makes the write refuse,
 * never hit another group.
 */
type DeleteSnapshot = {
  family: Family;
  write: Write;
  groups: Group[];
  id: string;
  name: string;
};

/**
 * The page's group writes replace `api-keys/<family>` with a server-checked precondition,
 * retaining each existing group's and nested key's `@id`. `groupsOf` reads a family's groups as shown;
 * `focusAfter` moves focus somewhere that still exists once the control that had it is gone. A
 * press while a write is pending is rejected before it touches any state.
 */
export function useGroupWrites(
  action: Action,
  groupsOf: (family: Family) => Group[] | undefined,
  nameOf: (family: Family, index: number) => string,
  focusAfter: () => void,
) {
  const write = useConfigWrite(action);
  const [deleting, setDeleting] = useState<DeleteSnapshot | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const toggle = async (family: Family, id: string, current: Group[]) => {
    const group = current.find((g) => g["@id"] === id);
    if (!group) return;
    const disabled = !group.disabled;
    setToggling(id);
    await write(
      `api-keys/${family}`,
      current.map((g) => (g["@id"] === id ? { ...g, disabled } : g)),
      disabled ? t("providers.toggle.disabled") : t("providers.toggle.enabled"),
    );
    setToggling(null);
  };

  return {
    /** The persisted group ID whose toggle is being written. */
    toggling: action.busy ? toggling : null,
    /** The name the open confirmation captured, null while it is closed. */
    deleting: deleting?.name ?? null,
    add: (family: Family, group: Group) =>
      write(`api-keys/${family}`, [...(groupsOf(family) ?? []), group], t("providers.add.added")),
    press: ({ kind, family, id }: GroupAction) => {
      const groups = groupsOf(family);
      if (action.busy || !groups || !id) return;
      const index = groups.findIndex((g) => g["@id"] === id);
      if (index < 0) return;
      if (kind === "delete")
        setDeleting({ family, write, groups, id, name: nameOf(family, index) });
      else void toggle(family, id, groups);
    },
    cancelDelete: () => setDeleting(null),
    confirmDelete: async () => {
      if (!deleting || action.busy) return;
      const ok = await deleting.write(
        `api-keys/${deleting.family}`,
        deleting.groups.filter((g) => g["@id"] !== deleting.id),
        t("providers.delete.deleted"),
      );
      if (ok) focusAfter();
      setDeleting(null);
      return ok;
    },
  };
}
