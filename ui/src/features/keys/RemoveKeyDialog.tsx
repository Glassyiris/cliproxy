import { useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { mask } from "../../lib/client-keys.ts";
import { t } from "../../lib/i18n.ts";

/**
 * Names the key by its masked form, so confirming never shows a secret. The last key stays named
 * while the dialog closes, and while the removal is on its way the dialog cannot be dismissed.
 */
export function RemoveKeyDialog({
  target,
  busy,
  onConfirm,
  onClose,
}: {
  target: string | null;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [named, setNamed] = useState(target ?? "");
  if (target !== null && target !== named) setNamed(target);
  return (
    <AlertDialog
      isOpen={target !== null}
      onOpenChange={(open) => !open && !busy && onClose()}
      title={t("keys.remove.title", { key: mask(named) })}
      description={t("keys.remove.description")}
      actionLabel={t("keys.remove.action")}
      cancelLabel={t("app.dialog.cancel")}
      isActionLoading={busy}
      onAction={onConfirm}
    />
  );
}
