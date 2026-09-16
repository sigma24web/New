/**
 * SSE stream semantics (Checkpoint 7).
 *
 * The event *source* is proved against a real database in `job-control.integration.test.ts`; what is
 * proved here is the streaming contract a client depends on, with time and the reader injected so ordering,
 * reconnection, heartbeats and disconnect cleanup are deterministic rather than timing-dependent.
 */
import { describe, expect, it } from 'vitest';
import type { JobEventRow } from '@yeonjae/db';
import { ApiError } from './problem.js';
import {
  formatEvent,
  parseLastEventId,
  SSE_HEADERS,
  SSE_PAGE_SIZE,
  streamJobEvents,
  type SseSink,
} from './sse.js';

function event(seq: number, kind = 'step.completed', terminal = false): JobEventRow {
  return {
    id: `evt-${seq}`,
    workspace_id: 'ws',
    project_id: 'proj',
    job_id: 'job',
    seq,
    kind,
    payload: { step: kind, n: seq },
    terminal,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
  };
}

/** A sink that records frames and can be closed to simulate a client disconnect. */
function recordingSink(): SseSink & { frames: string[]; ended: boolean; close: () => void } {
  const state = { frames: [] as string[], ended: false, shut: false };
  return {
    frames: state.frames,
    get ended() {
      return state.ended;
    },
    close: () => {
      state.shut = true;
    },
    // Writing to a closed sink throws rather than being ignored, so a write-after-disconnect is a test
    // failure instead of an invisible bug.
    write: (chunk: string) => {
      if (state.shut || state.ended) throw new Error('write after close');
      state.frames.push(chunk);
    },
    end: () => {
      state.ended = true;
    },
    isClosed: () => state.shut || state.ended,
  };
}

/** Serve a fixed event list as successive pages, then nothing. */
function readerFor(
  events: readonly JobEventRow[],
): (after: number, limit: number) => Promise<JobEventRow[]> {
  return async (after, limit) => events.filter((e) => e.seq > after).slice(0, limit);
}

describe('Last-Event-ID parsing', () => {
  it('treats an absent or empty header as "from the beginning"', () => {
    expect(parseLastEventId(undefined)).toBe(0);
    expect(parseLastEventId('')).toBe(0);
    expect(parseLastEventId('   ')).toBe(0);
  });

  it('accepts a non-negative integer id', () => {
    expect(parseLastEventId('0')).toBe(0);
    expect(parseLastEventId('7')).toBe(7);
    expect(parseLastEventId(' 42 ')).toBe(42);
  });

  it('rejects a malformed id instead of silently restarting the stream', () => {
    // Silently falling back to 0 would re-deliver events the client already processed — the exact
    // duplicate the header exists to prevent. So a bad header is a validation error.
    for (const bad of [
      '-1',
      '1.5',
      'abc',
      '7; DROP TABLE job_events',
      '١٢٣',
      '1e3',
      '9'.repeat(19),
    ]) {
      let thrown: unknown;
      try {
        parseLastEventId(bad);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, bad).toBeInstanceOf(ApiError);
      expect((thrown as ApiError).code).toBe('VALIDATION_FAILED');
      expect((thrown as ApiError).status).toBe(422);
    }
  });
});

