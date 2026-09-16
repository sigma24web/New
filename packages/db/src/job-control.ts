/**
 * Job control and the durable event log (Checkpoint 7; migration 0006's `jobs.control` / `job_events`).
 *
 * Migration 0006 persisted the control columns and the event table; this module gives them execution
 * semantics. Three properties are the reason it is shaped this way:
 *
 *  * CONTROL IS AN INTENT, NOT AN INTERRUPT. An operator writes `control = 'pause' | 'cancel'`; the running
 *    workflow observes it at a checkpoint boundary and stops there. Nothing tears a step in half, so a
 *    paused or cancelled job never leaves a partially committed canon delta behind — the invariant the
 *    Checkpoint 2–6 acceptance path depends on.
 *  * EVENTS ARE THE HISTORY, NOT A NOTIFICATION. `job_events` is append-only (trigger, migration 0006) with
 *    a monotone per-job `seq`. SSE is a *view* of that table, so a client reconnecting with `Last-Event-ID`
 *    replays real persisted history rather than whatever happened to be in memory.
 *  * SEQUENCES ARE ALLOCATED IN THE DATABASE. `seq` comes from a single statement that reads the current
 *    maximum and inserts, so two concurrent emitters cannot mint the same id; the UNIQUE (job_id, seq)
 *    constraint is the backstop.
 */
import { type Client, type Pool, rethrowCanon } from './client.js';
import { getJob, updateJob, type JobRow } from './workflow.js';

type Queryable = Pool | Client;

/** The operator's requested intent. `run` is the absence of a request. */
export type JobControl = 'run' | 'pause' | 'cancel';

/** Statuses from which no further work happens. A terminal job ignores control requests. */
export const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export type TerminalJobStatus = (typeof TERMINAL_JOB_STATUSES)[number];

export function isTerminalStatus(status: string): status is TerminalJobStatus {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status);
}

/**
 * Statuses that mean "an operator must decide something before this can progress". The API and UI surface
 * these as the attention queue; they are not failures and must not be retried automatically.
 */
export const ATTENTION_JOB_STATUSES = [
  'needs_attention',
  'waiting_review',
  'paused_budget',
] as const;

export function needsAttention(status: string): boolean {
  return (ATTENTION_JOB_STATUSES as readonly string[]).includes(status);
}

export interface JobEventRow {
  id: string;
  workspace_id: string;
  project_id: string;
  job_id: string;
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  terminal: boolean;
  created_at: Date;
}

/**
 * Append one event to a job's durable log and return it.
 *
 * The `seq` is allocated inside the INSERT so concurrent emitters serialize on the unique index rather than
 * on an application lock. Payloads carry progress metadata only — never manuscript prose, prompt text or
 * provider payloads (migration 0006's comment on the column is a contract, and `assertSafePayload` keeps it).
 */
export async function emitJobEvent(
  db: Queryable,
  input: {
    jobId: string;
    kind: string;
    payload?: Record<string, unknown> | undefined;
    terminal?: boolean | undefined;
  },
): Promise<JobEventRow> {
  const payload = input.payload ?? {};
  assertSafePayload(payload);
  const r = await db
    .query<JobEventRow>(
      `INSERT INTO job_events (workspace_id, project_id, job_id, seq, kind, payload, terminal)
       SELECT j.workspace_id, j.project_id, j.id,
              coalesce((SELECT max(e.seq) FROM job_events e WHERE e.job_id = j.id), 0) + 1,
              $2, $3::jsonb, $4
         FROM jobs j WHERE j.id = $1
       RETURNING *`,
      [input.jobId, input.kind, JSON.stringify(payload), input.terminal ?? false],
    )
    .catch(rethrowCanon);
  const row = r.rows[0];
  if (!row)
    throw new Error(`job ${input.jobId} does not exist (or is not visible) for event emission`);
  return row;
}

/** Keys that would put prose, prompts or secrets into an event payload. */
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'text',
  'prose',
  'manuscript',
  'content',
  'prompt',
  'system',
  'user_prompt',
  'output',
  'completion',
  'token',
  'secret',
  'password',
  'api_key',
  'authorization',
]);

/**
 * Refuse an event payload that carries manuscript text, prompt text or a credential. This is checked at the
 * emit boundary because an SSE stream is the one place the system pushes data at a client unprompted.
 */
