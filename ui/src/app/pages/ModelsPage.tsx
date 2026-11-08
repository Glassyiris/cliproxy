import Models from "../../features/models";
import PayloadRules from "../../features/payload";
import { t } from "../../lib/i18n.ts";
import { TabbedPage } from "./TabbedPage.tsx";

export default function ModelsPage() {
  return (
    <TabbedPage
      tabs={[
        { id: "models", label: () => t("app.nav.models"), page: Models },
        { id: "payload", label: () => t("app.nav.payload"), page: PayloadRules },
      ]}
    />
  );
}
