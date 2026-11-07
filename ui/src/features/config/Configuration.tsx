import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../app/PageFrame.tsx";
import { t } from "../../lib/i18n.ts";

export default function Configuration() {
  return (
    <PageFrame title={t("config.page.title")}>
      <EmptyState title={t("config.page.pending")} headingLevel={2} />
    </PageFrame>
  );
}
