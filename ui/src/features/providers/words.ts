// The words for a group's state, in the current language.
import { t } from "../../lib/i18n.ts";
import type { Status } from "../../themes/site/index.ts";
import { isFailing, type Entry } from "./groups.ts";

/**
 * Whether a group serves: switched off, holding no key, every key failing in the window, some
 * failing (how many), or serving.
 */
export function statusOf(entry: Entry): { status: Status; label: string } {
  if (entry.group.disabled) return { status: "disabled", label: t("providers.status.disabled") };
  if (!entry.keys.length) return { status: "disabled", label: t("providers.status.noKeys") };
  const failing = entry.keys.filter((k) => isFailing(k.traffic)).length;
  if (failing === entry.keys.length)
    return { status: "failing", label: t("providers.status.failing") };
  if (failing)
    return { status: "cooling", label: t("providers.status.someFailing", { count: failing }) };
  return { status: "ready", label: t("providers.status.serving") };
}
