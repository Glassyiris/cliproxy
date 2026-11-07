import { useState, type RefObject } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { t } from "../../lib/i18n.ts";

export type Confirmation = {
  title: string;
  description: string;
  action: string;
  destructive: boolean;
};

/**
 * A confirmation that names exactly what it will do. The last wording stays while the dialog
 * closes, and while the write is on its way the dialog stays open and busy.
 */
export function ConfirmDialog({
  dialogRef,
  confirmation,
  busy,
  onConfirm,
  onClose,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  confirmation: Confirmation | null;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [named, setNamed] = useState(confirmation);
  if (confirmation && confirmation !== named) setNamed(confirmation);
  return (
    <AlertDialog
      ref={dialogRef}
      isOpen={confirmation !== null}
      onOpenChange={(open) => !open && !busy && onClose()}
      title={named?.title ?? ""}
      description={named?.description ?? ""}
      actionLabel={named?.action ?? ""}
      actionVariant={named?.destructive ? "destructive" : "primary"}
      cancelLabel={t("plugins.dialog.cancel")}
      isActionLoading={busy}
      onAction={onConfirm}
    />
  );
}
