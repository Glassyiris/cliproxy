import { useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { t } from "../../lib/i18n.ts";

/** Names the resource without fetching its secret, including while the dialog closes. */
export function RevokeKeyDialog({
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
      title={t("keys.revoke.title", { key: named })}
      description={t("keys.revoke.description")}
      actionLabel={t("keys.revoke.action")}
      cancelLabel={t("app.dialog.cancel")}
      isActionLoading={busy}
      onAction={onConfirm}
    />
  );
}
