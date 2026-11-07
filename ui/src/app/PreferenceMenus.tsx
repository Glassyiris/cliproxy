import type { ReactNode } from "react";
import { Contrast, Languages, Moon, Palette, Sun } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuDivider,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@astryxdesign/core/DropdownMenu";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack } from "@astryxdesign/core/Layout";
import { isLocale, localeName, locales, t } from "../lib/i18n.ts";
import { isPalette } from "../themes/site/index.ts";
import { usePreferences, type ThemeMode } from "./preferences.ts";

const modeIcon = {
  system: Contrast,
  light: Sun,
  dark: Moon,
} as const satisfies Record<ThemeMode, IconProps["icon"]>;
const isMode = (value: string): value is ThemeMode => value in modeIcon;

/** The theme choices, as menu rows. */
function ThemeOptions() {
  const { mode, setMode } = usePreferences();
  return (
    <DropdownMenuRadioGroup
      label={t("app.theme.label")}
      value={mode}
      onChange={(value) => isMode(value) && setMode(value)}
    >
      <DropdownMenuRadioItem value="system" label={t("app.theme.system")} icon={modeIcon.system} />
      <DropdownMenuRadioItem value="light" label={t("app.theme.light")} icon={modeIcon.light} />
      <DropdownMenuRadioItem value="dark" label={t("app.theme.dark")} icon={modeIcon.dark} />
    </DropdownMenuRadioGroup>
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
  icon: <Icon icon={icon} />,
  isIconOnly: true,
  variant: "ghost" as const,
});

/** The theme (with palette) and language switches of the sign-in page, side by side at the page's top end. */
export function PreferenceMenus() {
  const { mode } = usePreferences();
  return (
    <HStack gap={1} vAlign="center">
      <DropdownMenu
        button={trigger(t("app.theme.label"), modeIcon[mode])}
        hasChevron={false}
        alignment="end"
      >
        <ThemeOptions />
        <DropdownMenuDivider />
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

/** One appearance menu: a ghost icon button with a tooltip, as BoothDex's header-controls.tsx. */
function FooterMenu({
  label,
  icon,
  children,
}: {
  label: string;
  icon: IconProps["icon"];
  children: ReactNode;
}) {
  return (
    <DropdownMenu
      placement="above"
      alignment="start"
      renderTrigger={(props) => (
        <IconButton
          {...props}
          label={label}
          tooltip={label}
          variant="ghost"
          icon={<Icon icon={icon} size="sm" />}
        />
      )}
    >
      {children}
    </DropdownMenu>
  );
}

/**
 * The appearance controls of the side nav: language, colour mode and palette, as BoothDex's admin
 * shell has the first two. They sit in SideNav's `footerIcons` row beside its collapse button,
 * which also stacks them in the collapsed rail; inside the footer section they overflowed it.
 */
export function FooterPreferences() {
  const { mode } = usePreferences();
  return (
    <>
      <FooterMenu label={t("app.locale.label")} icon={Languages}>
        <LanguageOptions />
      </FooterMenu>
      <FooterMenu label={t("app.theme.label")} icon={modeIcon[mode]}>
        <ThemeOptions />
      </FooterMenu>
      <FooterMenu label={t("app.colors.label")} icon={Palette}>
        <PaletteOptions />
      </FooterMenu>
    </>
  );
}
