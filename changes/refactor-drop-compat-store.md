Removed

- The config database has one schema (version 4), created whole on an empty file. Databases at schema versions 1 to 3 are no longer upgraded: opening one, or any other version, fails with `config database schema N is not supported by this build` and leaves the file unchanged, including its permissions, journal mode and any `-wal` and `-shm` files.
