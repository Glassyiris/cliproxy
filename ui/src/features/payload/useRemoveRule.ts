import { useEffect, useRef, useState, type RefObject } from "react";
import type { RemoveTarget } from "./RemoveRuleDialog.tsx";
import type { Group, Kind } from "./rules.ts";
import { entryLabel } from "./words.ts";

/**
 * Where focus goes once a removal has taken its row away: the rule that moved into its place, else
 * the last one of that kind, else the first rule anywhere. Null when none is left.
 */
function survivor(groups: Group[], at: { kind: Kind; index: number }) {
  const same = groups.find((g) => g.kind === at.kind);
  if (same?.entries.length) return `${at.kind}:${Math.min(at.index, same.entries.length - 1)}`;
  const other = groups.find((g) => g.entries.length);
  return other ? `${other.kind}:0` : null;
}

/**
 * Remove with a confirmation. Only a confirmed removal that the page accepted closes the dialog:
 * a second press while one is pending does nothing. A removed row takes focus with it, so focus
 * moves to `survivor`, or to the Add button when no rule is left.
 */
export function useRemoveRule({
  groups,
  busy,
  remove,
  addRef,
}: {
  groups: Group[] | undefined;
  busy: boolean;
  remove: (kind: Kind, index: number) => Promise<boolean>;
  addRef: RefObject<HTMLButtonElement | null>;
}) {
  const [target, setTarget] = useState<RemoveTarget | null>(null);
  const [removed, setRemoved] = useState<{ kind: Kind; index: number } | null>(null);
  // The dialog is a native modal: it hands focus back to the Remove button that opened it, which
  // is gone by now, so focus is moved only once it has closed.
  const dialogRef = useRef<HTMLDialogElement>(null);
  const focus = groups && removed ? survivor(groups, removed) : null;

  useEffect(() => {
    if (groups && removed && !focus) addRef.current?.focus();
  }, [groups, removed, focus, addRef]);

  return {
    dialogRef,
    target,
    focus,
    request: (kind: Kind, index: number) => {
      setRemoved(null);
      setTarget({
        kind,
        index,
        label: entryLabel(groups?.find((g) => g.kind === kind)?.entries[index]),
      });
    },
    confirm: async () => {
      if (!target || busy) return;
      const { kind, index } = target;
      const ok = await remove(kind, index);
      const dialog = dialogRef.current;
      setTarget(null);
      if (ok && dialog?.open)
        await new Promise((done) => dialog.addEventListener("close", done, { once: true }));
      if (ok) setRemoved({ kind, index });
    },
    close: () => setTarget(null),
  };
}
