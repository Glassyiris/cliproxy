import { useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import type { RuleRow } from "./modelConfig.ts";

type Asking = { row: RuleRow; done: (removed: boolean) => void };

/**
 * Removing a rule asks first. `ask` resolves true once the rule is removed, false when the
 * question is cancelled or the write fails; while the write is on its way the dialog stays busy.
 */
export function useRuleRemoval(busy: boolean, remove: (row: RuleRow) => Promise<boolean>) {
  const [asking, setAsking] = useState<Asking | null>(null);
  const [named, setNamed] = useState<RuleRow | null>(null);
  // The last rule stays named while the dialog closes.
  if (asking && asking.row !== named) setNamed(asking.row);
  const close = (removed: boolean) => {
    asking?.done(removed);
    setAsking(null);
  };
  const isAlias = named?.kind === "alias";
  const values = { alias: named?.alias ?? "", pattern: named?.pattern ?? "" };
  const family = named ? label(named.channel) : "";
  const dialog = (
    <AlertDialog
      isOpen={asking !== null}
      onOpenChange={(open) => !open && !busy && close(false)}
      title={
        isAlias ? t("models.remove.aliasTitle", values) : t("models.remove.excludedTitle", values)
      }
      description={
        isAlias
          ? t("models.remove.aliasDescription", { ...values, family })
          : t("models.remove.excludedDescription", { ...values, family })
      }
      actionLabel={isAlias ? t("models.remove.aliasAction") : t("models.remove.excludedAction")}
      cancelLabel={t("app.dialog.cancel")}
      isActionLoading={busy}
      onAction={async () => {
        if (!asking || busy) return;
        if (await remove(asking.row)) close(true);
      }}
    />
  );
  return {
    dialog,
    ask: (row: RuleRow) => new Promise<boolean>((done) => setAsking({ row, done })),
  };
}