export function assertSafePayload(payload: Record<string, unknown>): void {
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > 6) throw new Error(`job event payload nests too deeply at ${path}`);
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        walk(v, `${path}[${i}]`, depth + 1);
      });
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (FORBIDDEN_PAYLOAD_KEYS.has(k.toLowerCase()))
          throw new Error(`job event payload must not contain '${k}' (at ${path})`);
        walk(v, `${path}.${k}`, depth + 1);
      }
      return;
    }
    // A long string in an event is prose or a prompt by weight of probability.
    if (typeof value === 'string' && value.length > 2_000)
      throw new Error(`job event payload string at ${path} is too long to be progress metadata`);
  };
  walk(payload, '$', 0);
}

/**
 * Read a job's persisted events after `afterSeq`, oldest first. This is the replay source for SSE: a client
 * that reconnects with `Last-Event-ID: 7` receives 8, 9, 10… exactly once, in order.
 */
export async function jobEventsAfter(
  db: Queryable,
  input: { jobId: string; afterSeq?: number | undefined; limit?: number | undefined },
): Promise<JobEventRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 1_000);
  const r = await db.query<JobEventRow>(
    `SELECT * FROM job_events WHERE job_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
    [input.jobId, input.afterSeq ?? 0, limit],
  );
  return r.rows;
}

export interface ControlRequest {
  readonly jobId: string;
  readonly control: JobControl;
  readonly actorUserId: string;
}

export interface ControlOutcome {
  readonly job: JobRow;
  readonly applied: boolean;
  /** Why a request was not applied, for a typed API response. */
  readonly reason?: 'terminal' | 'already_requested' | 'not_paused' | undefined;
}

/**
 * Request a control transition. Returns `applied: false` with a reason rather than throwing, so the API can
 * map "already cancelled" to an idempotent success instead of a 500.
 *
 * Semantics:
 *  * `pause` on a live job records the intent; the runtime stops at its next checkpoint and sets `paused`.
 *  * `cancel` records the intent and moves the job to `cancelling`; the runtime finishes nothing further and
 *    settles on `cancelled`. Whatever was produced before that point stays noncanonical, because canon is
 *    only ever written by the acceptance step, which cannot run after the cancel is observed.
 *  * `resume` (expressed as `control = 'run'`) is only meaningful for a paused job.
 *  * a terminal job accepts nothing: history is never retracted.
 */
export async function requestJobControl(
  db: Queryable,
  input: ControlRequest,
): Promise<ControlOutcome> {
  const job = await getJob(db, input.jobId);
  if (!job) throw new Error(`job ${input.jobId} does not exist`);
  if (isTerminalStatus(job.status)) return { job, applied: false, reason: 'terminal' };

  if (input.control === 'run') {
    // Resume. A job that is not paused (and has no pause pending) has nothing to resume.
    const pausedish = job.status === 'paused' || job.status === 'paused_budget';
    if (!pausedish && jobControlOf(job) !== 'pause')
      return { job, applied: false, reason: 'not_paused' };
    const updated = await writeControl(db, {
      jobId: job.id,
      control: 'run',
      actorUserId: input.actorUserId,
      status: 'queued',
      clearPaused: true,
    });
    await emitJobEvent(db, {
      jobId: job.id,
      kind: 'job.resumed',
      payload: { status: updated.status, requested_by: input.actorUserId },
    });
    return { job: updated, applied: true };
  }

  if (jobControlOf(job) === input.control && input.control === 'cancel')
    // Cancel is idempotent: a second request changes nothing and must not emit a second event.
    return { job, applied: false, reason: 'already_requested' };

  if (input.control === 'pause') {
    if (jobControlOf(job) === 'cancel')
      // A cancelling job must not be downgraded to paused: that would resurrect work already abandoned.
      return { job, applied: false, reason: 'already_requested' };
    const updated = await writeControl(db, {
      jobId: job.id,
      control: 'pause',
      actorUserId: input.actorUserId,
      // Status becomes `paused` only when the runtime observes the intent; a job that is not currently
      // executing is paused immediately because nothing will pick it up.
      status: job.status === 'running' ? undefined : 'paused',
      markPaused: job.status !== 'running',
    });
    await emitJobEvent(db, {
      jobId: job.id,
      kind: 'job.pause_requested',
      payload: { status: updated.status, requested_by: input.actorUserId },
    });
    return { job: updated, applied: true };
  }

  const updated = await writeControl(db, {
    jobId: job.id,
    control: 'cancel',
    actorUserId: input.actorUserId,
    status: job.status === 'running' ? 'cancelling' : 'cancelled',
    markCancelled: job.status !== 'running',
    finished: job.status !== 'running',
  });
  await emitJobEvent(db, {
    jobId: job.id,
    kind: updated.status === 'cancelled' ? 'job.cancelled' : 'job.cancel_requested',
    payload: { status: updated.status, requested_by: input.actorUserId },
    terminal: updated.status === 'cancelled',
  });
  return { job: updated, applied: true };
}

/** The control column, typed. Rows predating a control request read as `run`. */
export function jobControlOf(job: JobRow & { control?: string | undefined }): JobControl {
  const raw = (job as { control?: string }).control;
  return raw === 'pause' || raw === 'cancel' ? raw : 'run';
}

async function writeControl(
  db: Queryable,
  input: {
    jobId: string;
    control: JobControl;
    actorUserId: string;
    status?: string | undefined;
    markPaused?: boolean | undefined;
    markCancelled?: boolean | undefined;
    clearPaused?: boolean | undefined;
    finished?: boolean | undefined;
  },
): Promise<JobRow> {
  const r = await db
    .query<JobRow>(
      `UPDATE jobs SET
         control = $2,
         control_requested_at = now(),
         control_requested_by = $3,
         status = coalesce($4, status),
         paused_at = CASE WHEN $5::boolean THEN now() WHEN $6::boolean THEN NULL ELSE paused_at END,
         cancelled_at = CASE WHEN $7::boolean THEN now() ELSE cancelled_at END,
         finished_at = CASE WHEN $8::boolean THEN now() ELSE finished_at END,
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        input.jobId,
        input.control,
        input.actorUserId,
        input.status ?? null,
        input.markPaused ?? false,
        input.clearPaused ?? false,
        input.markCancelled ?? false,
        input.finished ?? false,
      ],
    )
    .catch(rethrowCanon);
  const row = r.rows[0];
  if (!row) throw new Error(`job ${input.jobId} vanished while writing a control request`);
  return row;
}

