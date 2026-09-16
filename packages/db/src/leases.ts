/**
 * Target leases (Checkpoint 7; migration 0008, workflow reliability plan §1/§2).
 *
 * A lease answers "may this run touch this target right now?". Deterministic workflow ids already stop one
 * logical run from starting twice; a lease additionally stops two DIFFERENT runs — a scheduled production
 * and an operator regeneration, say — from racing each other into extraction and commit on one chapter.
 *
 * Three properties matter, and all three live in SQL (migration 0008) rather than here, because a check
 * performed in application code can be lost to a concurrent writer:
 *
 *  * EXCLUSIVITY: a partial unique index over live leases means at most one holder per target.
 *  * SELF-HEALING: a lease is a deadline the holder renews by heartbeat; a killed worker cannot block a
 *    target forever, because an expired lease may be stolen.
 *  * FENCING: every acquisition bumps a monotone fence. A revived holder that still believes it owns the
 *    lease presents a stale fence, and its renew/release is refused — which is what keeps a zombie worker
 *    from acting after its target was taken over.
 */
import { type Client, type Pool, rethrowCanon } from './client.js';

type Queryable = Pool | Client;

export type LeaseTargetKind = 'chapter' | 'project' | 'canon';

export interface LeaseRow {
  id: string;
  workspace_id: string;
  project_id: string;
  target_kind: LeaseTargetKind;
  target_id: string;
  holder_workflow_id: string;
  holder_job_id: string | null;
  fence: string | number;
  acquired_at: Date;
  renewed_at: Date;
  expires_at: Date;
  released_at: Date | null;
}

/** Default lease TTL. The reliability plan's heartbeat is 15 s with a 60 s timeout; the TTL matches it. */
export const LEASE_TTL_SECONDS = 60;

export interface AcquireLeaseInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly targetKind: LeaseTargetKind;
  readonly targetId: string;
  readonly holderWorkflowId: string;
  readonly holderJobId?: string | undefined;
  readonly ttlSeconds?: number | undefined;
}

/**
 * Acquire (or re-acquire) a lease. Returns `undefined` when a live lease is held by a different workflow —
 * the caller turns that into `LEASE_HELD` rather than waiting, so a duplicate start fails fast and visibly.
 *
 * Re-acquisition by the same workflow id is deliberately re-entrant: a worker that restarts mid-run must be
 * able to resume, and it is the same logical holder, so its fence is preserved.
 */
export async function acquireTargetLease(
  db: Queryable,
  input: AcquireLeaseInput,
): Promise<LeaseRow | undefined> {
  const r = await db
    .query<LeaseRow>(`SELECT * FROM canon.acquire_target_lease($1, $2, $3, $4, $5, $6, $7)`, [
      input.workspaceId,
      input.projectId,
      input.targetKind,
      input.targetId,
      input.holderWorkflowId,
      input.holderJobId ?? null,
      input.ttlSeconds ?? LEASE_TTL_SECONDS,
    ])
    .catch(rethrowCanon);
  const row = r.rows[0];
  // The function returns a NULL composite on contention, which surfaces as a row of nulls.
  return row?.id ? row : undefined;
}

/** Extend a held lease. `false` means the caller is no longer the holder and must stop touching the target. */
export async function renewTargetLease(
  db: Queryable,
  input: {
    leaseId: string;
    holderWorkflowId: string;
    fence: string | number;
    ttlSeconds?: number | undefined;
  },
): Promise<boolean> {
  const r = await db
    .query<{ renewed: boolean }>('SELECT canon.renew_target_lease($1, $2, $3, $4) AS renewed', [
      input.leaseId,
      input.holderWorkflowId,
      String(input.fence),
      input.ttlSeconds ?? LEASE_TTL_SECONDS,
    ])
    .catch(rethrowCanon);
  return r.rows[0]?.renewed ?? false;
}

/**
 * Release a lease. Idempotent: a retried cleanup activity must not error. Fenced: a lease already stolen by
 * a newer holder is not released out from under it.
 */
export async function releaseTargetLease(
  db: Queryable,
  input: { leaseId: string; holderWorkflowId: string; fence: string | number },
): Promise<boolean> {
  const r = await db
    .query<{ released: boolean }>('SELECT canon.release_target_lease($1, $2, $3) AS released', [
      input.leaseId,
      input.holderWorkflowId,
      String(input.fence),
    ])
    .catch(rethrowCanon);
  return r.rows[0]?.released ?? false;
}

