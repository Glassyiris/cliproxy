import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../app/PageFrame.tsx";
import { t } from "../../lib/i18n.ts";

export default function Models() {
  return (
    <PageFrame title={t("models.page.title")}>
      <EmptyState title={t("models.page.pending")} headingLevel={2} />
    </PageFrame>
  );
}
