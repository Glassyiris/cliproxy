import { IntlMessageFormat } from "intl-messageformat";
import accounts from "../i18n/accounts.ts";
import app from "../i18n/app.ts";
import config from "../i18n/config.ts";
import connect from "../i18n/connect.ts";
import keys from "../i18n/keys.ts";
import logs from "../i18n/logs.ts";
import models from "../i18n/models.ts";
import overview from "../i18n/overview.ts";
import payload from "../i18n/payload.ts";
import plugins from "../i18n/plugins.ts";
import providers from "../i18n/providers.ts";
import system from "../i18n/system.ts";
import usage from "../i18n/usage.ts";
import use from "../i18n/use.ts";

export const locales = ["en", "zh-CN", "zh-TW"] as const;
export type Locale = (typeof locales)[number];

const areas = [
  app,
  overview,
  use,
  accounts,
  providers,
  keys,
  models,
  payload,
  usage,
  logs,
  config,
  plugins,
  connect,
  system,
] as const;
type KeysOf<Area> = Area extends { en: infer Messages } ? keyof Messages : never;
export type MessageKey = KeysOf<(typeof areas)[number]>;
type Values = Record<string, string | number>;

// English is the fallback and ships in the entry chunk. Each Chinese table is one chunk of its
// own (src/i18n/<locale>/index.ts), loaded by loadLocale before the app shows that locale.
type Table = Partial<Record<MessageKey, string>>;
const en = Object.assign({}, ...areas.map((area) => area.en)) as Record<MessageKey, string>;
const messages: Partial<Record<Locale, Table>> = { en };
const tables: Record<Exclude<Locale, "en">, () => Promise<{ default: Table }>> = {
  "zh-CN": () => import("../i18n/zh-CN/index.ts"),
  "zh-TW": () => import("../i18n/zh-TW/index.ts"),
};

const compiled = new Map<string, IntlMessageFormat>();
let current: Locale = "en";

/** The locale t() formats in, for the Intl formatters outside this module (time.ts). */
export const currentLocale = () => current;

export const isLocale = (value: unknown): value is Locale => locales.includes(value as Locale);

/** Every later t() call uses this locale. The app root rerenders the tree after calling it. */
export function setLocale(locale: Locale) {
  current = locale;
}

/**
 * Fetches a locale's messages, once; English is always in. Call it before showing the locale:
 * until it resolves, t() falls back to English for that locale. A table that fails to load
 * leaves it on English and is tried again on the next call.
 */
export async function loadLocale(locale: Locale): Promise<void> {
  if (locale === "en" || messages[locale]) return;
  try {
    messages[locale] = (await tables[locale]()).default;
  } catch {
    return;
  }
  // Drop messages compiled from the English fallback while the table was missing.
  compiled.clear();
}

// Language names are shown in their own language and script, so they come from Intl, not a catalog.
const scripts: Record<Locale, string> = { en: "en", "zh-CN": "zh-Hans", "zh-TW": "zh-Hant" };
export const localeName = (locale: Locale) =>
  new Intl.DisplayNames([scripts[locale]], { type: "language" }).of(scripts[locale]) ?? locale;

/** Items joined as the current locale writes a list: "a, b and c", "a、b和c". */
export const list = (items: string[]) =>
  new Intl.ListFormat(current, { type: "conjunction" }).format(items);

/** An amount of money as the current locale writes it; an unknown currency code is shown as given. */
export function money(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(current, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** One message in the current locale, formatted as ICU with `values`. */
export function t(key: MessageKey, values?: Values): string {
  const cacheKey = `${current}\u0000${key}`;
  let format = compiled.get(cacheKey);
  if (!format) {
    format = new IntlMessageFormat(messages[current]?.[key] ?? en[key], current);
    compiled.set(cacheKey, format);
  }
  return String(format.format(values));
}
