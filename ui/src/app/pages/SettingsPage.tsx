import Configuration from "../../features/config";
import { t } from "../../lib/i18n.ts";
import { PageHostContext } from "../pageHost.ts";

/** The server configuration. */
export default function SettingsPage() {
  return (
    <PageHostContext value={{ kind: "tab", title: t("app.nav.config"), tabs: null }}>
      <Configuration />
    </PageHostContext>
  );
}
