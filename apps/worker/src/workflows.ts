/**
 * Deterministic workflow code (Checkpoint 7, ADR-0003 §1).
 *
 * Everything in this file must be replay-safe: no clocks, no randomness, no I/O, no imports that reach the
 * database or the network. Temporal re-executes this code from history on every recovery, and any
 * nondeterminism here would make a restarted worker diverge from what already happened — which, for a
 * pipeline that commits canon, would mean re-running an effect that already took place.
 *
 * The orchestration shape is therefore small and explicit:
 *
 *   acquire lease → observe control → produce (one durable activity) → settle terminal state → release
 *
 * with pause/cancel delivered as signals and progress exposed as a query. The chapter pipeline's own
 * stages are NOT decomposed here; they live in Checkpoint 5's `produceChapter`, which keeps its Postgres
 * checkpoint log (`job_steps`). That division is deliberate: Temporal supplies durable timers, retries,
 * signals, history replay and restart recovery; Postgres supplies step-level idempotency so a retried
 * activity re-spends nothing. Re-expressing the pipeline as separate activities would fork the canon
 * invariants into a second, weaker implementation.
 */
import {
  ApplicationFailure,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { Activities } from './activities.js';
import {
  versioned,
  type ChapterWorkflowInput,
  type ChapterWorkflowProgress,
  type ChapterWorkflowResult,
} from './contracts.js';

/**
 * Retry policies, split by what a failure MEANS (reliability plan §2).
 *
 * A provider outage or a lost connection is worth retrying; a policy or validation failure is not, because
 * the same input will fail the same way and retrying only burns budget and delays the operator's decision.
 * These codes are the workflow layer's existing stable vocabulary, so the split is not a new taxonomy.
 */
const NON_RETRYABLE = [
  // Deterministic validation / policy refusals: the input must change first.
  'INTAKE_INVALID',
  'SPEC_INVALID',
  'ARC_PLAN_INVALID',
  'CONTRACT_INVALID',
  'SCENE_PLAN_INVALID',
  'SCENE_DRAFT_INVALID',
  'IDENTITY_UNPINNED',
  'POLICY_UNKNOWN',
  'PREVIOUS_CHAPTER_NOT_ACCEPTED',
  'EXTRACTION_REJECTED',
  'EXTRACTION_ENVELOPE_MISMATCH',
  'NOT_EXTRACTABLE',
  'SUMMARY_INVALID',
  'REVISION_LIMIT',
  'PATCH_REGRESSED',
  'PATCH_UNANCHORED',
  'APPROVAL_BLOCKED',
  'OUTPUT_LANGUAGE_FAILED',
  // Operator must act: an automatic retry would hide the decision.
  'BUDGET_EXHAUSTED',
  'SELECTION_REQUEST_CHANGED',
  // A contract-version mismatch means the wrong worker picked the task up.
  'ContractVersionUnsupported',
];

const { produceChapterActivity } = proxyActivities<Activities>({
  // Chapter production is long: the reliability plan allows 3 h for ChapterProduction, and the heartbeat
  // is what distinguishes a slow chapter from a dead worker.
  startToCloseTimeout: '3 hours',
  heartbeatTimeout: '60 seconds',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '30 seconds',
    backoffCoefficient: 2,
    maximumAttempts: 4,
    nonRetryableErrorTypes: NON_RETRYABLE,
  },
});

/** Short, non-heartbeating activities: control checks, lookups, lease and terminal bookkeeping. */
const quick = proxyActivities<Activities>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '500 milliseconds',
    maximumInterval: '5 seconds',
    maximumAttempts: 5,
    nonRetryableErrorTypes: ['ContractVersionUnsupported'],
  },
});

export const pauseSignal = defineSignal('pause');
export const resumeSignal = defineSignal('resume');
export const cancelSignal = defineSignal('cancel');
export const progressQuery = defineQuery<ChapterWorkflowProgress>('progress');

/**
 * Produce one chapter durably.
 *
 * Duplicate-start protection has two independent layers, because each covers a case the other cannot:
 * the deterministic workflow id with `WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE` stops the same logical
 * run starting twice, and the target lease stops a DIFFERENT run (a regeneration, say) from racing this
 * one on the same chapter.
 */
