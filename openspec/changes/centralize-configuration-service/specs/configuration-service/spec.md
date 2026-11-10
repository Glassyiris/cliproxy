## Purpose

Give every configuration and credential mutation one application-level owner that keeps memory, durable state and notifications coherent without periodic reconciliation.

## ADDED Requirements

### Requirement: One mutation authority while the service runs
The system SHALL admit every online persistent-state mutation through one owning application service. External clients, including CLI configuration imports and login persistence, SHALL use authenticated management interfaces; internal refresh, plugin and scheduler commands SHALL enter the same authority without requiring HTTP loopback. Callers SHALL NOT obtain a writable persistence backend that bypasses this authority.

#### Scenario: Online CLI changes configuration
- **WHEN** a CLI imports configuration while the selected service is running
- **THEN** the CLI submits the mutation to that service and observes its committed result
- **AND** the CLI does not open the selected database for direct mutation

#### Scenario: Online authentication or transport fails
- **WHEN** an online mutation cannot authenticate or complete its management request
- **THEN** the operation reports an error
- **AND** it does not retry by writing the database locally

#### Scenario: Internal refresh saves a token
- **WHEN** a server-owned refresh or plugin operation needs to persist a credential change
- **THEN** it submits an internal command to the owning service
- **AND** it does not independently combine SQL writes with its own runtime publication sequence

### Requirement: Multi-document CLI mutations remain atomic
An online CLI operation that saves several credential documents as one logical batch SHALL submit one validated command. Either all accepted documents SHALL commit or none SHALL commit; the adapter SHALL not emulate that behavior through independent per-file writes. The batch SHALL remain restricted to authorized managed credential targets and preserve original document bytes.

#### Scenario: A later document in a CLI batch is invalid
- **WHEN** a CLI submits a multi-document save whose later document fails validation or a relevant precondition
- **THEN** the service rejects the batch without partially changing earlier documents
- **AND** the client does not bypass the failure through local database writes

### Requirement: Queries use immutable in-memory state
After initialization, configuration/resource/history queries and credential-state queries served by the component SHALL read its in-memory state or authorized immutable views, not SQLite. A request that already holds a snapshot SHALL retain a coherent view when a later mutation publishes a new version.

#### Scenario: Persistence is unavailable during a read
- **WHEN** the initialized service receives a query while its persistence destination is temporarily unavailable
- **THEN** it can return the last committed in-memory state without opening SQLite
- **AND** it does not represent an uncommitted candidate as the current state

#### Scenario: A reader overlaps a slow save
- **WHEN** a query overlaps validation or disk persistence of a candidate mutation
- **THEN** the query reads the previous complete snapshot rather than waiting for disk work under the state read lock
- **AND** subsequent queries can read the new complete snapshot after publication

### Requirement: Commands validate and serialize complete transitions
The service SHALL serialize admitted mutations, check applicable resource or credential preconditions, and validate candidate state before persistent mutation. Existing dry-run, validation-error and stale-write behavior SHALL remain observable. Unrelated domain changes SHALL NOT invalidate a worker result whose relevant preconditions still hold.

#### Scenario: A resource precondition is stale
- **WHEN** a configuration mutation supplies an out-of-date revision precondition
- **THEN** the service rejects it with the existing precondition-failure behavior
- **AND** no durable state, current snapshot or subscriber state is changed by that command

#### Scenario: Candidate validation or a dry run does not commit
- **WHEN** a command is invalid or is explicitly a dry run
- **THEN** validation reports the result without publishing a persistent mutation
- **AND** the current state and change subscribers are not advanced

### Requirement: Successful commits publish one coherent current version
A successful persistent mutation SHALL satisfy the durability contract before the service replaces its current in-memory state and dispatches the corresponding notifications. A success response SHALL identify the resulting committed state. Saving to the working checkpoint alone SHALL NOT constitute success.

#### Scenario: Publication succeeds
- **WHEN** a valid mutation completes durable publication
- **THEN** the service installs its new in-memory state, dispatches the appropriate notifications, and reports success
- **AND** the response and supplied subscriber snapshot describe the same accepted version

#### Scenario: Durable publication fails
- **WHEN** a mutation cannot publish its durable snapshot
- **THEN** it reports failure without publishing the candidate as current or sending a successful-change notification
- **AND** later retry and restart recovery follow the documented persistence contract

### Requirement: Unpublished checkpoints cannot be superseded from stale state
After installing a checkpoint whose final publication fails, the service SHALL retain explicit pending recovery state and refuse ordinary mutation admission until that state has been durably published and reconciled. It SHALL NOT encode a later image from older accepted memory that discards required checkpoint data. Already-in-flight non-repeatable grants SHALL be preserved by the same owner against the latest pending checkpoint while keeping runtime admission conditional; starting new grant work and dispatch using a known-invalidated affected credential SHALL be paused.

