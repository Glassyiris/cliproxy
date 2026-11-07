import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../app/PageFrame.tsx";
import { t } from "../../lib/i18n.ts";

export default function ProviderKeys() {
  return (
    <PageFrame title={t("providers.page.title")}>
      <EmptyState title={t("providers.page.pending")} headingLevel={2} />
    </PageFrame>
  );
}
