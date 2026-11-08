// The words for a group's state, in the current language.
import { t } from "../../lib/i18n.ts";
import type { Status } from "../../themes/site/index.ts";
import type { Entry } from "./groups.ts";
import { failingKeys, showOf, type Show } from "./list.ts";

const lamps: Record<Show, Status> = {
  ready: "ready",
  someFailing: "cooling",
  failing: "failing",
  noKeys: "disabled",
  disabled: "disabled",
};

/** The status filter's name for `show`. */
export const showWord = (show: Show) =>
  ({
    ready: () => t("providers.status.serving"),
    someFailing: () => t("providers.filters.someFailing"),
    failing: () => t("providers.status.failing"),
    noKeys: () => t("providers.status.noKeys"),
    disabled: () => t("providers.status.disabled"),
  })[show]();

/** The lamp and the word beside it; some keys failing says how many. */
export function statusOf(entry: Entry): { status: Status; label: string } {
  const show = showOf(entry);
  return {
    status: lamps[show],
    label:
      show === "someFailing"
        ? t("providers.status.someFailing", { count: failingKeys(entry) })
        : showWord(show),
  };
}
