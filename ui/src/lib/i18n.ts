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

const messages = Object.fromEntries(
  locales.map((locale) => [locale, Object.assign({}, ...areas.map((area) => area[locale]))]),
) as Record<Locale, Record<MessageKey, string>>;

const compiled = new Map<string, IntlMessageFormat>();
let current: Locale = "en";

/** The locale t() formats in, for the Intl formatters outside this module (time.ts). */
export const currentLocale = () => current;

export const isLocale = (value: unknown): value is Locale => locales.includes(value as Locale);

/** Every later t() call uses this locale. The app root rerenders the tree after calling it. */
export function setLocale(locale: Locale) {
  current = locale;
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
    format = new IntlMessageFormat(messages[current][key] ?? messages.en[key], current);
    compiled.set(cacheKey, format);
  }
  return String(format.format(values));
}
