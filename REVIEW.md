# REVIEW.md: reviewing a change (frontend and backend)

Name this file in every review brief. It defines review method; development rules live in root `AGENTS.md`, directory `AGENTS.md` files and `REQUIREMENTS.md`.

## Rule priority

Apply root Rule priority. Hard limits and money/login invariants outrank structure or style; style never blocks a higher-goal fix.

## Before you start

- Review read-only; do not edit, commit, rebase or push the branch.
- Record target base, branch head and merge-base SHAs. Review the fixed `base...head` diff, not moving branch tips.
- Read root and applicable directory rules plus `REQUIREMENTS.md`, then the change plan/brief, then recorded owner rulings. A ruled behaviour is not a finding.
- Finish your own pass before reading other reviews, bot comments or PR discussion. Then check missed findings, deduplicate and identify their sources.
- Use the independent/fresh-context reviewer required by root Model usage.

## Scope

- Check risk class against the diff. Underclassification is the first finding; review at the correct class.
- Review the change, not pre-existing defects. Separately list existing defects made reachable by this change.
- If the plan has a change map, match it both ways against the diff. A missing planned node or unplanned file is the first finding.
- Recommend "rewrite this, do not patch it", naming the function, when the shape no longer holds: a third patch at the same place, no expressible invariant, or callers needing special cases after the fix.

## Every finding has evidence

- Behaviour findings need a reproduction: failing test, scratch-database query, command/output or running-app scenario.
- Structure findings may use precise reading. Give `path:line` for every covered place, search command/output with real inputs, and what would break if a deletion claim were wrong.
- Reading-only evidence supports Medium at most. Higher severity needs reproduction, except when triggering the behaviour cannot be safe even in disposable isolation because it requires a real upstream, production-only state or destruction of others' data. Then give a complete input-to-effect static trace with every branch condition and label it "static, not reproduced: <reason>"; retain the severity the trace supports.
- Pass-bar items block through the pass bar, not severity. Report what was run and observed.
- Put unsupported suspicions in Hypotheses with a command that would settle them; they are not findings.
- Spend reproduction effort in proportion to risk and severity. If reproducing a suspected issue costs more than writing the change, use Hypotheses unless it is High-risk.
- Check reachability before reporting. Count exactly the claimed thing, not a wider set such as comments mentioning a call.

## Severity proves itself

| Severity | Meaning | Required evidence |
| --- | --- | --- |
| Blocker | Money lost/created, account takeover, secret/card exposure, data destruction or production unable to run | Trigger path with input/state/effect; reproduction or the complete static-trace exception |
| High | The same classes behind a reachable precondition, or a core flow failing for a whole class of users | Trigger path and reproduction or the static-trace exception |
| Medium | Limited real defect: recoverable lockout, operator-visible wrong value, security weakness needing another failure | Reproduction, or precise reading for structure |
| Low | Correct but fragile, misleading or untidy | Reproduction or precise reading |

Downgrade severity without a supporting trigger path. Removing a protection intentionally within scope is not a finding unless the author missed a consequence; name that consequence.

## Pass bar

Block a pass unless the author explains the case-specific reason for:

- keeping complexity a clearly simpler design would remove;
- moving a file above measured repository p90 without explaining why it stays whole;
- inserting a special case that makes an existing path harder to read;
- scattering feature checks through shared code for a local problem;
- adding wrappers, conversions or optional layers without clarity;
- duplicating an existing helper or wrapping/rewriting a platform/dependency mechanism;
- scripts, service units or workflows longer than comparable peers without reasons for the extra lines;
- comments restating code or denser than surrounding code;
- logic in the wrong layer.

Correct behaviour means no regression, not automatic approval. Until p90 is measured on the source set defined in `REQUIREMENTS.md`, "Numbers", report the missing baseline rather than inventing a size threshold.

## Checking against the rules

Check applicable `ui/AGENTS.md` and `crates/AGENTS.md` groups one by one.

- Layout: open phone/desktop screenshots in every theme with real data. Measure edges, gaps and title positions; empty/error-boundary shots do not count.
- Copy/i18n: run the existing i18n check and read changed strings in every locale.
- Accessibility: tab through the changed flow and measure contrast.
- Money/state: reproduce on a real private database with repeated/concurrent requests and out-of-order callbacks. Mocks alone do not prove a money path.
- Authorization: call changed endpoints from the wrong role and surface; check explicit public-route declarations.
- Sensitive data: plant a card number or dummy secret through each changed free-text path and search every log, including database logs.
- Schema and config changes: a fresh database and a fresh config work; every caller moved to the new form and no fallback for the old form remains.
- Local setup: flag renamed environment variables, new key files/paths, port/container changes or one-time setup steps that break other developers' runs.
- Feature flags: names, routes and messages behind a disabled flag are neither visible nor callable.
- Newly reachable defects: list separately from new defects.

## Review guidelines

Inspect the project contracts in this order; report findings by severity:

- Apply root `AGENTS.md`: callers migrate in the same change (opening paragraph) and goldens follow "History"; Go parity is not a target.
- Check passthrough bytes under backend APIs and modularity, secret boundaries under Security, and test isolation under Verification. A user's database is not the disposable real SQLite instance required for proof.
- For Claude changes, inspect system blocks, tool order and definitions, message content, cache_control placement, headers and beta flags, field order and whitespace. Flag any byte change before the last cache breakpoint unless the PR description declares its effect on existing sessions' prompt caching. Flag keepalive or other extra inference requests.
- For credential/config changes, inspect backend Security and Money and state: masking and documented plaintext surfaces, destination-bound retained secrets, atomic publication, refresh rotation and one snapshot per request.
- For lock, refresh, reload and Home changes, inspect lock order, locks held across await or blocking I/O, waits shutdown cannot cancel, and state read before a lock and used after it.
- Inspect request preparation and YAML config loading for repeated rescans under backend Performance. Skip style nits covered by fmt and clippy.

Locate findings at the recorded head SHA; cite the recorded base SHA for prior behaviour. Root Reporting's `origin/master` convention applies to PR and issue claims about existing master behaviour.

## CI, docs and commits

- Check tier placement, job granularity, evidence that gates fail on planted violations and empty inputs, and the tier running each Enforcement command. File existence is all the requirements checker proves about a command.
- Check README, architecture and runbook updates against changed behaviour; commands, paths and numbers must match code.
- A deferred Due date extension or tagged-rule exclusion needs approval from an owner quoted in the commit body.
- Check root commit and PR rules and the human submitter's disclosure fields.

## Report

```text
Verdict: PASS | FIX FIRST | BLOCK
Base / head / merge-base: <sha> <sha> <sha>
Covered: files and flows read; Not read: what and why
Findings, by severity and then the order below:
  [severity] path:line, one-sentence defect
    scenario: input -> state -> wrong result
    evidence: command/test and result, or precise reading and search output
    wanted: smallest change closing it
Made reachable by this change (pre-existing defects): ...
Hypotheses: each with the command that would settle it
Over-design: against the pass bar
Deferred-options candidates: set-aside options and reasons
From other reviewers: findings learned after the independent pass
```

- BLOCK for any Blocker. FIX FIRST for any High/Medium or pass-bar item. PASS with only Lows, each fixed or deferred under root Workflow.
- Order by severity, then structural regression; deletable complexity; added branch complexity; boundary/contract problems; file/module size; readability.
- Keep high-confidence findings prominent. Do not bury one large problem under small ones, restate the diff or list passed checks.
