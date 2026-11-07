import { useMemo, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Typeahead, createStaticSource, type SearchableItem } from "@astryxdesign/core/Typeahead";
import { t } from "../../lib/i18n.ts";
import { aliasProblems, newAlias, type Alias, type AliasProblems } from "./modelConfig.ts";

function AliasFooter({
  busy,
  cancel,
  submit,
}: {
  busy: boolean;
  cancel: () => void;
  submit: () => void;
}) {
  return (
    <LayoutFooter>
      <HStack gap={2} hAlign="end">
        <Button
          label={t("models.add.cancel")}
          variant="secondary"
          isLoading={busy}
          onClick={cancel}
        />
        <Button
          label={t("models.add.submit")}
          variant="primary"
          isLoading={busy}
          onClick={submit}
        />
      </HStack>
    </LayoutFooter>
  );
}

const aliasMessage = (code: AliasProblems["alias"]) => {
  if (code === "required") return t("models.add.aliasRequired");
  if (code === "duplicate") return t("models.add.duplicate");
  if (code === "same") return t("models.add.same");
};

const problem = (message: string | undefined) =>
  message ? ({ type: "error", message } as const) : undefined;

/** The add-alias form. Mounted only while open, so every opening starts empty. */
export function AddAliasDialog({
  models,
  aliases,
  busy,
  add,
  onClose,
}: {
  /** The catalog's model ids; empty when the catalog is missing, so the field takes typed text. */
  models: string[];
  aliases: Alias[];
  busy: boolean;
  /** Writes the new list; true when it was stored. */
  add: (alias: Alias) => Promise<boolean>;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<SearchableItem | null>(null);
  const [typed, setTyped] = useState("");
  const [alias, setAlias] = useState("");
  const [keep, setKeep] = useState(false);
  const [problems, setProblems] = useState<AliasProblems>({});
  const source = useMemo(
    () => createStaticSource(models.map((id) => ({ id, label: id }))),
    [models],
  );
  // A write cannot be called back once sent, so the dialog stays open until it ends.
  const close = () => !busy && onClose();

  const submit = async () => {
    // A model the catalog does not list can still be aliased, as the legacy datalist allowed.
    const name = (picked?.id ?? typed).trim();
    const found = aliasProblems(name, alias.trim(), aliases);
    setProblems(found);
    if (found.name || found.alias) return;
    if (await add(newAlias(name, alias.trim(), keep))) onClose();
  };

  return (
    <Dialog isOpen onOpenChange={(open) => !open && close()} purpose="form">
      <Layout
        header={<DialogHeader title={t("models.add.title")} onOpenChange={() => close()} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              <Typeahead
                label={t("models.add.upstream")}
                searchSource={source}
                value={picked}
                onChange={(item) => {
                  setPicked(item);
                  setProblems((p) => ({ ...p, name: undefined }));
                }}
                onChangeQuery={setTyped}
                hasEntriesOnFocus
                debounceMs={0}
                status={problem(problems.name && t("models.add.upstreamRequired"))}
              />
              <TextInput
                label={t("models.add.alias")}
                value={alias}
                onChange={(value) => {
                  setAlias(value);
                  setProblems((p) => ({ ...p, alias: undefined }));
                }}
                onEnter={() => void submit()}
                status={problem(aliasMessage(problems.alias))}
              />
              <CheckboxInput
                label={t("models.add.keep")}
                description={t("models.add.keepDescription")}
                value={keep}
                onChange={setKeep}
              />
            </VStack>
          </LayoutContent>
        }
        footer={<AliasFooter busy={busy} cancel={close} submit={() => void submit()} />}
      />
    </Dialog>
  );
}
