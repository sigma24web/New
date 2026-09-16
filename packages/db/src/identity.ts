/**
 * Identity, membership and workspace context (Checkpoint 7; migration 0006).
 *
 * Three rules shape this module, and each one is a rule because the alternative is a security defect:
 *
 *  * CREDENTIALS ARE NEVER STORED IN A USABLE FORM. Passwords, session tokens and API keys are stored as
 *    hashes. Passwords use scrypt with a per-user salt and recorded parameters, so the cost can be raised
 *    later without invalidating existing rows. Session and API-key tokens are high-entropy random secrets,
 *    so a single SHA-256 of the presented value is the right verifier — there is nothing to brute-force.
 *  * COMPARISONS ARE CONSTANT-TIME. Verifying a credential with `===` leaks how much of it matched.
 *  * THE WORKSPACE CONTEXT IS SERVER-DERIVED. `withWorkspace` sets `app.workspace_id` only from a membership
 *    row this module read itself, and it switches the connection to the non-superuser `yeonjae_app` role so
 *    the RLS policies of migration 0006 are actually binding. A client-supplied workspace id is never fed
 *    into the context; it is only ever *checked* against membership.
 */
import {
  randomBytes,
  createHash,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { type Client, type Pool, rethrowCanon } from './client.js';

/** Promisified scrypt. `promisify` cannot type the 4-argument overload, so it is wrapped explicitly. */
function scrypt(
  password: string,
  salt: string,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

type Queryable = Pool | Client;

export type WorkspaceRole = 'owner' | 'editor' | 'viewer';

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_algo: string;
  password_params: { N: number; r: number; p: number; keylen: number };
  password_salt: string;
  password_hash: string;
  status: 'active' | 'disabled';
  created_at: Date;
}

export interface MembershipRow {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: Date;
}

/** scrypt parameters for new credentials. Stored per row so they can be raised without a migration. */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A fresh high-entropy secret for a session or API key. Returned once; only its hash is persisted. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

async function scryptHash(
  password: string,
  salt: string,
  params: { N: number; r: number; p: number; keylen: number },
): Promise<string> {
  const derived = await scrypt(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    // scrypt needs memory proportional to N*r*128; the default limit rejects our parameters.
    maxmem: 256 * params.N * params.r,
  });
  return derived.toString('hex');
}

/** Constant-time comparison of two hex digests of equal expected length. */
function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

export async function createUser(
  db: Queryable,
  input: { email: string; displayName: string; password: string },
): Promise<UserRow> {
  const salt = randomBytes(16).toString('hex');
  const hash = await scryptHash(input.password, salt, SCRYPT_PARAMS);
  const r = await db
    .query<UserRow>(
      `INSERT INTO users (email, display_name, password_algo, password_params, password_salt, password_hash)
       VALUES ($1, $2, 'scrypt', $3::jsonb, $4, $5) RETURNING *`,
      [
        input.email.trim().toLowerCase(),
        input.displayName,
        JSON.stringify(SCRYPT_PARAMS),
        salt,
        hash,
      ],
    )
    .catch(rethrowCanon);
  const row = r.rows[0];
  if (!row) throw new Error('user insert returned no row');
  return row;
}

export async function getUserByEmail(db: Queryable, email: string): Promise<UserRow | undefined> {
  const r = await db.query<UserRow>('SELECT * FROM users WHERE email = $1', [
    email.trim().toLowerCase(),
  ]);
  return r.rows[0];
}

/**
 * Verify a password against the stored verifier. A disabled user and a wrong password are both reported as
 * `undefined`: the caller must not be able to distinguish "no such account" from "wrong password".
 */
export async function verifyPassword(
  db: Queryable,
  email: string,
  password: string,
): Promise<UserRow | undefined> {
  const user = await getUserByEmail(db, email);
  if (!user) {
    // Spend comparable work anyway so a missing account is not detectable by timing alone.
    await scryptHash(password, 'absent-account-salt', SCRYPT_PARAMS);
    return undefined;
  }
  const computed = await scryptHash(password, user.password_salt, user.password_params);
  if (!hashesEqual(computed, user.password_hash)) return undefined;
  if (user.status !== 'active') return undefined;
  return user;
}

