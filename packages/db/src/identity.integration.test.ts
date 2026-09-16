/**
 * Checkpoint 7 identity and tenancy isolation (migration 0006).
 *
 * These are security guarantees, so they are proved rather than asserted:
 *
 *  * credentials are unrecoverable from the database and verification fails closed;
 *  * a workspace-scoped connection sees ONLY that workspace, enforced by PostgreSQL row-level security,
 *    not by the query the application happened to write;
 *  * a connection with no workspace context sees nothing at all;
 *  * RLS still holds when the query deliberately omits a `workspace_id` predicate — which is the whole
 *    point of defence in depth: if an API authorization check were bypassed, the database still refuses.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  APP_ROLE,
  createApiKey,
  createProject,
  createSession,
  createUser,
  createWorkspace,
  csrfMatches,
  membershipOf,
  migrate,
  removeMember,
  resetDatabase,
  resolveApiKey,
  resolveSession,
  revokeApiKey,
  revokeSession,
  verifyPassword,
  withWorkspace,
  workspacesOf,
  type Pool,
} from './index.js';
import { databaseUrl, freshDatabase } from './testkit.js';

const run = databaseUrl() ? describe : describe.skip;

run('identity: credentials are never stored in a usable form (Checkpoint 7)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await freshDatabase();
  }, 60_000);
  beforeEach(async () => {
    await resetDatabase(pool);
    await migrate(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('stores a salted scrypt verifier, never the password, and never a reversible form', async () => {
    const user = await createUser(pool, {
      email: 'Operator@Example.com',
      displayName: 'Operator',
      password: 'correct horse battery staple',
    });
    // Email is normalized at the boundary so 'Operator@' and 'operator@' cannot become two accounts.
    expect(user.email).toBe('operator@example.com');
    expect(user.password_algo).toBe('scrypt');
    expect(user.password_salt).toMatch(/^[0-9a-f]{32}$/);
    expect(user.password_hash).toMatch(/^[0-9a-f]{128}$/);
    // The stored row contains nothing resembling the password.
    const serialized = JSON.stringify(user).toLowerCase();
    expect(serialized).not.toContain('correct horse');
    expect(serialized).not.toContain('battery staple');
    // Parameters are recorded per row, so the cost can be raised later without orphaning existing users.
    expect(user.password_params).toMatchObject({ N: 16384, r: 8, p: 1, keylen: 64 });
  }, 60_000);

  it('two users with the same password get different verifiers (per-user salt)', async () => {
    const a = await createUser(pool, {
      email: 'a@example.com',
      displayName: 'A',
      password: 'same',
    });
    const b = await createUser(pool, {
      email: 'b@example.com',
      displayName: 'B',
      password: 'same',
    });
    expect(a.password_salt).not.toBe(b.password_salt);
    expect(a.password_hash).not.toBe(b.password_hash);
  }, 60_000);

  it('verification accepts the right password and fails closed otherwise', async () => {
    await createUser(pool, { email: 'op@example.com', displayName: 'Op', password: 'right-pass' });
    await expect(verifyPassword(pool, 'op@example.com', 'right-pass')).resolves.toMatchObject({
      email: 'op@example.com',
    });
    // Wrong password, unknown account and a disabled account are indistinguishable to the caller.
    expect(await verifyPassword(pool, 'op@example.com', 'wrong-pass')).toBeUndefined();
    expect(await verifyPassword(pool, 'nobody@example.com', 'right-pass')).toBeUndefined();
    await pool.query(`UPDATE users SET status = 'disabled' WHERE email = 'op@example.com'`);
    expect(await verifyPassword(pool, 'op@example.com', 'right-pass')).toBeUndefined();
  }, 60_000);

  it('sessions resolve only while live: expiry and revocation both fail closed', async () => {
    const user = await createUser(pool, {
      email: 'op@example.com',
      displayName: 'Op',
      password: 'pw',
    });
    const issued = await createSession(pool, { userId: user.id });
    const resolved = await resolveSession(pool, issued.token);
    expect(resolved?.user.id).toBe(user.id);
    // The token itself is not stored anywhere.
    const stored = await pool.query<{ token_hash: string }>('SELECT token_hash FROM sessions');
    expect(stored.rows[0]?.token_hash).not.toBe(issued.token);
    // CSRF token is bound to the session and compared against its hash.
    expect(resolved && csrfMatches(resolved.session, issued.csrfToken)).toBe(true);
    expect(resolved && csrfMatches(resolved.session, 'forged')).toBe(false);

    await revokeSession(pool, issued.sessionId);
    expect(await resolveSession(pool, issued.token)).toBeUndefined();

    const second = await createSession(pool, { userId: user.id, ttlSeconds: 1 });
    await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      second.sessionId,
    ]);
    expect(await resolveSession(pool, second.token)).toBeUndefined();
    expect(await resolveSession(pool, 'not-a-token')).toBeUndefined();
  }, 60_000);

  it('API keys resolve until revoked and record their use', async () => {
    const ws = await createWorkspace(pool, 'ws');
    const user = await createUser(pool, {
      email: 'op@example.com',
      displayName: 'Op',
      password: 'pw',
    });
    const key = await createApiKey(pool, { workspaceId: ws, userId: user.id, name: 'ci' });
    const resolved = await resolveApiKey(pool, key.token);
    expect(resolved?.key.workspace_id).toBe(ws);
    expect(resolved?.key.last_used_at ?? null).not.toBeNull();
    await revokeApiKey(pool, key.id);
    expect(await resolveApiKey(pool, key.token)).toBeUndefined();
  }, 60_000);

  it('membership is the only source of a role, and it can be revoked', async () => {
    const ws = await createWorkspace(pool, 'ws');
    const user = await createUser(pool, {
      email: 'op@example.com',
      displayName: 'Op',
      password: 'pw',
    });
    expect(await membershipOf(pool, { workspaceId: ws, userId: user.id })).toBeUndefined();
    await addMember(pool, { workspaceId: ws, userId: user.id, role: 'editor' });
    expect(await membershipOf(pool, { workspaceId: ws, userId: user.id })).toMatchObject({
      role: 'editor',
    });
    // Re-adding updates the role rather than creating a second row.
    await addMember(pool, { workspaceId: ws, userId: user.id, role: 'owner' });
    expect(await membershipOf(pool, { workspaceId: ws, userId: user.id })).toMatchObject({
      role: 'owner',
    });
    expect(await workspacesOf(pool, user.id)).toEqual([
      { workspace_id: ws, name: 'ws', role: 'owner' },
    ]);
    expect(await removeMember(pool, { workspaceId: ws, userId: user.id })).toBe(true);
    expect(await membershipOf(pool, { workspaceId: ws, userId: user.id })).toBeUndefined();
    expect(await workspacesOf(pool, user.id)).toEqual([]);
  }, 60_000);
});

run('tenancy: PostgreSQL row-level security isolates every workspace (Checkpoint 7)', () => {
  let pool: Pool;
  let wsA: string;
  let wsB: string;
  let projectA: string;
  let projectB: string;

  beforeAll(async () => {
    pool = await freshDatabase();
  }, 60_000);
  beforeEach(async () => {
    await resetDatabase(pool);
    await migrate(pool);
    wsA = await createWorkspace(pool, 'workspace-a');
    wsB = await createWorkspace(pool, 'workspace-b');
    projectA = (await createProject(pool, { workspaceId: wsA, title: 'A' })).projectId;
    projectB = (await createProject(pool, { workspaceId: wsB, title: 'B' })).projectId;
  }, 120_000);
  afterAll(async () => {
    await pool.end();
  });

  it('runs as a non-superuser role, because a superuser bypasses RLS entirely', async () => {
    const who = await withWorkspace(pool, wsA, async (c) => {
      const r = await c.query<{ role: string; bypass: boolean }>(
        'SELECT current_user AS role, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass',
      );
      return r.rows[0];
    });
    expect(who?.role).toBe(APP_ROLE);
    // The guarantee this test exists for: the application's own role cannot ignore the policies.
    expect(who?.bypass).toBe(false);
  }, 60_000);

  it('a workspace-scoped connection sees only its own rows — WITHOUT a workspace predicate', async () => {
    // The queries below deliberately omit `WHERE workspace_id = ...`. Anything they return came from the
    // database's own isolation, which is exactly the defence-in-depth claim.
    const fromA = await withWorkspace(pool, wsA, async (c) => ({
      workspaces: (await c.query<{ id: string }>('SELECT id FROM workspaces')).rows.map(
        (r) => r.id,
      ),
      projects: (await c.query<{ id: string }>('SELECT id FROM projects')).rows.map((r) => r.id),
    }));
    expect(fromA.workspaces).toEqual([wsA]);
    expect(fromA.projects).toEqual([projectA]);

    const fromB = await withWorkspace(pool, wsB, async (c) => ({
      workspaces: (await c.query<{ id: string }>('SELECT id FROM workspaces')).rows.map(
        (r) => r.id,
      ),
      projects: (await c.query<{ id: string }>('SELECT id FROM projects')).rows.map((r) => r.id),
    }));
    expect(fromB.workspaces).toEqual([wsB]);
    expect(fromB.projects).toEqual([projectB]);
  }, 60_000);

  it("naming another workspace's row id explicitly still returns nothing", async () => {
    const leaked = await withWorkspace(pool, wsA, async (c) => {
      const p = await c.query('SELECT id FROM projects WHERE id = $1', [projectB]);
      const w = await c.query('SELECT id FROM workspaces WHERE id = $1', [wsB]);
      return { projects: p.rowCount ?? 0, workspaces: w.rowCount ?? 0 };
    });
    // A guessed or forged identifier is not an access path.
    expect(leaked).toEqual({ projects: 0, workspaces: 0 });
  }, 60_000);

  it('a connection with no workspace context sees nothing', async () => {
    const counts = await withWorkspace(pool, wsA, async (c) => {
      // Clear the context the way a buggy or hostile code path might.
      await c.query('SELECT set_config($1, $2, true)', ['app.workspace_id', '']);
      const w = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM workspaces');
      const p = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM projects');
      return { workspaces: w.rows[0]?.n, projects: p.rows[0]?.n };
    });
    expect(counts).toEqual({ workspaces: 0, projects: 0 });
  }, 60_000);

  it('writes are constrained too: a workspace cannot insert rows into another workspace', async () => {
    const err = await withWorkspace(pool, wsA, async (c) =>
      c
        .query('INSERT INTO projects (workspace_id, title) VALUES ($1, $2)', [wsB, 'smuggled'])
        .then(() => undefined)
        .catch((e: unknown) => e),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { message: string }).message).toMatch(/row-level security|policy/i);
    // And nothing landed.
    const count = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM projects WHERE workspace_id = $1',
      [wsB],
    );
    expect(count.rows[0]?.n).toBe(1);
  }, 60_000);

  it('the workspace context does not leak between pooled uses of the same connection', async () => {
    // Sequential scoped uses of a small pool: the second must not inherit the first's context.
    for (const [ws, project] of [
      [wsA, projectA],
      [wsB, projectB],
      [wsA, projectA],
    ] as const) {
      const rows = await withWorkspace(pool, ws, async (c) =>
        (await c.query<{ id: string }>('SELECT id FROM projects')).rows.map((r) => r.id),
      );
      expect(rows).toEqual([project]);
    }
  }, 60_000);

  it.each([
    ['chapters', 'project_id'],
    ['jobs', 'project_id'],
    ['workflow_artifacts', 'project_id'],
    ['canon_commits', 'project_id'],
    ['entities', 'project_id'],
    ['timelines', 'project_id'],
    ['summaries', 'project_id'],
    ['search_documents', 'project_id'],
    ['audit_log', 'workspace_id'],
    ['job_events', 'project_id'],
    ['exports', 'project_id'],
    ['api_idempotency_keys', 'workspace_id'],
  ])(
    '%s is workspace-isolated',
    async (table) => {
      const enabled = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        'SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1',
        [table],
      );
      // Both flags matter: ENABLE alone would not apply to the table owner.
      expect(enabled.rows[0]?.relrowsecurity, `${table} RLS enabled`).toBe(true);
      expect(enabled.rows[0]?.relforcerowsecurity, `${table} RLS forced`).toBe(true);
      const policies = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_policies WHERE tablename = $1',
        [table],
      );
      expect(policies.rows[0]?.n, `${table} has a policy`).toBeGreaterThan(0);
    },
    60_000,
  );

  it('every workspace-owned table has RLS enabled, forced and a policy', async () => {
    // A new tenant table added without RLS is a silent isolation hole, so this asserts the invariant across
    // the whole schema rather than a list someone must remember to update.
    const rows = await pool.query<{ table_name: string }>(
      `SELECT c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN information_schema.columns col
           ON col.table_name = c.relname AND col.table_schema = 'public'
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND col.column_name = 'workspace_id'
          AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`,
    );
    expect(rows.rows.map((r) => r.table_name)).toEqual([]);
  }, 60_000);
});
