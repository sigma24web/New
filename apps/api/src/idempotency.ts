/**
 * `Idempotency-Key` handling for mutation endpoints (API plan §1).
 *
 * A key is bound to (workspace, method, route, canonical request hash). That binding is the whole design:
 *
 *  * an identical retry replays the STORED response rather than doing the work again — which matters because
 *    the work behind these routes spends money at a model provider;
 *  * the same key with a different body is a client bug, not a licence to replay someone else's answer, so
 *    it fails deterministically with `IDEMPOTENCY_KEY_REUSED`;
 *  * two concurrent duplicate requests contend on the table's uniqueness, so exactly one proceeds and the
 *    other is told the request is already in progress. Neither can duplicate work or spend.
 *
 * The record is written in the caller's workspace scope, so RLS keeps one tenant's keys invisible to another
 * and two workspaces may use the same key string without colliding.
 */
import { createHash } from 'node:crypto';
import { type Client } from '@yeonjae/db';
import { ApiError } from './problem.js';

export interface IdempotencyOutcome<T> {
  readonly status: number;
  readonly body: T;
}

/** Order-insensitive hash of the request body: key reuse is judged on content, not formatting. */
export function requestHash(body: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sortKeysDeep(body) ?? null))
    .digest('hex')}`;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    );
  return value;
}

interface KeyRow {
  id: string;
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_status: number | null;
  response_body: unknown;
}

/**
 * Run `work` at most once for this key.
 *
 * Without a key the operation simply runs: the endpoints that require exactly-once semantics for spend are
 * additionally idempotent at the workflow layer (deterministic workflow ids and per-activity keys), so a
 * missing header degrades to "may repeat the request", never to "may double-spend".
 */
export async function withIdempotency<T>(
  client: Client,
  input: {
    workspaceId: string;
    key: string | undefined;
    method: string;
    route: string;
    body: unknown;
  },
  work: () => Promise<IdempotencyOutcome<T>>,
): Promise<IdempotencyOutcome<T>> {
  if (!input.key) return work();
  if (input.key.length > 255)
    throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key must be at most 255 characters.');

  const hash = requestHash(input.body);
  const claimed = await client.query<KeyRow>(
    `INSERT INTO api_idempotency_keys (workspace_id, idempotency_key, method, route, request_hash, status)
     VALUES ($1, $2, $3, $4, $5, 'in_progress')
     ON CONFLICT (workspace_id, idempotency_key, method, route) DO NOTHING
     RETURNING id, request_hash, status, response_status, response_body`,
    [input.workspaceId, input.key, input.method, input.route, hash],
  );

  const mine = claimed.rows[0];
  if (!mine) {
    // Someone else holds this key. Either it is the same request (replay or in flight) or a different one.
    const existing = await client.query<KeyRow>(
      `SELECT id, request_hash, status, response_status, response_body FROM api_idempotency_keys
        WHERE workspace_id = $1 AND idempotency_key = $2 AND method = $3 AND route = $4`,
      [input.workspaceId, input.key, input.method, input.route],
    );
    const row = existing.rows[0];
    if (!row) throw new ApiError('CONFLICT', 'The idempotency record vanished; retry the request.');
    if (row.request_hash !== hash)
      throw new ApiError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request body.',
      );
    if (row.status === 'completed' && row.response_status !== null)
      return { status: row.response_status, body: row.response_body as T };
    throw new ApiError(
      'IDEMPOTENT_REQUEST_IN_PROGRESS',
      'An identical request is already in progress; retry shortly to read its result.',
    );
  }

  const outcome = await work();
  await client.query(
    `UPDATE api_idempotency_keys
        SET status = 'completed', response_status = $2, response_body = $3::jsonb, completed_at = now()
      WHERE id = $1`,
    [mine.id, outcome.status, JSON.stringify(outcome.body)],
  );
  return outcome;
}
