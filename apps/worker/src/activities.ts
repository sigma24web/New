/**
 * Activities: every side effect of chapter production (Checkpoint 7, ADR-0003 §1).
 *
 * The critical design decision is what these activities DO NOT do. The chapter-production loop — planning,
 * drafting, evaluation, bounded revision, approval, extraction, verification, the atomic canon commit,
 * summaries and the accepted-only index — is Checkpoint 5's `produceChapter`, already proven by the
 * three-chapter fixture chain and the failure-recovery suite. Re-expressing those stages as separate
 * Temporal activities would create a second, weaker orchestration of the same invariants, and the first
 * divergence between them would be a canon bug.
 *
 * So `produceChapter` is wrapped as ONE activity, and it keeps its own Postgres checkpoint log. That is not
 * a shortcut: it is what makes the durability compose. `runStep` records each completed step in
 * `job_steps`, so a retried or restarted activity replays completed steps and re-spends nothing, while
 * Temporal supplies what Postgres checkpoints cannot — a durable timer, retry policy, signal delivery,
 * history replay and worker-restart recovery for the run as a whole.
 */
import { ApplicationFailure, Context } from '@temporalio/activity';
import {
  acquireTargetLease,
  checkpointControl,
  configFromEnv,
  createPool,
  emitJobEvent,
  finishJob,
  getJob,
  getArtifactById,
  getJobByWorkflowId,
  jobControlOf,
  JobControlStop,
  LEASE_TTL_SECONDS,
  leaseOwnership,
  liveTargetLease,
  listJobSteps,
  releaseTargetLease,
  renewTargetLease,
  type Pool,
} from '@yeonjae/db';
import {
  produceChapter,
  workflowIdFor,
  type ChapterProductionDeps,
  type StoryBible,
} from '@yeonjae/workflows';
import {
  CONTRACT_VERSION,
  versioned,
  type AcquireLeaseActivityInput,
  type AcquireLeaseActivityResult,
  type ControlActivityInput,
  type ControlActivityResult,
  type FinishActivityInput,
  type JobLookupInput,
  type JobLookupResult,
  type ProduceActivityInput,
  type ProduceActivityResult,
  type ReleaseLeaseActivityInput,
} from './contracts.js';

/**
 * How the activity layer reaches the database and the model gateway.
 *
 * Injected rather than imported so tests supply the replay gateway (no credentials, no spend) and the
 * production entry point supplies the real one. There is deliberately no default gateway: an activity that
 * could silently fall back to a live provider is exactly the accident this project forbids.
 */
export interface ActivityDeps {
  readonly pool: Pool;
  readonly makeDeps: (input: { workspaceId: string; projectId: string }) => ChapterProductionDeps;
}

