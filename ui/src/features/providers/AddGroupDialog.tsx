import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { KeyField } from "../../components/KeyField.tsx";
import { t } from "../../lib/i18n.ts";
import { formErrors, newGroup, type FormErrors, type Group } from "./groups.ts";

/** The title row; while the write is on its way the close control is busy instead. */
function Header({ busy, onClose }: { busy: boolean; onClose: () => void }) {
  if (!busy)
    return <DialogHeader title={t("providers.add.title")} onOpenChange={() => onClose()} />;
  return (
    <DialogHeader
      title={t("providers.add.title")}
      endContentEdgeCompensation="all"
      endContent={
        <Button
          variant="ghost"
          isIconOnly
          isLoading
          label={t("providers.dialog.closeWhileSaving")}
          tooltip={t("providers.dialog.closeWhileSaving")}
          icon={<Icon icon="close" color="inherit" />}
        />
      }
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
          label={t("providers.dialog.cancel")}
          variant="secondary"
          isLoading={busy}
          onClick={onCancel}
        />
        <Button
          label={t("providers.add.submit")}
          variant="primary"
          isLoading={busy}
          onClick={onSubmit}
        />
      </HStack>
    </LayoutFooter>
  );
}

const urlMessage = {
  required: () => t("providers.add.urlRequired"),
  invalid: () => t("providers.add.urlInvalid"),
};

type Values = { name: string; baseUrl: string; key: string };

const status = (message?: string) => (message ? { type: "error" as const, message } : undefined);

function Fields({
  compat,
  values,
  errors,
  change,
  submit,
}: {
  compat: boolean;
  values: Values;
  errors: FormErrors;
  change: (field: keyof Values) => (value: string) => void;
  submit: () => void;
}) {
  return (
    <VStack gap={3}>
      <TextInput
        label={t("providers.add.name")}
        size="lg"
        isRequired
        value={values.name}
        onChange={change("name")}
        onEnter={submit}
        autoComplete="off"
        status={status(errors.name && t("providers.add.nameRequired"))}
      />
      <TextInput
        label={t("providers.add.baseUrl")}
        size="lg"
        isRequired={compat}
        isOptional={!compat}
        type="url"
        placeholder={compat ? t("providers.add.urlPlaceholder") : t("providers.add.urlDefault")}
        value={values.baseUrl}
        onChange={change("baseUrl")}
        onEnter={submit}
        autoComplete="off"
        status={status(errors.baseUrl && urlMessage[errors.baseUrl]())}
      />
      <KeyField
        label={t("providers.add.key")}
        kind="new"
        secret={values.key}
        failure={errors.key ? t("providers.add.keyRequired") : ""}
        onChange={change("key")}
        submit={submit}
      />
    </VStack>
  );
}

/** The add-group form. Mounted only while open, so every opening starts empty. */
export function AddGroupDialog({
  compat,
  busy,
  add,
  onClose,
}: {
  /** An OpenAI-compatible group has no default endpoint, so its base URL is required. */
  compat: boolean;
  busy: boolean;
  /** Writes the new list; true when it was stored. */
  add: (group: Group) => Promise<boolean>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Values>({ name: "", baseUrl: "", key: "" });
  const [errors, setErrors] = useState<FormErrors>({});
  // A write cannot be called back once sent, so the dialog stays open until it ends.
  const close = () => !busy && onClose();
  const change = (field: keyof Values) => (value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
  };

  const submit = async () => {
    if (busy) return;
    const fields = {
      name: values.name.trim(),
      baseUrl: values.baseUrl.trim(),
      key: values.key.trim(),
    };
    const found = formErrors(fields, compat);
    setErrors(found);
    if (Object.keys(found).length) return;
    if (await add(newGroup(fields.name, fields.baseUrl, fields.key))) onClose();
  };

  return (
    <Dialog isOpen onOpenChange={(open) => !open && close()} purpose="form">
      <Layout
        header={<Header busy={busy} onClose={close} />}
        content={
          <LayoutContent>
            <Fields
              compat={compat}
              values={values}
              errors={errors}
              change={change}
              submit={() => void submit()}
            />
          </LayoutContent>
        }
        footer={<Footer busy={busy} onCancel={close} onSubmit={() => void submit()} />}
      />
    </Dialog>
  );
}
