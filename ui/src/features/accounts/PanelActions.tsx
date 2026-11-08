// What can be done to the open account. Unsupported actions render disabled and are named in
// the page's one MissingActions line.
import { Download, LogIn, RefreshCw } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Layout";
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
      icon={<Icon icon={RefreshCw} size="sm" />}
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

/** The resets: the local cooldown, and the quota a plugin stored; each asks first. */
function Resets({ row, writes }: Pick<PanelProps, "row" | "writes">) {
  const isAvailable = useAvailable();
  const a = row.account;
  const plugin = a.quota_plugin_id;
  return (
    <>
      <Button
        label={t("accounts.actions.resetCooldown")}
        size="sm"
        isLoading={writes.isBusy("cooldown")}
        isDisabled={!a.auth_index || !isAvailable(routes.resetCooldown)}
        onClick={() =>
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
          })
        }
      />
      {plugin && (
        <Button
          label={t("accounts.actions.resetStored")}
          size="sm"
          isLoading={writes.isBusy("stored")}
          isDisabled={!isAvailable(routes.resetPluginQuota)}
          onClick={() =>
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
            })
          }
        />
      )}
    </>
  );
}

export function PanelActions(props: PanelProps & { now: number }) {
  const { row, rows, writes, onDeleted } = props;
  const isAvailable = useAvailable();
  const a = row.account;
  const only = new Set([row.key]);
  return (
    <HStack gap={2} wrap="wrap">
      <CheckQuota {...props} />
      <Button
        label={a.disabled ? t("accounts.actions.enable") : t("accounts.actions.disable")}
        size="sm"
        isLoading={writes.isBusy(a.disabled ? "enable" : "disable")}
        isDisabled={!isAvailable(routes.setCredentialStatus)}
        onClick={() => writes.setStatus(rows, only, !a.disabled)}
      />
      <Button
        label={t("accounts.actions.refresh")}
        size="sm"
        isLoading={writes.isBusy("refresh")}
        isDisabled={!isAvailable(routes.refreshCredentials)}
        onClick={sendThenReload(
          writes,
          "refresh",
          () => refreshCredentials(target(a)),
          t("accounts.done.refreshed"),
        )}
      />
      <Resets row={row} writes={writes} />
      {a.siwc_bind_supported && (
        <Button
          label={t("accounts.actions.bindSiwc")}
          size="sm"
          icon={<Icon icon={LogIn} size="sm" />}
          href={`#connect/siwc/${encodeURIComponent(a.name)}`}
        />
      )}
      <Button
        label={t("accounts.actions.download")}
        size="sm"
        icon={<Icon icon={Download} size="sm" />}
        isLoading={writes.isBusy("download")}
        isDisabled={a.runtime_only}
        onClick={() =>
          void writes.run("download", async () =>
            saveBlob(await downloadCredential(a.name), a.name),
          )
        }
      />
      <Button
        label={t("accounts.actions.deleteOne")}
        variant="destructive"
        size="sm"
        isLoading={writes.isBusy("delete")}
        isDisabled={a.runtime_only || !isAvailable(routes.deleteCredentials)}
        onClick={() => writes.remove(reach(rows, only), onDeleted)}
      />
    </HStack>
  );
}
