Internal

- The stalled credential write test checks its queued reload against the bytes the scan read, as production reloads do, so it no longer fails when the reload runs after the queued write of another credential.
