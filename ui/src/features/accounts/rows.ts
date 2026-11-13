import { matchesWords } from "../../lib/search.ts";
import type { Credential, CredentialFields } from "../../lib/api/credentials.ts";
import {
  accountRow,
  buckets,
  credName,
  label,
  provider,
  type AccountRow,
  type Buckets,
  type Limits,
} from "../../lib/credentials.ts";

export interface Row extends Record<string, unknown> {
  /** File and auth index: one file can hold several accounts. Selection is kept by this key. */
  key: string;
  /** Go's credential id, which every per-credential route accepts; the open row in the hash. */
  id: string;
  account: Credential;
  provider: string;
  name: string;
  view: AccountRow;
  buckets: Buckets | null;
  /** Each bucket's span as the server writes it, oldest first. */
  times: string[];
}

export const rowKey = (a: Credential) => `${a.name}\u0000${a.auth_index}`;
const rowId = (a: Credential) => String(a.id || a.name);

/** What the tab's quota checker knows about an account, as accountRow reads it. */
type QuotaView = {
  limits: (a: Credential) => Limits;
  isLive: (a: Credential) => boolean;
  hasSource: (a: Credential) => boolean;
};

/** Every account, soonest weekly reset first, then by name. */
export function toRows(list: Credential[], quota: QuotaView, now: number): Row[] {
  const collator = new Intl.Collator();
  return list
    .map((a) => ({
      key: rowKey(a),
      id: rowId(a),
      account: a,
      provider: provider(a),
      name: credName(a),
      view: accountRow(a, quota.limits(a), quota.isLive(a), quota.hasSource(a), now),
      buckets: buckets(a),
      times: (a.recent_requests ?? []).map((b) => b.time),
    }))
    .sort((x, y) => x.view.next - y.view.next || collator.compare(x.name, y.name));
}

/** The inbox views: accounts that cannot serve now (the default), or every account. */
export type View = "needs" | "all";

/** Why an account cannot serve, as `credState` names it; the Overview cards link with these. */
const reasons = [
  "signIn",
  "unavailable",
  "error",
  "limited",
  "cooling",
  "disabled",
  "other",
] as const;

/**
 * The status filter (`show=`): it can serve, it serves with a window near its limit, or a reason.
 * The options partition the accounts: Ready leaves out the Low ones, which also serve.
 */
export const shows = ["ready", "low", ...reasons] as const;
export type Show = (typeof shows)[number];
export const isShow = (value: string | undefined): value is Show => shows.includes(value as Show);

export const hasShow = (row: Row, show: Show) =>
  show === "ready"
    ? row.view.ready && !row.view.low
    : show === "low"
      ? row.view.low
      : row.view.state.state === show;

/** The filters in the hash: family ("" is every family), view, status ("" is any) and search. */
export type Filters = { provider: string; view: View; show: Show | ""; search: string };

/**
 * What the row shows contains every word of `search`, ignoring case: name, email, note, file,
 * provider and plan, and the server's message, so "codex pro" or "429" finds what the list shows.
 */
export function matches(row: Row, search: string) {
  const a = row.account;
  const sub = row.view.sub;
  return matchesWords(
    [
      row.name,
      a.email,
      a.note,
      a.name,
      label(row.provider),
      a.id_token?.plan_type,
      sub?.kind === "detail" ? sub.text : null,
    ],
    search,
  );
}

/** The families with accounts, in the order their first account sorts. */
export const familiesOf = (rows: Row[]) => [...new Set(rows.map((r) => r.provider))];

/** Rows of the family that match the search and the status, before the view. */
export const inScope = (rows: Row[], f: Omit<Filters, "view">) =>
  rows.filter(
    (r) =>
      (!f.provider || r.provider === f.provider) &&
      (!f.show || hasShow(r, f.show)) &&
      matches(r, f.search),
  );

/** How many of `rows` each status filter keeps, and each family holds. */
export const countBy = <K extends string>(
  rows: Row[],
  keys: readonly K[],
  has: (r: Row, k: K) => boolean,
) => new Map(keys.map((k) => [k, rows.filter((r) => has(r, k)).length]));

export const inView = (rows: Row[], view: View) =>
  view === "all" ? rows : rows.filter((r) => !r.view.ready);

// Accounts that share one file change together: a delete removes the file. A runtime-only
// account has no file and stands alone.
const fileOf = (r: Row) => (r.account.runtime_only ? `\u0000${r.key}` : r.account.name);

/** Every file that holds a selected account, as all of that file's accounts. */
export function reach(rows: Row[], selected: ReadonlySet<string>): Row[][] {
  const files = new Map<string, Row[]>();
  for (const r of rows) {
    const f = fileOf(r);
    const group = files.get(f);
    if (group) group.push(r);
    else files.set(f, [r]);
  }
  return [...files.values()].filter((g) => g.some((r) => selected.has(r.key)));
}

/**
 * The accounts to switch to `disabled`: in every reached file where a selected account is not
 * yet in that state, each account not yet in it, so a shared file never ends half switched.
 */
export function toSwitch(files: Row[][], selected: ReadonlySet<string>, disabled: boolean) {
  const differs = (r: Row) => !!r.account.disabled !== disabled;
  return files
    .filter((g) => g.some((r) => selected.has(r.key) && differs(r)))
    .flat()
    .filter(differs);
}

/**
 * Selected rows the view does not show, and where they are: all in one family other than the one
 * filtered to (`provider`), or hidden by the filters (`provider` null).
 */
export function hiddenSelection(picked: Row[], shown: Row[], tab: string) {
  const visible = new Set(shown.map((r) => r.key));
  const hidden = picked.filter((r) => !visible.has(r.key));
  const other = hidden[0]?.provider;
  const onTab = !!tab && hidden.every((r) => r.provider === other && r.provider !== tab);
  return { count: hidden.length, provider: onTab ? other : null };
}

const numberFields = ["priority", "weight", "request_retry"] as const;
type NumberField = (typeof numberFields)[number];

/** The panel's fields form: the note, and whole numbers or null for "not set". */
export type FieldValues = { note: string } & Record<NumberField, number | null>;

export const fieldsOf = (a: Credential): FieldValues => ({
  note: a.note ?? "",
  priority: a.priority ?? null,
  weight: a.weight ?? null,
  request_retry: a.request_retry ?? null,
});

/** Only operator edits are sent, so a stale form cannot overwrite another operator's fields. */
export function fieldPatch(saved: FieldValues, values: FieldValues): CredentialFields {
  const patch: CredentialFields = {};
  if (values.note.trim() !== saved.note.trim()) patch.note = values.note.trim();
  for (const k of numberFields) {
    // An emptied field clears the override (Go deletes the key on null).
    if (values[k] !== saved[k]) patch[k] = values[k];
  }
  return patch;
}

export function pruneSelection(rows: Row[], selected: Set<string>): Set<string> {
  if (!selected.size) return selected;
  const keys = new Set(rows.map((r) => r.key));
  const kept = new Set([...selected].filter((key) => keys.has(key)));
  return kept.size === selected.size ? selected : kept;
}
