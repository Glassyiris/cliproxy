// One provider sign-in at a time: start, poll, cancel, paste a callback, then name the new account
// and read its usage once. Every step checks that its sign-in is still the current one, so an
// answer for a cancelled or replaced sign-in never moves a newer one.
import { useEffect, useRef, useState, type RefObject } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useQuota } from "../../app/QuotaProvider.tsx";
import { useSession } from "../../app/Session.tsx";
import { failureNotice, type Action } from "../../app/useAction.ts";
import { ApiError } from "../../lib/api/client.ts";
import type { Credential } from "../../lib/api/credentials.ts";
import { cancelOAuth, startOAuth, submitOAuthCallback } from "../../lib/api/oauth.ts";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { dismissNotice, notify } from "../../lib/notify.ts";
import type { QuotaReading } from "../../lib/quota.ts";
import { span } from "../../lib/time.ts";
import { isForwarded, signedInAccount, signInUrl, type Phase, type Seen } from "./flow.ts";
import {
  credentialNames,
  reason,
  reloadCredentials,
  useGone,
  useSignInStatus,
  type StatusAnswer,
} from "./queries.ts";
import { phaseWord } from "./words.ts";

export type Flow = {
  id: number;
  provider: string;
  url: string;
  state: string;
  device: boolean;
  userCode?: string;
  expiresAt?: number;
  seen: Seen | null;
  phase: Phase;
  /** The server's reason for a failed sign-in. */
  problem: string;
  /** The account was found by its new name after the server forgot the sign-in. */
  found: boolean;
  account: Credential | null;
  /** The usage read this sign-in made; null when none was made. */
  read: QuotaReading | null;
  /** When the phase last changed. */
  at: number;
  /** The "Callback sent…" toast; null until a callback is sent. */
  callbackNotice: number | null;
  /** Why the account list could not be reread after the server confirmed; null when it was. */
  reread: unknown;
};

type Ctx = {
  latest: { get(): Flow | null; set(flow: Flow | null): void };
  setFlow: (flow: Flow | null) => void;
  /** False once the page is left; a start still pending then cancels what it gets back. */
  mounted: RefObject<boolean>;
  quota: ReturnType<typeof useQuota>;
  queryClient: QueryClient;
};

let sequence = 0;

function latestFlow() {
  let flow: Flow | null = null;
  return { get: () => flow, set: (next: Flow | null) => void (flow = next) };
}

function commit(ctx: Ctx, next: Flow | null) {
  ctx.latest.set(next);
  ctx.setFlow(next);
}

/** Change the sign-in `id` if it is still the current one; the changed sign-in, else null. */
function update(ctx: Ctx, id: number, patch: Partial<Flow>) {
  const flow = ctx.latest.get();
  if (flow?.id !== id) return null;
  const next = { ...flow, ...patch };
  commit(ctx, next);
  return next;
}

/** Takes down "Callback sent…" once the sign-in has ended, success included. */
function dropCallbackNotice(flow: Flow) {
  if (flow.callbackNotice !== null) dismissNotice(flow.callbackNotice);
}

// After a callback, an ending other than success (refused, error, unknown, cancelled) replaces
// "Callback sent…" with a toast that says how the sign-in ended; a success replaces it with its
// own "connected" toast in `verify`.
function announceEnd(flow: Flow) {
  if (flow.callbackNotice === null) return;
  dropCallbackNotice(flow);
  notify(
    flow.phase === "error" || flow.phase === "refused" ? "error" : "info",
    t("connect.panel.ended", { provider: label(flow.provider), status: phaseWord(flow.phase) }),
  );
}

function end(ctx: Ctx, id: number, phase: Phase, problem = "") {
  const flow = update(ctx, id, { phase, problem, at: Date.now() });
  if (flow) announceEnd(flow);
}

/** Read the account's usage once, as Accounts does, and settle the sign-in on the answer. */
async function verify(ctx: Ctx, id: number, account: Credential | null) {
  const { quota } = ctx;
  let read: QuotaReading | null = null;
  if (account && quota.canCheck(account)) {
    // Within the 2-minute wait a check would hand back a read made for the old token.
    if (!quota.wait(account)) {
      if (!update(ctx, id, { phase: "verifying" })) return;
      const before = quota.reading(account);
      await quota.check(account);
      // Every read stores a new object; an unchanged one means this check made no read.
      const after = quota.reading(account);
      if (after !== before) read = after ?? null;
    }
  }
  // Only a token the provider rejects is "refused"; other failed reads say so plainly.
  const refused = !!read && (read.code === 401 || read.code === 403);
  const flow = update(ctx, id, {
    phase: refused ? "refused" : "ok",
    account,
    read,
    at: Date.now(),
  });
  if (!flow) return;
  if (refused) return announceEnd(flow);
  dropCallbackNotice(flow);
  notify("success", t("connect.result.connected", { provider: label(flow.provider) }));
}

/**
 * The server confirmed the sign-in: reread the account list, then read the account's usage. When
 * the list cannot be read the sign-in stays Connected with the failure and a reread, and no
 * success is announced, since the usage checker reads accounts from that list.
 */
async function confirm(ctx: Ctx, id: number, known: Credential | null, found: boolean) {
  const flow = update(ctx, id, { phase: "verifying", found, reread: null });
  if (!flow) return;
  let list: Credential[];
  try {
    list = (await reloadCredentials(ctx.queryClient)).files;
  } catch (e) {
    const ended = update(ctx, id, {
      phase: "ok",
      account: known,
      read: null,
      reread: e,
      at: Date.now(),
    });
    if (ended) dropCallbackNotice(ended);
    return;
  }
  await verify(ctx, id, known ?? signedInAccount(flow.provider, flow.seen, list));
}

