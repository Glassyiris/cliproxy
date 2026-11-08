import { Button } from "@astryxdesign/core/Button";
import { t } from "../lib/i18n.ts";

/**
 * The one way a page reaches the raw config: a plain jump to Settings › Advanced, as a secondary
 * header button before the page's primary action.
 * Editing lives only there, so the jump opens no entry of its own.
 */
export function SettingsLink() {
  return <Button label={t("app.page.editInSettings")} href="#settings?section=advanced" />;
}
