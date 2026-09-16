/**
 * Least privilege of the request-scoped application role (migration 0007, Checkpoint 7 audit repair).
 *
 * The isolation tests in `identity.integration.test.ts` prove RLS keeps one workspace's rows out of another
 * workspace's connection. They cannot prove anything about the tables that deliberately have NO workspace
 * column — `users`, `sessions`, `schema_migrations`, and the global prompt registry — because those carry no
 * policy at all. For them the only control is the grant, so the grant is what these tests pin down.
 *
 * Every case here failed against migration 0006 alone. They are regression tests for a real finding, not
 * restatements of the migration text.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_ROLE, createPool, migrate, resetDatabase, type Client, type Pool } from './index.js';
import { databaseUrl } from './testkit.js';

const run = databaseUrl() ? describe : describe.skip;

/**
 * Run one statement as the request-scoped role and report whether it was permitted. The transaction is
 * always rolled back, so a statement that IS permitted cannot corrupt the rest of the suite.
 */
async function asAppRole(
  pool: Pool,
  sql: string,
  params: readonly unknown[] = [],
): Promise<{ permitted: boolean; code?: string | undefined; rowCount: number }> {
  const client: Client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    const r = await client.query(sql, params as unknown[]);
    return { permitted: true, rowCount: r.rowCount ?? 0 };
  } catch (err) {
    const code = (err as { code?: string }).code;
    return { permitted: false, code, rowCount: 0 };
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** PostgreSQL's SQLSTATE for "permission denied for table". */
const INSUFFICIENT_PRIVILEGE = '42501';

run(
  'the request-scoped application role holds only the privileges it needs (migration 0007)',
  () => {
    let pool: Pool;

    beforeAll(async () => {
      const url = databaseUrl();
      if (!url) throw new Error('DATABASE_URL not set');
      pool = createPool({ connectionString: url, max: 4 });
      await resetDatabase(pool);
      await migrate(pool);
    }, 60_000);
    beforeEach(async () => {
      await resetDatabase(pool);
      await migrate(pool);
    });
    afterAll(async () => {
      await pool.end();
    });

    it('is a non-superuser role that cannot bypass row-level security', async () => {
      const r = await pool.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
      }>(
        'SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1',
        [APP_ROLE],
      );
      expect(r.rows[0]).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
      });
    });

    it('cannot read password verifiers or session secrets (those tables have no workspace and no policy)', async () => {
      // Authentication runs on the unscoped pool before a workspace is proven, so a request-scoped
      // connection has no legitimate reason to touch either table.
      for (const table of ['users', 'sessions']) {
        const read = await asAppRole(pool, `SELECT * FROM ${table}`);
        expect({ table, ...read }).toMatchObject({
          table,
          permitted: false,
          code: INSUFFICIENT_PRIVILEGE,
        });
      }
    });

    it('cannot overwrite a password verifier or delete a session', async () => {
      const update = await asAppRole(pool, `UPDATE users SET password_hash = 'x'`);
      expect(update.permitted).toBe(false);
      expect(update.code).toBe(INSUFFICIENT_PRIVILEGE);
      const revoke = await asAppRole(pool, 'DELETE FROM sessions');
      expect(revoke.permitted).toBe(false);
      expect(revoke.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it('cannot erase the migration ledger (which would make migrate() replay every migration)', async () => {
      const before = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM schema_migrations',
      );
      const wipe = await asAppRole(pool, 'DELETE FROM schema_migrations');
      expect(wipe.permitted).toBe(false);
      expect(wipe.code).toBe(INSUFFICIENT_PRIVILEGE);
      const after = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM schema_migrations',
      );
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
      expect(Number(after.rows[0]?.n)).toBeGreaterThan(0);
    });

    it('may read the global prompt registry but never rewrite it', async () => {
      // Read access is required: the gateway resolves pinned prompt versions on every production call.
      for (const table of ['prompt_versions', 'prompt_sets']) {
        const read = await asAppRole(pool, `SELECT count(*) FROM ${table}`);
        expect({ table, permitted: read.permitted }).toEqual({ table, permitted: true });
        for (const write of [`UPDATE ${table} SET id = id`, `DELETE FROM ${table}`]) {
          const attempt = await asAppRole(pool, write);
          expect({ write, permitted: attempt.permitted, code: attempt.code }).toMatchObject({
            write,
            permitted: false,
            code: INSUFFICIENT_PRIVILEGE,
          });
        }
      }
    });

    it('cannot mint an API key or promote its own principal through workspace_members', async () => {
      // Both are owner operations on the audited, unscoped path. A request-scoped connection that could do
      // either could manufacture a credential or a role for itself.
      const mint = await asAppRole(
        pool,
        `INSERT INTO api_keys (workspace_id, user_id, name, token_hash)
       VALUES (canon.uuid_v7(), canon.uuid_v7(), 'forged', 'deadbeef')`,
      );
      expect(mint.permitted).toBe(false);
      expect(mint.code).toBe(INSUFFICIENT_PRIVILEGE);

      const promote = await asAppRole(pool, `UPDATE workspace_members SET role = 'owner'`);
      expect(promote.permitted).toBe(false);
      expect(promote.code).toBe(INSUFFICIENT_PRIVILEGE);

      // Reading membership stays permitted: it is how the API derives a role, under RLS.
      const read = await asAppRole(pool, 'SELECT count(*) FROM workspace_members');
      expect(read.permitted).toBe(true);
    });

    it('refuses UPDATE and DELETE on prompt_sets at the trigger too, not only by grant', async () => {
      // Defence in depth: revoking the grant protects the request path, but the owner connection (migrations,
      // CLI, workers) writes prompt sets and must not be able to silently repoint a pinned mapping either.
      await pool.query(
        `INSERT INTO prompt_sets (id, mapping) VALUES ('set.audit.v1', '{"role":"x"}'::jsonb)`,
      );
      await expect(
        pool.query(
          `UPDATE prompt_sets SET mapping = '{"role":"y"}'::jsonb WHERE id = 'set.audit.v1'`,
        ),
      ).rejects.toThrow();
      await expect(
        pool.query(`DELETE FROM prompt_sets WHERE id = 'set.audit.v1'`),
      ).rejects.toThrow();
      const still = await pool.query<{ mapping: Record<string, string> }>(
        `SELECT mapping FROM prompt_sets WHERE id = 'set.audit.v1'`,
      );
      expect(still.rows[0]?.mapping).toEqual({ role: 'x' });
    });

    it('every workspace-owned table has RLS enabled, forced, and at least one policy', async () => {
      // 0006 covers this today; the assertion exists so a later migration that adds a tenant table without a
      // policy fails here instead of in production. Tables listed as intentionally global are excluded.
      const globalTables = [
        'prompt_versions',
        'prompt_sets',
        'schema_migrations',
        'users',
        'sessions',
      ];
      const r = await pool.query<{ relname: string; forced: boolean; policies: number }>(
        `SELECT c.relname,
              c.relforcerowsecurity AS forced,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT (c.relname = ANY($1))
        ORDER BY c.relname`,
        [globalTables],
      );
      expect(r.rows.length).toBeGreaterThan(20);
      const unprotected = r.rows.filter((row) => !row.forced || row.policies === 0);
      expect(unprotected).toEqual([]);
    });

    it('future tables default to read-only for the scoped role, so a new table cannot silently be writable', async () => {
      // 0006's ALTER DEFAULT PRIVILEGES granted full DML on every future table; 0007 narrows it to SELECT.
      await pool.query(
        'CREATE TABLE audit_probe_table (id uuid PRIMARY KEY DEFAULT canon.uuid_v7())',
      );
      try {
        const read = await asAppRole(pool, 'SELECT count(*) FROM audit_probe_table');
        expect(read.permitted).toBe(true);
        const write = await asAppRole(pool, 'INSERT INTO audit_probe_table DEFAULT VALUES');
        expect(write.permitted).toBe(false);
        expect(write.code).toBe(INSUFFICIENT_PRIVILEGE);
      } finally {
        await pool.query('DROP TABLE audit_probe_table');
      }
    });
  },
);
