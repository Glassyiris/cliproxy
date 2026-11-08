import Logs from "../../features/logs";
import Usage from "../../features/usage";
import { t } from "../../lib/i18n.ts";
import { TabbedPage } from "./TabbedPage.tsx";

/** Usage and logs, one tab each. */
export default function ActivityPage() {
  return (
    <TabbedPage
      route="activity"
      title={t("app.nav.activity")}
      tabs={[
        { id: "usage", label: () => t("app.nav.usage"), page: Usage },
        { id: "logs", label: () => t("app.nav.logs"), page: Logs },
      ]}
    />
  );
}
