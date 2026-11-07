import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../app/PageFrame.tsx";
import { t } from "../../lib/i18n.ts";

export default function UseWithTools() {
  return (
    <PageFrame title={t("use.page.title")}>
      <EmptyState title={t("use.page.pending")} headingLevel={2} />
    </PageFrame>
  );
}
