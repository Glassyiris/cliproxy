**Size report** for `776f2f0`: 3 measurements over their ceilings. Compared with `master` at `346e667`. ([run](https://github.com/prep-cook/cliproxy/actions/runs/123456789))

- **Binary 52.310 MB** (Release binary, Linux x86_64), ceiling 52.000 MB, `master` 45.859 MB
- **Crates in two or more versions 12** (Release binary, Linux x86_64), ceiling 11, `master` 11
- **Initial JS 361.2 KB** (Dashboard bundle, gzip), ceiling 360.0 KB, `master` 333.6 KB
- **not measured:** `.rodata` (Release binary, Linux x86_64)

#### Release binary, Linux x86_64

| Metric | `master` | This PR | Change | Ceiling | Room |
|---|--:|--:|--:|--:|--:|
| Binary | 45.859 MB | **52.310 MB** | +6.452 MB (+14.1%) | 52.000 MB | **over by 310.4 KB** |
| `.text` | 30.369 MB | 34.912 MB | +4.543 MB (+15.0%) | 35.000 MB | 0.3% |
| `.rodata` | 9.369 MB | **not measured** | — | 11.000 MB | — |
| Archive (`.tar.gz`) | 20.120 MB | 20.120 MB | 0 | 23.000 MB | 12.5% |
| Crates in two or more versions | 11 | **12** | +1 (+9.09%) | 11 | **over by 1** |

#### Dashboard bundle, gzip

| Metric | `master` | This PR | Change | Ceiling | Room |
|---|--:|--:|--:|--:|--:|
| Initial JS | 333.6 KB | **361.2 KB** | +27.6 KB (+8.26%) | 360.0 KB | **over by 1.2 KB** |
| Initial CSS | 47.8 KB | 47.8 KB | 0 | 55.0 KB | 13.1% |
| Largest lazy chunk (`plots-B1QdKRpU.js`) | 105.9 KB | 105.9 KB | 0 | 120.0 KB | 11.8% |
| All JS | 946.2 KB | 973.8 KB | +27.6 KB (+2.91%) | none | — |
| All CSS | 55.8 KB | 55.8 KB | 0 | none | — |

#### Idle, Linux, 1 auth file

| Metric | `master` | This PR | Change | Ceiling | Room |
|---|--:|--:|--:|--:|--:|
| Wakeups | 0 | 0 | 0 | 3 | 100.0% |
| CPU ticks | 0 | 0 | 0 | 1 | 100.0% |
| Threads | 6 | 6 | 0 | 6 | at the ceiling |
| RSS | 25,312 kB | 25,312 kB | 0 | 28,050 kB | 9.8% |

**Not measured in this run**

- Idle with 2,000 auth files: its report was ignored, see below

**Ignored reports**

- an artifact: `report artifact exceeds 1 MiB`
- `perf-2000.json`: `idle.linux.2000.rss_kb: value and ceiling must be nonnegative integers or null`

<sub>Ceilings: `bench/budgets.txt` and `ui/tools/size-budget.json`; raising one needs a maintainer's approval. Baseline: the latest successful CI run of a push to `master` before this run.</sub>
<!-- cliproxy-size-report -->
