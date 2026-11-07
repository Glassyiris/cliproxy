import { IntlMessageFormat } from "intl-messageformat";
import app from "../i18n/app.ts";
import system from "../i18n/system.ts";

export const locales = ["en", "zh-CN", "zh-TW"] as const;
export type Locale = (typeof locales)[number];

const areas = [app, system] as const;
type KeysOf<Area> = Area extends { en: infer Messages } ? keyof Messages : never;
export type MessageKey = KeysOf<(typeof areas)[number]>;
type Values = Record<string, string | number>;

const messages = Object.fromEntries(
  locales.map((locale) => [locale, Object.assign({}, ...areas.map((area) => area[locale]))]),
) as Record<Locale, Record<MessageKey, string>>;

const compiled = new Map<string, IntlMessageFormat>();
let current: Locale = "en";

export const isLocale = (value: unknown): value is Locale => locales.includes(value as Locale);

/** Every later t() call uses this locale. The app root rerenders the tree after calling it. */
export function setLocale(locale: Locale) {
  current = locale;
}

// Language names are shown in their own language and script, so they come from Intl, not a catalog.
const scripts: Record<Locale, string> = { en: "en", "zh-CN": "zh-Hans", "zh-TW": "zh-Hant" };
export const localeName = (locale: Locale) =>
  new Intl.DisplayNames([scripts[locale]], { type: "language" }).of(scripts[locale]) ?? locale;

/** One message in the current locale, formatted as ICU with `values`. */
export function t(key: MessageKey, values?: Values): string {
  const cacheKey = `${current}\u0000${key}`;
  let format = compiled.get(cacheKey);
  if (!format) {
    format = new IntlMessageFormat(messages[current][key] ?? messages.en[key], current);
    compiled.set(cacheKey, format);
  }
  return String(format.format(values));
}
