import { useState } from "react";
import { ApiError, ConnectionError } from "../lib/api/client.ts";
import { ConfigChangedError } from "../lib/api/config.ts";
import { t } from "../lib/i18n.ts";
import { notify, type NoticeLevel } from "../lib/notify.ts";

/**
 * What a failed write tells the user, by DESIGN.md "Notifications": a failed action is an error
 * toast that stays, carrying the server's own message. Null when the session already said it: a
 * rejected key signs out with its own notice, and an answer for an ended session has no reader.
 */
export function failureNotice(error: unknown): { level: NoticeLevel; message: string } | null {
  if (error instanceof ConfigChangedError)
    return { level: "error", message: t("app.action.configChanged") };
  if (error instanceof ApiError)
    return error.status === 401 ? null : { level: "error", message: error.message };
  if (error instanceof ConnectionError) {
    if (error.reason === "signed-out" || error.reason === "session-changed") return null;
    const message =
      error.reason === "timeout" ? t("app.connection.timeout") : t("app.connection.unreachable");
    return { level: "error", message };
  }
  return { level: "error", message: error instanceof Error ? error.message : String(error) };
}

/** Runs `work` unless another run is still pending; true when it finished without an error. */
type RunAction = (work: () => Promise<unknown>, success?: string) => Promise<boolean>;

/** The one-write-at-a-time rule, apart from React so it can be tested. */
export function createAction(setBusy: (busy: boolean) => void): RunAction {
  let pending = false;
  return async (work, success) => {
    if (pending) return false;
    pending = true;
    setBusy(true);
    try {
      await work();
      if (success) notify("success", success);
      return true;
    } catch (error) {
      const notice = failureNotice(error);
      if (notice) notify(notice.level, notice.message);
      return false;
    } finally {
      pending = false;
      setBusy(false);
    }
  };
}

export type Action = { busy: boolean; run: RunAction };

/**
 * A page's writes, one at a time: while one is pending a second press does nothing, so one press
 * is one effect. `busy` drives the pressed button's Astryx busy state; buttons are never greyed.
 */
export function useAction(): Action {
  const [busy, setBusy] = useState(false);
  const [run] = useState(() => createAction(setBusy));
  return { busy, run };
}
