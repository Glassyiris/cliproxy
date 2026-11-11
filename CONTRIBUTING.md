# Contributing to cook-router

## Before you start

- For a larger change, open an issue first so we can agree on the approach.

## Commits and pull request titles

Pull requests are squash-merged: the pull request title becomes the commit subject on `master`, and GitHub appends the number, as in `fix(ui): keep Overview tiles whole on a phone (#41)`. The description stays on the pull request, so write why there.

- Write the title as `type(scope): subject`, where type is a change category (`feat`, `fix`, `refactor`, `test`, `style`, `chore`, `docs`, `deps`, `ci`, `release`) and scope is one of the SCOPES in `.github/scripts/pr-title.py`.
- The subject is an English imperative phrase starting in lower case, such as `retry a reset Claude stream once`, with no full stop. A first word such as `OAuth` keeps its case.
- The whole title fits in 72 characters.
- Commit subjects follow the same `type(scope): subject` grammar. Each commit stands alone; fixups are squashed before pushing, not pushed as `fixup!` commits.
- The `Changes` workflow checks the title and reruns when you edit it. `python3 -I .github/scripts/pr-title.py '<title>'` runs the same check locally. The type and scope lists live in that script.

## Issues

See `.github/ISSUE_TEMPLATE/` for bug and feature request forms.

By contributing you agree that your work is released under the [GNU Affero General Public License, version 3 or later](LICENSE).
