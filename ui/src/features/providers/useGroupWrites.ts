import { useState } from "react";
import { useConfigWrite } from "../../app/serverQueries.ts";
import type { Action } from "../../app/useAction.ts";
import { t } from "../../lib/i18n.ts";
import type { Family } from "../../components/keyFamilies.ts";
import type { Group } from "./groups.ts";

type Write = ReturnType<typeof useConfigWrite>;

/** A press on a group's menu: the family it is stored under and its index there. */
export type GroupAction = { kind: "toggle" | "delete"; family: Family; index: number };

/**
 * What the delete confirmation showed when it opened: the family, its groups, the group at
 * `index`, and `write`, whose compare baseline is the config of that render. The delete writes
 * against this and nothing later, so a page that moved on underneath it makes the write refuse,
 * never hit another group.
 */
type DeleteSnapshot = {
  family: Family;
  write: Write;
  groups: Group[];
  index: number;
  name: string;
};

/**
 * The page's group writes, each replacing `api-keys/<family>` through one reread-and-compare, and
 * the state of the controls that start them. `groupsOf` reads a family's groups as shown;
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

  const toggle = async (family: Family, index: number, current: Group[]) => {
    const disabled = !current[index].disabled;
    setToggling(`${family}:${index}`);
    await write(
      `api-keys/${family}`,
      current.map((g, i) => (i === index ? { ...g, disabled } : g)),
      disabled ? t("providers.toggle.disabled") : t("providers.toggle.enabled"),
    );
    setToggling(null);
  };

  return {
    /** The group (`<family>:<index>`) whose toggle is being written. */
    toggling: action.busy ? toggling : null,
    /** The name the open confirmation captured, null while it is closed. */
    deleting: deleting?.name ?? null,
    add: (family: Family, group: Group) =>
      write(`api-keys/${family}`, [...(groupsOf(family) ?? []), group], t("providers.add.added")),
    press: ({ kind, family, index }: GroupAction) => {
      const groups = groupsOf(family);
      if (action.busy || !groups) return;
      if (kind === "delete")
        setDeleting({ family, write, groups, index, name: nameOf(family, index) });
      else void toggle(family, index, groups);
    },
    cancelDelete: () => setDeleting(null),
    confirmDelete: async () => {
      if (!deleting || action.busy) return;
      const ok = await deleting.write(
        `api-keys/${deleting.family}`,
        deleting.groups.filter((_, i) => i !== deleting.index),
        t("providers.delete.deleted"),
      );
      if (ok) focusAfter();
      setDeleting(null);
      return ok;
    },
  };
}
