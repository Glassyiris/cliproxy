import { useConfig, useConfigWrite } from "../../app/serverQueries.ts";
import { useAction } from "../../app/useAction.ts";
import type { Group } from "./RuleTable.tsx";
import { isList, kinds, rulesOf, storedRules, type Kind } from "./rules.ts";

const rulesPath = (kind: Kind) => `requests/payload/${kind}`;

/** The config's payload rules as groups, and the one write that replaces a kind's list. */
export function useRules() {
  const config = useConfig();
  const action = useAction();
  const write = useConfigWrite(action);

  const groups: Group[] | undefined = config.data
    ? kinds.map((kind) => {
        const stored = storedRules(config.data, kind);
        return { kind, entries: rulesOf(stored), notList: !isList(stored) };
      })
    : undefined;

  // The stored value is checked here too, so a rule is never written over a value that is not a
  // list, whichever dialog asked.
  const change = async (kind: Kind, next: (entries: unknown[]) => unknown[], success: string) => {
    if (!config.data) return false;
    const stored = storedRules(config.data, kind);
    if (!isList(stored)) return false;
    return write(rulesPath(kind), next(rulesOf(stored)), success);
  };

  return { config, action, groups, change };
}
