Removed

- Go-style single-dash flags (`-config`, `-tui`, `-flag=value`, `-bool=false`) are gone; use `--config`, `--tui` and the other double-dash forms. A repeated flag, a flag after an operand and `--bool=false` are parse errors, and a parse error now exits before any database opens.
- The `CLIProxyAPI Version: ...` banner on stdout is gone; the version is logged at startup.