/** Raised when a running workflow observes a pause or cancel intent at a checkpoint boundary. */
export class JobControlStop extends Error {
  constructor(
    readonly control: 'pause' | 'cancel',
    readonly step: string,
  ) {
    super(`job ${control} requested; stopped before ${step}`);
    this.name = 'JobControlStop';
  }
}

/**
 * The checkpoint-boundary hook a durable runtime calls before starting each step. It settles the job's
 * status to reflect the observed intent and throws `JobControlStop`, which the runtime translates into a
 * clean, resumable halt.
 *
 * Because this runs BEFORE a step rather than inside one, a paused job's next step has not begun: resuming
 * replays completed steps from `job_steps` and continues, with no duplicated provider spend.
 */
export async function checkpointControl(
  db: Queryable,
  input: { jobId: string; step: string },
): Promise<void> {
  const job = await getJob(db, input.jobId);
  if (!job) return;
  const control = jobControlOf(job);
  if (control === 'run') return;

  if (control === 'cancel') {
    await db.query(
      `UPDATE jobs SET status = 'cancelled', cancelled_at = coalesce(cancelled_at, now()),
              finished_at = now(), updated_at = now() WHERE id = $1`,
      [job.id],
    );
    await emitJobEvent(db, {
      jobId: job.id,
      kind: 'job.cancelled',
      payload: { stopped_before: input.step, artifacts: 'noncanonical' },
      terminal: true,
    });
    throw new JobControlStop('cancel', input.step);
  }

  await db.query(
    `UPDATE jobs SET status = 'paused', paused_at = coalesce(paused_at, now()), updated_at = now()
      WHERE id = $1`,
    [job.id],
  );
  await emitJobEvent(db, {
    jobId: job.id,
    kind: 'job.paused',
    payload: { stopped_before: input.step },
  });
  throw new JobControlStop('pause', input.step);
}

/**
 * Record a terminal outcome and emit the matching terminal event exactly once. An SSE client uses the
 * terminal event to know the stream is complete rather than merely idle.
 */
export async function finishJob(
  db: Queryable,
  input: {
    jobId: string;
    status: TerminalJobStatus;
    payload?: Record<string, unknown> | undefined;
  },
): Promise<JobEventRow | undefined> {
  const existing = await db.query<{ id: string }>(
    'SELECT id FROM job_events WHERE job_id = $1 AND terminal ORDER BY seq LIMIT 1',
    [input.jobId],
  );
  await updateJob(db, input.jobId, { status: input.status, finished: true });
  if (existing.rows[0]) return undefined;
  return emitJobEvent(db, {
    jobId: input.jobId,
    kind: `job.${input.status}`,
    payload: input.payload ?? { status: input.status },
    terminal: true,
  });
}
