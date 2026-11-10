import type { Config } from "../../lib/api/config.ts";
import { absent, storedValue } from "../../lib/configPath.ts";
import type { MessageKey } from "../../lib/i18n.ts";
import { strategies } from "../../lib/routing.ts";

/** The settings groups, in the order the page lists them (by task, not by config section). */
export const groups = ["routing", "access", "network", "requests", "logging", "advanced"] as const;
export type Group = (typeof groups)[number];

type Unit = "seconds" | "megabytes" | "bytes";

type Base = {
  /** Config key path, as the Management API writes it. */
  path: string;
  group: Group;
  /** The server reads it at start only (docs/CONFIGURATION.md). */
  restart?: true;
};

export type Setting = Base &
  (
    | { kind: "switch"; fallback: boolean }
    | { kind: "number"; fallback: number; min?: number; max?: number; units?: Unit }
    | { kind: "text"; fallback: string; pattern?: RegExp }
    | { kind: "list"; fallback: string[] }
    | { kind: "choice"; fallback: string; options: readonly string[] }
  );

// Go's time.ParseDuration: one or more number-unit pairs, such as "1h" or "1h30m".
const DURATION = /^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/;

/**
 * Every setting with a control, with the value the server uses when it is absent
 * (docs/CONFIGURATION.md). Other sections are edited as JSON under Advanced.
 */
export const settings: readonly Setting[] = [
  {
    path: "routing/strategy",
    group: "routing",
    kind: "choice",
    fallback: "soonest-reset",
    options: strategies,
  },
  { path: "routing/session-affinity", group: "routing", kind: "switch", fallback: false },
  {
    path: "routing/session-affinity-ttl",
    group: "routing",
    kind: "text",
    fallback: "1h",
    pattern: DURATION,
  },
  { path: "routing/retry/request-retry", group: "routing", kind: "number", fallback: 0, min: 0 },
  {
    path: "routing/retry/max-retry-credentials",
    group: "routing",
    kind: "number",
    fallback: 0,
    min: 0,
  },
  {
    path: "routing/retry/max-retry-interval",
    group: "routing",
    kind: "number",
    fallback: 0,
    min: 0,
    units: "seconds",
  },
  { path: "routing/cooldown/disable-cooling", group: "routing", kind: "switch", fallback: false },
  {
    path: "routing/cooldown/transient-error-cooldown-seconds",
    group: "routing",
    kind: "number",
    fallback: 0,
    units: "seconds",
  },
  {
    path: "routing/cooldown/save-cooldown-status",
    group: "routing",
    kind: "switch",
    fallback: false,
  },
  { path: "management/allow-remote", group: "access", kind: "switch", fallback: false },
  { path: "management/disable-control-panel", group: "access", kind: "switch", fallback: false },
  { path: "server/host", group: "network", kind: "text", fallback: "", restart: true },
  {
    path: "server/port",
    group: "network",
    kind: "number",
    fallback: 8317,
    min: 1,
    max: 65535,
    restart: true,
  },
  { path: "server/tls/enable", group: "network", kind: "switch", fallback: false, restart: true },
  { path: "server/tls/cert", group: "network", kind: "text", fallback: "", restart: true },
  { path: "server/tls/key", group: "network", kind: "text", fallback: "", restart: true },
  { path: "server/trusted-proxies", group: "network", kind: "list", fallback: [], restart: true },
  { path: "requests/proxy-url", group: "requests", kind: "text", fallback: "" },
  {
    path: "requests/tls-handshake-timeout-seconds",
    group: "requests",
    kind: "number",
    fallback: 0,
    min: 0,
    units: "seconds",
  },
  {
    path: "server/max-request-body-bytes",
    group: "requests",
    kind: "number",
    fallback: 0,
    units: "bytes",
  },
  {
    path: "observability/logs/logging-to-file",
    group: "logging",
    kind: "switch",
    fallback: false,
  },
  {
    path: "observability/logs/logs-max-total-size-mb",
    group: "logging",
    kind: "number",
    fallback: 0,
    min: 0,
    units: "megabytes",
  },
  { path: "observability/logs/request-log", group: "logging", kind: "switch", fallback: false },
  {
    path: "observability/usage/usage-statistics-enabled",
    group: "logging",
    kind: "switch",
    fallback: false,
  },
  { path: "oauth/auth-dir", group: "advanced", kind: "text", fallback: "~/.cli-proxy-api" },
];

export const settingsOf = (group: Group) => settings.filter((s) => s.group === group);

type SettingId = MessageKey extends infer K
  ? K extends `config.label.${infer Id}`
    ? Id
    : never
  : never;

/** A setting's name in the message catalog: its last path segment in camel case. */
export const settingId = (setting: Setting) =>
  setting.path
    .slice(setting.path.lastIndexOf("/") + 1)
    .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) as SettingId;

/** A draft holds only the settings the operator changed, by path. */
export type Draft = Readonly<Record<string, unknown>>;

/** The value a control shows: the draft's, else the stored value, else the server default. */
export function shown(config: Config, setting: Setting, draft: Draft): unknown {
  if (Object.hasOwn(draft, setting.path)) return draft[setting.path];
  const stored = storedValue(config, setting.path);
  return stored === absent || stored === null ? setting.fallback : stored;
}

/** Whether a drafted value is one the server accepts; the control shows why when it is not. */
export function isValid(setting: Setting, value: unknown): boolean {
  if (setting.kind === "text" && setting.pattern)
    return typeof value === "string" && setting.pattern.test(value);
  return true;
}

/**
 * The settings whose drafted value differs from the stored value; drafting a value back to
 * what is saved is no change. An unset key counts as its default, so choosing the default writes
 * nothing.
 */
export function changes(config: Config, draft: Draft, baseline: Draft = {}) {
  return settings.flatMap((setting) => {
    if (!Object.hasOwn(draft, setting.path)) return [];
    const stored = Object.hasOwn(baseline, setting.path)
      ? baseline[setting.path]
      : storedValue(config, setting.path);
    const before = stored === absent || stored === null ? setting.fallback : stored;
    const after = draft[setting.path];
    return JSON.stringify(before) === JSON.stringify(after)
      ? []
      : [{ setting, before: stored, after }];
  });
}

export type Change = ReturnType<typeof changes>[number];

/** The changes as a diff, one key per line pair in dotted form, as the review shows them. */
export function diffText(list: readonly Change[], unset: string) {
  return list
    .flatMap(({ setting, before, after }) => {
      const key = setting.path.replaceAll("/", ".");
      return [
        before === absent ? `-${key}: ${unset}` : `-${key}: ${JSON.stringify(before)}`,
        `+${key}: ${JSON.stringify(after)}`,
      ];
    })
    .join("\n");
}

export function editDraft(
  config: Config,
  draft: Draft,
  path: string,
  value: unknown,
  baseline: Draft = {},
) {
  return {
    values: { ...draft, [path]: value },
    baseline: Object.hasOwn(baseline, path)
      ? baseline
      : { ...baseline, [path]: storedValue(config, path) },
  };
}
