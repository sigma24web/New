/**
 * API contract tests (Checkpoint 7) against the real Fastify app and a real PostgreSQL 16 database.
 *
 * These exist to prove the claims that are easy to assert and hard to guarantee:
 *
 *  * an unauthenticated or unverifiable credential never reaches data;
 *  * a forged `X-Workspace-Id` is refused even when the user is a legitimate member of some workspace;
 *  * an identifier from another workspace is indistinguishable from one that does not exist;
 *  * the role matrix is enforced (viewer cannot write);
 *  * cookie-authenticated writes require a matching CSRF token;
 *  * `Idempotency-Key` replays the stored response, refuses a changed body, and cannot duplicate work
 *    under concurrency;
 *  * errors are RFC 9457 problem documents that never leak SQL, stack traces or internal messages.
 *
 * `app.inject()` exercises the real routing, hooks and error handler — not a hand-rolled call of a handler.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  createApiKey,
  createProject,
  createUser,
  createWorkspace,
  migrate,
  resetDatabase,
  type Pool,
} from '@yeonjae/db';
import { databaseUrl, freshDatabase } from '@yeonjae/db/testkit';
import type { FastifyInstance } from 'fastify';
import { buildApi } from './server.js';
import { CSRF_HEADER, SESSION_COOKIE, WORKSPACE_HEADER } from './auth.js';

const run = databaseUrl() ? describe : describe.skip;

interface Actor {
  readonly userId: string;
  readonly cookie: string;
  readonly csrf: string;
}

run('API: authentication, tenancy and contract (Checkpoint 7)', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let wsA: string;
  let wsB: string;
  let projectA: string;
  let projectB: string;
  let owner: Actor;
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
    const cookie = String(raw).split(';')[0] ?? '';
    const body = res.json<{ csrf_token: string; user: { id: string } }>();
    return { userId: body.user.id, cookie, csrf: body.csrf_token };
  }

  beforeAll(async () => {
    pool = await freshDatabase();
    // Cookies are insecure ONLY here because inject() speaks plain HTTP; production defaults to Secure.
    app = buildApi({ pool, secureCookies: false });
    await app.ready();
  }, 60_000);

  beforeEach(async () => {
    await resetDatabase(pool);
    await migrate(pool);
    wsA = await createWorkspace(pool, 'workspace-a');
    wsB = await createWorkspace(pool, 'workspace-b');
    projectA = (await createProject(pool, { workspaceId: wsA, title: 'Project A' })).projectId;
    projectB = (await createProject(pool, { workspaceId: wsB, title: 'Project B' })).projectId;

    const ownerUser = await createUser(pool, {
      email: 'owner@example.com',
      displayName: 'Owner',
      password: 'owner-password',
    });
    const viewerUser = await createUser(pool, {
      email: 'viewer@example.com',
      displayName: 'Viewer',
      password: 'viewer-password',
    });
    const otherUser = await createUser(pool, {
      email: 'other@example.com',
      displayName: 'Other',
      password: 'other-password',
    });
    await addMember(pool, { workspaceId: wsA, userId: ownerUser.id, role: 'owner' });
    await addMember(pool, { workspaceId: wsA, userId: viewerUser.id, role: 'viewer' });
    await addMember(pool, { workspaceId: wsB, userId: otherUser.id, role: 'owner' });

    owner = await login('owner@example.com', 'owner-password');
    viewer = await login('viewer@example.com', 'viewer-password');
    strangerInB = await login('other@example.com', 'other-password');
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  // ---- authentication -------------------------------------------------------------------------------

  it('rejects an unauthenticated request with a problem document, not data', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/projects' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const problem = res.json<{ code: string; request_id: string; type: string; detail: string }>();
    expect(problem.code).toBe('UNAUTHENTICATED');
    expect(problem.type).toBe('urn:yeonjae:error:UNAUTHENTICATED');
    // A request id is always present so an operator can correlate with server logs.
    expect(problem.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body).not.toContain('SELECT');
  }, 60_000);

  it.each([
    ['a garbage bearer token', { authorization: 'Bearer not-a-real-key' }],
    ['a garbage session cookie', { cookie: `${SESSION_COOKIE}=forged` }],
    ['an empty bearer token', { authorization: 'Bearer ' }],
  ])(
    'refuses %s — there is no accept-any-token path',
    async (_label, headers) => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/projects',
        headers: { ...headers, [WORKSPACE_HEADER]: wsA },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ code: string }>().code).toBe('UNAUTHENTICATED');
    },
    60_000,
  );

  it('login is not an account-existence oracle', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'owner@example.com', password: 'wrong' },
    });
    const noSuchUser = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@example.com', password: 'wrong' },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(noSuchUser.statusCode).toBe(401);
    // Byte-identical bodies except the request id: the two cases are indistinguishable.
    const strip = (body: string) => body.replace(/"request_id":"[^"]+"/, '"request_id":"X"');
    expect(strip(wrongPassword.body)).toBe(strip(noSuchUser.body));
  }, 60_000);

  it('a revoked session stops working immediately', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsA },
    });
    expect(before.statusCode).toBe(200);
    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
    });
    expect(logout.statusCode).toBe(200);
    const after = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsA },
    });
    expect(after.statusCode).toBe(401);
  }, 60_000);

  // ---- tenancy --------------------------------------------------------------------------------------

  it('requires a workspace header and rejects a malformed one', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie: owner.cookie },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ code: string }>().code).toBe('WORKSPACE_REQUIRED');

    const malformed = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: 'not-a-uuid' },
    });
    expect(malformed.statusCode).toBe(400);
  }, 60_000);

  it('a forged workspace header is refused even for a real, logged-in user', async () => {
    // The owner of A presents B's workspace id. Membership, not the header, decides.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsB },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('NOT_A_MEMBER');
    // The response does not disclose whether that workspace exists.
    expect(res.body).not.toContain('workspace-b');
  }, 60_000);

  it('a nonexistent workspace is indistinguishable from one you do not belong to', async () => {
    const absent = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: {
        cookie: owner.cookie,
        [WORKSPACE_HEADER]: '00000000-0000-4000-8000-000000000000',
      },
    });
    const foreign = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsB },
    });
    const strip = (body: string) => body.replace(/"request_id":"[^"]+"/, '"request_id":"X"');
    expect(strip(absent.body)).toBe(strip(foreign.body));
  }, 60_000);

  it('a project id from another workspace reads as 404, not 403', async () => {
    // A 403 would confirm the id exists somewhere. Invisible rows are simply absent.
    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectB}`,
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsA },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('NOT_FOUND');
    expect(res.body).not.toContain('Project B');
  }, 60_000);

  it('listing projects returns only the active workspace', async () => {
    const a = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsA },
    });
    expect(a.json<{ items: { id: string }[] }>().items.map((p) => p.id)).toEqual([projectA]);

    const b = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie: strangerInB.cookie, [WORKSPACE_HEADER]: wsB },
    });
    expect(b.json<{ items: { id: string }[] }>().items.map((p) => p.id)).toEqual([projectB]);
  }, 60_000);

  it('an API key cannot be presented for a workspace it is not bound to', async () => {
    const key = await createApiKey(pool, {
      workspaceId: wsA,
      userId: owner.userId,
      name: 'ci-key',
    });
    const ok = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { authorization: `Bearer ${key.token}`, [WORKSPACE_HEADER]: wsA },
    });
    expect(ok.statusCode).toBe(200);

    // Make the same user a member of B too: the key must STILL be confined to its own workspace.
    await addMember(pool, { workspaceId: wsB, userId: owner.userId, role: 'owner' });
    const crossed = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { authorization: `Bearer ${key.token}`, [WORKSPACE_HEADER]: wsB },
    });
    expect(crossed.statusCode).toBe(403);
    expect(crossed.json<{ code: string }>().code).toBe('NOT_A_MEMBER');
  }, 60_000);

  // ---- authorization matrix -------------------------------------------------------------------------

  it('a viewer may read but may not create', async () => {
    const read = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie: viewer.cookie, [WORKSPACE_HEADER]: wsA },
    });
    expect(read.statusCode).toBe(200);

    const write = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { cookie: viewer.cookie, [CSRF_HEADER]: viewer.csrf, [WORKSPACE_HEADER]: wsA },
      payload: { title: 'Should not exist' },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json<{ code: string }>().code).toBe('FORBIDDEN');
    // And nothing was created.
    const after = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsA },
    });
    expect(after.json<{ items: unknown[] }>().items).toHaveLength(1);
  }, 60_000);

  // ---- CSRF -----------------------------------------------------------------------------------------

  it('a cookie-authenticated write without a matching CSRF token is refused', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsA },
      payload: { title: 'No CSRF' },
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.json<{ code: string }>().code).toBe('CSRF_REQUIRED');

    const forged = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: 'forged', [WORKSPACE_HEADER]: wsA },
      payload: { title: 'Forged CSRF' },
    });
    expect(forged.statusCode).toBe(403);
  }, 60_000);

  it('an API key write needs no CSRF token, because it is not cookie-borne', async () => {
    const key = await createApiKey(pool, {
      workspaceId: wsA,
      userId: owner.userId,
      name: 'ci-key',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { authorization: `Bearer ${key.token}`, [WORKSPACE_HEADER]: wsA },
      payload: { title: 'Made by CI' },
    });
    expect(res.statusCode).toBe(201);
  }, 60_000);

  // ---- validation -----------------------------------------------------------------------------------

  it.each([
    ['a missing title', {}],
    ['an empty title', { title: '   ' }],
    ['a non-string title', { title: 42 }],
    ['an unknown quality tier', { title: 'x', quality_tier: 'platinum' }],
    ['an unknown operating mode', { title: 'x', operating_mode: 'yolo' }],
  ])(
    'refuses %s with a field-level problem document',
    async (_label, payload) => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf, [WORKSPACE_HEADER]: wsA },
        payload,
      });
      expect(res.statusCode).toBe(422);
      const problem = res.json<{ code: string; errors?: { path: string; message: string }[] }>();
      expect(problem.code).toBe('VALIDATION_FAILED');
      expect(problem.errors?.length).toBeGreaterThan(0);
      expect(problem.errors?.[0]?.path).toMatch(/^body\./);
    },
    60_000,
  );

  it('normalizes language-bearing input to NFC at the boundary (ADR-0030)', async () => {
    // Decomposed "é" (e + combining acute) must be stored composed, or code-point offsets computed later
    // would address a different string than the one persisted.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf, [WORKSPACE_HEADER]: wsA },
      payload: { title: 'Cafe\u0301 Chronicle' },
    });
    expect(res.statusCode).toBe(201);
    const { projectId } = res.json<{ projectId: string }>();
    const read = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}`,
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsA },
    });
    const title = read.json<{ title: string }>().title;
    expect(title).toBe('Café Chronicle');
    expect(title.normalize('NFC')).toBe(title);
    expect(title).not.toContain('\u0301');
  }, 60_000);

  it('rejects a malformed path parameter without touching the database', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects/not-a-uuid',
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsA },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ code: string }>().code).toBe('VALIDATION_FAILED');
  }, 60_000);

  it('an unknown route returns a problem document, not an HTML error page', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/nope',
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsA },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json<{ code: string }>().code).toBe('NOT_FOUND');
  }, 60_000);

  // ---- idempotency ----------------------------------------------------------------------------------

  it('an identical retry under one Idempotency-Key replays the stored response', async () => {
    const headers = {
      cookie: owner.cookie,
      [CSRF_HEADER]: owner.csrf,
      [WORKSPACE_HEADER]: wsA,
      'idempotency-key': 'key-1',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers,
      payload: { title: 'Once' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers,
      payload: { title: 'Once' },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    // The SAME project, not a second one.
    expect(second.json<{ projectId: string }>().projectId).toBe(
      first.json<{ projectId: string }>().projectId,
    );
    const list = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsA },
    });
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(2); // the seeded one + one created
  }, 60_000);

  it('a reordered but equivalent body is still the same request', async () => {
    const headers = {
      cookie: owner.cookie,
      [CSRF_HEADER]: owner.csrf,
      [WORKSPACE_HEADER]: wsA,
      'idempotency-key': 'key-order',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers,
      payload: { title: 'Ordered', quality_tier: 'standard' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers,
      payload: { quality_tier: 'standard', title: 'Ordered' },
    });
    expect(second.json<{ projectId: string }>().projectId).toBe(
      first.json<{ projectId: string }>().projectId,
    );
  }, 60_000);

  it('the same key with a different body fails deterministically', async () => {
    const headers = {
      cookie: owner.cookie,
      [CSRF_HEADER]: owner.csrf,
      [WORKSPACE_HEADER]: wsA,
      'idempotency-key': 'key-2',
    };
    await app.inject({ method: 'POST', url: '/v1/projects', headers, payload: { title: 'First' } });
    const changed = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers,
      payload: { title: 'Different' },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json<{ code: string }>().code).toBe('IDEMPOTENCY_KEY_REUSED');
  }, 60_000);

  it('two workspaces may use the same key string without colliding', async () => {
    await addMember(pool, { workspaceId: wsB, userId: owner.userId, role: 'owner' });
    const inA = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: {
        cookie: owner.cookie,
        [CSRF_HEADER]: owner.csrf,
        [WORKSPACE_HEADER]: wsA,
        'idempotency-key': 'shared',
      },
      payload: { title: 'In A' },
    });
    const inB = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: {
        cookie: owner.cookie,
        [CSRF_HEADER]: owner.csrf,
        [WORKSPACE_HEADER]: wsB,
        'idempotency-key': 'shared',
      },
      payload: { title: 'In B' },
    });
    expect(inA.statusCode).toBe(201);
    expect(inB.statusCode).toBe(201);
    expect(inA.json<{ projectId: string }>().projectId).not.toBe(
      inB.json<{ projectId: string }>().projectId,
    );
  }, 60_000);

  it('concurrent duplicate requests cannot create duplicate work', async () => {
    const headers = {
      cookie: owner.cookie,
      [CSRF_HEADER]: owner.csrf,
      [WORKSPACE_HEADER]: wsA,
      'idempotency-key': 'race',
    };
    const payload = { title: 'Raced' };
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/projects', headers, payload }),
      app.inject({ method: 'POST', url: '/v1/projects', headers, payload }),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort((x, y) => x - y);
    // Either both saw the same committed answer, or one was told the identical request is in flight.
    expect(statuses[0]).toBe(201);
    expect([201, 409]).toContain(statuses[1]);
    if (statuses[1] === 409) {
      const conflict = [a, b].find((r) => r.statusCode === 409);
      expect(conflict?.json<{ code: string }>().code).toBe('IDEMPOTENT_REQUEST_IN_PROGRESS');
    }
    // Exactly one project was created either way.
    const list = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsA },
    });
    const titles = list
      .json<{ items: { title: string }[] }>()
      .items.filter((p) => p.title === 'Raced');
    expect(titles).toHaveLength(1);
  }, 60_000);

  // ---- security headers, health and audit -----------------------------------------------------------

  it('sets conservative security headers on every response, including errors', async () => {
    for (const url of ['/health', '/v1/projects']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
  }, 60_000);

  it('the session cookie is HttpOnly and SameSite=Strict', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'owner@example.com', password: 'owner-password' },
    });
    const setCookie = res.headers['set-cookie'];
    const raw = String(Array.isArray(setCookie) ? setCookie[0] : setCookie);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Strict');
    expect(raw).toContain('Path=/');
    // The session token is never echoed into the JSON body.
    expect(res.body).not.toContain(raw.split('=')[1]?.split(';')[0] ?? 'unreachable');
  }, 60_000);

  it('health and readiness answer without authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json<{ status: string }>().status).toBe('ready');
  }, 60_000);

  it('records privileged actions in the audit log with the actor and request id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf, [WORKSPACE_HEADER]: wsA },
      payload: { title: 'Audited' },
    });
    expect(res.statusCode).toBe(201);
    const rows = await pool.query<{
      action: string;
      actor_user_id: string;
      request_id: string;
      workspace_id: string;
      detail: Record<string, unknown>;
    }>(`SELECT action, actor_user_id, request_id, workspace_id, detail FROM audit_log`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.action).toBe('project.create');
    expect(rows.rows[0]?.actor_user_id).toBe(owner.userId);
    expect(rows.rows[0]?.workspace_id).toBe(wsA);
    expect(rows.rows[0]?.request_id).toBe(res.headers['x-request-id']);
  }, 60_000);

  // ---- error redaction ------------------------------------------------------------------------------

  it('never leaks SQL, stack traces or internal error text', async () => {
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/projects' }),
      app.inject({
        method: 'GET',
        url: `/v1/projects/${projectB}`,
        headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsA },
      }),
      app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf, [WORKSPACE_HEADER]: wsA },
        payload: { title: 42 },
      }),
    ]);
    for (const res of responses) {
      const body = res.body;
      for (const forbidden of [
        'SELECT',
        'INSERT',
        'pg_',
        'at Object.',
        'node_modules',
        'ECONNREFUSED',
        'password_hash',
        'yeonjae_app',
      ])
        expect(body, `${res.statusCode} leaked ${forbidden}`).not.toContain(forbidden);
    }
  }, 60_000);

  // ---- pagination -----------------------------------------------------------------------------------

  it('paginates deterministically and refuses a malformed cursor', async () => {
    for (const title of ['P1', 'P2', 'P3'])
      await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf, [WORKSPACE_HEADER]: wsA },
        payload: { title },
      });
    const first = await app.inject({
      method: 'GET',
      url: '/v1/projects?limit=2',
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsA },
    });
    const page1 = first.json<{ items: { id: string }[]; next_cursor: string | null }>();
    expect(page1.items).toHaveLength(2);
    expect(page1.next_cursor).toBeTruthy();

    const second = await app.inject({
      method: 'GET',
      url: `/v1/projects?limit=2&cursor=${encodeURIComponent(page1.next_cursor ?? '')}`,
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsA },
    });
    const page2 = second.json<{ items: { id: string }[] }>();
    // No overlap and stable order: ids strictly increase across pages.
    const ids1 = page1.items.map((p) => p.id);
    const ids2 = page2.items.map((p) => p.id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
    expect([...ids1].sort()).toEqual(ids1);

    // Repeating the same request returns the same page.
    const repeat = await app.inject({
      method: 'GET',
      url: '/v1/projects?limit=2',
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsA },
    });
    expect(repeat.json<{ items: { id: string }[] }>().items.map((p) => p.id)).toEqual(ids1);

    const bad = await app.inject({
      method: 'GET',
      url: '/v1/projects?limit=2&cursor=%20%21%21not-base64',
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsA },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ code: string }>().code).toBe('INVALID_CURSOR');
  }, 120_000);

  it('rejects an out-of-range limit rather than clamping silently', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects?limit=100000',
      headers: { cookie: owner.cookie, [WORKSPACE_HEADER]: wsA },
    });
    expect(res.statusCode).toBe(422);
  }, 60_000);
});
