Removed

- The config database has one schema (version 4), created whole on an empty file. Databases at schema versions 1 to 3 are no longer upgraded: opening one, or any other version, fails with `config database schema N is not supported by this build` and leaves the file unchanged, including its permissions, journal mode and any `-wal` and `-shm` files.
- Credentials and cooldowns are no longer imported from `oauth.auth-dir` (the Go `*.json` credential files and `.cds` cooldown files), and `oauth.auth-dir` no longer defaults to `~/.cli-proxy-api`, which is no longer created. Add credentials by signing in or through the Management API.
- The `oauth.auth-dir` setting is removed, since nothing reads it: import and every config write reject it as an unknown setting. Delete it from existing config files.
- A Claude login no longer looks for, merges or removes an older `claude-<email>.json` file of the same account; it writes and merges only the file of its own name.
