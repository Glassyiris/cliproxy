import { useRef, useState } from "react";
import type { Plugin, StorePlugin } from "../../lib/api/plugins.ts";
import { t } from "../../lib/i18n.ts";
import type { Confirmation } from "./ConfirmDialog.tsx";
import { pluginName } from "./rows.ts";

/** A confirmation and what it does: `then` runs once a successful run's dialog has closed. */
export type Ask = Confirmation & { run: () => Promise<boolean>; then?: () => void };

export const deleteAsk = (
  p: Plugin,
  remove: (id: string) => Promise<boolean>,
  then: () => void,
): Ask => ({
  title: t("plugins.delete.title"),
  description: t("plugins.delete.description", { id: p.id }),
  action: t("plugins.delete.action"),
  destructive: true,
  run: () => remove(p.id),
  then,
});

export const installAsk = (
  p: StorePlugin,
  verb: string,
  install: (p: StorePlugin) => Promise<boolean>,
): Ask => ({
  title: t("plugins.store.confirmTitle", { verb, name: pluginName(p) }),
  description: t("plugins.store.confirmDescription"),
  action: verb,
  destructive: false,
  run: () => install(p),
});

/**
 * One confirmation at a time. Only a confirmed run the page accepted closes the dialog: a second
 * press while one is pending does nothing, and so does opening one. The dialog is a native modal that hands focus back to
 * the control that opened it, which is gone after a delete, so `then` runs once it has closed.
 */
export function useConfirmation(busy: boolean) {
  const [asking, setAsking] = useState<Ask | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  return {
    asking,
    dialogRef,
    ask: (next: Ask) => {
      if (!busy) setAsking(next);
    },
    close: () => setAsking(null),
    confirm: async () => {
      if (!asking || busy) return;
      const ok = await asking.run();
      const dialog = dialogRef.current;
      setAsking(null);
      if (!ok || !asking.then) return;
      if (dialog?.open)
        await new Promise((done) => dialog.addEventListener("close", done, { once: true }));
      asking.then();
    },
  };
}
