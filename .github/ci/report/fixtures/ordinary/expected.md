**Size report** for `776f2f0`: every measurement within its ceiling. Compared with `master` at `346e667`. ([run](https://github.com/prep-cook/cliproxy/actions/runs/123456789))

#### Release binary, Linux x86_64

| Metric | `master` | This PR | Change | Ceiling | Room |
|---|--:|--:|--:|--:|--:|
| Binary | 45.859 MB | 45.875 MB | +16.3 KB (+0.04%) | 52.000 MB | 11.8% |
| `.text` | 30.369 MB | 30.383 MB | +14.0 KB (+0.05%) | 35.000 MB | 13.2% |
| `.rodata` | 9.369 MB | 9.371 MB | +2.0 KB (+0.02%) | 11.000 MB | 14.8% |
| Archive (`.tar.gz`) | 20.120 MB | 20.126 MB | +6.1 KB (+0.03%) | 23.000 MB | 12.5% |
| Crates in two or more versions | 11 | 11 | 0 | 11 | at the ceiling |

#### Dashboard bundle, gzip

| Metric | `master` | This PR | Change | Ceiling | Room |
|---|--:|--:|--:|--:|--:|
| Initial JS | 333.6 KB | 334.1 KB | +419 B (+0.13%) | 360.0 KB | 7.2% |
| Initial CSS | 47.8 KB | 47.8 KB | 0 | 55.0 KB | 13.1% |
| Largest lazy chunk (`plots-B1QdKRpU.js`) | 105.9 KB | 105.9 KB | 0 | 120.0 KB | 11.8% |
| All JS | 946.2 KB | 946.7 KB | +473 B (+0.05%) | none | — |
| All CSS | 55.8 KB | 55.8 KB | 0 | none | — |

#### Idle, Linux, 1 auth file

| Metric | `master` | This PR | Change | Ceiling | Room |
|---|--:|--:|--:|--:|--:|
| Wakeups | 0 | 0 | 0 | 3 | 100.0% |
| CPU ticks | 0 | 0 | 0 | 1 | 100.0% |
| Threads | 6 | 6 | 0 | 6 | at the ceiling |
| RSS | 25,312 kB | 25,440 kB | +128 kB (+0.51%) | 28,050 kB | 9.3% |

#### Idle, Linux, 2,000 auth files

| Metric | `master` | This PR | Change | Ceiling | Room |
|---|--:|--:|--:|--:|--:|
| Wakeups | 0 | 0 | 0 | 3 | 100.0% |
| CPU ticks | 1 | 1 | 0 | 1 | at the ceiling |
| Threads | 6 | 6 | 0 | 6 | at the ceiling |
| RSS | 77,420 kB | 77,388 kB | -32 kB (-0.04%) | 85,241 kB | 9.2% |

<sub>Ceilings: `bench/budgets.txt` and `ui/tools/size-budget.json`; raising one needs a maintainer's approval. Baseline: the latest successful CI run of a push to `master` before this run.</sub>
<!-- cliproxy-size-report -->
