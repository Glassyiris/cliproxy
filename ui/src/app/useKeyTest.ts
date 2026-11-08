import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, ConnectionError } from "../lib/api/client.ts";
import { listClientModels } from "../lib/api/proxy.ts";
import { t } from "../lib/i18n.ts";

/** A client key test: it reaches models, it works but reaches none yet, or it failed. */
export type KeyTest =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ready"; models: string[] }
  | { status: "noModels" }
  | { status: "failed"; message: string };

const failure = (error: unknown) =>
  error instanceof ApiError
    ? error.status === 401
      ? t("app.keyTest.rejected")
      : t("app.keyTest.status", { status: error.status })
    : error instanceof ConnectionError && error.reason === "timeout"
      ? t("app.connection.timeout")
      : t("app.keyTest.unreachable");

/**
 * Ask this proxy for its models with a client key, as a tool would. Only the latest test may
 * answer: starting another, or leaving the page, drops the one still on its way.
 */
export function useKeyTest() {
  const [result, setResult] = useState<KeyTest>({ status: "idle" });
  const latest = useRef<AbortController | null>(null);
  useEffect(() => () => latest.current?.abort(), []);
  const test = useCallback(async (key: string) => {
    latest.current?.abort();
    const controller = new AbortController();
    latest.current = controller;
    setResult({ status: "testing" });
    try {
      const models = await listClientModels(key, controller.signal);
      if (latest.current === controller)
        setResult(models.length ? { status: "ready", models } : { status: "noModels" });
    } catch (error) {
      if (latest.current === controller) setResult({ status: "failed", message: failure(error) });
    }
  }, []);
  return { result, test };
}