export async function chapterProductionWorkflow(
  input: ChapterWorkflowInput,
): Promise<ChapterWorkflowResult> {
  let phase: ChapterWorkflowProgress['phase'] = 'starting';
  let jobId: string | undefined;
  let acceptedCanonVersion: number | undefined;
  let lastStep: string | undefined;
  /**
   * Signal state in one mutable object rather than two `let` booleans.
   *
   * Signal handlers mutate this asynchronously, which TypeScript's control-flow analysis cannot see: with
   * plain locals it narrows each flag to `false` after initialization and then reports every later check
   * as unreachable — the same narrowing trap that once hid a write-after-disconnect in the SSE stream. A
   * property read is re-evaluated, which is the real semantics of a flag a signal can flip at any moment.
   */
  const signals = { pause: false, cancel: false };
  // Read through functions so each check is a fresh call: TypeScript narrows a property after one test and
  // would otherwise report later checks as unreachable, hiding a missed signal.
  const pauseRequested = (): boolean => signals.pause;
  const cancelRequested = (): boolean => signals.cancel;

  setHandler(progressQuery, () =>
    versioned({
      phase,
      chapterNo: input.chapterNo,
      jobId,
      acceptedCanonVersion,
      lastStep,
    }),
  );
  // Signals are idempotent by construction: they set a flag. A duplicate pause or cancel therefore
  // changes nothing, which is what lets the API deliver a signal without deduplicating first.
  setHandler(pauseSignal, () => {
    signals.pause = true;
  });
  setHandler(resumeSignal, () => {
    signals.pause = false;
  });
  setHandler(cancelSignal, () => {
    signals.cancel = true;
  });

  const existing = await quick.lookupJob(
    versioned({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      workflowId: workflowIdOf(input),
    }),
  );
  jobId = existing.jobId;

  const leaseResult = await quick.acquireChapterLease(
    versioned({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      chapterNo: input.chapterNo,
      workflowId: workflowIdOf(input),
    }),
  );
  if (!leaseResult.acquired || !leaseResult.lease) {
    // Another run owns this chapter. This is a result, not a failure: retrying would not help, and the
    // operator needs to be told which run is in the way.
    phase = 'lease_contended';
    return versioned({
      outcome: 'lease_held' as const,
      jobId,
      acceptedCanonVersion: undefined,
      ...(leaseResult.heldBy ? { heldBy: leaseResult.heldBy } : {}),
    });
  }
  const lease = leaseResult.lease;

  try {
    // A cancel or pause that arrives before any work begins is honoured here, so no chapter is started
    // only to be abandoned.
    if (jobId) {
      const before = await quick.checkControl(versioned({ jobId, step: 'workflow_start' }));
      if (before.stopped) {
        phase = before.control === 'cancel' ? 'cancelled' : 'paused';
        if (before.control === 'cancel') await quick.cleanupCancelled(versioned({ jobId, lease }));
        return versioned({
          outcome: phase === 'cancelled' ? ('cancelled' as const) : ('paused' as const),
          jobId,
          acceptedCanonVersion: undefined,
        });
      }
    }
    if (cancelRequested()) {
      phase = 'cancelled';
      if (jobId) await quick.cleanupCancelled(versioned({ jobId, lease }));
      return versioned({ outcome: 'cancelled' as const, jobId, acceptedCanonVersion: undefined });
    }
    // A pause requested before the run starts holds here rather than starting and stopping.
    if (pauseRequested()) {
      phase = 'paused';
      await condition(() => !pauseRequested() || cancelRequested());
      if (cancelRequested()) {
        phase = 'cancelled';
        if (jobId) await quick.cleanupCancelled(versioned({ jobId, lease }));
        return versioned({ outcome: 'cancelled' as const, jobId, acceptedCanonVersion: undefined });
      }
    }

    phase = 'producing';
    const produced = await produceChapterActivity(
      versioned({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        chapterNo: input.chapterNo,
        ids: input.ids,
        inputsRef: input.inputsRef,
        workflowId: workflowIdOf(input),
        lease,
        ...(input.failAfterStep ? { failAfterStep: input.failAfterStep } : {}),
        ...(input.stage ? { stage: input.stage } : {}),
      }),
    );
    jobId = produced.jobId;
    acceptedCanonVersion = produced.accepted?.canonVersion;
    lastStep = produced.steps.at(-1)?.step;

    // A cancel that arrives while the activity is running is observed INSIDE the run, at the next
    // `runStep` boundary, so it stops before the following unit of work. Reaching this point with an
    // accepted chapter therefore means the cancel lost the race with an atomic commit.
    //
    // That race has exactly one honest outcome. Canon has advanced, the chapter is accepted, and the
    // commit cannot be un-made by a control flag; reporting `cancelled` here would produce a state that
    // contradicts itself — a cancelled job whose canon is committed and whose chapter is accepted — and
    // an operator reading the job would believe no chapter exists. So a late cancel is reported as
    // `too_late`, the job settles as completed, and the accepted canon keeps its meaning.
    if (acceptedCanonVersion !== undefined) {
      phase = 'completed';
      await quick.finishJobActivity(
        versioned({
          jobId,
          status: 'completed' as const,
          detail: {
            chapter_no: input.chapterNo,
            canon_version: acceptedCanonVersion,
            llm_calls: produced.llmCalls,
            // Recorded so the late cancel is visible in the job's history rather than silently dropped.
            late_cancel_ignored: cancelRequested(),
          },
        }),
      );
      return versioned({
        outcome: cancelRequested() ? ('too_late' as const) : ('accepted' as const),
        jobId,
        acceptedCanonVersion,
      });
    }

    // Nothing was accepted, so a cancel observed here is safe to honour.
    const after = await quick.checkControl(versioned({ jobId, step: 'post_production' }));
    if (after.stopped && after.control === 'cancel') {
      phase = 'cancelled';
      await quick.cleanupCancelled(versioned({ jobId, lease }));
      return versioned({ outcome: 'cancelled' as const, jobId, acceptedCanonVersion });
    }

    if (produced.status === 'completed') {
      // Completed without an accepted canon version: a staged run (`contract_and_pack`) rather than a
      // full production.
      phase = 'completed';
      await quick.finishJobActivity(
        versioned({
          jobId,
          status: 'completed' as const,
          detail: { chapter_no: input.chapterNo, llm_calls: produced.llmCalls },
        }),
      );
      return versioned({ outcome: 'accepted' as const, jobId, acceptedCanonVersion });
    }
    if (produced.status === 'planned')
      return versioned({ outcome: 'planned' as const, jobId, acceptedCanonVersion });

    // `needs_attention` is a settled state requiring an operator decision, not a failure to retry.
    phase = 'failed';
    return versioned({ outcome: 'needs_attention' as const, jobId, acceptedCanonVersion });
  } catch (err) {
    if (isCancellation(err)) {
      phase = 'cancelled';
      // Cleanup must run even though the scope is cancelled, or the lease would be held until its TTL and
      // the partial artifacts would never be recorded as noncanonical.
      await CancellationScope.nonCancellable(async () => {
        if (jobId) await quick.cleanupCancelled(versioned({ jobId, lease }));
        await quick.releaseChapterLease(versioned({ lease }));
      });
      return versioned({ outcome: 'cancelled' as const, jobId, acceptedCanonVersion });
    }
    phase = 'failed';
    const failedJobId = jobId;
    if (failedJobId)
      await CancellationScope.nonCancellable(async () => {
        await quick.finishJobActivity(
          versioned({
            jobId: failedJobId,
            status: 'failed' as const,
            detail: { chapter_no: input.chapterNo },
          }),
        );
      });
    throw ApplicationFailure.fromError(err);
  } finally {
    // Releasing in `finally` returns the chapter promptly; the lease TTL covers the case where the worker
    // dies without running this at all.
    await CancellationScope.nonCancellable(async () => {
      await quick.releaseChapterLease(versioned({ lease }));
    });
  }
}

/**
 * The deterministic workflow id. It matches `workflowIdFor` in `@yeonjae/workflows` so the Temporal run
 * and the Postgres job are the same identity — which is what makes a resumed workflow find its existing
 * job and replay completed steps instead of starting a second one.
 *
 * Recomputed here from the input rather than imported, because workflow code must not import modules that
 * reach the database.
 */
export function workflowIdOf(input: {
  readonly projectId: string;
  readonly chapterNo: number;
}): string {
  return `chapter:${input.projectId}:${input.chapterNo}`;
}
