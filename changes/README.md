# Changelog fragments

For each pull request, add one Markdown file named after the branch slug: replace `/` and other non-alphanumeric characters with `-`, use lowercase, and collapse repeated hyphens. For example, `fix/relay-timeout` becomes `changes/fix-relay-timeout.md`.

The first line is one of `Added`, `Changed`, `Fixed`, `Removed`, `Security`, or `Internal`. Follow it with one or more `- ` bullet lines, each describing a change. Blank lines are allowed. Do not add a PR number: the renderer looks up the commit that added the fragment. A fragment written after its PR merged (a backfill) ends each bullet with `(#N)` naming that PR, and the renderer keeps it.

```markdown
Fixed

- The relay stops waiting when the upstream request times out.
- Retrying a timed-out request opens a new upstream connection.
```

```markdown
Internal

- Contributors write changelog fragments instead of editing the shared Unreleased section.
```

Write each bullet for the person who runs cook-router: say what they see change. Use `Internal` for contributor-facing changes. Fragments are grouped as Added, Changed, Fixed, Removed, Security, then Internal, with filenames sorted within each group. `README.md` is not a fragment.

## When a fragment is required

A PR that touches a shipped path must add a new fragment. Shipped paths are:

- `crates/`
- `ui/src/`, `ui/dist/`, `ui/public/` and `ui/index.html`
- `Dockerfile`
- `vendor/`
- `Cargo.toml` and `Cargo.lock`

These do not require one:

- Tests: `crates/*/tests/`, `crates/*/examples/`, and `*.test.ts`, `*.test.tsx`, `*.spec.ts` and `*.spec.tsx` files.
- Documentation: `*.md` except `CHANGELOG.md`, and `docs/`.
- Everything outside the list above, such as `bench/`, `harness/`, `ui/scripts/`, `tools/` and `.github/`.

A PR that also changes a shipped path still needs a fragment. Modifying or renaming an existing fragment does not count. Maintainers can apply the `no-changelog` label when an entry is unnecessary.

The `Changes` workflow ([`changes.yml`](../.github/workflows/changes.yml)) validates every added or changed fragment from the PR head with the release parser, including fragment-only PRs and PRs labeled `no-changelog`. An invalid fragment fails with its filename and the parser's reason. The workflow runs again when a label is added or removed.

## Preview, check and release

From the repository root, with Python 3 (standard library only):

```sh
python3 -I tools/changelog.py render
```

This prints the generated `## [Unreleased]` section without changing files. Install and authenticate [GitHub CLI](https://cli.github.com/) to include PR numbers. The renderer uses `gh api repos/{owner}/{repo}/commits/{sha}/pulls` for the commit that added each fragment and prefers a merged PR when GitHub returns several. If Git history or GitHub is unavailable, it warns on stderr and leaves the number out.

```sh
python3 -I tools/changelog.py check
python3 -I tools/changelog.py check --base origin/master --head HEAD
```

The first form parses every fragment in `changes/`. The second also compares the branch with its merge base and applies the shipped-path rule; add `--label no-changelog` to simulate the label. The parser's tests run with `python3 -I -m unittest discover -s tools`.

To collect fragments for a release:

```sh
python3 -I tools/changelog.py release 0.5.0 2026-12-01
```

This creates `## [0.5.0] - 2026-12-01` in `CHANGELOG.md`, updates its comparison links, and deletes the consumed fragments. The Unreleased heading and fragment note remain. It refuses to overwrite handwritten Unreleased entries. Review warnings before publishing: offline release entries have no PR numbers. Commit the changelog and fragment deletions with the other release changes; this command does not update `Cargo.toml` or create a tag.
