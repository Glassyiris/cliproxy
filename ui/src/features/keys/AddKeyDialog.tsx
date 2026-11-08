import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { FormDialog } from "../../components/FormDialog.tsx";
import { KeyField } from "../../components/KeyField.tsx";
import { newKey } from "../../lib/client-keys.ts";
import { t } from "../../lib/i18n.ts";

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

  const submit = async () => {
    const key = draft.trim();
    if (!key) return setError(t("keys.add.required"));
    if (keys.includes(key)) return setError(t("keys.add.duplicate"));
    if (await add(key)) onClose();
  };

  return (
    <FormDialog
      title={t("keys.add.title")}
      submitLabel={t("keys.add.submit")}
      busy={busy}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
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
    </FormDialog>
  );
}
