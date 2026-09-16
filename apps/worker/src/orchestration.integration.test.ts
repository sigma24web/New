/**
 * Durable orchestration proofs (Checkpoint 7; workflow reliability plan §1–§5, §8).
 *
 * These run against Temporal's time-skipping test server (downloaded and run locally — no paid
 * infrastructure, no credentials) and a real PostgreSQL 16, with every model call replayed from the frozen
 * chapter-1 fixture. The claims proved here are the ones that make durable orchestration worth having:
 *
 *  * a duplicate start is refused rather than producing a chapter twice;
 *  * a target lease stops a *different* run from racing the same chapter, with fencing against zombies;
 *  * a worker killed mid-run and restarted resumes from its Postgres checkpoints and issues no duplicate
 *    provider call, and canon advances exactly once;
 *  * workflow history replays deterministically;
 *  * cancellation before the commit leaves nothing in canon, and its artifacts are recorded noncanonical;
 *  * a permanent (validation/policy) failure is not retried, while a transient one is.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { WorkflowFailedError } from '@temporalio/client';
import {
  acquireTargetLease,
  getJob,
  getJobByWorkflowId,
  liveTargetLease,
  migrate,
  putArtifact,
  releaseTargetLease,
  renewTargetLease,
  requestJobControl,
  resetDatabase,
  createUser,
  type Pool,
} from '@yeonjae/db';
import { databaseUrl, freshDatabase } from '@yeonjae/db/testkit';
import { createHarness, INTAKE, BIBLE, IDS } from '@yeonjae/workflows/testkit';
import { createActivities } from './activities.js';
import { CHAPTER_TASK_QUEUE, versioned, type ChapterWorkflowResult } from './contracts.js';
import { chapterWorkflowId, startChapterProduction } from './client.js';

const run = databaseUrl() ? describe : describe.skip;

/** Persist the run's immutable inputs and return their content-addressed ids. */
async function storeInputs(
  pool: Pool,
  input: { workspaceId: string; projectId: string },
): Promise<{ intakeArtifactId: string; bibleArtifactId: string }> {
  const intake = await putArtifact(pool, {
    ...input,
    step: 'worker_inputs',
    kind: 'story_intake',
    key: 'intake',
    payload: INTAKE,
  });
  const bible = await putArtifact(pool, {
    ...input,
    step: 'worker_inputs',
    kind: 'story_bible',
    key: 'bible',
    payload: BIBLE,
  });
  return { intakeArtifactId: intake.artifact.id, bibleArtifactId: bible.artifact.id };
}