#### Scenario: An unrelated mutation follows a failed token publication
- **WHEN** a provider replaces token R0 with R1, R1 is checkpointed, final publication fails, and an unrelated configuration mutation is attempted
- **THEN** the unrelated mutation is refused or deferred until pending publication is resolved
- **AND** it cannot publish a new full-state image containing only R0 in place of the required R1 data
- **AND** recovery/resolved publication retains R1 while runtime credential admission still checks its relevant registration preconditions

#### Scenario: Another granted result was already in flight
- **WHEN** a grant for a different credential completes while publication of the first checkpoint is pending
- **THEN** its required preservation is serialized by the same service against the latest pending state without erasing the first grant
- **AND** checkpoint preservation alone does not claim successful configuration publication or bypass runtime admission

#### Scenario: Pending publication is retried
- **WHEN** storage permits pending publication to complete
- **THEN** the service publishes and reconciles the latest retained checkpoint before admitting ordinary mutations
- **AND** an older accepted view never silently becomes the new persistence source

### Requirement: State domains retain their separate semantics
The common writer SHALL preserve distinct configuration, credential and cooldown semantics. Configuration-history restore SHALL affect configuration resources only. Secret-bearing credential data SHALL be exposed only to authorized consumers. A token grant that must be persisted before admission SHALL remain distinguishable from a credential admitted to runtime use.

#### Scenario: Configuration history is restored
- **WHEN** an earlier configuration revision is restored
- **THEN** the service creates a new configuration revision
- **AND** it does not resurrect a revoked or deleted credential

#### Scenario: Only cooldown state changes
- **WHEN** scheduler state needs persistence without a configuration change
- **THEN** it uses the common persistence authority
- **AND** ordinary configuration subscribers are not told that their configuration changed

#### Scenario: Scheduler feedback precedes a coalesced checkpoint
- **WHEN** live scheduler feedback changes before its background checkpoint is persisted
- **THEN** scheduling can use that volatile state while the canonical checkpoint still describes the last committed state
- **AND** eventual checkpoint persistence uses the common commit authority without claiming an ordinary configuration change

#### Scenario: A persisted grant is not admitted
- **WHEN** a granted token is durably recorded but its runtime registration precondition no longer holds
- **THEN** the service preserves the required grant data without presenting it as an accepted runtime credential update

### Requirement: The service owns callback subscriptions
The service SHALL own callback registration, delivery and unsubscription. It SHALL supply an immutable snapshot or authorized domain view, an associated version and a change category. Callback delivery SHALL preserve accepted version order, SHALL occur without holding the state read/write lock, and SHALL NOT require callbacks to reload ambient configuration. A failed callback SHALL be observable without undoing a durable commit or suppressing other subscribers.

#### Scenario: Two changes notify a subscriber
- **WHEN** two accepted changes affect a subscriber's domain
- **THEN** its callback is dispatched in accepted version order with the matching snapshot or domain view
- **AND** it never needs to reconstruct the event by querying a global configuration variable

#### Scenario: Registration overlaps publication
- **WHEN** a subscriber registers concurrently with a committed publication
- **THEN** registration provides an initial view and subsequent ordered callbacks without a gap that can lose the current state transition

#### Scenario: A subscriber exits or fails
- **WHEN** a subscriber unregisters, its owner exits, or its callback fails
- **THEN** the component does not retain an exited subscriber indefinitely
- **AND** callback failure does not prevent other current subscribers from being notified or roll back committed state

#### Scenario: A callback requests follow-up work
- **WHEN** a callback needs expensive processing or another mutation
- **THEN** it submits owned follow-up work rather than synchronously reentering the active mutation critical section

### Requirement: Offline writes require exclusive ownership
An offline command SHALL reuse the same validation, encoding and commit semantics and SHALL obtain exclusive ownership of the selected state before modifying it. A network failure alone SHALL NOT be treated as proof that the online owner has stopped.

#### Scenario: A service still owns the state
- **WHEN** an offline command attempts to mutate a state owned by a running service
- **THEN** direct mutation is refused and the command directs the caller to the online interface
- **AND** no competing live database or snapshot is created

#### Scenario: No service owns the state
- **WHEN** an offline command acquires exclusive ownership after the service has stopped
- **THEN** it can perform a mutation through the shared commit implementation and release ownership after completion

### Requirement: External file edits are not an online control interface
The running service SHALL NOT periodically hash, inspect metadata, query SQLite for changes, or install filesystem watchers to discover out-of-band edits. Supported online changes SHALL use the command authority; deliberate file restoration SHALL use the stopped-service recovery procedure.

#### Scenario: The service is idle
- **WHEN** no command or owned scheduled operation requires configuration work
- **THEN** the service performs no periodic configuration-file or SQLite reconciliation

#### Scenario: A user replaces the published file while running
- **WHEN** a user edits or replaces the published database without issuing an accepted command
- **THEN** the service does not automatically adopt that file as current state
- **AND** documented recovery guidance requires stopped-owner restoration rather than hidden hot reload
