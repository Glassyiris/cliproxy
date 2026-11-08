import Models from "../../features/models";
import PayloadRules from "../../features/payload";
import { t } from "../../lib/i18n.ts";
import { TabbedPage } from "./TabbedPage.tsx";

/** Models, with the payload rules as its second tab. */
export default function ModelsPage() {
  return (
    <TabbedPage
      route="models"
      title={t("app.nav.models")}
      tabs={[
        { id: "models", label: () => t("app.nav.models"), page: Models },
        { id: "payload", label: () => t("app.nav.payload"), page: PayloadRules },
      ]}
    />
  );
}