function onAnswer(ctx: Ctx, id: number, answer: StatusAnswer) {
  const flow = ctx.latest.get();
  if (flow?.id !== id || flow.phase !== "wait" || answer.status === "wait") return;
  if (answer.status === "ok") void confirm(ctx, id, answer.account, answer.found);
  else if (answer.status === "unknown") end(ctx, id, "unknown");
  else end(ctx, id, "error", answer.error);
}

/** "Cancelled" only when the server says so; a sign-in that already ended answers false. */
async function cancelFlow(ctx: Ctx, flow: Flow) {
  let answer;
  try {
    answer = await cancelOAuth(flow.state);
  } catch (e) {
    if (!failureNotice(e)) throw e;
    throw new Error(t("connect.cancel.failed", { reason: reason(e) }), { cause: e });
  }
  if (answer.cancelled !== false) end(ctx, flow.id, "cancelled");
}

/** End a session this page will not follow; nobody waits for the answer. */
const abandon = (state: string) => void cancelOAuth(state).catch(() => undefined);

async function begin(ctx: Ctx, provider: string, notOnServer: () => void) {
  const current = ctx.latest.get();
  if (current?.phase === "wait") await cancelFlow(ctx, current);
  if (!ctx.mounted.current) return;
  const seen = await credentialNames();
  if (!ctx.mounted.current) return;
  const r = await startOAuth(provider, isForwarded(provider)).catch((e: unknown) => {
    if (!(e instanceof ApiError && e.code === "provider_not_found")) throw e;
    notOnServer();
    throw new Error(t("connect.providers.notOnServer", { provider: label(provider) }));
  });
  if (!ctx.mounted.current) return abandon(r.state);
  const url = signInUrl(r.url, location.href);
  if (!url) {
    abandon(r.state);
    throw new Error(t("connect.start.unsafe"));
  }
  const now = Date.now();
  commit(ctx, {
    id: ++sequence,
    provider,
    url,
    state: r.state,
    device: r.flow === "device",
    userCode: r.user_code,
    expiresAt: r.expires_in ? now + r.expires_in * 1000 : undefined,
    seen,
    phase: "wait",
    problem: "",
    found: false,
    account: null,
    read: null,
    at: now,
    callbackNotice: null,
    reread: null,
  });
}

async function sendCallback(ctx: Ctx, address: string) {
  const flow = ctx.latest.get();
  if (flow?.phase !== "wait") return;
  await submitOAuthCallback(flow.provider, address);
  const now = ctx.latest.get();
  if (now?.id === flow.id && now.phase === "wait")
    update(ctx, flow.id, { callbackNotice: notify("info", t("connect.callback.sent")) });
}

/**
 * The page's sign-in. Writes go through the page's `action`, one at a time; `pressed` names the
 * control whose write is pending. Leaving the page cancels a waiting sign-in.
 */
export function useSignIn(action: Action) {
  const queryClient = useQueryClient();
  const quota = useQuota();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [latest] = useState(latestFlow);
  const [gone, addGone] = useGone();
  const [pressed, setPressed] = useState("");
  const mounted = useRef(false);
  const { beforeSignOut } = useSession();
  const ctx: Ctx = { latest, setFlow, mounted, quota, queryClient };
  const status = useSignInStatus(flow, flow?.phase === "wait", (id, answer) =>
    onAnswer(ctx, id, answer),
  );
  // Leaving the page or signing out cancels a waiting sign-in. Signing out runs this before the
  // session drops its key, which the cancel request needs.
  useEffect(() => {
    mounted.current = true;
    const leave = () => {
      mounted.current = false;
      const left = latest.get();
      latest.set(null);
      if (left?.phase === "wait") abandon(left.state);
    };
    const stop = beforeSignOut(leave);
    return () => {
      stop();
      leave();
    };
  }, [latest, beforeSignOut]);
  const run = (control: string, work: () => Promise<unknown>) =>
    action.run(async () => {
      setPressed(control);
      try {
        await work();
      } finally {
        setPressed("");
      }
    });
  return {
    flow,
    gone,
    busy: action.busy,
    /** The time the code expiry counts from: the latest status read. */
    polledAt: status.dataUpdatedAt,
    /** Why the latest status read failed; the sign-in keeps waiting. Null while reads succeed. */
    statusError: status.isError ? status.error : null,
    retryStatus: () => void status.refetch(),
    pending: pressed,
    start: (provider: string) => run(provider, () => begin(ctx, provider, () => addGone(provider))),
    cancel: () =>
      run("cancel", async () => {
        const current = latest.get();
        if (current?.phase === "wait") await cancelFlow(ctx, current);
      }),
    sendCallback: (address: string) => run("callback", () => sendCallback(ctx, address)),
    tryAgain: () =>
      run("tryAgain", async () => {
        const current = latest.get();
        if (current?.phase !== "refused" || !current.account) return;
        const wait = quota.wait(current.account);
        if (wait) notify("info", t("connect.result.readRecently", { time: span(wait) }));
        else await verify(ctx, current.id, current.account);
      }),
    /** Reread the account list after it failed; the sign-in itself is not started again. */
    reread: () =>
      run("reread", async () => {
        const current = latest.get();
        if (current?.phase !== "ok" || !current.reread) return;
        await confirm(ctx, current.id, current.account, current.found);
      }),
  };
}

export type SignIn = ReturnType<typeof useSignIn>;
