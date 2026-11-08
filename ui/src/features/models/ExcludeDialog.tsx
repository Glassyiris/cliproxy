import { useState } from "react";
import { VStack } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { FormDialog } from "../../components/FormDialog.tsx";
import { t } from "../../lib/i18n.ts";
import { FamilyField, problem, type DialogStart } from "./AddAliasDialog.tsx";
import { isExcluded, type Channel } from "./modelConfig.ts";

/** The exclusion form: a model ID or a `*` pattern. Mounted only while open. */
export function ExcludeDialog({
  start,
  excludedOf,
  busy,
  exclude,
  onClose,
}: {
  start: DialogStart;
  excludedOf: (channel: Channel) => string[];
  busy: boolean;
  /** Writes the new list; true when it was stored. */
  exclude: (channel: Channel, pattern: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [channel, setChannel] = useState(start.channel);
  const [draft, setDraft] = useState(start.model ?? "");
  const [error, setError] = useState("");
  const submit = async () => {
    const pattern = draft.trim();
    if (!pattern) return setError(t("models.exclude.required"));
    if (isExcluded(excludedOf(channel), pattern)) return setError(t("models.exclude.duplicate"));
    if (await exclude(channel, pattern)) onClose();
  };
  return (
    <FormDialog
      title={t("models.exclude.title")}
      submitLabel={t("models.exclude.submit")}
      busy={busy}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <VStack gap={3}>
        <FamilyField
          value={channel}
          onChange={(next) => {
            setChannel(next);
            setError("");
          }}
        />
        <TextInput
          label={t("models.exclude.field")}
          description={t("models.exclude.hint")}
          placeholder={t("models.exclude.placeholder")}
          value={draft}
          onChange={(value) => {
            setDraft(value);
            setError("");
          }}
          onEnter={() => void submit()}
          status={problem(error)}
        />
      </VStack>
    </FormDialog>
  );
}
