import { useEffect, useReducer } from "react";
import { available, onCapabilityChange } from "../lib/api/client.ts";
import type { Route } from "../lib/api/routes.ts";
import { list, t } from "../lib/i18n.ts";
import { StatusLamp } from "./StatusLamp.tsx";

/** `available(route)`, read again whenever the server answers a route as not implemented. */
export function useAvailable() {
  const [, changed] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onCapabilityChange(changed), []);
  return available;
}

/**
 * One line naming the actions this server does not implement (REQUIREMENTS intentional design:
 * write actions are probed at sign-in, and unsupported ones render disabled). Nothing when all are.
 */
export function MissingActions({
  actions,
}: {
  actions: readonly { route: Route; label: string }[];
}) {
  const isAvailable = useAvailable();
  const missing = actions.filter((a) => !isAvailable(a.route)).map((a) => a.label);
  if (!missing.length) return null;
  return (
    <StatusLamp status="disabled" label={t("app.missing.actions", { actions: list(missing) })} />
  );
}
