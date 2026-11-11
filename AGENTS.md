# Agent guidelines

这是给 AI agents 和人类贡献者的代码规范和审查指南。

## Landing a change

- **A change is either a fix or a feature.** A fix solves a bug or closes a gap against the spec; a feature adds new capability. Fixes are usually safe and welcome; features need discussion first.
- **For a larger change, open an issue first so we can agree on the approach.**
- **Write tests.** If the codebase already has tests for the area, add yours. If not, write one that shows the fix works.
- **Never merge with a failing or pending check.** The `master` ruleset requires `ci-ok`, `fragments` and `title`. Do not disable it to land a feature. If CI is red for a reason outside your change, fix that first in its own pull request.

## Code rules

- **Removing a screen or control also removes its message keys** in every locale. `npm run check` fails on unused keys.
- **A background task or thread stops with its owner.** Stop it on drop or shutdown and wait for it. A task that outlives its owner keeps writing into directories that tests then fail to delete (`DirectoryNotEmpty`). Wait on events (a channel, `Notify`, a file watcher), not on a polling timer. The idle server must stay within `bench/budgets.txt`: about three wakeups in the measured window. Raising a budget needs a maintainer's approval and a measured reason.
- **Title the pull request `type(scope): subject`.** The types, scopes and rules are in CONTRIBUTING.md under Commits and pull request titles. The title becomes the squash commit's subject.
- **Claims need their line.** A consequence stated in a PR or an issue names the code producing it, or is narrowed until it can; say what you did not check. Line numbers come from `origin/main`, not your working tree.
- **A check that could not run did not pass.** If a gate is missing, errors, or produces no output, say so; empty output reads exactly like a clean run.
- **Fix where the paths converge**, not where you first saw the failure: a guard on one loader leaves its siblings failing open.

## Review guidelines

- Be specific: quote the line, give the counter-example, link the doc.
- Prefer "Why X?" over "X is wrong"; code written by another maintainer or an experienced contributor can defend itself.
- Nitpicks are fine when labeled; blocking issues need "blocking:" or a clear implication that the change cannot land as written.
