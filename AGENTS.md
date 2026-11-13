# AGENTS.md: development rules

Every agent planning, writing or reviewing a change follows this file and the applicable files below.
If you are deploying cooker rather than developing it, stop here: it ships only as a Docker image, described in the README.

cooker is an efficient AI gateway. Its focus is request routing and credential scheduling, built from clear modules with a sound structure; judge every feature and design by how it serves that focus. It began as a full rewrite of CLIProxyAPI and no longer tracks it. Go behaviour is not a target: change routes, config, response shapes and the Management API when a better design calls for it, and migrate every caller (dashboard, TUI, tests, docs) in the same change.

## Rule priority

Within a level, the more specific rule wins, then the newer owner statement.
The owners are Zakkaus, xz-dev, Glassyiris and JohnsonRan. Any one is an owner for rulings and production-step approval. Publishing a release or replacing Core's running proxy additionally requires Vayun's explicit approval.
Record each owner ruling with its date and quote under "Settled" in `docs/OPEN-QUESTIONS.md`; a ruling that grants an exception also gets a row in `REQUIREMENTS.md`, "Exceptions".

1. Hard limits: the Secrets rules below; explicit approval from an owner for each production step; no live-upstream test traffic without approval from an owner; no bypassing signing, review or gates. A flaky-test quarantine needs an owner and a date.
2. An owner's explicit instruction for the current task.
3. Recorded owner rulings. A ruled behaviour is not a finding or a question to reopen.
4. Repository files: `REQUIREMENTS.md` decides numbers, gates and exceptions; this file decides rules; directory `AGENTS.md` files govern their directories.
5. Shared skills, templates and tool defaults.

Weigh competing goals in order: correctness and security of money and login; stored-data integrity; agreed schedule; smallest change; consistency; polish.
A higher goal permits only the smallest change that meets it. Record unresolved conflicts in `docs/OPEN-QUESTIONS.md` and ask an owner.

## Where the rules live

| File | Read by | Holds |
| --- | --- | --- |
| `AGENTS.md` | every agent | priority, hard limits, workflow, reporting, writing, commits |
| `.github/AGENTS.md` | CI authors; name it in briefs for gate scripts outside `.github/` | tiers and gate rules |
| `crates/AGENTS.md` | backend authors; also name it in harness, benchmark and backend deployment briefs | workspace boundaries, APIs, state, security, operations |
| `ui/AGENTS.md` | frontend authors | components, layout, loading, i18n, accessibility |
| `REVIEW.md` | reviewers; name it in every review brief | review method and report |
| `REQUIREMENTS.md` | everyone | numbers, gates, exceptions, dated enforcement gaps |

Each directory's `CLAUDE.md` imports its `AGENTS.md`. For tools that load only the root rules, name the applicable directory rules in the brief.

Write each rule once. Put mechanically checkable rules in gates; reserve judgment for review.
For a Core telemetry deployment, follow `docs/CLAUDE-CACHE-TELEMETRY.md`, "Deployment check".

## Scope

- Supported targets: the server on Linux and the dashboard in current browsers. Add no code, CI jobs or packaging for other platforms.
- The release artifact is a Docker image published to GitHub Packages. Provide no installer in any form, including scripts run inside a container.
- Apply rules to features the project has. Record inapplicable groups with their reason in `REQUIREMENTS.md`.
- Add no features, abstractions or tests merely to satisfy this checklist. "If present" applies only to an existing feature.
- Keep numbers, commands and exceptions in `REQUIREMENTS.md`; it wins on those values.
- Every `###` heading in a checked rule file has an exact `path: heading` Enforcement row. Use that heading level only for rule groups.
- A rule needing a separate gate because failure loses money, an account, a secret or data gets a rule tag and its own `path#id` Enforcement row.

## History

- The port froze at CLIProxyAPI v8.0.35, commit `ae3ee3be303fb07fb8173279923413005bf32177`. Comments citing Go paths explain origins, not a continuing compatibility requirement.
- Existing Go goldens and comparison tests pin unchanged behaviour. Update or delete a golden when its contract changes; no entry in `docs/DIFFERENCES-FROM-GO.md` is required, because that document records differences predating the split.

## Layout

`Cargo.toml` lists current workspace members and dependencies. `crates/AGENTS.md` defines their responsibility boundaries.
`ui/` is the dashboard. `harness/` sends the same requests to Go and Rust and compares them.

## General (every change)

### Change risk

