import { useRef, type RefObject } from "react";
import { Eye } from "lucide-react";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Selector } from "@astryxdesign/core/Selector";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import type { Config } from "../../lib/api/config.ts";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { families, groupsOf, storedGroups, type Family } from "./groups.ts";

export const familyName = (family: Family) =>
  family === "openai-compatibility" ? t("providers.family.openaiCompatibility") : label(family);

/**
 * Eight families do not fit as segments beside the side nav or on a phone (Astryx advises two to
 * five, and the labels cut to their first letter), so a phone gets the same choice as a list.
 */
function FamilyPicker({
  family,
  config,
  onChange,
}: {
  family: Family;
  config: Config | undefined;
  onChange: (family: string) => void;
}) {
  const labelOf = (f: Family) => {
    const count = config ? groupsOf(storedGroups(config, f)).length : 0;
    return count ? t("providers.family.withCount", { name: familyName(f), count }) : familyName(f);
  };
  const isMobile = useAppShellMobile().isMobile;
  if (isMobile)
    return (
      <Selector
        label={t("providers.family.label")}
        isLabelHidden
        value={family}
        onChange={onChange}
        options={families.map((f) => ({ value: f, label: labelOf(f) }))}
      />
    );
  return (
    <SegmentedControl label={t("providers.family.label")} value={family} onChange={onChange}>
      {families.map((f) => (
        <SegmentedControlItem key={f} value={f} label={labelOf(f)} />
      ))}
    </SegmentedControl>
  );
}

/** The family choice, the reveal switch (when there are keys to reveal) and the link to the raw config. */
export function ProviderToolbar({
  family,
  config,
  onChange,
  pickerRef,
  canReveal,
  revealed,
  onReveal,
}: {
  family: Family;
  /** For the group counts; undefined while it loads. */
  config: Config | undefined;
  onChange: (family: string) => void;
  pickerRef: RefObject<HTMLElement | null>;
  canReveal: boolean;
  revealed: boolean;
  onReveal: (revealed: boolean) => void;
}) {
  return (
    <VStack gap={3}>
      <VStack ref={pickerRef}>
        <FamilyPicker family={family} config={config} onChange={onChange} />
      </VStack>
      <HStack gap={3} vAlign="center" wrap="wrap">
        {canReveal && (
          <ToggleButton
            label={t("providers.page.show")}
            icon={<Icon icon={Eye} />}
            pressedIcon={<Icon icon="eyeSlash" />}
            isPressed={revealed}
            onPressedChange={onReveal}
          />
        )}
        <Link href="#config">{t("providers.page.edit")}</Link>
      </HStack>
    </VStack>
  );
}

/**
 * A control that was focused and is now gone (the Add button of the empty state, the menu of a
 * deleted group) leaves focus on the page body; the family picker is always there.
 */
export function usePickerFocus() {
  const ref = useRef<HTMLElement>(null);
  const focus = () =>
    requestAnimationFrame(() =>
      ref.current
        ?.querySelector<HTMLElement>("[role=radio][tabindex='0'], [role=combobox]")
        ?.focus(),
    );
  return { ref, focus };
}
