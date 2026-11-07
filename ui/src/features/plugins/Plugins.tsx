import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageFrame } from "../../app/PageFrame.tsx";
import { t } from "../../lib/i18n.ts";

export default function Plugins() {
  return (
    <PageFrame title={t("plugins.page.title")}>
      <EmptyState title={t("plugins.page.pending")} headingLevel={2} />
    </PageFrame>
  );
}
