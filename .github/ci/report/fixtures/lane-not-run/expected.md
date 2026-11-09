**Size report** for `776f2f0`: every measurement within its ceiling. Compared with `master` at `346e667`. ([run](https://github.com/prep-cook/gnocchi/actions/runs/123456789))

#### Dashboard bundle, gzip

| Metric | `master` | This PR | Change | Ceiling | Room |
|---|--:|--:|--:|--:|--:|
| Initial JS | 333.6 KB | 331.2 KB | -2.4 KB (-0.73%) | 360.0 KB | 8.0% |
| Initial CSS | 47.8 KB | 47.8 KB | +36 B (+0.08%) | 55.0 KB | 13.1% |
| Largest lazy chunk (`plots-B1QdKRpU.js`) | 105.9 KB | 105.9 KB | 0 | 120.0 KB | 11.8% |
| All JS | 946.2 KB | 943.1 KB | -3.1 KB (-0.33%) | none | — |
| All CSS | 55.8 KB | 55.8 KB | 0 | none | — |

**Not measured in this run**

- Release binary and idle with 1 auth file: not run (the changed paths do not reach it)
- Idle with 2,000 auth files: no report (the job ended with `failure`)

<sub>Ceilings: `bench/budgets.txt` and `ui/tools/size-budget.json`; raising one needs a maintainer's approval. Baseline: the latest successful CI run of a push to `master` before this run.</sub>
<!-- gnocchi-size-report -->
