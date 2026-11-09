**Size report** for `776f2f0`: every measurement within its ceiling. No `master` baseline: no successful CI run of a push to master before this run. ([run](https://github.com/prep-cook/gnocchi/actions/runs/123456789))

#### Dashboard bundle, gzip

| Metric | `master` | This PR | Change | Ceiling | Room |
|---|--:|--:|--:|--:|--:|
| Initial JS | — | 334.1 KB | — | 360.0 KB | 7.2% |
| Initial CSS | — | 47.8 KB | — | 55.0 KB | 13.1% |
| Largest lazy chunk (`plots-B1QdKRpU.js`) | — | 105.9 KB | — | 120.0 KB | 11.8% |
| All JS | — | 946.2 KB | — | none | — |
| All CSS | — | 55.8 KB | — | none | — |

**Not measured in this run**

- Release binary and idle with 1 auth file: not run (the changed paths do not reach it)
- Idle with 2,000 auth files: not run (the changed paths do not reach it)

<sub>Ceilings: `bench/budgets.txt` and `ui/tools/size-budget.json`; raising one needs a maintainer's approval. Baseline: the latest successful CI run of a push to `master` before this run.</sub>
<!-- gnocchi-size-report -->
