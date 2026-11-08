import ClientKeys from "../../features/keys";
import { UseWithTools } from "../../features/use";
import { t } from "../../lib/i18n.ts";
import { PageHostContext } from "../pageHost.ts";
import { useDialogParam } from "./PageDialog.tsx";

/**
 * The client keys; "Use with a tool" opens over them from the header and from a key's row. The
 * keys page draws the header's controls itself, since a row opens the dialog with its own key.
 */
export default function ClientsPage() {
  const use = useDialogParam("use", ["tool", "key"]);
  return (
    <>
      <PageHostContext value={{ kind: "tab", title: t("app.nav.clients"), tabs: null }}>
        <ClientKeys />
      </PageHostContext>
      <UseWithTools isOpen={use.isOpen} onClose={use.close} />
    </>
  );
}
