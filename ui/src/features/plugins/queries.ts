import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { serverKeys, useConfigWrite } from "../../app/serverQueries.ts";
import { useHashParams } from "../../app/useHashRoute.ts";
import type { Action } from "../../app/useAction.ts";
import type { Config } from "../../lib/api/config.ts";
import {
  deletePlugin,
  installPlugin,
  listPluginStore,
  type Plugin,
  type StorePlugin,
} from "../../lib/api/plugins.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";

const storeKey = ["plugins", "store"] as const;

/** The dialog's open panel is the store while the hash says `?store=1`; it is read then, not before. */
export function useStore() {
  const [params, setParams] = useHashParams();
  const isOpen = params.store === "1";
  const store = useQuery({
    queryKey: storeKey,
    queryFn: ({ signal }) => listPluginStore(signal),
    enabled: isOpen,
  });
  return {
    isOpen,
    store,
    show: (open: boolean) => setParams({ store: open ? "1" : undefined }, "push"),
  };
}

/**
 * Every write of the page, one at a time through `action`. `pending` names the switch whose write
 * is on its way (the header's, or one plugin's), so only that switch shows busy. A press while another
 * write is pending returns before it touches any state.
 */
export function usePluginWrites(action: Action, config: Config | undefined) {
  const queryClient = useQueryClient();
  const writeConfig = useConfigWrite(action);
  const [pending, setPending] = useState<{ id?: string } | null>(null);
  // Set at once, where `action.busy` only follows on the next render.
  const inFlight = useRef(false);

  const reload = (...keys: readonly (readonly string[])[]) =>
    Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));

  const toggle = async (id: string | undefined, path: string, next: boolean, ok: string) => {
    if (action.busy || inFlight.current) return;
    inFlight.current = true;
    setPending({ id });
    try {
      await writeConfig(path, next, ok);
    } finally {
      await reload(serverKeys.plugins);
      setPending(null);
      inFlight.current = false;
    }
  };

  return {
    /** Whether the switch of plugin `id`, or the header's without one, has a write on its way. */
    loading: (id?: string) => pending !== null && pending.id === id,
    all: (on: boolean) =>
      config &&
      toggle(
        undefined,
        "plugins/enabled",
        on,
        on ? t("plugins.page.switchedOn") : t("plugins.page.switchedOff"),
      ),
    one: (p: Plugin) =>
      config && toggle(p.id, `plugins/configs/${p.id}/enabled`, !p.enabled, t("plugins.row.saved")),
    remove: (id: string) =>
      action.run(async () => {
        try {
          await deletePlugin(id);
        } finally {
          await reload(serverKeys.plugins, serverKeys.config, storeKey);
        }
      }, t("plugins.delete.deleted")),
    install: async (p: StorePlugin) => {
      let restart = false;
      const ok = await action.run(async () => {
        try {
          const answer = await installPlugin(p.id, p.source_id);
          restart = answer.restart_required;
        } finally {
          await reload(serverKeys.plugins, serverKeys.config, storeKey);
        }
      });
      if (ok)
        notify(
          "success",
          restart ? t("plugins.store.installedRestart") : t("plugins.store.installed"),
        );
      return ok;
    },
  };
}
