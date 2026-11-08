import { useState, type RefObject } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { t } from "../../lib/i18n.ts";
import type { Kind } from "./rules.ts";

export type RemoveTarget = { kind: Kind; index: number; confirmed: unknown; label: string };

/**
 * Names the rule by its kind and models. The last rule stays named while the dialog closes, and
 * while the removal is on its way the dialog stays open and busy.
 */
export function RemoveRuleDialog({
  dialogRef,
  target,
  busy,
  onConfirm,
  onClose,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  target: RemoveTarget | null;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [named, setNamed] = useState(target);
  if (target && target !== named) setNamed(target);
  return (
    <AlertDialog
      ref={dialogRef}
      isOpen={target !== null}
      onOpenChange={(open) => !open && !busy && onClose()}
      title={t("payload.remove.title", { kind: named?.kind ?? "" })}
      description={t("payload.remove.description", { models: named?.label ?? "" })}
      actionLabel={t("payload.remove.action")}
      cancelLabel={t("app.dialog.cancel")}
      isActionLoading={busy}
      onAction={onConfirm}
    />
  );
}
