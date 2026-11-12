## Purpose

Keep concurrent work explicit, bounded and owned so components can share immutable state safely and isolated jobs cannot depend on hidden mutable configuration.

## ADDED Requirements

### Requirement: Execution placement follows the work
The current server SHALL host its configuration service within its existing single-process, multithreaded application. Network and other nonblocking waits SHALL use asynchronous work; blocking encoding/storage work SHALL not stall asynchronous request scheduling. Additional operating-system processes SHALL require an external-program or isolation reason, not merely a desire to parallelize configuration access.

#### Scenario: Configuration is read from multiple threads
- **WHEN** concurrent requests query configuration in the running server
- **THEN** they obtain safe immutable in-process views without cross-process shared structures or a per-query database connection

#### Scenario: A snapshot is encoded while requests are served
- **WHEN** snapshot encoding or filesystem synchronization takes appreciable time
- **THEN** it runs as owned blocking work without holding the configuration read lock or blocking the network scheduler

### Requirement: Isolated computation uses explicit input and output
A computation assigned to an isolated worker SHALL receive all variable business inputs explicitly and return an explicit result or error. It SHALL NOT consult a global runtime, mutable configuration singleton, existing live database, implicit current directory, or undeclared environment/filesystem input to determine its result. Only data needed by that job SHALL cross the boundary, and secret data SHALL not be included or logged without a legitimate need.

#### Scenario: Ambient configuration changes during computation
- **WHEN** an isolated job is running and the owner's current configuration changes
- **THEN** that job's computation remains based on its supplied input
- **AND** the owner, not the worker, decides whether the output is still applicable

#### Scenario: An encoder runs without access to the old database
- **WHEN** an isolated encoding job receives a complete state snapshot but has no existing database available
- **THEN** it can produce the new database image from that input alone

### Requirement: Result admission checks relevant versions
Jobs whose output can mutate state SHALL identify the input state, resource or credential preconditions on which they depend. The authoritative owner SHALL check those preconditions before admitting the result. A result SHALL not overwrite a newer registration or resource merely because computation finished later; changes unrelated to its actual preconditions SHALL not automatically invalidate it.

#### Scenario: A credential is replaced while its refresh runs
- **WHEN** a refresh completes after the relevant credential registration was replaced
- **THEN** the owner rejects stale runtime admission while preserving any separately required grant-persistence semantics

#### Scenario: An unrelated setting changes
- **WHEN** a job's relevant resource version remains current despite an unrelated configuration change
- **THEN** result admission evaluates the relevant preconditions instead of rejecting it solely because some global counter advanced

### Requirement: Every concurrent resource has an owner
Every background task, worker thread, child process and subscription SHALL belong to an explicit component lifetime. Ownership SHALL include stopping admission, cancellation where safe, awaiting or joining termination, and cleanup of handles/subscriptions. Merely starting work or requesting cancellation SHALL not count as waiting for it to stop.

#### Scenario: A component shuts down
- **WHEN** a component begins shutdown
- **THEN** it stops admitting work and waits for its owned tasks, threads and child processes to settle
- **AND** no detached writer continues using directories that the owner has deleted

#### Scenario: A subscription owner exits
- **WHEN** a subscribing component is destroyed or stopped
- **THEN** its owned registration is released without a process-global callback retaining the component indefinitely

### Requirement: Shutdown preserves critical persistence sections
Cancellation SHALL distinguish work that can be discarded from work already responsible for a non-repeatable effect or a commit/publication sequence. Shutdown SHALL stop new work but allow required critical persistence to settle before workspace deletion or success acknowledgement.

#### Scenario: A grant or commit is already in flight
- **WHEN** shutdown reaches a refresh that has consumed a token grant or a mutation that has entered durable publication
- **THEN** the owner waits for the required persistence outcome rather than releasing its resources beneath the writer

#### Scenario: Pure computation is cancelled
- **WHEN** a computation with no admitted external effects is no longer needed
- **THEN** its owner can cancel or discard it and collect its process/task outcome without changing current state

### Requirement: Side effects stay at explicit integration boundaries
The application SHALL separate state transformation and encoding from network, filesystem and process-launch adapters. Function callbacks SHALL receive the snapshot and version they need instead of rereading ambient state. If a future explicitly approved design crosses process boundaries, it SHALL exchange serialized messages and invoke callbacks locally rather than treating function pointers or thread-safe structures as cross-process memory.

#### Scenario: A publication callback updates a component
- **WHEN** a callback receives a committed snapshot
- **THEN** it bases reconfiguration on that supplied snapshot and owns any follow-up effects or tasks

#### Scenario: A worker needs external input
- **WHEN** a computation requires information from a file, network operation or environment setting
- **THEN** an explicit adapter obtains or declares that input and passes it into the computation
- **AND** the worker does not acquire hidden access to the owner's mutable configuration
