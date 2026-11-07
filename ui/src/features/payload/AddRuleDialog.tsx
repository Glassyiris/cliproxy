import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter, HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Selector } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { t } from "../../lib/i18n.ts";
import { kindMeaning, paramsMessage } from "./words.ts";
import { kinds, parseParams, protocols, type Kind, type Rule } from "./rules.ts";

// Selector holds no empty value, so "Any protocol" has a name of its own.
const ANY = "any";

const kindOptions = () => kinds.map((k) => ({ value: k, label: k, description: kindMeaning(k) }));

const protocolOptions = () => [
  { value: ANY, label: t("payload.add.anyProtocol") },
  ...protocols.map((p) => ({ value: p, label: p })),
];

/** The kind picker; a kind whose stored value is not a list says so and points at Configuration. */
function KindField({
  kind,
  blocked,
  onChange,
}: {
  kind: Kind;
  blocked: boolean;
  onChange: (kind: Kind) => void;
}) {
  return (
    <VStack gap={1}>
      <Selector
        label={t("payload.add.kind")}
        value={kind}
        options={kindOptions()}
        status={blocked ? { type: "error", message: t("payload.group.storedNotList") } : undefined}
        onChange={(value) => onChange(value as Kind)}
      />
      {blocked && <Link href="#config">{t("payload.page.editLink")}</Link>}
    </VStack>
  );
}

function ValuesField({
  kind,
  value,
  error,
  onChange,
}: {
  kind: Kind;
  value: string;
  error: string;
  onChange: (value: string) => void;
}) {
  return (
    <TextArea
      label={kind === "filter" ? t("payload.add.valuesList") : t("payload.add.valuesObject")}
      value={value}
      rows={6}
      hasSpellCheck={false}
      status={error ? { type: "error", message: error } : undefined}
      onChange={onChange}
    />
  );
}

function Footer({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <LayoutFooter>
      <HStack gap={2} hAlign="end">
        <Button
          label={t("payload.add.cancel")}
          variant="secondary"
          isLoading={busy}
          onClick={onCancel}
        />
        <Button
          label={t("payload.add.submit")}
          variant="primary"
          isLoading={busy}
          onClick={onSubmit}
        />
      </HStack>
    </LayoutFooter>
  );
}

/** The add-rule form. Mounted only while open, so every opening starts from the defaults. */
export function AddRuleDialog({
  busy,
  notList,
  add,
  onClose,
}: {
  busy: boolean;
  /** Kinds whose stored value is not a list: a rule is never written over it. */
  notList: readonly Kind[];
  /** Writes the rule into its kind's list; true when it was stored. */
  add: (kind: Kind, rule: Rule) => Promise<boolean>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<Kind>("default");
  const [model, setModel] = useState("*");
  const [protocol, setProtocol] = useState(ANY);
  const [values, setValues] = useState("");
  const [modelError, setModelError] = useState("");
  const [valuesError, setValuesError] = useState("");
  // A write cannot be called back once sent, so the dialog stays open until it ends.
  const close = () => !busy && onClose();

  const submit = async () => {
    const name = model.trim();
    const parsed = parseParams(kind, values);
    if (notList.includes(kind)) return;
    setModelError(name ? "" : t("payload.add.modelRequired"));
    setValuesError("error" in parsed ? paramsMessage(parsed.error) : "");
    if (!name || "error" in parsed) return;
    const models = [protocol === ANY ? { name } : { name, protocol }];
    if (await add(kind, { models, params: parsed.value })) onClose();
  };

  return (
    <Dialog isOpen onOpenChange={(open) => !open && close()} purpose="form">
      <Layout
        header={<DialogHeader title={t("payload.add.title")} onOpenChange={() => close()} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              <KindField
                kind={kind}
                blocked={notList.includes(kind)}
                onChange={(value) => {
                  setKind(value);
                  setValuesError("");
                }}
              />
              <TextInput
                label={t("payload.add.model")}
                value={model}
                status={modelError ? { type: "error", message: modelError } : undefined}
                onChange={(value) => {
                  setModel(value);
                  setModelError("");
                }}
              />
              <Selector
                label={t("payload.add.protocol")}
                value={protocol}
                options={protocolOptions()}
                onChange={setProtocol}
              />
              <ValuesField
                kind={kind}
                value={values}
                error={valuesError}
                onChange={(value) => {
                  setValues(value);
                  setValuesError("");
                }}
              />
            </VStack>
          </LayoutContent>
        }
        footer={<Footer busy={busy} onCancel={close} onSubmit={() => void submit()} />}
      />
    </Dialog>
  );
}
