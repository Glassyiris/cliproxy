import { Puzzle } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import Configuration from "../../features/config";
import { PluginsDialog } from "../../features/plugins";
import { t } from "../../lib/i18n.ts";
import { PageHostContext } from "../pageHost.ts";
import { ArgFromQuery } from "../useHashRoute.ts";
import { useDialogParam } from "./PageDialog.tsx";

/**
 * The server configuration; Plugins opens over it from the header. Its store and its open plugin
 * are query keys (src/lib/hash.ts), and the open plugin is the dialog's route argument.
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
      <ArgFromQuery value="plugin">
        <PluginsDialog isOpen={plugins.isOpen} onClose={plugins.close} />
      </ArgFromQuery>
    </>
  );
}
