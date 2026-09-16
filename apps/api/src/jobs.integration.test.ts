/**
 * Job control and SSE over the real HTTP surface (Checkpoint 7).
 *
 * `sse.test.ts` proves the streaming loop; `job-control.integration.test.ts` proves the durable semantics.
 * What is proved here is that the HTTP layer applies them with authentication, the role matrix, RLS scoping
 * and idempotency intact — in particular that a job in another workspace is a 404 rather than a 403, so a
 * job id cannot be used to discover that a foreign job exists.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  createProject,
  createUser,
  createWorkspace,
  emitJobEvent,
  ensureJob,
  ensurePromptSet,
  getJob,
  migrate,
  resetDatabase,
  updateJob,
  type Pool,
} from '@yeonjae/db';
import { databaseUrl, freshDatabase } from '@yeonjae/db/testkit';
import type { FastifyInstance } from 'fastify';
import { buildApi } from './server.js';
import { CSRF_HEADER, WORKSPACE_HEADER } from './auth.js';

const run = databaseUrl() ? describe : describe.skip;

interface Actor {
  readonly userId: string;
  readonly cookie: string;
  readonly csrf: string;
}

run('API: job control and server-sent events (Checkpoint 7)', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let wsA: string;
  let wsB: string;
  let projectA: string;
  let jobA: string;
  let jobB: string;
  let owner: Actor;
  let editor: Actor;
  let viewer: Actor;
  let strangerInB: Actor;

  async function login(email: string, password: string): Promise<Actor> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
    });
    expect(res.statusCode, res.body).toBe(200);
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const body = res.json<{ csrf_token: string; user: { id: string } }>();
    return {
      userId: body.user.id,
      cookie: String(raw).split(';')[0] ?? '',
      csrf: body.csrf_token,
    };
  }

  function authed(actor: Actor, workspaceId: string): Record<string, string> {
    return {
      cookie: actor.cookie,
      [WORKSPACE_HEADER]: workspaceId,
      [CSRF_HEADER]: actor.csrf,
    };
  }

  async function makeJob(workspaceId: string, projectId: string, chapter: number): Promise<string> {
    await ensurePromptSet(pool, { id: 'set.test.v1', mapping: {} });
    const created = await ensureJob(pool, {
      workspaceId,
      projectId,
      kind: 'chapter_production',
      workflowId: `chapter:${projectId}:${chapter}`,
      idempotencyKey: `chapter:${projectId}:${chapter}`,
      canonVersionRead: 0,
      productionPolicyVersion: 'standard.v1',
      promptSetId: 'set.test.v1',
      narrativeIdentityVersionId: null as unknown as string,
      pins: {},
    });
    return created.job.id;
  }

  beforeAll(async () => {
    pool = await freshDatabase();
    app = buildApi({ pool, secureCookies: false });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await migrate(pool);
    wsA = await createWorkspace(pool, 'workspace-a');
    wsB = await createWorkspace(pool, 'workspace-b');
    projectA = (await createProject(pool, { workspaceId: wsA, title: 'Project A' })).projectId;
    const projectB = (await createProject(pool, { workspaceId: wsB, title: 'Project B' }))
      .projectId;
    jobA = await makeJob(wsA, projectA, 1);
    jobB = await makeJob(wsB, projectB, 1);

    const users = await Promise.all(
      (
        [
          ['owner@example.com', 'Owner'],
          ['editor@example.com', 'Editor'],
          ['viewer@example.com', 'Viewer'],
          ['other@example.com', 'Other'],
        ] as const
      ).map(([email, name]) =>
        createUser(pool, { email, displayName: name, password: `${name}-password-1` }),
      ),
    );
    const roles = [
      [wsA, 'owner'],
      [wsA, 'editor'],
      [wsA, 'viewer'],
      [wsB, 'owner'],
    ] as const;
    for (const [index, [workspaceId, role]] of roles.entries()) {
      const user = users[index];
      if (!user) throw new Error('test user fixture missing');
      await addMember(pool, { workspaceId, userId: user.id, role });
    }

    owner = await login('owner@example.com', 'Owner-password-1');
    editor = await login('editor@example.com', 'Editor-password-1');
    viewer = await login('viewer@example.com', 'Viewer-password-1');
    strangerInB = await login('other@example.com', 'Other-password-1');
  }, 180_000);

  // ---- authorization and isolation ---------------------------------------------------------------------

  it('requires authentication for job reads, control and the event stream', async () => {
    for (const [method, url] of [
      ['GET', `/v1/jobs/${jobA}`],
      ['POST', `/v1/jobs/${jobA}:pause`],
      ['GET', `/v1/jobs/${jobA}/events`],
    ] as const) {
      const res = await app.inject({ method, url });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 401 });
      expect(res.headers['content-type']).toContain('application/problem+json');
    }
  });

  it('hides another workspace\u2019s job behind the same 404 as a nonexistent one', async () => {
    // A 403 here would confirm that jobB exists. Both answers must be identical.
    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobB}`,
      headers: authed(owner, wsA),
    });
    const absent = await app.inject({
      method: 'GET',
      url: `/v1/jobs/00000000-0000-7000-8000-000000000000`,
      headers: authed(owner, wsA),
    });
    expect(foreign.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect(foreign.json<{ detail: string }>().detail).toBe(
      absent.json<{ detail: string }>().detail,
    );

    // Same for the stream and for control: no cross-workspace leak on any path.
    for (const url of [`/v1/jobs/${jobB}/events`, `/v1/jobs/${jobB}:cancel`]) {
      const method = url.endsWith('events') ? 'GET' : 'POST';
      const res = await app.inject({ method, url, headers: authed(owner, wsA) });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 404 });
    }
    // And the legitimate owner in workspace B can still see it, so the 404 is isolation, not breakage.
    const legit = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobB}`,
      headers: authed(strangerInB, wsB),
    });
    expect(legit.statusCode).toBe(200);
  });

  it('enforces the role matrix: viewers cannot control, only owners may cancel', async () => {
    await updateJob(pool, jobA, { status: 'running' });
    const viewerPause = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobA}:pause`,
      headers: authed(viewer, wsA),
    });
    expect(viewerPause.statusCode).toBe(403);

    // An editor may pause and resume ordinary production.
    const editorPause = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobA}:pause`,
      headers: authed(editor, wsA),
    });
    expect(editorPause.statusCode).toBe(202);

    // Cancelling discards paid-for work, so it is reserved to owners.
    const editorCancel = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobA}:cancel`,
      headers: authed(editor, wsA),
    });
    expect(editorCancel.statusCode).toBe(403);
    const ownerCancel = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobA}:cancel`,
      headers: authed(owner, wsA),
    });
    expect(ownerCancel.statusCode).toBe(202);
  });

  it('requires a CSRF token for cookie-authenticated control', async () => {
    await updateJob(pool, jobA, { status: 'running' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobA}:pause`,
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsA },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('CSRF_REQUIRED');
    // The refused request changed nothing.
    expect((await getJob(pool, jobA))?.control).toBe('run');
  });

  // ---- control semantics over HTTP ---------------------------------------------------------------------

  it('pauses, resumes and reports the job\u2019s control state truthfully', async () => {
    await updateJob(pool, jobA, { status: 'running' });
    const pause = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobA}:pause`,
      headers: authed(owner, wsA),
    });
    expect(pause.statusCode).toBe(202);
    expect(pause.json()).toMatchObject({ applied: true, control: 'pause', status: 'running' });

    const read = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobA}`,
      headers: authed(owner, wsA),
    });
    expect(read.json()).toMatchObject({ control: 'pause', terminal: false, attention: false });

    await updateJob(pool, jobA, { status: 'paused' });
    const resume = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobA}:resume`,
      headers: authed(owner, wsA),
    });
    expect(resume.statusCode).toBe(202);
    expect(resume.json()).toMatchObject({ applied: true, control: 'run', status: 'queued' });
  });

  it('reports a refused control request as an honest non-application, not a silent success', async () => {
    await updateJob(pool, jobA, { status: 'completed' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobA}:cancel`,
      headers: authed(owner, wsA),
    });
    // 200 (not 202): nothing was applied, and the reason says why.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: false, reason: 'terminal', status: 'completed' });
  });

  it('surfaces the attention state for a job an operator must decide on', async () => {
    await updateJob(pool, jobA, { status: 'needs_attention' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobA}`,
      headers: authed(owner, wsA),
    });
    expect(res.json()).toMatchObject({ attention: true, terminal: false });
  });

  it('applies Idempotency-Key to control mutations', async () => {
    await updateJob(pool, jobA, { status: 'running' });
    const headers = { ...authed(owner, wsA), 'idempotency-key': 'pause-once' };
    const first = await app.inject({ method: 'POST', url: `/v1/jobs/${jobA}:pause`, headers });
    const replay = await app.inject({ method: 'POST', url: `/v1/jobs/${jobA}:pause`, headers });
    expect(first.statusCode).toBe(202);
    // The replay returns the STORED response rather than re-evaluating the control request.
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(first.json());
    const events = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM job_events WHERE job_id = $1 AND kind = 'job.pause_requested'`,
      [jobA],
    );
    expect(events.rows[0]?.n).toBe('1');
  });

  it('audits every applied control action with the actor and request id', async () => {
    await updateJob(pool, jobA, { status: 'running' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobA}:pause`,
      headers: authed(owner, wsA),
    });
    expect(res.statusCode).toBe(202);
    const audit = await pool.query<{
      action: string;
      actor_user_id: string;
      target_id: string;
      request_id: string;
    }>(
      `SELECT action, actor_user_id, target_id, request_id FROM audit_log
        WHERE workspace_id = $1 AND action = 'job.pause'`,
      [wsA],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_user_id: owner.userId, target_id: jobA });
    expect(audit.rows[0]?.request_id).toBe(res.headers['x-request-id']);
  });

  // ---- the event stream --------------------------------------------------------------------------------

  it('streams persisted events as text/event-stream and closes on the terminal event', async () => {
    for (const kind of ['job.started', 'step.completed'])
      await emitJobEvent(pool, { jobId: jobA, kind, payload: { step: kind } });
    await emitJobEvent(pool, {
      jobId: jobA,
      kind: 'job.completed',
      payload: { status: 'completed' },
      terminal: true,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobA}/events`,
      headers: authed(viewer, wsA),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const ids = [...res.body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual([1, 2, 3]);
    expect(res.body).toContain('event: job.completed');
  });

  it('replays only what a reconnecting client has not seen', async () => {
    for (const kind of ['job.started', 'step.completed', 'step.completed'])
      await emitJobEvent(pool, { jobId: jobA, kind, payload: {} });
    await emitJobEvent(pool, { jobId: jobA, kind: 'job.completed', payload: {}, terminal: true });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobA}/events`,
      headers: { ...authed(viewer, wsA), 'last-event-id': '2' },
    });
    const ids = [...res.body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual([3, 4]);
    expect(res.body).not.toContain('id: 1');
  });

  it('rejects a malformed Last-Event-ID instead of restarting the stream', async () => {
    await emitJobEvent(pool, { jobId: jobA, kind: 'job.completed', payload: {}, terminal: true });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobA}/events`,
      headers: { ...authed(viewer, wsA), 'last-event-id': 'not-a-number' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json<{ code: string }>().code).toBe('VALIDATION_FAILED');
  });

  it('never emits another workspace\u2019s events into a stream', async () => {
    await emitJobEvent(pool, { jobId: jobB, kind: 'job.started', payload: { tenant: 'b' } });
    await emitJobEvent(pool, { jobId: jobA, kind: 'job.started', payload: { tenant: 'a' } });
    await emitJobEvent(pool, { jobId: jobA, kind: 'job.completed', payload: {}, terminal: true });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobA}/events`,
      headers: authed(viewer, wsA),
    });
    expect(res.body).toContain('"tenant":"a"');
    expect(res.body).not.toContain('"tenant":"b"');
    expect(res.body).not.toContain(jobB);
  });
});
