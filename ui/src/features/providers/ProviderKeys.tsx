import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useAction } from "../../app/useAction.ts";
import { useHashParams } from "../../app/useHashRoute.ts";
import { t } from "../../lib/i18n.ts";
import { AddGroupDialog } from "./AddGroupDialog.tsx";
import { DeleteGroupDialog } from "./DeleteGroupDialog.tsx";
import { isFamily, type Family } from "./groups.ts";
import { ProviderBody } from "./ProviderBody.tsx";
import { ProviderToolbar, usePickerFocus } from "./ProviderToolbar.tsx";
import { useFamily } from "./useFamily.ts";
import { useGroupWrites } from "./useGroupWrites.ts";

export default function ProviderKeys() {
  const action = useAction();
  const [params, setParams] = useHashParams();
  const family: Family = isFamily(params.family) ? params.family : "claude";
  const [revealed, setRevealed] = useState(false);
  const [adding, setAdding] = useState(false);
  const { config, usage, groups, names, traffic, max } = useFamily(family);
  const picker = usePickerFocus();
  const writes = useGroupWrites(action, family, groups, names, picker.focus);

  const addButton = (
    <Button
      label={t("providers.page.add")}
      variant="primary"
      icon={<Icon icon={Plus} />}
      onClick={() => {
        if (!action.busy) setAdding(true);
      }}
    />
  );

  return (
    <PageFrame
      title={t("providers.page.title")}
      meta={
        groups && (
          <Text type="supporting" color="secondary">
            {t("providers.page.groups", { count: groups.length })}
          </Text>
        )
      }
      actions={groups?.length ? addButton : undefined}
    >
      <ProviderToolbar
        family={family}
        config={config.data}
        onChange={(value) => setParams({ family: value === "claude" ? undefined : value }, "push")}
        pickerRef={picker.ref}
        canReveal={!!groups?.length}
        revealed={revealed}
        onReveal={setRevealed}
      />
      <ProviderBody
        family={family}
        config={config}
        usage={usage}
        groups={groups}
        names={names}
        revealed={revealed}
        traffic={traffic}
        max={max}
        saving={writes.toggling}
        addButton={addButton}
        onAction={writes.press}
      />
      {adding && groups && (
        <AddGroupDialog
          compat={family === "openai-compatibility"}
          busy={action.busy}
          add={writes.add}
          onClose={() => setAdding(false)}
        />
      )}
      <DeleteGroupDialog
        target={writes.deleting}
        busy={action.busy}
        onConfirm={() => void writes.confirmDelete()}
        onClose={writes.cancelDelete}
      />
    </PageFrame>
  );
}
