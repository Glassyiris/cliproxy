import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../app/PageFrame.tsx";
import { t } from "../../lib/i18n.ts";

export default function Accounts() {
  return (
    <PageFrame title={t("accounts.page.title")} width="full">
      <EmptyState title={t("accounts.page.pending")} headingLevel={2} />
    </PageFrame>
  );
}