Classify by what can break, not by file type. Take the higher class when uncertain; no class relaxes a hard limit.

| Class | Examples | Plan | Proof | Review |
| --- | --- | --- | --- | --- |
| Low | copy, docs, styling, test-only changes | commit message | touched-area checks | own diff read and automated checks |
| Medium | feature, API change, refactor | short PR plan | changed-behaviour tests and impact check | one fresh-context diff review |
| High | money, login, security, migration, deletion | written plan reviewed before coding | failing regression test, every behaviour hunk ablated, integration against touched dependencies using a real disposable database or upstream sandbox | independent review under Model usage |

### Workflow

- Plan scope, impact and verification to the risk class before coding.
- Keep working across milestones when a dependency can run in the background.
- Make a real improvement with the smallest coherent change: no over-engineering, over-fixing or shortcuts.
- Fix where the paths converge, not where the failure first appeared: a guard on one loader leaves siblings failing open.
- Before release, fix a Low only when it is reachable, causes concrete harm (money lands wrong, a secret reaches storage or logs, or one mistyped command can damage production), and has a small fix.
- Record set-aside findings and options in `docs/DEFERRED-OPTIONS.md` with source, reason and reconsideration trigger. Record unresolved decisions in `docs/OPEN-QUESTIONS.md`. An owner decides deferred options after release.

### When unsure

- Fix verified defects inside the agreed scope, then report them.
- Leave intentionality and out-of-scope decisions to an owner.
- Continue unblocked work while questions are open. Ask together at a stopping point; ask immediately only when all work is blocked.
- Check reachability first. Give unreachable states no design.

### Waiting

- Use one background wait or completion notification with a long timeout; do other work meanwhile.
- With several jobs and a wake-up facility, check all statuses together at the interval in `REQUIREMENTS.md`. Record completed, failed and stuck jobs in the job's STATE file, a progress record the orchestrator keeps outside the repository.
- A wake-up reads status and returns to work, rather than waiting on a job. Use minutes, not seconds.
- At the configured timeout, record a stuck step's state and move on.

### Reporting

- Report commands actually run, their results and what remains unverified.
- A check that could not run did not pass. Report missing gates, errors and empty output; do not present silence as a clean run.
- Evidence must cover real content: pages showing only an error boundary prove nothing.
- Claims need their line. A consequence in a PR or issue names the code producing it, or is narrowed until it can. Cite `origin/master` lines for claims about existing master behaviour; review findings cite the recorded head SHA under `REVIEW.md`.

### Code quality

- Keep logic readable and idiomatic; remove dead code, duplicate code, debug output, temporary files and useless comments.
- Use a newer library or language feature only when it removes code or a known defect; name that benefit in the PR.
- Match existing style unless an owner sets another convention.
- Mark deliberate simplifications with a `ponytail:` comment naming the ceiling and upgrade path.

### Impact and edge cases

- Check affected callers and other areas; preserve intentional designs recorded in `REQUIREMENTS.md`.
- Handle reachable edges without excessive defensive code.

### Secrets

Keep secrets, tokens, credentials and card numbers out of logs, source and client storage (localStorage, sessionStorage, IndexedDB, and cookies readable by script). Upstream credentials and client keys never reach logs or the wrong side.

### Performance baseline

- Measure before a rewrite or optimization; results must not regress. Measure both versions on the same host, record its load, and repeat before claiming a difference.
- Performance and memory claims come from `docs/BENCHMARKS.md`. `bench/run.sh`, `bench/messages.sh` and `bench/latency.sh` reproduce its scripted workloads; field observations are labelled and are not reproducible on demand.
- Existing size ceilings have headroom. Raise a ceiling only for a measured need, with approval from an owner and the reason beside the source value.

### Tests (if present)

- Keep tests lean and focused on critical paths. Backend isolation rules are in `crates/AGENTS.md`, "Verification".
- A bug fix includes a test that fails without it. If a test cannot cover the change, explain why and give the verification command.
- Demonstrate a new check failing on a planted violation before counting it as a gate.
- For fixes with multiple behaviour hunks, ablate each hunk and require a failing test. High-risk changes ablate every hunk; other changes report any omitted ablations. A one-hunk failing regression test already supplies this proof.
- Test limits and tier placement belong in `REQUIREMENTS.md`.
- Run baseline measurements, full verification gates and browser end-to-end checks on a machine that can hold them; on small machines run the affected crate or filter (`crates/AGENTS.md`, "Verification").

