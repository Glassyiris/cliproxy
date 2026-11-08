import { useState, type ReactNode } from "react";
import { Grid } from "@astryxdesign/core/Grid";
import { VStack } from "@astryxdesign/core/Layout";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { t } from "../../lib/i18n.ts";
import { strategyHelp, strategyName, type Strategy } from "../../lib/routing.ts";
import { layout } from "../../themes/site/layout.ts";
import { isValid, settingId, type Setting } from "./settings.ts";

/**
 * One row of a settings group, as the settings-sidebar template draws its rows: the name and what
 * it does at the start, the control beside it; where both columns do not fit they stack.
 */
export function Row({
  label,
  hint,
  note,
  children,
}: {
  label: string;
  /** The label is a config key, set in the mono family (DESIGN.md "Text types"). */
  hint?: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <VStack paddingBlock={4}>
      <Grid columns={{ minWidth: layout.settingsColumnMin }} gap={4} align="start">
        <VStack gap={0}>
          <Text type="body" weight="semibold">
            {label}
          </Text>
          {hint && (
            <Text type="supporting" color="secondary">
              {hint}
            </Text>
          )}
          {note && (
            <Text type="supporting" color="secondary">
              {note}
            </Text>
          )}
        </VStack>
        {children}
      </Grid>
    </VStack>
  );
}

const label = (s: Setting) => t(`config.label.${settingId(s)}`);

/** Typed text that is committed to the draft only once the server would accept it. */
function TextControl({
  setting,
  value,
  onChange,
}: {
  setting: Extract<Setting, { kind: "text" | "list" }>;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const shown = Array.isArray(value) ? value.join(", ") : typeof value === "string" ? value : "";
  const [typed, setTyped] = useState<string | null>(null);
  const text = typed ?? shown;
  const invalid = setting.kind === "text" && !isValid(setting, text);
  return (
    <TextInput
      label={label(setting)}
      isLabelHidden
      value={text}
      hasSpellCheck={false}
      width={setting.kind === "text" && setting.pattern ? layout.shortControlWidth : undefined}
      status={invalid ? { type: "error", message: t("config.row.duration") } : undefined}
      onChange={(next) => {
        setTyped(next);
        if (setting.kind === "list")
          onChange(
            next
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean),
          );
        else if (isValid(setting, next)) onChange(next);
      }}
      onBlur={() => !invalid && setTyped(null)}
    />
  );
}

/** The control of `setting`; `value` is undefined while the config loads. */
export function Control({
  setting,
  value,
  onChange,
}: {
  setting: Setting;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const isLoading = value === undefined;
  if (setting.kind === "choice")
    return (
      <RadioList
        label={label(setting)}
        isLabelHidden
        value={typeof value === "string" ? value : ""}
        isDisabled={isLoading}
        aria-busy={isLoading}
        onChange={onChange}
      >
        {setting.options.map((option) => (
          <RadioListItem
            key={option}
            value={option}
            label={strategyName(option as Strategy)}
            description={strategyHelp(option as Strategy)}
          />
        ))}
      </RadioList>
    );
  if (isLoading) {
    const short = setting.kind === "number" || (setting.kind === "text" && setting.pattern);
    return (
      <Skeleton width={short ? layout.shortControlWidth : "100%"} height="var(--size-element-md)" />
    );
  }
  if (setting.kind === "switch")
    return (
      <Switch
        label={label(setting)}
        isLabelHidden
        value={value === true}
        onChange={(on) => onChange(on)}
      />
    );
  if (setting.kind === "number")
    return (
      <NumberInput
        label={label(setting)}
        isLabelHidden
        value={typeof value === "number" ? value : null}
        min={setting.min}
        max={setting.max}
        isIntegerOnly
        isWheelEnabled={false}
        width={layout.shortControlWidth}
        units={setting.units ? t(`config.unit.${setting.units}`) : undefined}
        onChange={onChange}
      />
    );
  return <TextControl setting={setting} value={value} onChange={onChange} />;
}
