import { createContext, use } from "react";
import type { ProviderMessagesByLocale } from "@astryxdesign/core/i18n";
import { isLocale, loadLocale, type Locale } from "../lib/i18n.ts";
import { defaultPalette, isPalette, type Palette } from "../themes/site/index.ts";

// The only three choices this dashboard keeps across reloads. index.html reads the same keys
// before first paint and sets <html data-theme>, <html data-palette> and <html lang>, which the
// app then starts from.
const THEME_KEY = "cliproxy-theme";
const PALETTE_KEY = "cliproxy-palette";
const LOCALE_KEY = "cliproxy-locale";

export type ThemeMode = "system" | "light" | "dark";

export function initialMode(): ThemeMode {
  const mode = document.documentElement.dataset.theme;
  return mode === "light" || mode === "dark" ? mode : "system";
}

export function initialPalette(): Palette {
  const palette = document.documentElement.dataset.palette;
  return isPalette(palette) ? palette : defaultPalette;
}

export function initialLocale(): Locale {
  const lang = document.documentElement.lang;
  return isLocale(lang) ? lang : "en";
}

function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage may be blocked; the choice still applies until reload.
  }
}

export const storeMode = (mode: ThemeMode) => store(THEME_KEY, mode === "system" ? null : mode);

export const storePalette = (palette: Palette) =>
  store(PALETTE_KEY, palette === defaultPalette ? null : palette);

export function storeLocale(locale: Locale) {
  store(LOCALE_KEY, locale);
  document.documentElement.lang = locale;
}

/**
 * Astryx's own strings for a locale, resolved once the app's own table for it is in too: both
 * callers (main.tsx before the first render, App before it switches) then show the locale whole.
 * English is built in; the Chinese catalogs load on demand.
 */
export async function astryxMessages(locale: Locale): Promise<ProviderMessagesByLocale> {
  const [messages] = await Promise.all([astryxCatalog(locale), loadLocale(locale)]);
  return messages;
}

async function astryxCatalog(locale: Locale): Promise<ProviderMessagesByLocale> {
  if (locale === "zh-CN")
    return { "zh-CN": (await import("@astryxdesign/core/locales/zh-CN.generated.js")).default };
  if (locale === "zh-TW")
    return { "zh-TW": (await import("@astryxdesign/core/locales/zh-TW.generated.js")).default };
  return {};
}

type Preferences = {
  mode: ThemeMode;
  palette: Palette;
  locale: Locale;
  setMode: (mode: ThemeMode) => void;
  setPalette: (palette: Palette) => void;
  setLocale: (locale: Locale) => void;
};

export const PreferencesContext = createContext<Preferences | null>(null);

export function usePreferences() {
  const value = use(PreferencesContext);
  if (!value) throw new Error("usePreferences outside PreferencesContext");
  return value;
}
