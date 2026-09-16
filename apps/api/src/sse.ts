/**
 * Server-sent job events (Checkpoint 7, API plan `GET /jobs/{id}/events`).
 *
 * The stream is a *view over `job_events`*, never an in-memory broadcast. That single decision is what makes
 * the required guarantees achievable:
 *
 *  * REPLAY. A client reconnecting with `Last-Event-ID: 7` gets 8, 9, 10… from the table. Nothing is
 *    invented, and an event delivered before a disconnect is never delivered twice, because `seq` is
 *    monotone per job and the cursor only moves forward.
 *  * ISOLATION. The connection is opened inside the caller's RLS scope and the job is resolved through it,
 *    so a job in another workspace is not merely unauthorized — it is invisible, and the route answers the
 *    same 404 as a job that does not exist. An id must not be a cross-tenant probe.
 *  * TERMINATION. A terminal event closes the stream. A client therefore learns the difference between
 *    "finished" and "idle", instead of polling forever.
 *  * BOUNDED WORK. Each poll reads at most one page, heartbeats keep intermediaries from dropping an idle
 *    connection, and a closed socket aborts the loop, so an abandoned client stops costing queries.
 */
import { type JobEventRow, type Pool } from '@yeonjae/db';
import { ApiError } from './problem.js';

/** Frames per poll. A burst larger than this is delivered across successive polls, never in one write. */
export const SSE_PAGE_SIZE = 200;

export interface SseOptions {
  /** Poll interval for new events. */
  readonly pollMs?: number | undefined;
  /** Heartbeat interval; a comment frame keeps proxies from closing an idle stream. */
  readonly heartbeatMs?: number | undefined;
  /** Hard ceiling on stream lifetime, so a forgotten browser tab cannot hold a connection forever. */
  readonly maxDurationMs?: number | undefined;
}

const DEFAULTS = { pollMs: 250, heartbeatMs: 15_000, maxDurationMs: 30 * 60_000 } as const;

/**
 * Parse `Last-Event-ID`. A malformed value is rejected rather than silently treated as 0, because silently
 * restarting the stream from the beginning would re-deliver events the client already processed — exactly
 * the duplicate the header exists to prevent.
 */
export function parseLastEventId(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const value = raw.trim();
  if (!/^\d{1,18}$/.test(value))
    throw new ApiError(
      'VALIDATION_FAILED',
      'Last-Event-ID must be a non-negative integer event id.',
      { errors: [{ path: 'headers.last-event-id', message: 'must be a non-negative integer' }] },
    );
  return Number(value);
}

/** Render one event as an SSE frame. `id:` is the persisted `seq`, which is what a client echoes back. */
export function formatEvent(event: JobEventRow): string {
  const data = JSON.stringify({
    id: event.seq,
    job_id: event.job_id,
    kind: event.kind,
    payload: event.payload,
    terminal: event.terminal,
    created_at:
      event.created_at instanceof Date ? event.created_at.toISOString() : event.created_at,
  });
  return `id: ${event.seq}\nevent: ${event.kind}\ndata: ${data}\n\n`;
}

/**
 * The minimal sink an SSE loop needs; Fastify's raw response satisfies it, and so does a test double.
 *
 * `isClosed()` is a METHOD rather than a readonly property on purpose. As a property, TypeScript narrows it
 * to `false` after one check and the compiler then reports every later check as unreachable — which is how
 * a write-after-disconnect slipped in: the loop checked once per batch and wrote every frame in that batch.
 * A method call is re-evaluated each time, which is the actual semantics of a socket that can close at any
 * moment.
 */
export interface SseSink {
  write(chunk: string): void;
  end(): void;
  isClosed(): boolean;
}

export interface SseResult {
  /** Highest event id delivered, so a caller (and a test) can assert the cursor advanced exactly once. */
  readonly lastSeq: number;
  readonly delivered: number;
  readonly heartbeats: number;
  readonly reason: 'terminal' | 'client_closed' | 'timeout';
}

/**
 * Stream a job's events until a terminal event, a client disconnect or the duration ceiling.
 *
 * `pool` is used for the polling reads; the caller has already authorized the request and verified the job
 * is visible in its workspace, and passes a `readEvents` bound to that scope so every poll stays scoped.
 */
export async function streamJobEvents(input: {
  sink: SseSink;
  readEvents: (afterSeq: number, limit: number) => Promise<JobEventRow[]>;
  fromSeq: number;
  options?: SseOptions | undefined;
  /** Injected for tests; defaults to real time. */
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}): Promise<SseResult> {
  const { sink, readEvents } = input;
  const pollMs = input.options?.pollMs ?? DEFAULTS.pollMs;
  const heartbeatMs = input.options?.heartbeatMs ?? DEFAULTS.heartbeatMs;
  const maxDurationMs = input.options?.maxDurationMs ?? DEFAULTS.maxDurationMs;
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const startedAt = now();
  let cursor = input.fromSeq;
  let delivered = 0;
  let heartbeats = 0;
  let lastWriteAt = startedAt;

  // A comment frame immediately: the client learns the stream is open without waiting for the first event.
  sink.write(`: stream open, resuming after ${cursor}\n\n`);

  for (;;) {
    if (sink.isClosed()) return { lastSeq: cursor, delivered, heartbeats, reason: 'client_closed' };

    const batch = await readEvents(cursor, SSE_PAGE_SIZE);
    for (const event of batch) {
      // The client can go away *during* a poll, so closure is re-checked per frame rather than only per
      // batch: writing to a destroyed socket is an unhandled error, not a no-op.
      if (sink.isClosed())
        return { lastSeq: cursor, delivered, heartbeats, reason: 'client_closed' };
      // Defensive: only ever move the cursor forward, so a duplicate row could not be delivered twice.
      if (event.seq <= cursor) continue;
      sink.write(formatEvent(event));
      cursor = event.seq;
      delivered += 1;
      lastWriteAt = now();
      if (event.terminal) {
        sink.end();
        return { lastSeq: cursor, delivered, heartbeats, reason: 'terminal' };
      }
    }

    if (sink.isClosed()) return { lastSeq: cursor, delivered, heartbeats, reason: 'client_closed' };
    if (now() - startedAt >= maxDurationMs) {
      // Not a terminal event: the job may still be running, and the client should reconnect with the id.
      sink.write(`: stream duration limit reached; reconnect with Last-Event-ID: ${cursor}\n\n`);
      sink.end();
      return { lastSeq: cursor, delivered, heartbeats, reason: 'timeout' };
    }
    if (now() - lastWriteAt >= heartbeatMs) {
      sink.write(`: heartbeat ${cursor}\n\n`);
      heartbeats += 1;
      lastWriteAt = now();
    }
    if (batch.length < SSE_PAGE_SIZE) await sleep(pollMs);
  }
}

/** The headers an SSE response must carry. Buffering must be off or events arrive in clumps. */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store, no-transform',
  connection: 'keep-alive',
  // Nginx and several managed proxies buffer responses by default, which would defeat streaming.
  'x-accel-buffering': 'no',
};

/** Resolve a job inside an RLS-scoped connection, returning a 404 for anything not visible. */
export async function jobOr404(
  readJob: () => Promise<{ id: string; project_id: string } | undefined>,
): Promise<{ id: string; project_id: string }> {
  const job = await readJob();
  if (!job) throw new ApiError('NOT_FOUND', 'The job does not exist.');
  return job;
}

export type { JobEventRow, Pool };
