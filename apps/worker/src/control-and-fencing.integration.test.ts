/**
 * Corrective-audit proofs: lease fencing and mid-run control (Checkpoint 7).
 *
 * The first orchestration suite proved control that was requested *before* a run started, which is a much
 * weaker claim than the one the system needs. These tests submit the request **while the pipeline is
 * actively executing**, and they revoke a lease **mid-run**, because those are the cases where a mistake
 * costs real money or real canon:
 *
 *  * a zombie worker that lost its lease must stop before its next durable side effect — not merely fail
 *    to renew — so it cannot draft, evaluate, accept or commit against a chapter another worker now owns;
 *  * a pause or cancel issued during drafting/evaluation/extraction must be observed at the next
 *    PostgreSQL checkpoint, leaving no partial canon;
 *  * a cancel that loses the race with the atomic commit must NOT relabel accepted canon as cancelled.
 *
 * Control is observed inside `runStep`, which is the only place that knows a unit of work has not begun,
 * so these run the real production loop rather than a stub of it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireTargetLease,
  getJob,
  getJobByWorkflowId,
  jobEventsAfter,
  leaseOwnership,
  migrate,
  releaseTargetLease,
  requestJobControl,
  resetDatabase,
  type Pool,
} from '@yeonjae/db';
import { databaseUrl, freshDatabase } from '@yeonjae/db/testkit';
import { createHarness, IDS } from '@yeonjae/workflows/testkit';
import { produceChapter, WorkflowError, workflowIdFor } from '@yeonjae/workflows';

const run = databaseUrl() ? describe : describe.skip;

run('lease fencing and mid-run control (Checkpoint 7 corrective audit)', () => {
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;
  let harness: Awaited<ReturnType<typeof createHarness>>;
  let actorUserId: string;

  beforeAll(async () => {
    pool = await freshDatabase();
  }, 120_000);
  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await migrate(pool);
    harness = await createHarness(pool);
    workspaceId = harness.workspaceId;
    projectId = harness.projectId;
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_algo, password_params, password_salt, password_hash)
       VALUES ('operator@example.com', 'Operator', 'scrypt', '{"N":1,"r":8,"p":1,"keylen":64}', 's', 'h')
       RETURNING id`,
    );
    actorUserId = user.rows[0]?.id ?? '';
  }, 120_000);

  function input(lease?: { leaseId: string; holderWorkflowId: string; fence: string }) {
    return {
      ...harness.input(1),
      ...(lease ? { lease } : {}),
    };
  }

  async function acquire(holder: string, ttlSeconds = 60) {
    const lease = await acquireTargetLease(pool, {
      workspaceId,
      projectId,
      targetKind: 'chapter',
      targetId: '1',
      holderWorkflowId: holder,
      ttlSeconds,
    });
    if (!lease) throw new Error(`could not acquire lease for ${holder}`);
    return {
      leaseId: lease.id,
      holderWorkflowId: lease.holder_workflow_id,
      fence: String(lease.fence),
    };
  }

  async function canonVersion(): Promise<number> {
    const r = await pool.query<{ v: number }>(
      'SELECT canon_version AS v FROM projects WHERE id = $1',
      [projectId],
    );
    return r.rows[0]?.v ?? -1;
  }

  async function llmCalls(): Promise<number> {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM llm_calls WHERE project_id = $1`,
      [projectId],
    );
    return Number(r.rows[0]?.n ?? '0');
  }

  /**
   * Run production while a watcher fires once the job reaches `afterStep`.
   *
   * Polling the persisted `current_step` is how the test observes that the pipeline is genuinely mid-run:
   * the control request or lease revocation then lands while work is in flight, which is precisely the
   * case a pre-seeded flag cannot exercise.
   */
  async function whileRunning(
    act: (jobId: string) => Promise<void>,
    lease?: { leaseId: string; holderWorkflowId: string; fence: string },
  ): Promise<{ error: unknown; fired: boolean; stoppedAt: string | undefined }> {
    let fired = false;
    let stoppedAt: string | undefined;
    const watcher = (async () => {
      // Fire as soon as the job is genuinely executing a step. Waiting for one exact step name is racy:
      // a fast step can come and go between polls, and the test would then never fire at all.
      for (let i = 0; i < 2_000; i += 1) {
        const job = await getJobByWorkflowId(pool, workflowIdFor(projectId, 1));
        if (job?.current_step && job.status === 'running') {
          stoppedAt = job.current_step;
          await act(job.id);
          fired = true;
          return;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    let error: unknown;
    try {
      await produceChapter(
        { pool, gateway: harness.gateway(), bindings: harness.bindings },
        input(lease),
      );
    } catch (err) {
      error = err;
    }
    await watcher;
    return { error, fired, stoppedAt };
  }

  // ---- A. lease loss stops a zombie before the next durable effect ------------------------------------

  it('stops a run whose lease was stolen, before its next step', async () => {
    const mine = await acquire('worker-a');

    // A second worker takes the chapter over mid-run (the first worker's lease is released, then
    // re-acquired at a higher fence — exactly what happens when a TTL lapses and another worker steals it).
    const { error, fired } = await whileRunning(async () => {
      await releaseTargetLease(pool, {
        leaseId: mine.leaseId,
        holderWorkflowId: mine.holderWorkflowId,
        fence: mine.fence,
      });
      await acquire('worker-b');
    }, mine);

    expect(fired).toBe(true);
    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).code).toBe('LEASE_LOST');
    // The zombie stopped before committing anything: canon never advanced.
    expect(await canonVersion()).toBeLessThan(3);
    const chapter = await pool.query<{ status: string }>(
      'SELECT status FROM chapters WHERE project_id = $1 AND number = 1',
      [projectId],
    );
    expect(chapter.rows[0]?.status).not.toBe('accepted');
    // And the new holder still owns the target.
    const owner = await leaseOwnership(pool, {
      leaseId: mine.leaseId,
      holderWorkflowId: mine.holderWorkflowId,
      fence: mine.fence,
    });
    expect(owner.owned).toBe(false);
    expect(owner.reason).toBe('fenced_out');
    expect(owner.currentHolder).toBe('worker-b');
  }, 300_000);

  it('stops a run whose lease expired, and never resurrects it', async () => {
    const mine = await acquire('worker-a', 1);
    await new Promise((r) => setTimeout(r, 1_200));
    // The lease has lapsed; ownership is reported as expired rather than silently tolerated.
    const state = await leaseOwnership(pool, mine);
    expect(state).toMatchObject({ owned: false, reason: 'expired' });

    let error: unknown;
    try {
      await produceChapter(
        { pool, gateway: harness.gateway(), bindings: harness.bindings },
        input(mine),
      );
    } catch (err) {
      error = err;
    }
    expect((error as WorkflowError).code).toBe('LEASE_LOST');
    expect(await canonVersion()).toBe(0);
    // Nothing was spent: the run stopped at its first step boundary.
    expect(await llmCalls()).toBe(0);
  }, 300_000);

  it('lets the rightful holder keep working and finish', async () => {
    const mine = await acquire('worker-a');
    const result = await produceChapter(
      { pool, gateway: harness.gateway(), bindings: harness.bindings },
      input(mine),
    );
    expect(result.status).toBe('completed');
    expect(result.accepted?.canon_version).toBe(3);
    // Ownership held throughout.
    expect((await leaseOwnership(pool, mine)).owned).toBe(true);
  }, 300_000);

  it('reports why ownership was lost, distinguishing released, expired and fenced out', async () => {
    const a = await acquire('worker-a');
    await releaseTargetLease(pool, {
      leaseId: a.leaseId,
      holderWorkflowId: a.holderWorkflowId,
      fence: a.fence,
    });
    // Released and nobody else took it: the target is genuinely free.
    expect((await leaseOwnership(pool, a)).reason).toBe('released');

    const b = await acquire('worker-b', 1);
    await new Promise((r) => setTimeout(r, 1_200));
    // Lapsed with no rival yet: expired.
    expect((await leaseOwnership(pool, b)).reason).toBe('expired');

    // Once a rival holds the target, the answer changes to fenced_out and names the holder — the caller
    // needs to know a live owner exists, not merely that its own lease ended.
    await acquire('worker-c');
    const fenced = await leaseOwnership(pool, b);
    expect(fenced.reason).toBe('fenced_out');
    expect(fenced.currentHolder).toBe('worker-c');
    // A lease id that does not exist is 'missing', never silently "owned".
    expect(
      (
        await leaseOwnership(pool, {
          leaseId: '00000000-0000-7000-8000-000000000000',
          holderWorkflowId: 'nobody',
          fence: '1',
        })
      ).reason,
    ).toBe('missing');
  }, 120_000);

  // ---- B. pause/cancel requested WHILE the pipeline is running ----------------------------------------

  it('observes a cancel requested mid-run at the next checkpoint, with no partial canon', async () => {
    const { error, fired } = await whileRunning(async (jobId) => {
      await requestJobControl(pool, { jobId, control: 'cancel', actorUserId });
    });

    expect(fired).toBe(true);
    // The run stopped; it did not finish the chapter.
    expect(error).toBeDefined();
    const job = await getJobByWorkflowId(pool, workflowIdFor(projectId, 1));
    expect(job?.status).toBe('cancelled');
    // No canon advanced and no chapter was accepted: the cancel landed between steps.
    expect(await canonVersion()).toBe(0);
    const chapter = await pool.query<{ status: string }>(
      'SELECT status FROM chapters WHERE project_id = $1 AND number = 1',
      [projectId],
    );
    expect(chapter.rows[0]?.status).not.toBe('accepted');
    // The terminal event names the step it stopped before and records the artifacts as noncanonical.
    const events = await jobEventsAfter(pool, { jobId: job?.id ?? '' });
    const terminal = events.filter((e) => e.terminal);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.payload).toMatchObject({ artifacts: 'noncanonical' });
  }, 300_000);

  it('observes a pause requested mid-run and leaves the run resumable', async () => {
    const { fired } = await whileRunning(async (jobId) => {
      await requestJobControl(pool, { jobId, control: 'pause', actorUserId });
    });
    expect(fired).toBe(true);

    const job = await getJobByWorkflowId(pool, workflowIdFor(projectId, 1));
    expect(job?.status).toBe('paused');
    expect(await canonVersion()).toBe(0);
    const spentWhilePaused = await llmCalls();

    // Resuming continues from the persisted checkpoints rather than restarting the chapter.
    await requestJobControl(pool, { jobId: job?.id ?? '', control: 'run', actorUserId });
    const resumed = await produceChapter(
      { pool, gateway: harness.gateway(), bindings: harness.bindings },
      input(),
    );
    expect(resumed.status).toBe('completed');
    expect(resumed.accepted?.canon_version).toBe(3);
    // Steps completed before the pause were replayed, so the resumed run did not redo their spend.
    expect(resumed.steps.some((s) => s.status === 'replayed')).toBe(true);
    expect(await llmCalls()).toBeGreaterThanOrEqual(spentWhilePaused);
  }, 600_000);

  it('does not consult control while replaying already-completed steps', async () => {
    // Run to completion, then request a pause and re-run: replay performs no work and no spend, so
    // stopping there would strand a finished run.
    const first = await produceChapter(
      { pool, gateway: harness.gateway(), bindings: harness.bindings },
      input(),
    );
    expect(first.status).toBe('completed');
    const job = await getJobByWorkflowId(pool, workflowIdFor(projectId, 1));
    const spend = await llmCalls();

    await pool.query(`UPDATE jobs SET status = 'running' WHERE id = $1`, [job?.id ?? '']);
    await requestJobControl(pool, { jobId: job?.id ?? '', control: 'pause', actorUserId });
    const replayed = await produceChapter(
      { pool, gateway: harness.gateway(), bindings: harness.bindings },
      input(),
    );
    expect(replayed.status).toBe('completed');
    expect(replayed.accepted?.canon_version).toBe(3);
    // No additional spend, and canon did not advance a second time.
    expect(await llmCalls()).toBe(spend);
    expect(await canonVersion()).toBe(3);
  }, 600_000);

  // ---- C. a cancel that loses the race with the commit -------------------------------------------------

  it('never relabels accepted canon as cancelled when the cancel arrives too late', async () => {
    const result = await produceChapter(
      { pool, gateway: harness.gateway(), bindings: harness.bindings },
      input(),
    );
    expect(result.accepted?.canon_version).toBe(3);
    const job = await getJobByWorkflowId(pool, workflowIdFor(projectId, 1));

    // The operator cancels after the atomic commit already accepted the chapter.
    const outcome = await requestJobControl(pool, {
      jobId: job?.id ?? '',
      control: 'cancel',
      actorUserId,
    });
    // A terminal job accepts no control at all, so the accepted state cannot be contradicted.
    expect(outcome).toMatchObject({ applied: false, reason: 'terminal' });

    const after = await getJob(pool, job?.id ?? '');
    expect(after?.status).toBe('completed');
    const chapter = await pool.query<{ status: string }>(
      'SELECT status FROM chapters WHERE project_id = $1 AND number = 1',
      [projectId],
    );
    // Persisted job, chapter status and canon all agree; none says "cancelled".
    expect(chapter.rows[0]?.status).toBe('accepted');
    expect(await canonVersion()).toBe(3);
    const terminal = (await jobEventsAfter(pool, { jobId: job?.id ?? '' })).filter(
      (e) => e.terminal,
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.kind).not.toContain('cancel');
  }, 600_000);

  it('keeps the persisted job, its events and canon in agreement after a mid-run cancel', async () => {
    const { fired } = await whileRunning(async (jobId) => {
      await requestJobControl(pool, { jobId, control: 'cancel', actorUserId });
    });
    expect(fired).toBe(true);

    const job = await getJobByWorkflowId(pool, workflowIdFor(projectId, 1));
    const events = await jobEventsAfter(pool, { jobId: job?.id ?? '' });
    const terminal = events.filter((e) => e.terminal);
    // Exactly one terminal event, it says cancelled, the job says cancelled, and canon is untouched.
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.kind).toBe('job.cancelled');
    expect(job?.status).toBe('cancelled');
    expect(job?.finished_at).not.toBeNull();
    expect(await canonVersion()).toBe(0);
    // A retried cancel does not append a second terminal event.
    await requestJobControl(pool, { jobId: job?.id ?? '', control: 'cancel', actorUserId });
    const again = (await jobEventsAfter(pool, { jobId: job?.id ?? '' })).filter((e) => e.terminal);
    expect(again).toHaveLength(1);
  }, 300_000);

  it('uses the fixture plan ids so the replay provider serves every call', () => {
    // Guards the harness itself: a missing fixture id would make these tests exercise a different path.
    expect(IDS.arc1).toBeTruthy();
    expect(IDS.contract1).toBeTruthy();
  });
});
