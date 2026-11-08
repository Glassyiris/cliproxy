import { Languages, Moon, Palette, Sun } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@astryxdesign/core/DropdownMenu";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack } from "@astryxdesign/core/Layout";
import { isLocale, localeName, locales, t } from "../lib/i18n.ts";
import { isPalette } from "../themes/site/index.ts";
import { usePreferences } from "./preferences.ts";
import { SettingsButton } from "./settings/SettingsDialog.tsx";

/**
 * Flips light and dark relative to what is shown, as BoothDex's ColorModeToggle; until the first
 * press the page follows the system.
 */
function ColorModeToggle({ iconSize = "md" }: { iconSize?: "sm" | "md" }) {
  const { mode, setMode } = usePreferences();
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const isDark = mode === "dark" || (mode === "system" && prefersDark);
  const label = isDark ? t("app.theme.toLight") : t("app.theme.toDark");
  return (
    <IconButton
      label={label}
      tooltip={label}
      variant="ghost"
      icon={<Icon icon={isDark ? Sun : Moon} size={iconSize} />}
      onClick={() => setMode(isDark ? "light" : "dark")}
    />
  );
}

/** The palette choices, as menu rows. Moon, the default, comes first. */
function PaletteOptions() {
  const { palette, setPalette } = usePreferences();
  return (
    <DropdownMenuRadioGroup
      label={t("app.colors.label")}
      value={palette}
      onChange={(value) => isPalette(value) && setPalette(value)}
    >
      <DropdownMenuRadioItem value="moon" label={t("app.colors.moon")} />
      <DropdownMenuRadioItem value="main" label={t("app.colors.main")} />
    </DropdownMenuRadioGroup>
  );
}

/** The language choices, as menu rows. */
function LanguageOptions() {
  const { locale, setLocale } = usePreferences();
  return (
    <DropdownMenuRadioGroup
      label={t("app.locale.label")}
      value={locale}
      onChange={(value) => isLocale(value) && setLocale(value)}
    >
      {locales.map((l) => (
        <DropdownMenuRadioItem key={l} value={l} label={localeName(l)} />
      ))}
    </DropdownMenuRadioGroup>
  );
}

const trigger = (label: string, icon: IconProps["icon"]) => ({
  label,
  tooltip: label,
  icon: <Icon icon={icon} size="md" />,
  isIconOnly: true,
  variant: "ghost" as const,
});

/** The colour-mode, palette and language switches of the sign-in page, at the page's top end. */
export function PreferenceMenus() {
  return (
    <HStack gap={1} vAlign="center">
      <ColorModeToggle />
      <DropdownMenu
        button={trigger(t("app.colors.label"), Palette)}
        hasChevron={false}
        alignment="end"
      >
        <PaletteOptions />
      </DropdownMenu>
      <DropdownMenu
        button={trigger(t("app.locale.label"), Languages)}
        hasChevron={false}
        alignment="end"
      >
        <LanguageOptions />
      </DropdownMenu>
    </HStack>
  );
}

/**
 * The side nav's footer icon row, beside its collapse button: the colour-mode toggle and the
 * settings button. `footerIcons` is the slot SideNav also stacks in the collapsed rail.
 */
export function FooterPreferences() {
  return (
    <>
      <ColorModeToggle iconSize="sm" />
      <SettingsButton />
    </>
  );
}
