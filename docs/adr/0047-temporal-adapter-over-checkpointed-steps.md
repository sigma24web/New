# ADR-0047: Temporal orchestrates the proven chapter loop as a single durable activity, not as decomposed activities

- **Status:** Accepted
- **Date:** 2026-09-16
- **Deciders:** engineering agent (Checkpoint 7)
- **Relates to:** ADR-0003 (Temporal), ADR-0044 (modular monolith first), ADR-0046 (chapter-production
  implementation), workflow reliability plan `docs/06-system/04-workflow-reliability-plan.md`

## Context

ADR-0044 deferred Temporal to Checkpoint 7 "once the core loop is proven", and designed
`packages/workflows`' step contract so "each step can later become a Temporal activity without changing its
inputs/outputs". The core loop is now proven: Checkpoint 5 delivered `produceChapter` as
Postgres-checkpointed idempotent steps, and Checkpoint 6 proved a three-chapter accepted chain, the
failure-recovery suite and winner-only selection on top of it.

The literal reading of ADR-0044 §2 is that each `runStep` call should now become its own Temporal activity,
with the workflow re-expressing the pipeline's control flow. Implementing that revealed a problem worth
recording rather than absorbing silently.

The chapter pipeline's invariants are not distributed evenly across its steps; several are *relationships
between* steps:

- the previous-chapter gate must run before any model spend or canon write (ADR-0046, T17);
- approval must pin the selected winner, and canon acceptance must re-check it independently (B-6-4);
- extraction may only cite the manuscript version it was given, and the commit must be atomic against the
  canon version the delta was based on (ADR-0038, B-6-2);
- bounded revision, regression re-checks and the quarantine of losing candidates are a single decision
  procedure, not a sequence of independent effects.

Re-expressing that control flow in workflow code would create a **second implementation of the same
invariants**. Both would then have to be maintained in lockstep, and the first divergence between them would
be a canon defect — precisely the class of bug this project spends its design budget avoiding. It would also
mean Temporal workflow history became a second home for decisions currently recorded in `job_steps`, with
no single place to read what happened.

## Decision

1. **Temporal is adopted** at Checkpoint 7, as ADR-0003 and ADR-0044 intended. `apps/worker` runs a
   Temporal worker; `apps/api` and the CLI start and control chapter runs through it.
2. **The workflow orchestrates, it does not re-decide.** `chapterProductionWorkflow` is deliberately small:
   acquire the target lease → observe control intent → run production → settle the terminal state →
   release the lease. It contains no planning, drafting, evaluation, selection, extraction or commit logic.
3. **`produceChapter` is wrapped as one durable activity** and keeps its Postgres checkpoint log. Durability
   composes across the two layers rather than being duplicated:
   - Postgres (`job_steps`, content-addressed artifacts, gateway idempotency keys) gives **step-level
     exactly-once**: a retried or restarted activity replays completed steps and issues no duplicate
     provider call;
   - Temporal gives **run-level durability**: durable timers, typed retry policies, signal delivery,
     history replay, worker-restart recovery and cancellation scopes.
4. **Two independent duplicate-start defences**, because each covers a case the other cannot. The
   deterministic workflow id (`chapter:<project>:<n>`) with a reject-duplicate reuse policy stops the same
   logical run from starting twice. Migration 0008's **target leases** stop a *different* run — an operator
   regeneration, say — from racing the same chapter; leases carry a TTL so a dead worker cannot block a
   target forever, and a monotone **fence** so a revived holder cannot act after its lease was stolen.
5. **Activity contracts are versioned and carry no prose.** Only identifiers, hashes and counters cross the
   boundary; the story intake and bible are passed as content-addressed artifact ids and loaded by the
   activity. Workflow history therefore stays bounded and never becomes a second, unguarded copy of
   customer manuscript content. An unknown contract version is rejected, never reinterpreted.
6. **Failures are classified by meaning.** Provider and network faults retry with backoff; validation,
   policy, budget and selection refusals are non-retryable, because the same input fails the same way and
   retrying only spends budget while delaying the operator's decision.
7. **Control remains an intent observed at checkpoint boundaries.** Pause and cancel are signals; the
   workflow checks them *between* units of work, never inside one. A cancelled run therefore leaves no
   partial canon, and its artifacts are recorded noncanonical rather than deleted.
8. **No paid infrastructure in CI.** Tests run against Temporal's time-skipping test server, which the SDK
   downloads and runs locally, with every model call replayed from the frozen fixture.

## Consequences

- The Checkpoint 5/6 proofs keep their force: the code they exercise is unchanged and still the only path
  that writes canon. ADR-0044 §2's promise is honoured in the sense that mattered — the step contract did
  not have to change — while its literal decomposition is not applied, which is why this ADR exists.
- A future decomposition remains possible and is now cheaper: the workflow boundary, lease, control and
  contract-versioning scaffolding all exist, so splitting the activity later is a local change. It should be
  driven by a concrete need (per-stage retry policies, or stages that must run on differently sized
  workers), not by symmetry.
- Temporal history is not the system of record. Postgres remains it (ADR-0002); history is recovery
  metadata. `ResumeFromArtifactsWorkflow` from the reliability plan §3 is therefore not required for
  correctness at this checkpoint: a lost namespace loses no committed state, and a re-started run resumes
  from `job_steps`.
- The reliability plan's per-activity timeout table is applied at the granularity that now exists: one
  3-hour start-to-close for the production activity with a 60-second heartbeat timeout (the plan's §1
  value), rather than per-role timeouts. Per-role timeouts return with a future decomposition.

## Alternatives considered

- **Decompose every step into an activity now.** Rejected: it duplicates the canon invariants in workflow
  code for no capability the combined Postgres + Temporal design lacks, and it puts a second copy of the
  decision record in workflow history.
- **Skip Temporal and keep Postgres checkpoints alone.** Rejected: it leaves no durable timer, no signal
  delivery, no supervised retry and no worker-restart recovery for a run as a whole — the reliability plan
  §2 failure catalogue assumes all four, and ADR-0003 is an accepted decision that Checkpoint 7 is the
  point at which it lands.
- **Adopt Temporal only for new workflows (export, correction) and leave chapter production on the CLI
  path.** Rejected: it splits operational behaviour, so an operator would have two different pause/cancel
  semantics depending on which surface started the work.
