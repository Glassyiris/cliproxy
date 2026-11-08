// The words for the codes accountRow (src/lib/credentials.ts) gives, in the current language.
import { stateWord } from "../../components/StatusLamp.tsx";
import { windowLabel } from "../../components/QuotaWindow.tsx";
import type { Cooldown } from "../../lib/api/credentials.ts";
import type { AccountRow } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { ago, span } from "../../lib/time.ts";

export function wordOf(v: AccountRow, now: number) {
  if (v.word.kind === "inUse") return t("accounts.row.inUse");
  if (v.word.kind === "coolingUntil")
    return t("accounts.row.coolingUntil", { until: v.word.until });
  return stateWord(v.state, now);
}

const windowName = (w: Extract<AccountRow["sub"], { kind: "low" }>["window"]) =>
  w === "session"
    ? t("accounts.columns.session")
    : w === "weekly"
      ? t("accounts.columns.weekly")
      : windowLabel(w);

export function subOf(v: AccountRow) {
  const sub = v.sub;
  if (!sub) return "";
  switch (sub.kind) {
    case "serving":
      return t("accounts.row.serving");
    case "canServe":
      return t("accounts.row.canServe");
    case "tokenRefused":
      return t("accounts.row.tokenRefused");
    case "notInRotation":
      return t("accounts.row.notInRotation");
    case "coolingDown":
      return t("accounts.row.coolingDown");
    case "low":
      return t("accounts.row.low", { window: windowName(sub.window), used: sub.used });
    case "detail":
      return sub.text;
    case "modelsCooling":
      return t("accounts.row.modelsCooling", { count: sub.count });
  }
}

export function lastOf(v: AccountRow) {
  const last = v.last;
  if (!last) return t("app.quota.notReported");
  if (last.kind === "now") return t("accounts.row.usedNow");
  if (last.kind === "notIn") return t("accounts.row.notIn", { minutes: last.minutes });
  return t("accounts.row.usedAgo", { time: span(last.ms) });
}

export function ageOf(v: AccountRow, now: number) {
  const age = v.age;
  if (!("at" in age))
    return age.kind === "disabled" ? t("accounts.row.ageDisabled") : t("accounts.row.neverChecked");
  return age.kind === "checked"
    ? t("accounts.row.checked", { time: ago(age.at, now) })
    : t("accounts.row.seen", { time: ago(age.at, now) });
}

const reasons: Record<Cooldown["reason"], () => string> = {
  credential_quota: () => t("accounts.cooldown.credentialQuota"),
  quota: () => t("accounts.cooldown.quota"),
  unauthorized: () => t("accounts.cooldown.unauthorized"),
  payment_required: () => t("accounts.cooldown.paymentRequired"),
  not_found: () => t("accounts.cooldown.notFound"),
  transient_error: () => t("accounts.cooldown.transientError"),
  unknown: () => t("accounts.cooldown.unknown"),
};

/** "<model or Whole account> · <reason> [HTTP status] · <time left>". */
export function cooldownOf(c: Cooldown, now: number) {
  const values = {
    scope: c.model_key || t("accounts.cooldown.wholeAccount"),
    reason: (reasons[c.reason] ?? reasons.unknown)(),
    time: span(Math.max(0, Date.parse(c.retry_at) - now)),
  };
  return c.http_status
    ? t("accounts.cooldown.withStatus", { ...values, status: c.http_status })
    : t("accounts.cooldown.token", values);
}
