import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../app/PageFrame.tsx";
import { t } from "../../lib/i18n.ts";

export default function ClientKeys() {
  return (
    <PageFrame title={t("keys.page.title")}>
      <EmptyState title={t("keys.page.pending")} headingLevel={2} />
    </PageFrame>
  );
}
