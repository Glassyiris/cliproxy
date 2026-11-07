import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../app/PageFrame.tsx";
import { t } from "../../lib/i18n.ts";

export default function Connect() {
  return (
    <PageFrame title={t("connect.page.title")}>
      <EmptyState title={t("connect.page.pending")} headingLevel={2} />
    </PageFrame>
  );
}
