import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { ContrastIcon, LanguageIcon, MoonIcon, SunIcon } from "../components/icons.tsx";
import { isLocale, localeName, locales, t } from "../lib/i18n.ts";
import { usePreferences, type ThemeMode } from "./preferences.ts";

const modeIcon = { system: ContrastIcon, light: SunIcon, dark: MoonIcon } as const;
const isMode = (value: string): value is ThemeMode => value in modeIcon;

/** The theme and language switches, shown on the sign-in page and in the navigation footer. */
export function PreferenceMenus() {
  const { mode, setMode, locale, setLocale } = usePreferences();
  const trigger = (label: string, icon: typeof SunIcon) => ({
    label,
    tooltip: label,
    icon: <Icon icon={icon} />,
    isIconOnly: true,
    variant: "ghost" as const,
  });
  return (
    <>
      <DropdownMenu button={trigger(t("app.theme.label"), modeIcon[mode])} hasChevron={false}>
        <DropdownMenuRadioGroup
          label={t("app.theme.label")}
          value={mode}
          onChange={(value) => isMode(value) && setMode(value)}
        >
          <DropdownMenuRadioItem value="system" label={t("app.theme.system")} icon={ContrastIcon} />
          <DropdownMenuRadioItem value="light" label={t("app.theme.light")} icon={SunIcon} />
          <DropdownMenuRadioItem value="dark" label={t("app.theme.dark")} icon={MoonIcon} />
        </DropdownMenuRadioGroup>
      </DropdownMenu>
      <DropdownMenu button={trigger(t("app.locale.label"), LanguageIcon)} hasChevron={false}>
        <DropdownMenuRadioGroup
          label={t("app.locale.label")}
          value={locale}
          onChange={(value) => isLocale(value) && setLocale(value)}
        >
          {locales.map((l) => (
            <DropdownMenuRadioItem key={l} value={l} label={localeName(l)} />
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenu>
    </>
  );
}
