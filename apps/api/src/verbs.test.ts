/**
 * Colon-verb route dispatch (Checkpoint 7).
 *
 * This exists because of a concrete, reproduced hazard rather than a hypothetical one: Fastify reads
 * `/v1/jobs/:jobId\:pause` as one parameter literally named `jobId:pause`, so registering `:pause`,
 * `:resume` and `:cancel` as three routes makes the first answer all three. A `…:cancel` request executing
 * the pause handler would cross an authorization boundary (cancel is owner-only). Dispatch therefore
 * happens here, against a closed allowlist.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from './problem.js';
import { requireVerb, splitVerb } from './verbs.js';

const JOB_VERBS = ['pause', 'resume', 'cancel'] as const;

describe('splitVerb', () => {
  it('splits an id from its action on the final colon', () => {
    expect(splitVerb('01a0a937-719d-7560-8fa5-3fa749e428bf:cancel')).toEqual({
      id: '01a0a937-719d-7560-8fa5-3fa749e428bf',
      verb: 'cancel',
    });
  });

  it('rejects a segment with no action, an empty action or an empty id', () => {
    for (const bad of [undefined, '', 'abc', 'abc:', ':cancel']) {
      let thrown: unknown;
      try {
        splitVerb(bad);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, String(bad)).toBeInstanceOf(ApiError);
      expect((thrown as ApiError).status).toBe(404);
    }
  });
});

describe('requireVerb', () => {
  it('resolves each allowed verb to itself, so no action can execute another\u2019s handler', () => {
    for (const verb of JOB_VERBS) {
      const parsed = requireVerb(`job-1:${verb}`, JOB_VERBS);
      expect(parsed).toEqual({ id: 'job-1', verb });
    }
  });

  it('404s an unknown or foreign verb instead of falling through to a neighbour', () => {
    // `approve` is a real action on chapters; on a job it must not resolve to anything at all.
    for (const bad of ['approve', 'delete', 'Pause', 'pause ', 'cancel;drop']) {
      let thrown: unknown;
      try {
        requireVerb(`job-1:${bad}`, JOB_VERBS);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, bad).toBeInstanceOf(ApiError);
      expect((thrown as ApiError).status).toBe(404);
      // The message must not enumerate the verbs that do exist.
      expect((thrown as ApiError).publicDetail).toBe('No such action.');
    }
  });

  it('keeps colons inside an id by splitting on the last one only', () => {
    // Workflow ids are `chapter:<project>:<n>`, so a resource segment can legitimately contain colons.
    expect(requireVerb('chapter:proj:7:resume', JOB_VERBS)).toEqual({
      id: 'chapter:proj:7',
      verb: 'resume',
    });
  });
});