export async function addMember(
  db: Queryable,
  input: { workspaceId: string; userId: string; role: WorkspaceRole },
): Promise<MembershipRow> {
  const r = await db
    .query<MembershipRow>(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role
       RETURNING *`,
      [input.workspaceId, input.userId, input.role],
    )
    .catch(rethrowCanon);
  const row = r.rows[0];
  if (!row) throw new Error('membership upsert returned no row');
  return row;
}

export async function removeMember(
  db: Queryable,
  input: { workspaceId: string; userId: string },
): Promise<boolean> {
  const r = await db.query(
    'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [input.workspaceId, input.userId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * The membership row for a (workspace, user), or `undefined`. This is the ONLY source of a principal's role:
 * nothing derived from a request header or body may substitute for it.
 */
export async function membershipOf(
  db: Queryable,
  input: { workspaceId: string; userId: string },
): Promise<MembershipRow | undefined> {
  const r = await db.query<MembershipRow>(
    'SELECT * FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [input.workspaceId, input.userId],
  );
  return r.rows[0];
}

export async function workspacesOf(
  db: Queryable,
  userId: string,
): Promise<{ workspace_id: string; name: string; role: WorkspaceRole }[]> {
  // Deliberately reads through the membership table with an explicit join rather than relying on the RLS
  // context, because this runs BEFORE a workspace is selected.
  const r = await db.query<{ workspace_id: string; name: string; role: WorkspaceRole }>(
    `SELECT m.workspace_id, w.name, m.role
       FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = $1 ORDER BY w.name, m.workspace_id`,
    [userId],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------------------------------------

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_token_hash: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface IssuedSession {
  readonly sessionId: string;
  /** Returned to the client once. Only its hash is stored. */
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}

export async function createSession(
  db: Queryable,
  input: { userId: string; ttlSeconds?: number },
): Promise<IssuedSession> {
  const token = generateToken();
  const csrfToken = generateToken(24);
  const ttl = input.ttlSeconds ?? 12 * 60 * 60;
  const r = await db
    .query<SessionRow>(
      `INSERT INTO sessions (user_id, token_hash, csrf_token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4)) RETURNING *`,
      [input.userId, sha256(token), sha256(csrfToken), ttl],
    )
    .catch(rethrowCanon);
  const row = r.rows[0];
  if (!row) throw new Error('session insert returned no row');
  return { sessionId: row.id, token, csrfToken, expiresAt: row.expires_at };
}

/** Resolve a presented session token. Expired and revoked sessions resolve to `undefined`, never to a user. */
export async function resolveSession(
  db: Queryable,
  token: string,
): Promise<{ session: SessionRow; user: UserRow } | undefined> {
  const r = await db.query<SessionRow>(
    `SELECT * FROM sessions
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [sha256(token)],
  );
  const session = r.rows[0];
  if (!session) return undefined;
  const u = await db.query<UserRow>(`SELECT * FROM users WHERE id = $1 AND status = 'active'`, [
    session.user_id,
  ]);
  const user = u.rows[0];
  if (!user) return undefined;
  return { session, user };
}

export function csrfMatches(session: SessionRow, presented: string): boolean {
  return hashesEqual(sha256(presented), session.csrf_token_hash);
}

export async function revokeSession(db: Queryable, sessionId: string): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [
    sessionId,
  ]);
}

// ---------------------------------------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------------------------------------

export interface ApiKeyRow {
  id: string;
  workspace_id: string;
  user_id: string;
  name: string;
  token_hash: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export async function createApiKey(
  db: Queryable,
  input: { workspaceId: string; userId: string; name: string },
): Promise<{ id: string; token: string }> {
  const token = generateToken();
  const r = await db
    .query<ApiKeyRow>(
      `INSERT INTO api_keys (workspace_id, user_id, name, token_hash) VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.workspaceId, input.userId, input.name, sha256(token)],
    )
    .catch(rethrowCanon);
  const row = r.rows[0];
  if (!row) throw new Error('api key insert returned no row');
  return { id: row.id, token };
}

export async function resolveApiKey(
  db: Queryable,
  token: string,
): Promise<{ key: ApiKeyRow; user: UserRow } | undefined> {
  const r = await db.query<ApiKeyRow>(
    'SELECT * FROM api_keys WHERE token_hash = $1 AND revoked_at IS NULL',
    [sha256(token)],
  );
  const key = r.rows[0];
  if (!key) return undefined;
  const u = await db.query<UserRow>(`SELECT * FROM users WHERE id = $1 AND status = 'active'`, [
    key.user_id,
  ]);
  const user = u.rows[0];
  if (!user) return undefined;
  // Record the use and return the row as it now stands, so the caller observes the update it caused rather
  // than the pre-update snapshot.
  const touched = await db.query<ApiKeyRow>(
    'UPDATE api_keys SET last_used_at = now() WHERE id = $1 RETURNING *',
    [key.id],
  );
  return { key: touched.rows[0] ?? key, user };
}

export async function revokeApiKey(db: Queryable, id: string): Promise<void> {
  await db.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [
    id,
  ]);
}

// ---------------------------------------------------------------------------------------------------------
// workspace context for RLS
// ---------------------------------------------------------------------------------------------------------

/** The role the application runs as so that migration 0006's RLS policies are binding (never a superuser). */
export const APP_ROLE = 'yeonjae_app';

/**
 * Run `fn` with the database connection scoped to one workspace: the non-superuser application role plus
 * `app.workspace_id`. Every statement inside sees only that workspace's rows, enforced by the database.
 *
 * `workspaceId` must already have been verified against a membership row — this function scopes a connection,
 * it does not authorize. Callers in the API layer go through `requireWorkspace`, which does both in order.
 */
export async function withWorkspace<T>(
  pool: Pool,
  workspaceId: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // set_config with is_local=true scopes both settings to this transaction, so a pooled connection can
    // never leak one request's workspace into the next.
    await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', workspaceId]);
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
