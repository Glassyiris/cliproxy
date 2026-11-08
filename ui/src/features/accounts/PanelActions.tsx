// What can be done to the open account: the two actions used most as buttons, the rest in one
// menu after them, so the row stays one line in the panel. Unsupported actions render disabled
// and are named in the page's one MissingActions line.
import { RotateCcw, TimerReset } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import type { DropdownMenuItemData, DropdownMenuOption } from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Layout";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Spinner } from "@astryxdesign/core/Spinner";
import { icons } from "../../components/icons.ts";
import type { useQuota } from "../../app/QuotaProvider.tsx";
import { useAvailable } from "../../components/MissingActions.tsx";
import { downloadCredential, refreshCredentials } from "../../lib/api/credentials.ts";
import { resetPluginQuota } from "../../lib/api/plugins.ts";
import { routes } from "../../lib/api/routes.ts";
import { resetCooldown } from "../../lib/api/routing.ts";
import { saveBlob } from "../../lib/download.ts";
import { t } from "../../lib/i18n.ts";
import { span } from "../../lib/time.ts";
import { reach, type Row } from "./rows.ts";
import { target, type Writes } from "./writes.tsx";

export type PanelProps = {
  row: Row;
  rows: Row[];
  quota: ReturnType<typeof useQuota>;
  writes: Writes;
  onDeleted: (keys: string[]) => void;
};

function CheckQuota({ row, quota, now }: Pick<PanelProps, "row" | "quota"> & { now: number }) {
  const a = row.account;
  const pending = quota.pending(a);
  const wait = quota.wait(a, now);
  const text =
    pending === "queued"
      ? t("accounts.actions.queued")
      : pending === "checking"
        ? t("accounts.actions.checking")
        : wait > 0
          ? t("accounts.actions.checkedWait", { time: span(wait) })
          : t("accounts.actions.checkQuota");
  return (
    <Button
      label={text}
      size="sm"
      icon={<Icon icon={icons.refresh} size="sm" />}
      isLoading={pending === "checking"}
      isDisabled={!quota.canCheck(a) || (!pending && wait > 0)}
      onClick={() => void quota.check(a)}
    />
  );
}

/** A write followed by a reread of the list, under the button `id`. */
const sendThenReload =
  (writes: Writes, id: string, work: () => Promise<unknown>, success?: string) => () =>
    void writes.run(
      id,
      async () => {
        await work();
        await writes.reload();
      },
      success,
    );

/** A menu row and the busy mark of the write it starts. */
type MenuAction = DropdownMenuItemData & { label: string; busy: string };

type Available = ReturnType<typeof useAvailable>;

/** The resets: the local cooldown, and the quota a plugin stored; each asks first. */
function resets({ row, writes }: Pick<PanelProps, "row" | "writes">, isAvailable: Available) {
  const a = row.account;
  const plugin = a.quota_plugin_id;
  const items: MenuAction[] = [
    {
      label: t("accounts.actions.resetCooldown"),
      icon: TimerReset,
      busy: "cooldown",
      isDisabled: !a.auth_index || !isAvailable(routes.resetCooldown),
      onClick: () =>
        writes.ask({
          title: t("accounts.confirm.cooldownTitle", { name: row.name }),
          description: t("accounts.confirm.cooldownDetail"),
          actionLabel: t("accounts.actions.resetCooldown"),
          run: sendThenReload(
            writes,
            "cooldown",
            () => resetCooldown(a.auth_index),
            t("accounts.done.cooldownReset"),
          ),
        }),
    },
  ];
  if (plugin)
    items.push({
      label: t("accounts.actions.resetStored"),
      icon: RotateCcw,
      busy: "stored",
      isDisabled: !isAvailable(routes.resetPluginQuota),
      onClick: () =>
        writes.ask({
          title: t("accounts.confirm.storedTitle", { name: row.name }),
          description: t("accounts.confirm.storedDetail", { plugin }),
          actionLabel: t("accounts.actions.resetStored"),
          run: sendThenReload(
            writes,
            "stored",
            () => resetPluginQuota(plugin, a.auth_index),
            t("accounts.done.storedReset"),
          ),
        }),
    });
  return items;
}

/** The menu's rows (refresh, the resets, download), and delete, which sits apart after them. */
function menuActions(props: PanelProps, isAvailable: Available) {
  const { row, rows, writes, onDeleted } = props;
  const a = row.account;
  const rest: MenuAction[] = [
    {
      label: t("accounts.actions.refresh"),
      icon: icons.refresh,
      busy: "refresh",
      isDisabled: !isAvailable(routes.refreshCredentials),
      onClick: sendThenReload(
        writes,
        "refresh",
        () => refreshCredentials(target(a)),
        t("accounts.done.refreshed"),
      ),
    },
    ...resets(props, isAvailable),
    {
      label: t("accounts.actions.download"),
      icon: icons.download,
      busy: "download",
      isDisabled: a.runtime_only,
      onClick: () =>
        void writes.run("download", async () => saveBlob(await downloadCredential(a.name), a.name)),
    },
  ];
  const remove: MenuAction = {
    label: t("accounts.actions.deleteOne"),
    icon: icons.delete,
    variant: "destructive",
    busy: "delete",
    isDisabled: a.runtime_only || !isAvailable(routes.deleteCredentials),
    onClick: () => writes.remove(reach(rows, new Set([row.key])), onDeleted),
  };
  return { rest, remove };
}

/** The menu after the buttons; while one of its writes runs, its trigger shows the spinner. */
function MoreActions(props: PanelProps) {
  const isAvailable = useAvailable();
  const { rest, remove } = menuActions(props, isAvailable);
  const running = [...rest, remove].find((m) => props.writes.isBusy(m.busy));
  const item = (m: MenuAction): DropdownMenuItemData => ({
    label: m.label,
    icon: m.icon,
    variant: m.variant,
    isDisabled: m.isDisabled,
    onClick: m.onClick,
  });
  const items: DropdownMenuOption[] = [...rest.map(item), { type: "divider" }, item(remove)];
  return (
    <MoreMenu
      label={t("app.list.moreActions")}
      variant="secondary"
      size="sm"
      alignment="end"
      icon={running ? <Spinner size="sm" aria-label={running.label} /> : undefined}
      items={items}
    />
  );
}

export function PanelActions(props: PanelProps & { now: number }) {
  const { row, rows, writes } = props;
  const isAvailable = useAvailable();
  const a = row.account;
  const only = new Set([row.key]);
  return (
    <HStack gap={2} vAlign="center" hAlign="end">
      <CheckQuota {...props} />
      <Button
        label={a.disabled ? t("accounts.actions.enable") : t("accounts.actions.disable")}
        size="sm"
        isLoading={writes.isBusy(a.disabled ? "enable" : "disable")}
        isDisabled={!isAvailable(routes.setCredentialStatus)}
        onClick={() => writes.setStatus(rows, only, !a.disabled)}
      />
      <MoreActions {...props} />
    </HStack>
  );
}
