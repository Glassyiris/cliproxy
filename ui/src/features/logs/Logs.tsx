import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../app/PageFrame.tsx";
import { t } from "../../lib/i18n.ts";

export default function Logs() {
  return (
    <PageFrame title={t("logs.page.title")} width="full">
      <EmptyState title={t("logs.page.pending")} headingLevel={2} />
    </PageFrame>
  );
}
