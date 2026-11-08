import Accounts from "../../features/accounts";
import ProviderKeys from "../../features/providers";
import { t } from "../../lib/i18n.ts";
import { TabbedPage } from "./TabbedPage.tsx";

export default function AccountsPage() {
  return (
    <TabbedPage
      tabs={[
        { id: "accounts", label: () => t("app.nav.accounts"), page: Accounts },
        { id: "providers", label: () => t("app.nav.providers"), page: ProviderKeys },
      ]}
    />
  );
}
