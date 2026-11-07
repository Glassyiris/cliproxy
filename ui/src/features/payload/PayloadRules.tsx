import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import { PageFrame } from "../../app/PageFrame.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { t } from "../../lib/i18n.ts";
import { AddRuleDialog } from "./AddRuleDialog.tsx";
import { RemoveRuleDialog } from "./RemoveRuleDialog.tsx";
import { RuleTable } from "./RuleTable.tsx";
import { useRemoveRule } from "./useRemoveRule.ts";
import { useRules } from "./useRules.ts";

export default function PayloadRules() {
  const { config, action, groups, change } = useRules();
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const removal = useRemoveRule({
    groups,
    busy: action.busy,
    addRef,
    remove: (kind, index) =>
      change(kind, (e) => e.filter((_, n) => n !== index), t("payload.remove.removed")),
  });

  const hasRules = groups?.some((g) => g.entries.length > 0 || g.notList);
  const total = groups?.reduce((sum, g) => sum + g.entries.length, 0);

  const addButton = (
    <Button
      ref={addRef}
      label={t("payload.page.add")}
      variant="primary"
      icon={<Icon icon={Plus} />}
      onClick={() => setAdding(true)}
    />
  );

  return (
    <PageFrame
      title={t("payload.page.title")}
      meta={
        total !== undefined && (
          <HStack>
            <Badge variant="neutral" label={total} />
          </HStack>
        )
      }
      actions={hasRules ? addButton : undefined}
    >
      <Text type="supporting" color="secondary">
        {t("payload.page.intro")} <Link href="#config">{t("payload.page.editLink")}</Link>
      </Text>
      {config.isError && (
        <ReadError
          error={config.error}
          what={t("payload.page.what")}
          retry={() => void config.refetch()}
        />
      )}
      {groups && !hasRules && (
        <EmptyState
          title={t("payload.empty.title")}
          description={t("payload.empty.description")}
          headingLevel={2}
          actions={addButton}
        />
      )}
      {(config.isPending || hasRules) && (
        <RuleTable groups={groups} focus={removal.focus} onRemove={removal.request} />
      )}
      {adding && groups && (
        <AddRuleDialog
          busy={action.busy}
          notList={groups.filter((g) => g.notList).map((g) => g.kind)}
          add={(kind, rule) =>
            change(kind, (entries) => [...entries, rule], t("payload.add.added"))
          }
          onClose={() => setAdding(false)}
        />
      )}
      <RemoveRuleDialog
        dialogRef={removal.dialogRef}
        target={removal.target}
        busy={action.busy}
        onConfirm={() => void removal.confirm()}
        onClose={removal.close}
      />
    </PageFrame>
  );
}
