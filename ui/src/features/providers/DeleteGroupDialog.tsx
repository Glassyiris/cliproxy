import { useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { t } from "../../lib/i18n.ts";

/**
 * Names the group, never its keys. The last group stays named while the dialog closes, and while
 * the deletion is on its way the dialog cannot be dismissed.
 */
export function DeleteGroupDialog({
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
      title={t("providers.delete.title", { name: named })}
      description={t("providers.delete.description")}
      actionLabel={t("providers.delete.action")}
      cancelLabel={t("providers.dialog.cancel")}
      isActionLoading={busy}
      onAction={onConfirm}
    />
  );
}
