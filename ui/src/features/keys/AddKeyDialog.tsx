import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { KeyField } from "../../components/KeyField.tsx";
import { newKey } from "../../lib/client-keys.ts";
import { t } from "../../lib/i18n.ts";

/** The title row; while the write is on its way the close control is busy instead. */
function AddKeyHeader({ busy, onClose }: { busy: boolean; onClose: () => void }) {
  if (!busy) return <DialogHeader title={t("keys.add.title")} onOpenChange={() => onClose()} />;
  return (
    <DialogHeader
      title={t("keys.add.title")}
      endContentEdgeCompensation="all"
      endContent={
        <Button
          variant="ghost"
          isIconOnly
          isLoading
          label={t("keys.dialog.closeWhileSaving")}
          tooltip={t("keys.dialog.closeWhileSaving")}
          icon={<Icon icon="close" color="inherit" />}
        />
      }
    />
  );
}

/** The add-key form. Mounted only while open, so every opening starts empty. */
export function AddKeyDialog({
  keys,
  busy,
  add,
  onClose,
}: {
  keys: string[];
  busy: boolean;
  /** Writes the new list; true when it was stored. */
  add: (key: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  // A write cannot be called back once sent, so the dialog stays open until it ends.
  const close = () => !busy && onClose();

  const submit = async () => {
    const key = draft.trim();
    if (!key) return setError(t("keys.add.required"));
    if (keys.includes(key)) return setError(t("keys.add.duplicate"));
    if (await add(key)) onClose();
  };

  return (
    <Dialog isOpen onOpenChange={(open) => !open && close()} purpose="form">
      <Layout
        header={<AddKeyHeader busy={busy} onClose={close} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              <KeyField
                label={t("keys.add.field")}
                kind="new"
                secret={draft}
                failure={error}
                onChange={(value) => {
                  setDraft(value);
                  setError("");
                }}
                submit={() => void submit()}
              />
              <HStack>
                <Button
                  label={t("keys.add.generate")}
                  variant="secondary"
                  onClick={() => {
                    setDraft(newKey());
                    setError("");
                  }}
                />
              </HStack>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button
                label={t("keys.dialog.cancel")}
                variant="secondary"
                isLoading={busy}
                onClick={close}
              />
              <Button
                label={t("keys.add.submit")}
                variant="primary"
                isLoading={busy}
                onClick={() => void submit()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