### Merging

`master` has no required checks while the project is unstable, so CI results inform a merge but do not block it.

- Merge after the risk-class review. Read the CI results first; when a check fails, name it and its cause in the PR, and fix a failure the change caused before merging. Fix unrelated red CI in its own PR.
- Follow `CONTRIBUTING.md` for squash merging.
- A visible UI change waits until an owner has seen screenshots or a preview. A release waits for the approval in Rule priority.
- Before opening a PR, run the final-tree pre-PR commands in `REQUIREMENTS.md`, "Commands", and read their results. Split a change too large to check that way.

### Model usage

- The orchestrator chooses models; sub-agents do not choose their own.
- Rank by importance: strongest for money, login, risk and architecture; next tier for non-core code and UI specs; cheaper tier for fully specified mechanical work, search and log triage. Verify cheaper-tier output before trusting it.
- Use a different model family for High-risk review, or an owner when only one family is available. Other reviews use a fresh context without the writer's history.
- When a request names a model and effort, put the full requested id and effort in the brief and launch command. Within the first minute, verify the served model id against the request and stop a mismatched run.
- Update STATE at each long-job milestone. Hand off from STATE when context exceeds the recorded limit or the agent rereads known files or repeats a failed step. Prefer phase boundaries; a job fitting one context needs no handoff.

### Documentation

- Update the README, architecture and runbook descriptions in the same change as behaviour.
- When a PR touches a shipped path, add `changes/<branch-slug>.md` as `changes/README.md` describes; do not edit `CHANGELOG.md` in a PR.
- A dependency change updates every generated file in the same PR: `Cargo.lock`, `harness/rust/Cargo.lock` (CI refuses stale state with `--locked`), and `THIRD-PARTY-NOTICES`.
- Generate notices with `python3 -I tools/third-party-notices.py`; install cargo-about 0.9.3 with `--features cli` and run `npm ci` in `ui/` first.

### Writing (docs, comments, reports, PR and issue text)

- Lead with the result, failure, decision or required action. Give each sentence one action, result, reason or constraint; name actor and object and use one term per concept.
- Verify commands, paths, options, versions, defaults and performance claims. Label unverified statements.
- Delete introductions, recaps, repeated conclusions, filler and promotional adjectives. Avoid decorative emoji, walls of bold and em-dash rhythm.
- Use sequential headings naming tasks or subjects. Give a page one reader goal and one document type: tutorial, how-to, reference or explanation.
- Open a README with what the project is, installation and the shortest successful use.
- Comments state contracts or reasons code cannot express: invariants, security boundaries, compatibility constraints or workarounds. Delete restatements and follow the repository's comment language.
- Chinese documents use one script, spaces between CJK and Latin letters or digits, established technical terms and the reader's locale vocabulary, including Taiwan wording for zh-TW.
- Interface labels name actions. Errors say what happened and what to do next; members do not see upstream detail. The operator-detail exception is recorded in `REQUIREMENTS.md`, "Exceptions".

### Commits and pull requests

- One logical change per PR and per commit. Formatting and import reordering go in their own PR.
- Title PRs and commits `type(scope): subject`, using the types, scopes and English imperative grammar in `CONTRIBUTING.md`. The PR title becomes the squash subject; its length limit is in `REQUIREMENTS.md`.
- Bodies explain the prior failure, why the change is correct, what callers must change and issue id. Leave out work diaries and routine test reports; verification belongs in the PR.
- Sign every commit. Fix a stuck signing agent rather than bypassing it. Use message files with `git commit -F` and PR body files with `--body-file`; do not override git config on the command line.
- The human who submits the change is the commit author. Agents add no model or tool attribution (trailers, generated-with text, session links). The PR template's disclosure checkboxes are for the human submitter; agents leave them unticked.
- Squash `fixup!` and `squash!` commits before pushing.
- Fill in the PR template. Put risk class and diff evidence first under Problem, followed by the failure or need and its cause. Explain the change, correctness and caller changes under How I fixed it. Put exact risky-path verification commands, results and remaining limits under Verified. Omit social closings.

## Both sides

### Frontend–backend mapping (when both exist)

- Every frontend call reaches an existing backend endpoint.
- Record a reason for every endpoint without a frontend caller in `REQUIREMENTS.md`, "Exceptions". Add UI or remove endpoints only when no valid reason exists.
- Map error codes and statuses to the correct notification levels.
- Browser requests stay on the project's origin; third-party calls go through the backend.
