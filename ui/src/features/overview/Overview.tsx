import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../app/PageFrame.tsx";
import { t } from "../../lib/i18n.ts";

export default function Overview() {
  return (
    <PageFrame title={t("overview.page.title")} width="full">
      <EmptyState title={t("overview.page.pending")} headingLevel={2} />
    </PageFrame>
  );
}
