import { useMemo, useState } from "react";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { VStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Typeahead, createStaticSource, type SearchableItem } from "@astryxdesign/core/Typeahead";
import { FormDialog } from "../../components/FormDialog.tsx";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import {
  aliasProblems,
  channels,
  isChannel,
  newAlias,
  type Alias,
  type AliasProblems,
  type Channel,
} from "./modelConfig.ts";

const aliasMessage = (code: AliasProblems["alias"]) => {
  if (code === "required") return t("models.add.aliasRequired");
  if (code === "duplicate") return t("models.add.duplicate");
  if (code === "same") return t("models.add.same");
};

export const problem = (message: string | undefined) =>
  message ? ({ type: "error", message } as const) : undefined;

/** The family a rule is written to: aliases and exclusions are kept per family. */
export function FamilyField({
  value,
  onChange,
}: {
  value: Channel;
  onChange: (channel: Channel) => void;
}) {
  return (
    <Selector
      label={t("models.col.family")}
      value={value}
      options={channels.map((id) => ({ value: id, label: label(id) }))}
      onChange={(next) => isChannel(next) && onChange(next)}
    />
  );
}

export type DialogStart = { channel: Channel; model?: string };

type AliasForm = {
  start: DialogStart;
  aliasesOf: (channel: Channel) => Alias[];
  /** Writes the new list; true when it was stored. */
  add: (channel: Channel, alias: Alias) => Promise<boolean>;
  onClose: () => void;
};

function useAliasForm({ start, aliasesOf, add, onClose }: AliasForm) {
  const [channel, setChannel] = useState(start.channel);
  const [picked, setPicked] = useState<SearchableItem | null>(
    start.model ? { id: start.model, label: start.model } : null,
  );
  const [typed, setTyped] = useState("");
  const [alias, setAlias] = useState("");
  const [keep, setKeep] = useState(false);
  const [problems, setProblems] = useState<AliasProblems>({});
  const submit = async () => {
    // A model the catalog does not list can still be aliased, as the legacy datalist allowed.
    const name = (picked?.id ?? typed).trim();
    const found = aliasProblems(name, alias.trim(), aliasesOf(channel));
    setProblems(found);
    if (found.name || found.alias) return;
    if (await add(channel, newAlias(name, alias.trim(), keep))) onClose();
  };
  return {
    channel,
    picked,
    alias,
    keep,
    problems,
    submit,
    setKeep,
    setTyped,
    setChannel: (next: Channel) => {
      setChannel(next);
      setPicked(null);
    },
    pick: (item: SearchableItem | null) => {
      setPicked(item);
      setProblems((p) => ({ ...p, name: undefined }));
    },
    type: (value: string) => {
      setAlias(value);
      setProblems((p) => ({ ...p, alias: undefined }));
    },
  };
}

/** The add-alias form. Mounted only while open, so every opening starts from `start`. */
export function AddAliasDialog({
  modelsOf,
  busy,
  ...form
}: AliasForm & {
  /** A family's catalog IDs; empty when it is missing, so the field takes typed text. */
  modelsOf: (channel: Channel) => string[];
  busy: boolean;
}) {
  const f = useAliasForm(form);
  const models = modelsOf(f.channel);
  const source = useMemo(
    () => createStaticSource(models.map((id) => ({ id, label: id }))),
    [models],
  );
  const submit = f.submit;
  return (
    <FormDialog
      title={t("models.add.title")}
      submitLabel={t("models.add.submit")}
      busy={busy}
      onSubmit={() => void submit()}
      onClose={form.onClose}
    >
      <VStack gap={3}>
        <FamilyField value={f.channel} onChange={f.setChannel} />
        <Typeahead
          label={t("models.add.upstream")}
          searchSource={source}
          value={f.picked}
          onChange={f.pick}
          onChangeQuery={f.setTyped}
          hasEntriesOnFocus
          debounceMs={0}
          status={problem(f.problems.name && t("models.add.upstreamRequired"))}
        />
        <TextInput
          label={t("models.add.alias")}
          value={f.alias}
          onChange={f.type}
          onEnter={() => void submit()}
          status={problem(aliasMessage(f.problems.alias))}
        />
        <CheckboxInput label={t("models.add.keep")} value={f.keep} onChange={f.setKeep} />
      </VStack>
    </FormDialog>
  );
}
