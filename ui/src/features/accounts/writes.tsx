// Every write on Accounts, one at a time through the page's useAction (PAGE-MAP "Writes"). Each
// batch acts on whole files, because the server deletes and toggles by file (REQUIREMENTS
// intentional design), and rereads the list after each request so the table shows progress.
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { serverKeys } from "../../app/serverQueries.ts";
import { useAction } from "../../app/useAction.ts";
import { ApiError, ConnectionError } from "../../lib/api/client.ts";
import {
  deleteCredentials,
  refreshCredentials,
  setCredentialStatus,
  uploadCredentials,
  type Credential,
  type CredentialList,
} from "../../lib/api/credentials.ts";
import { list, t } from "../../lib/i18n.ts";
import { reach, rowKey, toSwitch, type Row } from "./rows.ts";

/** A question before a destructive or far-reaching write. */
type Ask = { title: string; description: string; actionLabel: string; run: () => void };

/** The account as the per-credential routes select it: file name and, when set, auth index. */
export const target = (a: Credential) => ({
  name: a.name,
  ...(a.auth_index ? { auth_index: a.auth_index } : {}),
});
const names = (rows: Row[]) => list(rows.map((r) => r.name));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The session is over (signed out, a new key, or the key refused): nothing more may be sent. */
const endsSession = (e: unknown) =>
  (e instanceof ConnectionError && (e.reason === "signed-out" || e.reason === "session-changed")) ||
  (e instanceof ApiError && e.status === 401);

/**
 * Sends each unit past ordinary failures and returns the ones that failed, with the server's
 * message. With `done`, a unit the reread list already shows done is not sent, and a failed
 * request whose unit the fresh list shows done counts as done. The batch stops at once when the
 * session ends or the page that started it is gone, so it never goes on under another session.
 */
async function sendEach<T>(
  c: Context,
  units: T[],
  send: (u: T) => Promise<unknown>,
  done?: (u: T) => boolean,
) {
  const why = new Map<T, string>();
  for (const u of units) {
    // An ended session has no reader, as useAction's failureNotice says, so this stops quietly.
    if (!c.isMounted()) throw new ConnectionError("session-changed");
    if (done?.(u)) continue;
    try {
      await send(u);
    } catch (e) {
      if (endsSession(e)) throw e;
      why.set(u, message(e));
    }
    if ((await c.reload()) && why.has(u) && done?.(u)) why.delete(u);
  }
  return units.filter((u) => why.has(u)).map((u) => ({ u, why: why.get(u) }));
}

/** Throws the partial outcome: what finished, then each failure with its reason. */
function report(done: string, failed: { name: string; why?: string }[]) {
  if (!failed.length) return;
  const each = failed.map((f) => (f.why ? t("accounts.batch.failedWhy", f) : f.name));
  throw new Error(t("accounts.batch.partial", { done, count: failed.length, names: list(each) }));
}

/** What every write needs from the page: the one action, the list reread, and the question. */
type Context = {
  run: (id: string, work: () => Promise<unknown>, success?: string) => Promise<boolean>;
  /**
   * Rereads the list; false when the reread failed, which the list shows as its own error, so
   * a write that succeeded still reports success.
   */
  reload: () => Promise<boolean>;
  isMounted: () => boolean;
  current: () => Credential[];
  ask: (ask: Ask) => void;
};

/** Enable or disable every account the selection reaches, asking when others change too. */
function setStatus(c: Context, rows: Row[], selected: ReadonlySet<string>, disabled: boolean) {
  const units = toSwitch(reach(rows, selected), selected, disabled);
  const also = units.filter((r) => !selected.has(r.key));
  const doneText = (count: number) =>
    disabled ? t("accounts.batch.disabled", { count }) : t("accounts.batch.enabled", { count });
  // A runtime-only account leaves the list once disabled (Rust auth_files.rs `entry`), so a
  // request's own success stands; the list only turns a failure into done.
  const isDone = (r: Row) =>
    c.current().some((a) => rowKey(a) === r.key && !!a.disabled === disabled);
  const go = () =>
    void c.run(
      disabled ? "disable" : "enable",
      async () => {
        const send = (r: Row) => setCredentialStatus(target(r.account), disabled);
        const failed = await sendEach(c, units, send, isDone);
        report(
          doneText(units.length - failed.length),
          failed.map(({ u, why }) => ({ name: u.name, why })),
        );
      },
      doneText(units.length),
    );
  if (!also.length) return go();
  c.ask({
    title: disabled
      ? t("accounts.confirm.disableTitle", { count: units.length })
      : t("accounts.confirm.enableTitle", { count: units.length }),
    description: t("accounts.confirm.sameFiles", { names: names(also) }),
    actionLabel: disabled ? t("accounts.actions.disable") : t("accounts.actions.enable"),
    run: go,
  });
}

