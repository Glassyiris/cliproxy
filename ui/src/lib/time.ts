import { currentLocale, t } from "./i18n.ts";

type Unit = "second" | "minute" | "hour" | "day";

/**
 * A duration in the units a reader needs: seconds under a minute, rounded minutes under an hour,
 * whole hours plus minutes under 48 hours, then rounded days.
 */
export function spanParts(ms: number): [number, Unit][] {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return [[s, "second"]];
  const m = Math.round(s / 60);
  if (m < 60) return [[m, "minute"]];
  const h = Math.floor(m / 60);
  if (h < 48)
    return m % 60
      ? [
          [h, "hour"],
          [m % 60, "minute"],
        ]
      : [[h, "hour"]];
  return [[Math.round(h / 24), "day"]];
}

// English reads the narrow "2h 5m"; Chinese reads the short form, since narrow zh-TW joins the
// parts unevenly ("2 小時5 分鐘").
const style = () => (currentLocale() === "en" ? "narrow" : "short");

const formats = new Map<string, Intl.NumberFormat | Intl.ListFormat | Intl.RelativeTimeFormat>();
function format<F extends Intl.NumberFormat | Intl.ListFormat | Intl.RelativeTimeFormat>(
  key: string,
  make: (locale: string) => F,
): F {
  const id = `${currentLocale()}\u0000${key}`;
  let f = formats.get(id) as F | undefined;
  if (!f) formats.set(id, (f = make(currentLocale())));
  return f;
}

/** A duration as the app locale writes it: "45s", "2h 5m", "3d"; "2小时5分钟"; "2 小時 5 分鐘". */
export function span(ms: number): string {
  const unitDisplay = style();
  const parts = spanParts(ms).map(([n, unit]) =>
    format(
      `${unit} ${unitDisplay}`,
      (l) => new Intl.NumberFormat(l, { style: "unit", unit, unitDisplay }),
    ).format(n),
  );
  return format(
    `list ${unitDisplay}`,
    (l) => new Intl.ListFormat(l, { type: "unit", style: unitDisplay }),
  ).format(parts);
}

/**
 * How long ago `value` (epoch ms or a date string) was: "just now" under 45 s, else the largest
 * unit of `span` ("2h ago" for 2 h 5 min: a relative time takes one unit). Empty for no date.
 */
export function ago(value: unknown, now = Date.now()): string {
  const at = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  if (Number.isNaN(at) || at <= 0) return "";
  if (now - at < 45_000) return t("app.time.justNow");
  const [[n, unit]] = spanParts(now - at);
  const s = style();
  return format(`ago ${s}`, (l) => new Intl.RelativeTimeFormat(l, { style: s })).format(-n, unit);
}
