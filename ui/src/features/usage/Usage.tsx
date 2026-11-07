import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../app/PageFrame.tsx";
import { t } from "../../lib/i18n.ts";

export default function Usage() {
  return (
    <PageFrame title={t("usage.page.title")} width="full">
      <EmptyState title={t("usage.page.pending")} headingLevel={2} />
    </PageFrame>
  );
}
