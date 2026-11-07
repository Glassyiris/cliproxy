/** routing.strategy values, with a one-line explanation each. `rust`: offered only by cliproxy-rs. */
export const strategies = [
  { value: "round-robin", name: "Round robin", rust: false, help: "Takes the accounts in turn, one request each." },
  { value: "fill-first", name: "Fill first", rust: false, help: "Uses one account until it cools down or reaches a limit, then moves to the next." },
  {
    value: "weighted-round-robin",
    name: "Weighted round robin",
    rust: false,
    help: "Takes the accounts in turn in proportion to each account's weight, set on Accounts.",
  },
  {
    value: "soonest-reset",
    name: "Soonest reset first",
    rust: true,
    help: "Uses the account whose weekly limit resets soonest until it cools down or uses up a window, then moves to the next. Conversations bound to an account stay on it. This is the default.",
  },
] as const;
/** The strategy a configured value selects, aliases included, as the server reads it: unset is soonest reset on cliproxy-rs (`rust`) and round robin on Go; anything else is round robin. */
export function strategy(value: unknown, rust: boolean): (typeof strategies)[number] {
  const v = String(value ?? "").trim().toLowerCase() || (rust ? "soonest-reset" : "round-robin");
  const alias: Record<string, string> = {
    rr: "round-robin", roundrobin: "round-robin", ff: "fill-first", fillfirst: "fill-first",
    wrr: "weighted-round-robin", weightedroundrobin: "weighted-round-robin", "reset-first": "soonest-reset",
  };
  return strategies.find((s) => s.value === (alias[v] || v)) || strategies[0];
}
