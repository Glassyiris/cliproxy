import { useState } from "react";
import { useConfigWrite } from "../../app/serverQueries.ts";
import type { Action } from "../../app/useAction.ts";
import { t } from "../../lib/i18n.ts";
import type { Family, Group } from "./groups.ts";
import type { GroupAction } from "./ProviderTable.tsx";

/**
 * What the delete confirmation showed when it opened: the family, the group at `index` of
 * `groups`, and `stored`, the value the server held then. The delete writes against this and
 * nothing later, so a page that moved on underneath it makes the write refuse, never hit another
 * group.
 */
type DeleteSnapshot = {
  family: Family;
  stored: unknown;
  groups: Group[];
  index: number;
  name: string;
};

/**
 * The page's group writes, each replacing `api-keys/<family>` through one reread-and-compare, and
 * the state of the controls that start them. `stored` is the value as the server holds it;
 * `focusAfter` moves focus somewhere that still exists once the control that had it is gone. A
 * press while a write is pending is rejected before it touches any state.
 */
export function useGroupWrites(
  action: Action,
  family: Family,
  stored: unknown,
  groups: Group[] | undefined,
  names: string[],
  focusAfter: () => void,
) {
  const write = useConfigWrite(action);
  const [deleting, setDeleting] = useState<DeleteSnapshot | null>(null);
  const [toggling, setToggling] = useState<number | null>(null);

  const toggle = async (index: number, current: Group[]) => {
    const disabled = !current[index].disabled;
    setToggling(index);
    await write(
      `api-keys/${family}`,
      stored,
      current.map((g, i) => (i === index ? { ...g, disabled } : g)),
      disabled ? t("providers.toggle.disabled") : t("providers.toggle.enabled"),
    );
    setToggling(null);
  };

  return {
    /** The group whose toggle is being written. */
    toggling: action.busy ? toggling : null,
    /** The name the open confirmation captured, null while it is closed. */
    deleting: deleting?.name ?? null,
    add: async (group: Group) => {
      const ok = await write(
        `api-keys/${family}`,
        stored,
        [...(groups ?? []), group],
        t("providers.add.added"),
      );
      if (ok && !groups?.length) focusAfter();
      return ok;
    },
    press: ({ kind, index }: GroupAction) => {
      if (action.busy || !groups) return;
      if (kind === "delete") setDeleting({ family, stored, groups, index, name: names[index] });
      else void toggle(index, groups);
    },
    cancelDelete: () => setDeleting(null),
    confirmDelete: async () => {
      if (!deleting || action.busy) return;
      const ok = await write(
        `api-keys/${deleting.family}`,
        deleting.stored,
        deleting.groups.filter((_, i) => i !== deleting.index),
        t("providers.delete.deleted"),
      );
      if (ok) focusAfter();
      setDeleting(null);
    },
  };
}
