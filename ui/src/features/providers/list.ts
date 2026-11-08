// The Provider keys list as Accounts filters its own: by family, by status, by a search, and the
// inbox views (the groups that need attention, or every group).
import { familyName, type Family } from "../../components/keyFamilies.ts";
import { isFailing, type Entry } from "./groups.ts";

/** A group's status, as the status filter (`show=`) names it. */
export const shows = ["ready", "someFailing", "failing", "noKeys", "disabled"] as const;
export type Show = (typeof shows)[number];
export const isShow = (value: string | undefined): value is Show => shows.includes(value as Show);

/** How many of the group's keys failed in the window: half or more of their requests failed. */
export const failingKeys = (entry: Entry) => entry.keys.filter((k) => isFailing(k.traffic)).length;

/** Switched off, holding no key, every key failing, some failing, or serving. */
export function showOf(entry: Entry): Show {
  if (entry.group.disabled) return "disabled";
  if (!entry.keys.length) return "noKeys";
  const failing = failingKeys(entry);
  if (failing === entry.keys.length) return "failing";
  return failing ? "someFailing" : "ready";
}

/** The inbox views: groups that cannot serve in full (the default, as on Accounts), or every group. */
export type View = "needs" | "all";

/** The filters in the hash: family ("" is every family), view, status ("" is any) and search. */
export type Filters = { provider: Family | ""; view: View; show: Show | ""; search: string };

/** Name or endpoint contains every word of `search`, ignoring case. */
function matches(entry: Entry, search: string) {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [entry.name, entry.group["base-url"], familyName(entry.family)]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Groups of the family that match the search and the status, before the view. */
export const inScope = (entries: Entry[], f: Omit<Filters, "view">) =>
  entries.filter(
    (e) =>
      (!f.provider || e.family === f.provider) &&
      (!f.show || showOf(e) === f.show) &&
      matches(e, f.search),
  );

export const inView = (entries: Entry[], view: View) =>
  view === "all" ? entries : entries.filter((e) => showOf(e) !== "ready");

/** How many of `entries` each key holds, `keyOf` naming an entry's key. */
export function countBy<K extends string>(entries: Entry[], keyOf: (e: Entry) => K) {
  const counts = new Map<K, number>();
  for (const e of entries) counts.set(keyOf(e), (counts.get(keyOf(e)) ?? 0) + 1);
  return counts;
}
