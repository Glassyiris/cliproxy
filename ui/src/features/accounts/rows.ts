import type { Credential, CredentialFields } from "../../lib/api/credentials.ts";
import {
  accountRow,
  buckets,
  credName,
  provider,
  type AccountRow,
  type Buckets,
  type Limits,
} from "../../lib/credentials.ts";

/** One account in the table. */
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
}

export const rowKey = (a: Credential) => `${a.name}\u0000${a.auth_index}`;
const rowId = (a: Credential) => String(a.id || a.name);

/** What the tab's quota checker knows about an account, as accountRow reads it. */
export type QuotaView = {
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
    }))
    .sort((x, y) => x.view.next - y.view.next || collator.compare(x.name, y.name));
}

export const shows = ["ready", "low", "attention"] as const;
export type Show = (typeof shows)[number];
export const isShow = (value: string | undefined): value is Show => shows.includes(value as Show);

/** The filters in the hash: provider tab ("" is All), quick filter and search text. */
export type Filters = { provider: string; show: Show | ""; search: string };

/** Name, email or note contains every word of `search`, ignoring case. */
export function matches(row: Row, search: string) {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const a = row.account;
  const text = [row.name, a.email, a.note, a.name].filter(Boolean).join("\n").toLowerCase();
  return words.every((w) => text.includes(w));
}

/** The provider tabs: each provider in list order, with its account count. */
export function providerCounts(rows: Row[]) {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.provider, (counts.get(r.provider) ?? 0) + 1);
  return [...counts];
}

/** Rows in the provider tab that match the search, before the quick filter. */
export const inTab = (rows: Row[], f: Pick<Filters, "provider" | "search">) =>
  rows.filter((r) => (!f.provider || r.provider === f.provider) && matches(r, f.search));

export const shownRows = (tab: Row[], show: Filters["show"]) =>
  show ? tab.filter((r) => r.view[show]) : tab;

// Accounts that share one file change together: a delete removes the file, and a plugin
// source's status change reaches every account it expands to (Go auth_files_fields.go
// patchPluginVirtualSourceStatus). A runtime-only account has no file and stands alone.
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
 * Selected rows the view does not show, and where they are: on one other provider's tab
 * (`provider`), or hidden by the filters (`provider` null).
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

/** The fields to write: the trimmed note, each set number, and null for a number emptied. */
export function fieldPatch(a: Credential, values: FieldValues): CredentialFields {
  const patch: CredentialFields = { note: values.note.trim() };
  for (const k of numberFields) {
    const v = values[k];
    // An emptied field clears the override (Go deletes the key on null).
    if (v !== null) patch[k] = v;
    else if (a[k] !== undefined) patch[k] = null;
  }
  return patch;
}