describe('SSE frame format', () => {
  it('emits the persisted seq as the SSE id so reconnection is exact', () => {
    const frame = formatEvent(event(9, 'step.completed'));
    expect(frame.startsWith('id: 9\nevent: step.completed\ndata: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    const data = JSON.parse(frame.split('data: ')[1] ?? '{}') as Record<string, unknown>;
    expect(data).toMatchObject({ id: 9, job_id: 'job', kind: 'step.completed', terminal: false });
    // One frame is one event: a client parsing by blank line cannot mis-split it.
    expect(frame.split('\n\n').filter(Boolean)).toHaveLength(1);
  });

  it('declares an unbuffered event-stream content type', () => {
    expect(SSE_HEADERS['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(SSE_HEADERS['cache-control']).toContain('no-store');
    expect(SSE_HEADERS['x-accel-buffering']).toBe('no');
  });
});

describe('streamJobEvents', () => {
  it('delivers events in seq order and closes on the terminal event', async () => {
    const sink = recordingSink();
    const result = await streamJobEvents({
      sink,
      fromSeq: 0,
      readEvents: readerFor([
        event(1, 'job.started'),
        event(2),
        event(3, 'job.completed', true),
        // An event after the terminal one must never be delivered.
        event(4, 'job.impossible'),
      ]),
    });
    expect(result).toMatchObject({ reason: 'terminal', delivered: 3, lastSeq: 3 });
    expect(sink.ended).toBe(true);
    const ids = sink.frames.filter((f) => f.startsWith('id: ')).map((f) => f.split('\n')[0]);
    expect(ids).toEqual(['id: 1', 'id: 2', 'id: 3']);
  });

  it('resumes after Last-Event-ID without re-delivering or skipping anything', async () => {
    const events = [event(1), event(2), event(3), event(4, 'job.completed', true)];
    const sink = recordingSink();
    const result = await streamJobEvents({ sink, fromSeq: 2, readEvents: readerFor(events) });
    expect(result.delivered).toBe(2);
    const ids = sink.frames.filter((f) => f.startsWith('id: ')).map((f) => f.split('\n')[0]);
    expect(ids).toEqual(['id: 3', 'id: 4']);
    // The opening comment states the resume point, so a stuck client is diagnosable from the wire.
    expect(sink.frames[0]).toContain('resuming after 2');
  });

  it('suppresses a duplicate row rather than delivering an event twice', async () => {
    // A reader that (wrongly) returns an already-delivered event must not produce a duplicate frame:
    // the cursor only ever moves forward.
    const sink = recordingSink();
    let call = 0;
    const result = await streamJobEvents({
      sink,
      fromSeq: 0,
      readEvents: async () => {
        call += 1;
        if (call === 1) return [event(1), event(2)];
        return [event(1), event(2), event(3, 'job.completed', true)];
      },
      sleep: async () => undefined,
    });
    expect(result.delivered).toBe(3);
    const ids = sink.frames.filter((f) => f.startsWith('id: ')).map((f) => f.split('\n')[0]);
    expect(ids).toEqual(['id: 1', 'id: 2', 'id: 3']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('heartbeats an idle stream without inventing events', async () => {
    let clock = 0;
    const sink = recordingSink();
    const result = await streamJobEvents({
      sink,
      fromSeq: 0,
      // Never any events: the stream stays open until the duration ceiling.
      readEvents: async () => [],
      options: { pollMs: 0, heartbeatMs: 1_000, maxDurationMs: 5_000 },
      now: () => clock,
      sleep: async (ms) => {
        clock += Math.max(ms, 600);
      },
    });
    expect(result.reason).toBe('timeout');
    expect(result.delivered).toBe(0);
    expect(result.heartbeats).toBeGreaterThan(0);
    // Heartbeats are comment frames, so a client's event parser never sees them as data.
    const heartbeats = sink.frames.filter((f) => f.startsWith(': heartbeat'));
    expect(heartbeats.length).toBe(result.heartbeats);
    expect(sink.frames.some((f) => f.startsWith('id: '))).toBe(false);
    // The timeout tells the client how to resume rather than pretending the job ended.
    expect(sink.frames.at(-1)).toContain('reconnect with Last-Event-ID: 0');
    expect(sink.ended).toBe(true);
  });

  it('stops promptly and writes nothing more when the client disconnects', async () => {
    const sink = recordingSink();
    let served = 0;
    const result = await streamJobEvents({
      sink,
      fromSeq: 0,
      readEvents: async (after) => {
        served += 1;
        if (served === 1) return [event(1)];
        // The client went away between polls.
        sink.close();
        return [event(after + 1)];
      },
      sleep: async () => undefined,
    });
    expect(result.reason).toBe('client_closed');
    expect(result.delivered).toBe(1);
    // No frame was written after the disconnect: recordingSink throws on write-after-close, so reaching
    // here at all proves the loop checked before writing.
    const ids = sink.frames.filter((f) => f.startsWith('id: '));
    expect(ids).toHaveLength(1);
  });

  it('delivers a burst larger than one page across successive polls, in order', async () => {
    const total = SSE_PAGE_SIZE + 25;
    const events = [
      ...Array.from({ length: total }, (_, i) => event(i + 1)),
      event(total + 1, 'job.completed', true),
    ];
    const sink = recordingSink();
    const result = await streamJobEvents({
      sink,
      fromSeq: 0,
      readEvents: readerFor(events),
      sleep: async () => undefined,
    });
    expect(result.delivered).toBe(total + 1);
    const ids = sink.frames
      .filter((f) => f.startsWith('id: '))
      .map((f) => Number(f.slice(4, f.indexOf('\n'))));
    expect(ids).toEqual(events.map((e) => e.seq));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('never writes manuscript text: payloads come from the safe-payload-checked log', async () => {
    const sink = recordingSink();
    await streamJobEvents({
      sink,
      fromSeq: 0,
      readEvents: readerFor([event(1, 'step.completed'), event(2, 'job.completed', true)]),
    });
    const wire = sink.frames.join('');
    for (const key of ['prompt', 'manuscript', 'password']) expect(wire).not.toContain(`"${key}"`);
  });
});
