import { Plug } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import ClientKeys from "../../features/keys";
import UseWithTools from "../../features/use";
import { t } from "../../lib/i18n.ts";
import { PageHostContext } from "../pageHost.ts";
import { PageDialog, useDialogParam } from "./PageDialog.tsx";

/** The client keys; "Use with a tool" opens over them from the header and from a key's menu. */
export default function ClientsPage() {
  const use = useDialogParam("use", ["tool"]);
  const title = t("app.nav.clients");
  return (
    <>
      <PageHostContext
        value={{
          kind: "tab",
          title,
          tabs: null,
          actions: (
            <Button
              label={t("app.nav.use")}
              variant="secondary"
              icon={<Icon icon={Plug} />}
              onClick={use.open}
            />
          ),
        }}
      >
        <ClientKeys />
      </PageHostContext>
      <PageDialog isOpen={use.isOpen} title={t("app.nav.use")} onClose={use.close}>
        <UseWithTools />
      </PageDialog>
    </>
  );
}
