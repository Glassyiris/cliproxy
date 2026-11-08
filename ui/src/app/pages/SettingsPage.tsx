import { Puzzle } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import Configuration from "../../features/config";
import Plugins from "../../features/plugins";
import { t } from "../../lib/i18n.ts";
import { PageHostContext } from "../pageHost.ts";
import { ArgFromQuery } from "../useHashRoute.ts";
import { PageDialog, useDialogParam } from "./PageDialog.tsx";

/**
 * The server configuration; Plugins opens over it from the header. Configuration's open section is
 * the path argument, so the open plugin is `?plugin=` (src/lib/hash.ts).
 */
export default function SettingsPage() {
  const plugins = useDialogParam("plugins", ["plugin", "store"]);
  return (
    <>
      <PageHostContext
        value={{
          kind: "tab",
          title: t("app.nav.settings"),
          tabs: null,
          actions: (
            <Button
              label={t("app.nav.plugins")}
              variant="secondary"
              icon={<Icon icon={Puzzle} />}
              onClick={plugins.open}
            />
          ),
        }}
      >
        <Configuration />
      </PageHostContext>
      <PageDialog isOpen={plugins.isOpen} title={t("app.nav.plugins")} onClose={plugins.close}>
        <ArgFromQuery value="plugin">
          <Plugins />
        </ArgFromQuery>
      </PageDialog>
    </>
  );
}
