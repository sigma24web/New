/**
 * Job control and the durable event log (Checkpoint 7).
 *
 * These tests treat control as an execution guarantee rather than a column write. The properties proved
 * here are the ones the API, the SSE stream and the durable runtime all rely on:
 *
 *  * a pause or cancel observed at a checkpoint boundary stops BEFORE the next step, so no step is torn in
 *    half and nothing partial reaches canon;
 *  * a terminal job never re-opens, and a duplicate control request never duplicates an event;
 *  * `job_events` is append-only with a monotone per-job `seq`, even under concurrent emission, because SSE
 *    reconnection replays from it and must not be able to observe a gap, a duplicate or a rewrite;
 *  * event payloads cannot carry manuscript prose, prompt text or credentials.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSafePayload,
  checkpointControl,
  createProject,
  createUser,
  createWorkspace,
  emitJobEvent,
  ensureJob,
  ensurePromptSet,
  finishJob,
  getJob,
  isTerminalStatus,
  jobControlOf,
  JobControlStop,
  jobEventsAfter,
  migrate,
  needsAttention,
  requestJobControl,
  resetDatabase,
  updateJob,
  type Pool,
} from './index.js';
import { freshDatabase, databaseUrl } from './testkit.js';

const run = databaseUrl() ? describe : describe.skip;

run('job control and the durable event log (Checkpoint 7)', () => {
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;
  let actorUserId: string;
  let jobId: string;
  let seq = 0;

  beforeAll(async () => {
    pool = await freshDatabase();
  }, 60_000);
  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await migrate(pool);
    workspaceId = await createWorkspace(pool, `ws-${(seq += 1)}`);
    const project = await createProject(pool, { workspaceId, title: 'Second Awakening' });
    projectId = project.projectId;
    const user = await createUser(pool, {
      email: `operator${seq}@example.com`,
      displayName: 'Operator',
      password: 'correct horse battery staple',
    });
    actorUserId = user.id;
    await ensurePromptSet(pool, { id: 'set.test.v1', mapping: {} });
    const job = await ensureJob(pool, {
      workspaceId,
      projectId,
      kind: 'chapter_production',
      workflowId: `chapter:${projectId}:1`,
      idempotencyKey: `chapter:${projectId}:1`,
      canonVersionRead: 0,
      productionPolicyVersion: 'standard.v1',
      promptSetId: 'set.test.v1',
      narrativeIdentityVersionId: null as unknown as string,
      pins: {},
    });
    jobId = job.job.id;
  });

  // ---- events are a real, ordered, append-only history -------------------------------------------------

  it('allocates a monotone per-job seq and replays deterministically from any point', async () => {
    for (const kind of ['job.started', 'step.completed', 'step.completed', 'job.completed'])
      await emitJobEvent(pool, { jobId, kind, payload: { step: kind } });

    const all = await jobEventsAfter(pool, { jobId });
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    // Replay from the middle: exactly the later events, in order, with no duplicate of event 2.
    const resumed = await jobEventsAfter(pool, { jobId, afterSeq: 2 });
    expect(resumed.map((e) => e.seq)).toEqual([3, 4]);
    // Replay from the end is empty rather than an error: a fully caught-up client is normal.
    expect(await jobEventsAfter(pool, { jobId, afterSeq: 4 })).toEqual([]);
    // Every event carries the tenant so the SSE route can refuse a foreign stream.
    expect(all.every((e) => e.workspace_id === workspaceId && e.project_id === projectId)).toBe(
      true,
    );
  });

  it('never mints a duplicate seq under concurrent emission', async () => {
    // Twelve concurrent emitters on one job. The allocating INSERT serializes on UNIQUE (job_id, seq), so
    // some attempts may fail — but no two may succeed with the same id.
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        emitJobEvent(pool, { jobId, kind: 'step.progress', payload: { i } }),
      ),
    );
    const succeeded = attempts.filter((a) => a.status === 'fulfilled').length;
    expect(succeeded).toBeGreaterThan(0);
    const rows = await jobEventsAfter(pool, { jobId, limit: 1_000 });
    expect(rows.length).toBe(succeeded);
    const seqs = rows.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('refuses to rewrite or delete history (append-only trigger)', async () => {
    const event = await emitJobEvent(pool, { jobId, kind: 'job.started', payload: {} });
    await expect(
      pool.query(`UPDATE job_events SET kind = 'forged' WHERE id = $1`, [event.id]),
    ).rejects.toThrow();
    await expect(pool.query('DELETE FROM job_events WHERE id = $1', [event.id])).rejects.toThrow();
    const still = await jobEventsAfter(pool, { jobId });
    expect(still.map((e) => e.kind)).toEqual(['job.started']);
  });

  it('refuses event payloads carrying prose, prompt text or a credential', () => {
    expect(() => {
      assertSafePayload({ step: 'draft', words: 3200 });
    }).not.toThrow();
    for (const bad of [
      { text: 'The rain fell on the tower.' },
      { manuscript: 'x' },
      { prompt: 'x' },
      { api_key: 'sk-live-1' },
      { nested: { password: 'hunter2' } },
    ])
      expect(() => {
        assertSafePayload(bad);
      }).toThrow();
    // A long string is prose by weight of probability even under an innocuous key.
    expect(() => {
      assertSafePayload({ note: 'a'.repeat(2_001) });
    }).toThrow();
  });

  // ---- control transitions -----------------------------------------------------------------------------

  it('pauses a running job as an intent and settles it at the checkpoint boundary', async () => {
    await updateJob(pool, jobId, { status: 'running' });
    const outcome = await requestJobControl(pool, { jobId, control: 'pause', actorUserId });
    expect(outcome.applied).toBe(true);
    // The intent is recorded but the job keeps its status: nothing interrupts a step mid-flight.
    expect(jobControlOf(outcome.job)).toBe('pause');
    expect(outcome.job.status).toBe('running');

    // The runtime reaches its next checkpoint and stops there.
    await expect(checkpointControl(pool, { jobId, step: 'draft_scene_2' })).rejects.toBeInstanceOf(
      JobControlStop,
    );
    const paused = await getJob(pool, jobId);
    expect(paused?.status).toBe('paused');
    const events = await jobEventsAfter(pool, { jobId });
    expect(events.map((e) => e.kind)).toEqual(['job.pause_requested', 'job.paused']);
    // The pause names the step it stopped before, which is what makes resumption auditable.
    expect(events[1]?.payload).toMatchObject({ stopped_before: 'draft_scene_2' });
  });

  it('resumes a paused job and lets the runtime proceed past the checkpoint', async () => {
    await updateJob(pool, jobId, { status: 'paused' });
    await requestJobControl(pool, { jobId, control: 'pause', actorUserId });
    const resumed = await requestJobControl(pool, { jobId, control: 'run', actorUserId });
    expect(resumed.applied).toBe(true);
    expect(jobControlOf(resumed.job)).toBe('run');
    expect(resumed.job.status).toBe('queued');
    expect(resumed.job.paused_at).toBeNull();
    // With the intent cleared the checkpoint no longer stops the workflow.
    await expect(
      checkpointControl(pool, { jobId, step: 'draft_scene_2' }),
    ).resolves.toBeUndefined();
  });

  it('refuses to resume a job that is not paused', async () => {
    await updateJob(pool, jobId, { status: 'running' });
    const outcome = await requestJobControl(pool, { jobId, control: 'run', actorUserId });
    expect(outcome).toMatchObject({ applied: false, reason: 'not_paused' });
  });

  it('cancels at a checkpoint and leaves whatever was produced noncanonical', async () => {
    await updateJob(pool, jobId, { status: 'running' });
    const requested = await requestJobControl(pool, { jobId, control: 'cancel', actorUserId });
    expect(requested.applied).toBe(true);
    expect(requested.job.status).toBe('cancelling');

    await expect(
      checkpointControl(pool, { jobId, step: 'accept_canon_delta' }),
    ).rejects.toBeInstanceOf(JobControlStop);
    const cancelled = await getJob(pool, jobId);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.finished_at).not.toBeNull();
    const terminal = (await jobEventsAfter(pool, { jobId })).filter((e) => e.terminal);
    expect(terminal).toHaveLength(1);
    // The cancel stopped BEFORE acceptance, so no canon commit exists for this project.
    expect(terminal[0]?.payload).toMatchObject({
      stopped_before: 'accept_canon_delta',
      artifacts: 'noncanonical',
    });
    const commits = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM canon_commits WHERE project_id = $1',
      [projectId],
    );
    expect(commits.rows[0]?.n).toBe('0');
  });

  it('treats a duplicate cancel as a no-op and never emits a second event', async () => {
    await updateJob(pool, jobId, { status: 'running' });
    await requestJobControl(pool, { jobId, control: 'cancel', actorUserId });
    const again = await requestJobControl(pool, { jobId, control: 'cancel', actorUserId });
    expect(again).toMatchObject({ applied: false, reason: 'already_requested' });
    const events = await jobEventsAfter(pool, { jobId });
    expect(events.filter((e) => e.kind.startsWith('job.cancel'))).toHaveLength(1);
  });

  it('refuses to downgrade a cancelling job to paused', async () => {
    await updateJob(pool, jobId, { status: 'running' });
    await requestJobControl(pool, { jobId, control: 'cancel', actorUserId });
    const pause = await requestJobControl(pool, { jobId, control: 'pause', actorUserId });
    expect(pause).toMatchObject({ applied: false, reason: 'already_requested' });
    // The cancel intent survives: abandoned work is not resurrected by a late pause.
    const after = await getJob(pool, jobId);
    expect(after).toBeDefined();
    if (after) expect(jobControlOf(after)).toBe('cancel');
  });

  it('cancels a not-yet-running job immediately, without waiting for a checkpoint', async () => {
    await updateJob(pool, jobId, { status: 'queued' });
    const outcome = await requestJobControl(pool, { jobId, control: 'cancel', actorUserId });
    expect(outcome.applied).toBe(true);
    // Nothing will pick the job up, so there is no future checkpoint to settle at.
    expect(outcome.job.status).toBe('cancelled');
    expect(outcome.job.cancelled_at).not.toBeNull();
  });

  it('accepts no control request on a terminal job and never retracts history', async () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      await updateJob(pool, jobId, { status });
      expect(isTerminalStatus(status)).toBe(true);
      for (const control of ['pause', 'cancel', 'run'] as const) {
        const outcome = await requestJobControl(pool, { jobId, control, actorUserId });
        expect({ status, control, ...outcome }).toMatchObject({
          status,
          control,
          applied: false,
          reason: 'terminal',
        });
      }
      // The terminal status is unchanged by the refused requests.
      expect((await getJob(pool, jobId))?.status).toBe(status);
    }
  });

  it('records the actor and the moment of every applied control request', async () => {
    await updateJob(pool, jobId, { status: 'running' });
    const outcome = await requestJobControl(pool, { jobId, control: 'pause', actorUserId });
    expect(outcome.job.control_requested_by).toBe(actorUserId);
    expect(outcome.job.control_requested_at).toBeInstanceOf(Date);
  });

  // ---- terminal events ---------------------------------------------------------------------------------

  it('emits exactly one terminal event per job even if finishJob runs twice', async () => {
    await emitJobEvent(pool, { jobId, kind: 'job.started', payload: {} });
    const first = await finishJob(pool, { jobId, status: 'completed', payload: { chapters: 1 } });
    expect(first?.terminal).toBe(true);
    // A retried finish (worker restart after the commit but before acknowledging) must not append again.
    const second = await finishJob(pool, { jobId, status: 'completed' });
    expect(second).toBeUndefined();
    const terminal = (await jobEventsAfter(pool, { jobId })).filter((e) => e.terminal);
    expect(terminal).toHaveLength(1);
    expect((await getJob(pool, jobId))?.status).toBe('completed');
  });

  it('classifies the statuses that require an operator decision as attention, not failure', () => {
    for (const status of ['needs_attention', 'waiting_review', 'paused_budget'])
      expect(needsAttention(status)).toBe(true);
    for (const status of ['running', 'queued', 'completed', 'failed', 'cancelled'])
      expect(needsAttention(status)).toBe(false);
  });

  it('keeps one job\u2019s events invisible to another job\u2019s replay', async () => {
    const other = await ensureJob(pool, {
      workspaceId,
      projectId,
      kind: 'chapter_production',
      workflowId: `chapter:${projectId}:2`,
      idempotencyKey: `chapter:${projectId}:2`,
      canonVersionRead: 0,
      productionPolicyVersion: 'standard.v1',
      promptSetId: 'set.test.v1',
      narrativeIdentityVersionId: null as unknown as string,
      pins: {},
    });
    await emitJobEvent(pool, { jobId, kind: 'job.started', payload: {} });
    await emitJobEvent(pool, { jobId: other.job.id, kind: 'job.started', payload: {} });
    // Each job's sequence starts at 1 independently, and a replay never crosses jobs.
    expect((await jobEventsAfter(pool, { jobId })).map((e) => e.job_id)).toEqual([jobId]);
    expect((await jobEventsAfter(pool, { jobId: other.job.id })).map((e) => e.seq)).toEqual([1]);
  });
});
