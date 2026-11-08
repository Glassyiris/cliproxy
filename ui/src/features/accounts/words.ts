// The words for the codes accountRow (src/lib/credentials.ts) gives, in the current language.
import { windowLabel } from "../../components/QuotaWindow.tsx";
import type { Cooldown, Credential } from "../../lib/api/credentials.ts";
import type { AccountRow } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { ago, span } from "../../lib/time.ts";
import type { Show } from "./rows.ts";

const stateWords: Record<AccountRow["state"]["state"], () => string> = {
  ready: () => t("accounts.state.ready"),
  limited: () => t("accounts.state.limited"),
  cooling: () => t("accounts.state.cooling"),
  signIn: () => t("accounts.state.signIn"),
  unavailable: () => t("accounts.state.unavailable"),
  error: () => t("accounts.state.error"),
  disabled: () => t("accounts.state.disabled"),
  other: () => "",
};

/** The word beside the lamp; when an account comes back is its own column. */
export function statusOf(v: AccountRow) {
  if (v.word.kind === "inUse") return t("accounts.row.inUse");
  return v.state.state === "other" ? (v.state.status ?? "") : stateWords[v.state.state]();
}

/** The status filter's name for `show`. */
export const showWord = (show: Show) =>
  show === "ready"
    ? t("accounts.filters.ready")
    : show === "low"
      ? t("accounts.filters.low")
      : show === "other"
        ? t("accounts.state.other")
        : stateWords[show]();

/** When the account can serve again: the time left and the clock time, or why it is not known. */
export function recoveryOf(v: AccountRow, now: number): { first: string; second: string } {
  const s = v.state;
  if (v.ready) return { first: t("accounts.recovery.none"), second: "" };
  if (s.until && s.until > now)
    return {
      first: t("accounts.recovery.in", { time: span(s.until - now) }),
      second: t("accounts.recovery.at", { at: s.until }),
    };
  if (s.state === "signIn") return { first: t("accounts.recovery.afterSignIn"), second: "" };
  if (s.state === "disabled") return { first: t("accounts.recovery.whenEnabled"), second: "" };
  return { first: t("accounts.recovery.unknown"), second: "" };
}

const windowName = (w: Extract<AccountRow["sub"], { kind: "low" }>["window"]) =>
  w === "session"
    ? t("accounts.columns.session")
    : w === "weekly"
      ? t("accounts.columns.weekly")
      : windowLabel(w);

function subOf(v: AccountRow) {
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
  // The label says the quota was read; a check from this dashboard says so, a stored read is
  // only its age.
  return age.kind === "checked"
    ? t("accounts.row.checked", { time: ago(age.at, now) })
    : ago(age.at, now);
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

/** A cooldown's reason, the HTTP status that started it when the server kept one, and its time left. */
export function cooldownOf(c: Cooldown, now: number) {
  const values = {
    reason: (reasons[c.reason] ?? reasons.unknown)(),
    time: span(Math.max(0, Date.parse(c.retry_at) - now)),
  };
  return c.http_status
    ? t("accounts.cooldown.withStatus", { ...values, status: c.http_status })
    : t("accounts.cooldown.detail", values);
}

/**
 * Why the row is in its state: for a cooling or limited account the cooldown's own reason and the
 * HTTP status that started it, which the server keeps; otherwise the row's secondary line.
 */
export function reasonOf(v: AccountRow, a: Credential) {
  const waits = v.state.state === "cooling" || v.state.state === "limited";
  const c = waits ? (a.cooldowns ?? []).find((x) => x.scope !== "model") : undefined;
  if (!c) return subOf(v);
  const reason = (reasons[c.reason] ?? reasons.unknown)();
  return c.http_status
    ? t("accounts.row.cooldownStatus", { reason, status: c.http_status })
    : reason;
}
