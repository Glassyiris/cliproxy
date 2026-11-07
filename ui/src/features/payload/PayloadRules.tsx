import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../app/PageFrame.tsx";
import { t } from "../../lib/i18n.ts";

export default function PayloadRules() {
  return (
    <PageFrame title={t("payload.page.title")}>
      <EmptyState title={t("payload.page.pending")} headingLevel={2} />
    </PageFrame>
  );
}
