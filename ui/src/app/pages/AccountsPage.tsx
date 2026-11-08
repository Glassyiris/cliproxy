import Accounts from "../../features/accounts";
import ProviderKeys from "../../features/providers";
import { t } from "../../lib/i18n.ts";
import { TabbedPage } from "./TabbedPage.tsx";

/** Accounts, with the provider keys as its second tab. */
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
