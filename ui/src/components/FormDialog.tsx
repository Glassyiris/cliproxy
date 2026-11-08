import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { t } from "../lib/i18n.ts";

/** A dialog's title row; while a write is on its way the close control is busy instead. */
export function FormDialogHeader({
  title,
  subtitle,
  busy,
  busyLabel = t("app.dialog.closeWhileSaving"),
  onClose,
}: {
  title: string;
  subtitle?: ReactNode;
  busy: boolean;
  busyLabel?: string;
  onClose: () => void;
}) {
  if (!busy)
    return (
      <DialogHeader title={title} subtitle={subtitle} onOpenChange={(open) => !open && onClose()} />
    );
  return (
    <DialogHeader
      title={title}
      subtitle={subtitle}
      endContentEdgeCompensation="all"
      endContent={
        <Button
          variant="ghost"
          isIconOnly
          isLoading
          label={busyLabel}
          tooltip={busyLabel}
          icon={<Icon icon="close" color="inherit" />}
        />
      }
    />
  );
}

/**
 * A form in a dialog: title, the fields, and Cancel beside the primary action. A write cannot be
 * called back once sent, so while `busy` nothing closes it and both buttons show the busy state.
 */
export function FormDialog({
  title,
  submitLabel,
  busy,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const close = () => !busy && onClose();
  return (
    <Dialog isOpen onOpenChange={(open) => !open && close()} purpose="form">
      <Layout
        header={<FormDialogHeader title={title} busy={busy} onClose={close} />}
        content={<LayoutContent>{children}</LayoutContent>}
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button
                label={t("app.dialog.cancel")}
                variant="secondary"
                isLoading={busy}
                onClick={close}
              />
              <Button label={submitLabel} variant="primary" isLoading={busy} onClick={onSubmit} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
