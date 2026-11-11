Fixed

- Claude preserved-thinking requests now recover from rejected conversation prefixes instead of returning a 400. If upstream `drop_block` handling is insufficient, the executor retries once without completed historical thinking while preserving the active tool-use cycle and required custom beta headers.