export interface LeaseOwnership {
  readonly owned: boolean;
  /** Why ownership was lost, for a typed error an operator can act on. */
  readonly reason: 'held' | 'released' | 'expired' | 'fenced_out' | 'missing';
  /** The workflow that holds the lease now, when someone else does. */
  readonly currentHolder?: string | undefined;
  readonly currentFence?: string | undefined;
}

/**
 * Report whether a holder still owns a lease, and if not, why.
 *
 * This is a READ, deliberately separate from `renewTargetLease`. Renewal answers "extend my deadline",
 * which conflates "I no longer own this" with "the database is unreachable" into a single boolean — and a
 * caller that cannot tell those apart must either abort healthy runs on a blip or keep producing after
 * being fenced out. Reporting the reason lets the caller fail closed on lost ownership and retry on a
 * transport fault.
 */
export async function leaseOwnership(
  db: Queryable,
  input: { leaseId: string; holderWorkflowId: string; fence: string | number },
): Promise<LeaseOwnership> {
  const r = await db.query<{
    holder_workflow_id: string;
    fence: string;
    released_at: Date | null;
    expired: boolean;
  }>(
    `SELECT holder_workflow_id, fence::text AS fence, released_at, (expires_at <= now()) AS expired
       FROM target_leases WHERE id = $1`,
    [input.leaseId],
  );
  const row = r.rows[0];
  if (!row) return { owned: false, reason: 'missing' };

  // Who owns the target NOW. A holder whose own row says `released` may still have been superseded by a
  // different worker, and the caller needs to know that a rival is live — "released" alone would suggest
  // the target is free when it is not.
  const live = await db.query<{ holder_workflow_id: string; fence: string }>(
    `SELECT holder_workflow_id, fence::text AS fence FROM target_leases
      WHERE project_id = (SELECT project_id FROM target_leases WHERE id = $1)
        AND target_kind = (SELECT target_kind FROM target_leases WHERE id = $1)
        AND target_id = (SELECT target_id FROM target_leases WHERE id = $1)
        AND released_at IS NULL AND expires_at > now()
      ORDER BY fence DESC LIMIT 1`,
    [input.leaseId],
  );
  const current = live.rows[0];
  const supersededByRival =
    current !== undefined &&
    (current.holder_workflow_id !== input.holderWorkflowId ||
      current.fence !== String(input.fence));
  if (supersededByRival)
    return {
      owned: false,
      reason: 'fenced_out',
      currentHolder: current.holder_workflow_id,
      currentFence: current.fence,
    };

  if (row.holder_workflow_id !== input.holderWorkflowId || row.fence !== String(input.fence))
    return { owned: false, reason: 'fenced_out' };

  if (row.released_at !== null) return { owned: false, reason: 'released' };
  if (row.expired) return { owned: false, reason: 'expired' };
  return { owned: true, reason: 'held' };
}

/** The live lease on a target, if any. Used to tell an operator which run is in the way. */
export async function liveTargetLease(
  db: Queryable,
  input: { projectId: string; targetKind: LeaseTargetKind; targetId: string },
): Promise<LeaseRow | undefined> {
  const r = await db.query<LeaseRow>(
    `SELECT * FROM target_leases
      WHERE project_id = $1 AND target_kind = $2 AND target_id = $3 AND released_at IS NULL
        AND expires_at > now()`,
    [input.projectId, input.targetKind, input.targetId],
  );
  return r.rows[0];
}

/**
 * Run `fn` while holding a lease on a target, releasing it afterwards even on failure.
 *
 * The lease is released in `finally` so a crashed step does not hold its target until the TTL expires;
 * the TTL exists for the case where the process dies without running `finally` at all.
 */
export async function withTargetLease<T>(
  db: Queryable,
  input: AcquireLeaseInput,
  fn: (lease: LeaseRow) => Promise<T>,
): Promise<{ acquired: false; lease: LeaseRow | undefined } | { acquired: true; result: T }> {
  const lease = await acquireTargetLease(db, input);
  if (!lease)
    return {
      acquired: false,
      lease: await liveTargetLease(db, {
        projectId: input.projectId,
        targetKind: input.targetKind,
        targetId: input.targetId,
      }),
    };
  try {
    return { acquired: true, result: await fn(lease) };
  } finally {
    await releaseTargetLease(db, {
      leaseId: lease.id,
      holderWorkflowId: lease.holder_workflow_id,
      fence: lease.fence,
    }).catch(() => false);
  }
}
