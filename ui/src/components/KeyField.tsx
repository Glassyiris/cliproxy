import { useState, type RefObject } from "react";
import { Eye } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { InputGroup } from "@astryxdesign/core/InputGroup";
import { TextInput } from "@astryxdesign/core/TextInput";
import { t } from "../lib/i18n.ts";

/** A secret field with a show/hide button and its error; the sign-in card and Add key use it. */
export function KeyField({
  label,
  secret,
  onChange,
  failure,
  submit,
  inputRef,
  kind,
}: {
  label: string;
  secret: string;
  onChange: (value: string) => void;
  failure: string;
  submit: () => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** The management key being typed to sign in, or a new key being made up. */
  kind: "sign-in" | "new";
}) {
  const [shown, setShown] = useState(false);
  const toggle = shown ? t("app.signIn.hideKey") : t("app.signIn.showKey");
  return (
    <InputGroup
      label={label}
      size="lg"
      status={failure ? { type: "error", message: failure } : undefined}
    >
      <TextInput
        ref={inputRef}
        label={label}
        isLabelHidden
        type={shown ? "text" : "password"}
        value={secret}
        onChange={onChange}
        onEnter={submit}
        hasAutoFocus
        autoComplete={kind === "sign-in" ? "current-password" : "off"}
        autoCapitalize="off"
        hasAutoCorrect={false}
        hasSpellCheck={false}
        enterKeyHint={kind === "sign-in" ? "go" : "done"}
      />
      <Button
        label={toggle}
        tooltip={toggle}
        isIconOnly
        variant="secondary"
        icon={<Icon icon={shown ? "eyeSlash" : Eye} />}
        onClick={() => setShown((s) => !s)}
      />
    </InputGroup>
  );
}