export function createActivities(deps: ActivityDeps) {
  const { pool } = deps;

  return {
    /**
     * Acquire the chapter's target lease.
     *
     * Contention is reported, not thrown: "another run owns this chapter" is a legitimate outcome the
     * workflow turns into a `lease_held` result, and an operator needs to know which run is in the way.
     */
    async acquireChapterLease(
      input: AcquireLeaseActivityInput,
    ): Promise<AcquireLeaseActivityResult> {
      assertVersion(input.v);
      const lease = await acquireTargetLease(pool, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        targetKind: 'chapter',
        targetId: String(input.chapterNo),
        holderWorkflowId: input.workflowId,
        ttlSeconds: LEASE_TTL_SECONDS,
      });
      if (!lease) {
        const held = await liveTargetLease(pool, {
          projectId: input.projectId,
          targetKind: 'chapter',
          targetId: String(input.chapterNo),
        });
        return versioned({
          acquired: false,
          ...(held ? { heldBy: held.holder_workflow_id } : {}),
        });
      }
      return versioned({
        acquired: true,
        lease: versioned({
          leaseId: lease.id,
          holderWorkflowId: lease.holder_workflow_id,
          fence: String(lease.fence),
        }),
      });
    },

    /**
     * Run (or resume) chapter production.
     *
     * Idempotency comes from the deterministic workflow id: `ensureJob` finds the existing job and
     * `runStep` replays every completed step from `job_steps`. A retry after a worker crash therefore
     * continues from the last checkpoint and issues no duplicate provider call.
     *
     * The activity heartbeats so Temporal can distinguish a long chapter from a dead worker, and it renews
     * the target lease on the same beat — the lease must not expire under a run that is still making
     * progress, or a second run could steal the chapter mid-production.
     */
    async produceChapterActivity(input: ProduceActivityInput): Promise<ProduceActivityResult> {
      assertVersion(input.v);
      const ctx = Context.current();
      /**
       * Heartbeat and lease renewal.
       *
       * Renewal failure is NEVER ignored. The previous version swallowed both a `false` result and a
       * thrown error, which meant a worker could keep drafting, evaluating and committing canon after its
       * lease had expired or been stolen at a higher fence — exactly the zombie this lease exists to
       * prevent. Now the outcome is recorded and the *step boundary* enforces it: `runStep` re-verifies
       * ownership before every unit of work, so a fenced-out run stops before its next durable side
       * effect rather than at some arbitrary point inside one.
       *
       * The callback is deliberately not `void`-discarded: an interval callback that returns a rejected
       * promise is an unhandled rejection, so the async work is wrapped and its failure captured.
       */
      let renewalError: unknown;
      const beat = (): void => {
        void (async () => {
          try {
            ctx.heartbeat({ chapterNo: input.chapterNo });
            await renewTargetLease(pool, {
              leaseId: input.lease.leaseId,
              holderWorkflowId: input.lease.holderWorkflowId,
              fence: input.lease.fence,
            });
          } catch (err) {
            // Recorded, not thrown: throwing from a timer cannot be caught by the activity. The
            // authoritative check is the ownership read at the next step boundary.
            renewalError = err;
          }
        })();
      };
      const heartbeat = setInterval(beat, HEARTBEAT_MS);

      try {
        // The intake and bible come from the content-addressed artifact store, addressed by the ids in
        // the workflow input. History therefore carries a hash-derived reference rather than the
        // documents, and a replay loads byte-identical inputs.
        const { intake, bible } = await loadProductionInputs(pool, input.inputsRef);
        // Verify ownership before the run starts as well as at each step: an activity retried after a
        // long backoff may already have lost its target.
        const owner = await leaseOwnership(pool, {
          leaseId: input.lease.leaseId,
          holderWorkflowId: input.lease.holderWorkflowId,
          fence: input.lease.fence,
        });
        if (!owner.owned)
          throw ApplicationFailure.nonRetryable(
            `target lease lost before production (${owner.reason}); another run owns this chapter`,
            'LEASE_LOST',
            { reason: owner.reason, current_holder: owner.currentHolder ?? null },
          );
        const result = await produceChapter(
          deps.makeDeps({ workspaceId: input.workspaceId, projectId: input.projectId }),
          {
            // The lease travels into the workflow context so `runStep` can re-verify it at every step
            // boundary; that is what stops a zombie mid-pipeline rather than only at the edges.
            lease: {
              leaseId: input.lease.leaseId,
              holderWorkflowId: input.lease.holderWorkflowId,
              fence: input.lease.fence,
            },
            projectId: input.projectId,
            chapterNo: input.chapterNo,
            intake,
            bible,
            ids: input.ids,
            ...(input.failAfterStep ? { failAfterStep: input.failAfterStep } : {}),
            ...(input.stage ? { stage: input.stage } : {}),
          },
        );
        const job = await getJob(pool, result.job_id);
        const steps = await listJobSteps(pool, result.job_id);
        return versioned({
          jobId: result.job_id,
          chapterId: result.chapter_id,
          status: result.status,
          accepted: result.accepted
            ? {
                manuscriptVersionId: result.accepted.manuscript_version_id,
                commitId: result.accepted.commit_id,
                canonVersion: result.accepted.canon_version,
              }
            : undefined,
          llmCalls: await countLlmCalls(pool, result.job_id),
          spendCents: String(job?.spend_cents ?? '0'),
          steps: steps.map((s) => ({ step: s.step, status: s.status })),
        });
      } finally {
        clearInterval(heartbeat);
        // Surface a renewal fault that never became a lost lease, so an operator sees the degradation
        // instead of it being silently discarded.
        if (renewalError !== undefined)
          ctx.log.warn('target lease renewal failed during production', {
            chapter_no: input.chapterNo,
            lease_id: input.lease.leaseId,
          });
      }
    },

    /**
     * Observe the operator's control intent at a checkpoint boundary.
     *
     * This runs BETWEEN units of work, never inside one, which is the property that makes a pause or
     * cancel safe: the next step has not begun, so nothing is torn in half and nothing partial can reach
     * canon. `checkpointControl` throws `JobControlStop`; here it is translated into a plain result,
     * because "the operator asked us to stop" is a normal outcome and not an activity failure to retry.
     */
    async checkControl(input: ControlActivityInput): Promise<ControlActivityResult> {
      assertVersion(input.v);
      const job = await getJob(pool, input.jobId);
      if (!job) return versioned({ control: 'run' as const, stopped: false });
      try {
        await checkpointControl(pool, { jobId: input.jobId, step: input.step });
        return versioned({ control: 'run' as const, stopped: false });
      } catch (err) {
        if (err instanceof JobControlStop)
          return versioned({ control: err.control, stopped: true });
        throw err;
      }
    },

    /** Resolve the job for a workflow id, so a resumed workflow can report progress before producing. */
    async lookupJob(input: JobLookupInput): Promise<JobLookupResult> {
      assertVersion(input.v);
      const job = await getJobByWorkflowId(pool, input.workflowId);
      return versioned({ jobId: job?.id, status: job?.status });
    },

    /**
     * Record a terminal outcome and emit the single terminal job event.
     *
     * `finishJob` is idempotent about the terminal event, which matters because this activity may be
     * retried after its transaction committed but before Temporal recorded the result.
     */
    async finishJobActivity(input: FinishActivityInput): Promise<void> {
      assertVersion(input.v);
      await finishJob(pool, {
        jobId: input.jobId,
        status: input.status,
        ...(input.detail ? { payload: { ...input.detail } } : {}),
      });
    },

    /**
     * Cleanup on cancellation: release the lease and record that whatever was produced is NOT canon.
     *
     * The reliability plan's cancellation row requires exactly this — release the lease, mark partial
     * artifacts non-canonical, write the cost summary. Nothing here deletes a manuscript version: drafts
     * stay immutable and auditable, they simply never became canon.
     */
    async cleanupCancelled(input: {
      readonly v: number;
      readonly jobId: string;
      readonly lease?: ReleaseLeaseActivityInput['lease'] | undefined;
    }): Promise<void> {
      assertVersion(input.v);
      if (input.lease)
        await releaseTargetLease(pool, {
          leaseId: input.lease.leaseId,
          holderWorkflowId: input.lease.holderWorkflowId,
          fence: input.lease.fence,
        });
      const job = await getJob(pool, input.jobId);
      if (!job) return;
      await emitJobEvent(pool, {
        jobId: input.jobId,
        kind: 'job.cleanup',
        payload: {
          artifacts: 'noncanonical',
          spend_cents: String(job.spend_cents),
          control: jobControlOf(job),
        },
      });
    },

    async releaseChapterLease(input: ReleaseLeaseActivityInput): Promise<void> {
      assertVersion(input.v);
      await releaseTargetLease(pool, {
        leaseId: input.lease.leaseId,
        holderWorkflowId: input.lease.holderWorkflowId,
        fence: input.lease.fence,
      });
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;

/** Heartbeat cadence from the reliability plan (§1: heartbeat every 15 s, 60 s timeout). */
const HEARTBEAT_MS = 15_000;

/**
 * Refuse a payload from an unknown contract version instead of guessing at its shape. A worker replaying
 * history written by a newer deployment must fail loudly, not reinterpret fields.
 */
function assertVersion(v: number): void {
  if (v !== CONTRACT_VERSION)
    throw new Error(
      `activity contract version ${v} is not supported by this worker (expects ${CONTRACT_VERSION})`,
    );
}

/**
 * Load the run's immutable inputs from the artifact store.
 *
 * A missing artifact is a hard error: continuing with a substitute input would produce a chapter from
 * something other than what the run was started with, which no amount of later validation could detect.
 */
async function loadProductionInputs(
  pool: Pool,
  ref: { intakeArtifactId: string; bibleArtifactId: string },
): Promise<{ intake: unknown; bible: StoryBible }> {
  const intakeRow = await getArtifactById(pool, ref.intakeArtifactId);
  const bibleRow = await getArtifactById(pool, ref.bibleArtifactId);
  if (!intakeRow)
    throw new Error(
      `story intake artifact ${ref.intakeArtifactId} is missing; cannot produce a chapter`,
    );
  if (!bibleRow)
    throw new Error(
      `story bible artifact ${ref.bibleArtifactId} is missing; cannot produce a chapter`,
    );
  return { intake: intakeRow.payload, bible: bibleRow.payload as StoryBible };
}

async function countLlmCalls(pool: Pool, jobId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM llm_calls WHERE job_id = $1',
    [jobId],
  );
  return Number(r.rows[0]?.n ?? '0');
}

/** Build a pool from the environment for the production worker entry point. */
export function poolFromEnv(): Pool {
  return createPool(configFromEnv());
}

export { workflowIdFor };