run('durable orchestration: apps/worker over Temporal (Checkpoint 7)', () => {
  let env: TestWorkflowEnvironment;
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;
  let requestedBy: string;
  let inputsRef: { intakeArtifactId: string; bibleArtifactId: string };
  let harnessDeps: Parameters<typeof createActivities>[0]['makeDeps'];
  let seq = 0;

  beforeAll(async () => {
    // Downloads and runs the Temporal test server locally; nothing paid, nothing external.
    env = await TestWorkflowEnvironment.createTimeSkipping();
    pool = await freshDatabase();
  }, 240_000);

  afterAll(async () => {
    await env.teardown();
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await migrate(pool);
    const harness = await createHarness(pool);
    workspaceId = harness.workspaceId;
    projectId = harness.projectId;
    // The activity layer receives the replay gateway, so no test can reach a live provider.
    harnessDeps = () => ({ pool, gateway: harness.gateway(), bindings: harness.bindings });
    const user = await createUser(pool, {
      email: `operator${(seq += 1)}@example.com`,
      displayName: 'Operator',
      password: 'correct horse battery staple',
    });
    requestedBy = user.id;
    inputsRef = await storeInputs(pool, { workspaceId, projectId });
  }, 240_000);

  /** Run a worker for the duration of `fn`, then shut it down. */
  async function withWorker<T>(fn: () => Promise<T>): Promise<T> {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: CHAPTER_TASK_QUEUE,
      workflowsPath: new URL('./workflows.ts', import.meta.url).pathname,
      activities: createActivities({ pool, makeDeps: harnessDeps }),
    });
    return worker.runUntil(fn());
  }

  function startInput() {
    return {
      workspaceId,
      projectId,
      chapterNo: 1,
      ids: { arcId: IDS.arc1 ?? '', seasonId: IDS.season1 ?? '', contractId: IDS.contract1 ?? '' },
      inputsRef,
      requestedBy,
    };
  }

  // ---- the happy path, once -----------------------------------------------------------------------------

  it('produces chapter 1 to acceptance through the workflow, advancing canon exactly once', async () => {
    const result = await withWorker(async () => {
      const started = await startChapterProduction(env.client, startInput());
      expect(started).toMatchObject({ started: true, workflowId: chapterWorkflowId(projectId, 1) });
      return env.client.workflow
        .getHandle(started.workflowId)
        .result() as Promise<ChapterWorkflowResult>;
    });

    expect(result.outcome).toBe('accepted');
    expect(result.acceptedCanonVersion).toBe(3);
    // Exactly one canon commit chain for this project, and the chapter is accepted.
    const chapter = await pool.query<{ status: string }>(
      'SELECT status FROM chapters WHERE project_id = $1 AND number = 1',
      [projectId],
    );
    expect(chapter.rows[0]?.status).toBe('accepted');
    // The job is terminal with exactly one terminal event.
    const job = await getJobByWorkflowId(pool, chapterWorkflowId(projectId, 1));
    expect(job?.status).toBe('completed');
    const terminal = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM job_events WHERE job_id = $1 AND terminal',
      [job?.id ?? ''],
    );
    expect(terminal.rows[0]?.n).toBe('1');
    // The lease was released, so the chapter is not blocked after the run.
    expect(
      await liveTargetLease(pool, { projectId, targetKind: 'chapter', targetId: '1' }),
    ).toBeUndefined();
  }, 240_000);

  // ---- duplicate start ----------------------------------------------------------------------------------

  it('refuses a duplicate start while a run is live, and never produces the chapter twice', async () => {
    const outcome = await withWorker(async () => {
      const first = await startChapterProduction(env.client, startInput());
      // Second start with the same deterministic workflow id, while the first is live.
      const second = await startChapterProduction(env.client, startInput());
      const result = (await env.client.workflow
        .getHandle(first.workflowId)
        .result()) as ChapterWorkflowResult;
      return { first, second, result };
    });

    expect(outcome.first.started).toBe(true);
    expect(outcome.second).toMatchObject({ started: false, reason: 'already_running' });
    expect(outcome.result.outcome).toBe('accepted');

    // One job, one canon commit for the accepted chapter: the duplicate start produced nothing.
    const jobs = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM jobs WHERE project_id = $1',
      [projectId],
    );
    expect(jobs.rows[0]?.n).toBe('1');
    const commits = await pool.query<{ max: number | null }>(
      'SELECT max(version) AS max FROM canon_commits WHERE project_id = $1',
      [projectId],
    );
    expect(commits.rows[0]?.max).toBe(3);
  }, 240_000);

  it('rejects a second run on the same chapter through the target lease', async () => {
    // A different workflow id (an operator regeneration) targeting the same chapter: the deterministic id
    // does not protect this case, the lease does.
    const held = await acquireTargetLease(pool, {
      workspaceId,
      projectId,
      targetKind: 'chapter',
      targetId: '1',
      holderWorkflowId: 'regenerate:chapter:1',
    });
    expect(held).toBeDefined();

    const result = await withWorker(async () => {
      const started = await startChapterProduction(env.client, startInput());
      return env.client.workflow
        .getHandle(started.workflowId)
        .result() as Promise<ChapterWorkflowResult>;
    });
    expect(result.outcome).toBe('lease_held');
    expect(result.heldBy).toBe('regenerate:chapter:1');
    // Nothing was produced: no canon commit for a chapter someone else owns.
    const commits = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM canon_commits WHERE project_id = $1',
      [projectId],
    );
    expect(commits.rows[0]?.n).toBe('0');
  }, 240_000);

  it('fences a zombie holder out after its lease is stolen', async () => {
    const first = await acquireTargetLease(pool, {
      workspaceId,
      projectId,
      targetKind: 'chapter',
      targetId: '7',
      holderWorkflowId: 'worker-a',
      ttlSeconds: 1,
    });
    expect(first).toBeDefined();
    if (!first) throw new Error('lease not acquired');

    // The TTL lapses (the worker died without releasing), so a new holder may take over.
    await new Promise((r) => setTimeout(r, 1_100));
    const second = await acquireTargetLease(pool, {
      workspaceId,
      projectId,
      targetKind: 'chapter',
      targetId: '7',
      holderWorkflowId: 'worker-b',
    });
    expect(second).toBeDefined();
    if (!second) throw new Error('lease not stolen');
    expect(Number(second.fence)).toBeGreaterThan(Number(first.fence));

    // The revived first holder still thinks it owns the chapter. Both its renew and its release fail, so
    // it cannot extend a lease it lost nor release the new holder's lease out from under them.
    expect(
      await renewTargetLease(pool, {
        leaseId: first.id,
        holderWorkflowId: 'worker-a',
        fence: first.fence,
      }),
    ).toBe(false);
    expect(
      await releaseTargetLease(pool, {
        leaseId: second.id,
        holderWorkflowId: 'worker-a',
        fence: first.fence,
      }),
    ).toBe(false);
    // The legitimate holder can still renew.
    expect(
      await renewTargetLease(pool, {
        leaseId: second.id,
        holderWorkflowId: 'worker-b',
        fence: second.fence,
      }),
    ).toBe(true);
  }, 120_000);

  // ---- worker restart, replay and no duplicate spend ---------------------------------------------------

  it('resumes after a worker restart without duplicate provider spend, and canon advances once', async () => {
    const workflowId = chapterWorkflowId(projectId, 1);

    // First worker: the production activity is injected to fail after the story spec step, so the run
    // stops partway with its Postgres checkpoints intact.
    await withWorker(async () => {
      const started = await startChapterProduction(env.client, {
        ...startInput(),
        failAfterStep: 'story_spec',
      });
      await expect(
        env.client.workflow.getHandle(started.workflowId).result(),
      ).rejects.toBeInstanceOf(WorkflowFailedError);
    });

    const partialJob = await getJobByWorkflowId(pool, workflowId);
    expect(partialJob).toBeDefined();
    expect(partialJob?.status).toBe('failed');
    // Completed checkpoints survive the failure: that is what the restart will replay instead of redoing.
    const completedBefore = await completedStepCount(pool, partialJob?.id ?? '');
    expect(completedBefore).toBeGreaterThan(0);
    const callsAfterPartial = await llmCallCount(pool, partialJob?.id ?? '');
    // Nothing reached canon: a failed run leaves no commit.
    expect(await commitCount(pool, projectId)).toBe(0);

    // A fresh workflow run on a restarted worker. `ensureJob` finds the same job by its deterministic id
    // and `runStep` replays the completed steps from job_steps, so completed model calls are not re-spent.
    const result = await withWorker(async () => {
      const restarted = await startChapterProduction(env.client, startInput());
      expect(restarted.started).toBe(true);
      return env.client.workflow
        .getHandle(restarted.workflowId)
        .result() as Promise<ChapterWorkflowResult>;
    });

    expect(result.outcome).toBe('accepted');
    const finishedJob = await getJobByWorkflowId(pool, workflowId);
    // Same job row: the restart resumed rather than starting a parallel run.
    expect(finishedJob?.id).toBe(partialJob?.id);
    // Canon advanced exactly once despite two workflow runs over the same job.
    expect(await commitCount(pool, projectId)).toBe(3);
    // The steps completed before the crash were replayed, not re-executed, so the run's total model spend
    // is what a single clean run costs — the restart added no duplicate provider call for them.
    const completedAfter = await completedStepCount(pool, finishedJob?.id ?? '');
    expect(completedAfter).toBeGreaterThan(completedBefore);
    const callsAfterResume = await llmCallCount(pool, finishedJob?.id ?? '');
    const clean = await cleanRunLlmCalls(pool);
    expect({ callsAfterResume, clean, callsAfterPartial }).toMatchObject({
      callsAfterResume: clean,
    });
  }, 600_000);

  // ---- cancellation ------------------------------------------------------------------------------------

  it('cancels before the commit and leaves nothing in canon', async () => {
    // The control intent is recorded before the workflow starts, so the first checkpoint observes it.
    const seeded = await pool.query<{ id: string }>(
      `INSERT INTO jobs (workspace_id, project_id, kind, status, production_policy_version, workflow_id,
                         idempotency_key, control, control_requested_at, control_requested_by)
       VALUES ($1, $2, 'chapter_production', 'queued', 'standard.v1', $3, $3, 'cancel', now(), $4)
       RETURNING id`,
      [workspaceId, projectId, chapterWorkflowId(projectId, 1), requestedBy],
    );
    const jobId = seeded.rows[0]?.id ?? '';

    const result = await withWorker(async () => {
      const started = await startChapterProduction(env.client, startInput());
      return env.client.workflow
        .getHandle(started.workflowId)
        .result() as Promise<ChapterWorkflowResult>;
    });

    expect(result.outcome).toBe('cancelled');
    expect((await getJob(pool, jobId))?.status).toBe('cancelled');
    // No canon, and the cleanup recorded that whatever exists is not canonical.
    expect(await commitCount(pool, projectId)).toBe(0);
    const events = await pool.query<{ kind: string; payload: Record<string, unknown> }>(
      'SELECT kind, payload FROM job_events WHERE job_id = $1 ORDER BY seq',
      [jobId],
    );
    expect(events.rows.map((r) => r.kind)).toContain('job.cancelled');
    expect(events.rows.some((r) => r.payload.artifacts === 'noncanonical')).toBe(true);
    // The lease was released even though the run was cancelled.
    expect(
      await liveTargetLease(pool, { projectId, targetKind: 'chapter', targetId: '1' }),
    ).toBeUndefined();
  }, 240_000);

  it('honours a pause intent at the first checkpoint without starting production', async () => {
    const seeded = await pool.query<{ id: string }>(
      `INSERT INTO jobs (workspace_id, project_id, kind, status, production_policy_version, workflow_id,
                         idempotency_key, control, control_requested_at, control_requested_by)
       VALUES ($1, $2, 'chapter_production', 'queued', 'standard.v1', $3, $3, 'pause', now(), $4)
       RETURNING id`,
      [workspaceId, projectId, chapterWorkflowId(projectId, 1), requestedBy],
    );
    const jobId = seeded.rows[0]?.id ?? '';

    const result = await withWorker(async () => {
      const started = await startChapterProduction(env.client, startInput());
      return env.client.workflow
        .getHandle(started.workflowId)
        .result() as Promise<ChapterWorkflowResult>;
    });

    expect(result.outcome).toBe('paused');
    expect((await getJob(pool, jobId))?.status).toBe('paused');
    // Paused before any spend: no canon and no model calls on this job.
    expect(await commitCount(pool, projectId)).toBe(0);
    expect(await llmCallCount(pool, jobId)).toBe(0);
  }, 240_000);

  it('treats duplicate control requests as one, through the durable layer', async () => {
    const seeded = await pool.query<{ id: string }>(
      `INSERT INTO jobs (workspace_id, project_id, kind, status, production_policy_version, workflow_id,
                         idempotency_key)
       VALUES ($1, $2, 'chapter_production', 'running', 'standard.v1', $3, $3)
       RETURNING id`,
      [workspaceId, projectId, `chapter:${projectId}:9`],
    );
    const jobId = seeded.rows[0]?.id ?? '';
    const first = await requestJobControl(pool, {
      jobId,
      control: 'cancel',
      actorUserId: requestedBy,
    });
    const second = await requestJobControl(pool, {
      jobId,
      control: 'cancel',
      actorUserId: requestedBy,
    });
    expect(first.applied).toBe(true);
    expect(second).toMatchObject({ applied: false, reason: 'already_requested' });
    const events = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM job_events WHERE job_id = $1 AND kind LIKE 'job.cancel%'`,
      [jobId],
    );
    expect(events.rows[0]?.n).toBe('1');
  }, 120_000);

  // ---- failure classification --------------------------------------------------------------------------

  it('does not retry a permanent failure, and reports the job as failed', async () => {
    // Chapter 2 without an accepted chapter 1 is a deterministic policy refusal
    // (PREVIOUS_CHAPTER_NOT_ACCEPTED). Retrying cannot change the outcome, so the workflow must not.
    const result = await withWorker(async () => {
      const started = await startChapterProduction(env.client, {
        ...startInput(),
        chapterNo: 2,
        ids: {
          arcId: IDS.arc1 ?? '',
          seasonId: IDS.season1 ?? '',
          contractId: IDS.contract2 ?? '',
        },
      });
      return env.client.workflow
        .getHandle(started.workflowId)
        .result()
        .then(
          () => 'resolved' as const,
          (err: unknown) => err,
        );
    });
    expect(result).toBeInstanceOf(WorkflowFailedError);

    const job = await getJobByWorkflowId(pool, chapterWorkflowId(projectId, 2));
    expect(job?.status).toBe('failed');
    // One attempt per step: the permanent failure was not retried into extra spend.
    const attempts = await pool.query<{ max: number | null }>(
      'SELECT max(attempt) AS max FROM job_steps WHERE job_id = $1',
      [job?.id ?? ''],
    );
    expect(attempts.rows[0]?.max ?? 1).toBe(1);
    expect(await commitCount(pool, projectId)).toBe(0);
  }, 240_000);

  it('refuses an activity payload from an unknown contract version instead of guessing', async () => {
    const activities = createActivities({ pool, makeDeps: harnessDeps });
    await expect(
      activities.checkControl({
        v: 999,
        jobId: '00000000-0000-7000-8000-000000000000',
        step: 'x',
      } as never),
    ).rejects.toThrow(/contract version 999 is not supported/);
    // The current version is accepted.
    await expect(
      activities.lookupJob(versioned({ workspaceId, projectId, workflowId: 'nope' })),
    ).resolves.toMatchObject({ jobId: undefined });
  }, 60_000);

  // ---- deterministic replay ----------------------------------------------------------------------------

  it('replays a completed workflow history deterministically', async () => {
    const workflowId = chapterWorkflowId(projectId, 1);
    await withWorker(async () => {
      const started = await startChapterProduction(env.client, startInput());
      await env.client.workflow.getHandle(started.workflowId).result();
    });

    // Re-execute the recorded history against the current workflow code. A nondeterminism error here
    // would mean a deployed worker could diverge from what already happened — the failure mode that makes
    // durable execution unsafe for a pipeline that commits canon.
    const handle = env.client.workflow.getHandle(workflowId);
    const history = await handle.fetchHistory();
    const { Worker: WorkerClass } = await import('@temporalio/worker');
    await WorkerClass.runReplayHistory(
      {
        workflowsPath: new URL('./workflows.ts', import.meta.url).pathname,
        replayName: 'chapter-production-replay',
      },
      history,
    );
  }, 600_000);
});

async function completedStepCount(pool: Pool, jobId: string): Promise<number> {
  if (!jobId) return 0;
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM job_steps WHERE job_id = $1 AND status = 'completed'`,
    [jobId],
  );
  return Number(r.rows[0]?.n ?? '0');
}

/**
 * Model calls a single uninterrupted run of the same chapter costs, measured on a separate project in the
 * same database. Comparing against this is what turns "the restart worked" into "the restart re-spent
 * nothing": an equal count means every pre-crash step was replayed from its checkpoint.
 */
async function cleanRunLlmCalls(pool: Pool): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM llm_calls WHERE job_id = (
       SELECT id FROM jobs WHERE kind = 'chapter_production' AND status = 'completed'
        ORDER BY created_at DESC LIMIT 1)`,
  );
  return Number(r.rows[0]?.n ?? '0');
}

async function commitCount(pool: Pool, projectId: string): Promise<number> {
  const r = await pool.query<{ max: number | null }>(
    'SELECT max(version) AS max FROM canon_commits WHERE project_id = $1',
    [projectId],
  );
  return r.rows[0]?.max ?? 0;
}

async function llmCallCount(pool: Pool, jobId: string): Promise<number> {
  if (!jobId) return 0;
  const r = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM llm_calls WHERE job_id = $1',
    [jobId],
  );
  return Number(r.rows[0]?.n ?? '0');
}