/** One token refresh per file: the accounts of one file share its token. */
function refresh(c: Context, files: Row[][], selected: ReadonlySet<string>) {
  const pickOf = (g: Row[]) => g.find((r) => selected.has(r.key)) ?? g[0];
  const doneText = (count: number) => t("accounts.batch.refreshed", { count });
  return c.run(
    "refresh",
    async () => {
      const send = (g: Row[]) => refreshCredentials(target(pickOf(g).account));
      const failed = await sendEach(c, files, send);
      report(
        doneText(files.length - failed.length),
        failed.map(({ u, why }) => ({ name: names(u), why })),
      );
    },
    doneText(files.length),
  );
}

/** Delete whole files after naming each file and its accounts; `deleted` gets their keys. */
function remove(c: Context, files: Row[][], deleted: (keys: string[]) => void) {
  const deletable = files.filter((g) => !g[0].account.runtime_only);
  const doneText = (count: number) => t("accounts.batch.deleted", { count });
  const each = deletable.map((g) =>
    t("accounts.confirm.fileWith", { file: g[0].account.name, names: names(g) }),
  );
  const send = async (g: Row[]) => {
    await deleteCredentials([g[0].account.name]);
    deleted(g.map((r) => r.key));
  };
  const go = () =>
    void c.run(
      "delete",
      async () => {
        const failed = await sendEach(c, deletable, send);
        report(
          doneText(deletable.length - failed.length),
          failed.map(({ u, why }) => ({ name: u[0].account.name, why })),
        );
      },
      doneText(deletable.length),
    );
  c.ask({
    title: t("accounts.confirm.deleteTitle", { count: deletable.flat().length }),
    description: t("accounts.confirm.deleteFiles", { count: deletable.length, files: list(each) }),
    actionLabel: t("accounts.actions.delete"),
    run: go,
  });
}

/** Upload credential files; a partial answer names each file that failed. */
const upload = (c: Context, files: File[]) =>
  c.run(
    "upload",
    async () => {
      const result = await uploadCredentials(files);
      await c.reload();
      const failed = result.failed ?? [];
      report(
        t("accounts.done.uploaded", { count: result.uploaded ?? files.length - failed.length }),
        failed.map((f) => ({ name: f.name, why: f.error })),
      );
    },
    t("accounts.done.uploaded", { count: files.length }),
  );

export type Writes = ReturnType<typeof useWrites>;

export function useWrites() {
  const action = useAction();
  const queryClient = useQueryClient();
  const [pressed, setPressed] = useState("");
  const [question, setQuestion] = useState<Ask | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const c: Context = {
    // The busy mark moves only when the action takes the work; a press while busy does nothing.
    run: (id, work, success) =>
      action.run(async () => {
        setPressed(id);
        await work();
      }, success),
    reload: () =>
      queryClient.refetchQueries({ queryKey: serverKeys.credentials }, { throwOnError: true }).then(
        () => true,
        (e: unknown) => {
          if (endsSession(e)) throw e;
          return false;
        },
      ),
    isMounted: () => mounted.current,
    current: () => queryClient.getQueryData<CredentialList>(serverKeys.credentials)?.files ?? [],
    ask: setQuestion,
  };
  const dialog = (
    <AlertDialog
      isOpen={!!question}
      onOpenChange={(open) => !open && setQuestion(null)}
      title={question?.title ?? ""}
      description={question?.description ?? ""}
      actionLabel={question?.actionLabel ?? ""}
      cancelLabel={t("accounts.confirm.cancel")}
      onAction={() => {
        question?.run();
        setQuestion(null);
      }}
    />
  );
  return {
    run: c.run,
    reload: c.reload,
    ask: c.ask,
    isBusy: (id: string) => action.busy && pressed === id,
    setStatus: (rows: Row[], selected: ReadonlySet<string>, disabled: boolean) =>
      setStatus(c, rows, selected, disabled),
    refresh: (files: Row[][], selected: ReadonlySet<string>) => refresh(c, files, selected),
    remove: (files: Row[][], deleted: (keys: string[]) => void) => remove(c, files, deleted),
    upload: (files: File[]) => upload(c, files),
    dialog,
  };
}
