/**
 * Authentication and workspace authorization (Checkpoint 7).
 *
 * The order of operations is the security property, so it is written once, here, and every route goes
 * through it:
 *
 *   1. AUTHENTICATE. Resolve the principal from a credential the server can verify — a session cookie or a
 *      bearer API key, both stored only as hashes. There is no "accept any bearer token" path: an
 *      unverifiable credential is `UNAUTHENTICATED`, never a default user.
 *   2. AUTHORIZE. Read the membership row for (workspace, principal) from the database. A client-supplied
 *      `X-Workspace-Id` is only ever *checked* against that row; it is never trusted, and for API-key
 *      principals it must additionally match the key's own workspace.
 *   3. SCOPE. Only then open a connection with `SET LOCAL ROLE yeonjae_app` and `app.workspace_id`, so the
 *      RLS policies of migration 0006 apply to every statement the request makes.
 *
 * `requireRole` implements the authorization matrix: viewer reads, editor produces and reviews, owner
 * administers and performs destructive operations.
 */
import {
  csrfMatches,
  membershipOf,
  resolveApiKey,
  resolveSession,
  withWorkspace,
  type Client,
  type Pool,
  type SessionRow,
  type UserRow,
  type WorkspaceRole,
} from '@yeonjae/db';
import { ApiError } from './problem.js';

export const SESSION_COOKIE = 'yeonjae_session';
export const CSRF_HEADER = 'x-csrf-token';
export const WORKSPACE_HEADER = 'x-workspace-id';

export interface Principal {
  readonly user: UserRow;
  readonly via: 'session' | 'api_key';
  readonly session?: SessionRow | undefined;
  /** For API keys: the workspace the key itself is bound to. A key cannot reach another workspace. */
  readonly keyWorkspaceId?: string | undefined;
}

export interface RequestLike {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly cookies?: Readonly<Record<string, string | undefined>> | undefined;
}

function header(req: RequestLike, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Parse `Cookie` without a dependency; the API only needs its own session cookie. */
export function parseCookies(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Resolve the authenticated principal, or throw. Cookie-authenticated unsafe requests additionally require a
 * matching CSRF token (double-submit): a browser can be made to send a cookie cross-site, but not a header.
 * API-key requests are not cookie-borne, so CSRF does not apply to them.
 */
export async function authenticate(pool: Pool, req: RequestLike): Promise<Principal> {
  const authorization = header(req, 'authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice(7).trim();
    const resolved = await resolveApiKey(pool, token);
    if (!resolved)
      throw new ApiError('UNAUTHENTICATED', 'The API key is missing, revoked or invalid.');
    return {
      user: resolved.user,
      via: 'api_key',
      keyWorkspaceId: resolved.key.workspace_id,
    };
  }

  const cookies = req.cookies ?? parseCookies(header(req, 'cookie'));
  const sessionToken = cookies[SESSION_COOKIE];
  if (!sessionToken)
    throw new ApiError('UNAUTHENTICATED', 'A session cookie or API key is required.');
  const resolved = await resolveSession(pool, sessionToken);
  if (!resolved)
    throw new ApiError('UNAUTHENTICATED', 'The session is expired, revoked or invalid.');

  if (UNSAFE_METHODS.has(req.method.toUpperCase())) {
    const presented = header(req, CSRF_HEADER);
    if (!presented || !csrfMatches(resolved.session, presented))
      throw new ApiError(
        'CSRF_REQUIRED',
        'A matching CSRF token header is required for cookie-authenticated writes.',
      );
  }
  return { user: resolved.user, via: 'session', session: resolved.session };
}

export interface WorkspaceScope {
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
  readonly principal: Principal;
}

/**
 * Verify that the principal really belongs to the requested workspace. This is where a forged
 * `X-Workspace-Id` dies: the header names a candidate, and membership decides.
 */
export async function requireWorkspace(
  pool: Pool,
  principal: Principal,
  requested: string | undefined,
): Promise<WorkspaceScope> {
  const workspaceId = requested?.trim();
  if (!workspaceId)
    throw new ApiError('WORKSPACE_REQUIRED', `The ${WORKSPACE_HEADER} header is required.`);
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId))
    throw new ApiError('WORKSPACE_REQUIRED', `The ${WORKSPACE_HEADER} header must be a UUID.`);

  // An API key is bound to one workspace; presenting it with another workspace's id is a forgery attempt,
  // and it is refused even if the user happens to be a member of that other workspace.
  if (principal.via === 'api_key' && principal.keyWorkspaceId !== workspaceId)
    throw new ApiError('NOT_A_MEMBER', 'This API key is not valid for the requested workspace.');

  const membership = await membershipOf(pool, { workspaceId, userId: principal.user.id });
  if (!membership)
    // Deliberately identical to the response for a workspace that does not exist: membership must not be a
    // probe for which workspaces exist.
    throw new ApiError('NOT_A_MEMBER', 'The workspace does not exist or you are not a member.');
  return { workspaceId, role: membership.role, principal };
}

const RANK: Record<WorkspaceRole, number> = { viewer: 1, editor: 2, owner: 3 };

/** Enforce the authorization matrix. `viewer` < `editor` < `owner`. */
export function requireRole(scope: WorkspaceScope, minimum: WorkspaceRole): void {
  if (RANK[scope.role] < RANK[minimum])
    throw new ApiError(
      'FORBIDDEN',
      `This operation requires the ${minimum} role; your role is ${scope.role}.`,
    );
}

/** Run `fn` inside the authorized workspace's RLS scope. */
export async function inScope<T>(
  pool: Pool,
  scope: WorkspaceScope,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  return withWorkspace(pool, scope.workspaceId, fn);
}
