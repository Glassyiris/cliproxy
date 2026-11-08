import { Plug } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { t } from "../../lib/i18n.ts";

/**
 * A server with no accounts: the template's empty state in place of the tiles and the chart, with
 * the two steps that matter, connecting an account and pointing a tool at the proxy.
 */
export function FirstRun({ connect }: { connect: () => void }) {
  return (
    <Card padding={6}>
      <EmptyState
        title={t("overview.start.title")}
        description={t("overview.start.text")}
        headingLevel={2}
        icon={<Icon icon={Plug} size="lg" />}
        actions={
          <>
            <Button label={t("overview.page.connect")} variant="secondary" onClick={connect} />
            <Button label={t("overview.start.useTools")} variant="ghost" href="#use" />
          </>
        }
      />
    </Card>
  );
}
