import { useConfig, useConfigWrite } from "../../app/serverQueries.ts";
import { useAction } from "../../app/useAction.ts";
import { isList, kinds, rulesOf, storedRules, type Group, type Kind } from "./rules.ts";

const PAYLOAD_PATH = "requests/payload";
const rulesPath = (kind: Kind) => `${PAYLOAD_PATH}/${kind}`;

/** The rules as JSON in the Settings editor, for what the form here does not edit. */
export const editHref = `#settings?section=advanced&key=${PAYLOAD_PATH}`;

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
