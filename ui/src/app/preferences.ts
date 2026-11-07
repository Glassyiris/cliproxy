import { createContext, use } from "react";
import type { ProviderMessagesByLocale } from "@astryxdesign/core/i18n";
import { isLocale, type Locale } from "../lib/i18n.ts";

// The only two choices this dashboard keeps across reloads. index.html reads the same keys before
// first paint and sets <html data-theme> and <html lang>, which the app then starts from.
const THEME_KEY = "cliproxy-theme";
const LOCALE_KEY = "cliproxy-locale";

export type ThemeMode = "system" | "light" | "dark";

export function initialMode(): ThemeMode {
  const mode = document.documentElement.dataset.theme;
  return mode === "light" || mode === "dark" ? mode : "system";
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

export function storeLocale(locale: Locale) {
  store(LOCALE_KEY, locale);
  document.documentElement.lang = locale;
}

/** Astryx's own strings for a locale. English is built in; the Chinese catalogs load on demand. */
export async function astryxMessages(locale: Locale): Promise<ProviderMessagesByLocale> {
  if (locale === "zh-CN")
    return { "zh-CN": (await import("@astryxdesign/core/locales/zh-CN.generated.js")).default };
  if (locale === "zh-TW")
    return { "zh-TW": (await import("@astryxdesign/core/locales/zh-TW.generated.js")).default };
  return {};
}

export type Preferences = {
  mode: ThemeMode;
  locale: Locale;
  setMode: (mode: ThemeMode) => void;
  setLocale: (locale: Locale) => void;
};

export const PreferencesContext = createContext<Preferences | null>(null);

export function usePreferences() {
  const value = use(PreferencesContext);
  if (!value) throw new Error("usePreferences outside PreferencesContext");
  return value;
}
