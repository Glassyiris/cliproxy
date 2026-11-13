Internal

- Add the shared mmap stream store with complete-record publication, pinned reader leases, read-based retention and bounded storage. Production inference remains on its existing path until the S1 execution cutover.
- Add the production-versus-heap storage gate with raw samples, comparison distributions, memory accounting, pinned total-cap and isolated ENOSPC workloads. Failed or missing rows return a nonzero exit status.
- Keep read-retention ownership on each stream to avoid process-wide reference-count contention on every delivered record.
- Avoid notification registration for ready records and redundant atomic read-modify-write during locked publication.
