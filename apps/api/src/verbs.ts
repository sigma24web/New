/**
 * Colon-verb action routes (`POST /v1/jobs/{id}:cancel`, `…/chapters/{n}:approve`, …).
 *
 * The API plan specifies actions as a colon suffix on the resource path, and that wire format is kept
 * exactly. It cannot, however, be expressed as three Fastify route patterns: Fastify's router reads
 * `/v1/jobs/:jobId\:pause` as a SINGLE parameter literally named `jobId:pause`, so registering `:pause`,
 * `:resume` and `:cancel` raises "Method 'POST' already declared" for the second and third — and, before
 * that error surfaces, the first registration silently answers all three. A request to `…:cancel` executing
 * the pause handler is a correctness and authorization hazard (cancel is owner-only, pause is not), which is
 * why this module exists rather than a looser route pattern.
 *
 * So one route per resource family captures the whole final segment, and the verb is parsed and matched
 * against an explicit allowlist here. An unknown verb is a 404 (no such action), never a fallthrough to a
 * neighbouring handler.
 */
import { ApiError } from './problem.js';

/** Parse `"<id>:<verb>"` from a single path segment. */
export function splitVerb(segment: string | undefined): { id: string; verb: string } {
  if (!segment) throw new ApiError('NOT_FOUND', 'No such route.');
  const colon = segment.lastIndexOf(':');
  // No colon at all means the caller hit an action route without naming an action.
  if (colon <= 0 || colon === segment.length - 1)
    throw new ApiError('NOT_FOUND', 'No such action.');
  return { id: segment.slice(0, colon), verb: segment.slice(colon + 1) };
}

/**
 * Parse and validate a colon verb against the actions a route actually implements.
 *
 * `allowed` is the closed set for that resource; anything else is 404 rather than 422, because an
 * unimplemented action is indistinguishable from a nonexistent route from the client's point of view and
 * must not hint at actions that exist elsewhere.
 */
export function requireVerb<T extends string>(
  segment: string | undefined,
  allowed: readonly T[],
): { id: string; verb: T } {
  const { id, verb } = splitVerb(segment);
  const match = allowed.find((a) => a === verb);
  if (!match) throw new ApiError('NOT_FOUND', 'No such action.');
  return { id, verb: match };
}
