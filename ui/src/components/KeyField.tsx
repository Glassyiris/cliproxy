import { useCallback, useState, type KeyboardEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { Eye } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { InputGroup, type InputGroupProps } from "@astryxdesign/core/InputGroup";
import { TextInput } from "@astryxdesign/core/TextInput";
import { t } from "../lib/i18n.ts";

/**
 * Enter that commits an IME conversion (isComposing, or keyCode 229 from older Safari) must not
 * submit the sign-in form; Astryx's onEnter makes the same check.
 */
function holdComposingEnter(event: KeyboardEvent<HTMLInputElement>) {
  const native = event.nativeEvent;
  if (event.key === "Enter" && (native.isComposing || native.keyCode === 229))
    event.preventDefault();
}

type KeyFieldProps = {
  label: string;
  secret: string;
  onChange: (value: string) => void;
  failure: string;
  /** Runs on Enter for kind "new"; the sign-in field's Enter submits its form instead. */
  submit?: () => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  /**
   * The management key being typed to sign in, inside a form a password manager can save, or a
   * new key being made up.
   */
  kind: "sign-in" | "new";
  /** The input's name attribute, for a password manager. */
  htmlName?: string;
  /** Off when the field is not the dialog's first, so focus lands on the first one. */
  hasAutoFocus?: boolean;
  size?: InputGroupProps["size"];
};

/** A secret field with a show/hide button and its error; the sign-in card and the add dialogs use it. */
export function KeyField({
  label,
  secret,
  onChange,
  failure,
  submit,
  inputRef,
  kind,
  htmlName,
  hasAutoFocus = true,
  size = "lg",
}: KeyFieldProps) {
  const [shown, setShown] = useState(false);
  const toggle = shown ? t("app.signIn.hideKey") : t("app.signIn.showKey");
  const signIn = kind === "sign-in";
  // A password manager saves a password field only: the key is hidden again before the form's own
  // submit handler runs (a listener on the form fires before React's, which sits on the root).
  const attach = useCallback(
    (node: HTMLInputElement) => {
      if (inputRef) inputRef.current = node;
      const form = signIn ? node.form : null;
      const hide = () => flushSync(() => setShown(false));
      form?.addEventListener("submit", hide);
      return () => {
        form?.removeEventListener("submit", hide);
        if (inputRef) inputRef.current = null;
      };
    },
    [inputRef, signIn],
  );
  return (
    <InputGroup
      label={label}
      size={size}
      status={failure ? { type: "error", message: failure } : undefined}
    >
      <TextInput
        ref={attach}
        label={label}
        isLabelHidden
        type={shown ? "text" : "password"}
        value={secret}
        onChange={onChange}
        htmlName={htmlName}
        onEnter={signIn ? undefined : submit}
        onKeyDown={signIn ? holdComposingEnter : undefined}
        hasAutoFocus={hasAutoFocus}
        autoComplete={signIn ? "current-password" : "off"}
        autoCapitalize="off"
        hasAutoCorrect={false}
        hasSpellCheck={false}
        enterKeyHint={signIn ? "go" : "done"}
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
