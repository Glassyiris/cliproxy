import { useState } from "react";
import { VStack } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { FormDialog } from "../../components/FormDialog.tsx";
import { KeyField } from "../../components/KeyField.tsx";
import { t } from "../../lib/i18n.ts";
import { formErrors, newGroup, type FormErrors, type Group } from "./groups.ts";

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
        hasAutoFocus
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
        hasAutoFocus={false}
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
    <FormDialog
      title={t("providers.add.title")}
      submitLabel={t("providers.add.submit")}
      busy={busy}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <Fields
        compat={compat}
        values={values}
        errors={errors}
        change={change}
        submit={() => void submit()}
      />
    </FormDialog>
  );
}
