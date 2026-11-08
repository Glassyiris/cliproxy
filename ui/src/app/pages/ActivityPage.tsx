import Logs from "../../features/logs";
import Usage from "../../features/usage";
import { t } from "../../lib/i18n.ts";
import { TabbedPage } from "./TabbedPage.tsx";

export default function ActivityPage() {
  return (
    <TabbedPage
      tabs={[
        { id: "usage", label: () => t("app.nav.usage"), page: Usage },
        { id: "logs", label: () => t("app.nav.logs"), page: Logs },
      ]}
    />
  );
}
