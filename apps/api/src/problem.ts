/**
 * RFC 9457 problem details (API plan §2).
 *
 * Two rules, both about not leaking:
 *
 *  * The `code` is a STABLE typed identifier a client may branch on — the same vocabulary the workflow layer
 *    already uses (`BUDGET_EXHAUSTED`, `STALE_CANON`, `PREVIOUS_CHAPTER_NOT_ACCEPTED`, …) — so the API does
 *    not invent a second error language.
 *  * `detail` is a SAFE public sentence. Raw PostgreSQL text, provider payloads, stack traces, SQL and
 *    cross-workspace identifiers never reach it. `toProblem` treats any error it does not recognise as an
 *    internal error with a generic detail, because an unrecognised error is exactly the case where guessing
 *    would leak. The real message is logged server-side against the request id instead.
 */
import { WorkflowError, type WorkflowErrorCode } from '@yeonjae/workflows';

export type ProblemCode =
  | WorkflowErrorCode
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'CSRF_REQUIRED'
  | 'FORBIDDEN'
  | 'WORKSPACE_REQUIRED'
  | 'NOT_A_MEMBER'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'UNSUPPORTED_LANGUAGE'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'IDEMPOTENT_REQUEST_IN_PROGRESS'
  | 'INVALID_CURSOR'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'NOT_IMPLEMENTED_IN_TIER'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

export interface Problem {
  /** A stable URN identifying the problem type, per RFC 9457's `type`. */
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: ProblemCode;
  readonly request_id: string;
  /** Safe, structured extras a client can act on (never internal identifiers of other tenants). */
  readonly errors?: readonly { readonly path: string; readonly message: string }[] | undefined;
  readonly data?: Readonly<Record<string, unknown>> | undefined;
}

const TITLES: Record<ProblemCode, string> = {
  UNAUTHENTICATED: 'Authentication required',
  INVALID_CREDENTIALS: 'Invalid credentials',
  CSRF_REQUIRED: 'CSRF token required',
  FORBIDDEN: 'Insufficient role',
  WORKSPACE_REQUIRED: 'Workspace required',
  NOT_A_MEMBER: 'Not a workspace member',
  NOT_FOUND: 'Not found',
  VALIDATION_FAILED: 'Request validation failed',
  UNSUPPORTED_LANGUAGE: 'Unsupported manuscript language',
  IDEMPOTENCY_KEY_REUSED: 'Idempotency key reused with a different request',
  IDEMPOTENT_REQUEST_IN_PROGRESS: 'An identical request is already in progress',
  INVALID_CURSOR: 'Invalid cursor',
  RATE_LIMITED: 'Too many requests',
  PAYLOAD_TOO_LARGE: 'Request body too large',
  NOT_IMPLEMENTED_IN_TIER: 'Not implemented in this tier',
  CONFLICT: 'Conflict',
  INTERNAL_ERROR: 'Internal error',
  // Workflow codes keep their operator-facing meaning.
  INTAKE_INVALID: 'Story intake is invalid',
  NO_PROVIDER: 'No model provider is configured',
  IDENTITY_UNPINNED: 'Narrative Identity is not pinned',
  POLICY_UNKNOWN: 'Unknown Production Policy',
  SPEC_INVALID: 'Story Spec is invalid',
  ARC_PLAN_INVALID: 'Arc plan is invalid',
  CONTRACT_INVALID: 'Chapter contract is invalid',
  SCENE_PLAN_INVALID: 'Scene plan is invalid',
  SCENE_DRAFT_INVALID: 'Scene draft is invalid',
  PREVIOUS_CHAPTER_NOT_ACCEPTED: 'Previous chapter is not accepted',
  PACK_FAILED: 'Context pack could not be built',
  MODEL_CALL_FAILED: 'Model call failed',
  OUTPUT_LANGUAGE_FAILED: 'Output language check failed',
  EVALUATION_FAILED: 'Evaluation failed',
  APPROVAL_BLOCKED: 'Approval blocked',
  SELECTION_CONFLICT: 'Candidate selection conflict',
  SELECTION_REQUEST_CHANGED: 'Selection request changed',
  CONCURRENT_CALL: 'Concurrent call',
  REVISION_LIMIT: 'Revision limit reached',
  PATCH_REGRESSED: 'Patch regressed a protected dimension',
  PATCH_UNANCHORED: 'Patch is not anchored',
  NOT_EXTRACTABLE: 'Version is not extractable',
  EXTRACTION_REJECTED: 'Canon extraction rejected',
  EXTRACTION_ENVELOPE_MISMATCH: 'Canon extraction envelope mismatch',
  CANON_STALE: 'Canon is stale',
  ACCEPTANCE_FAILED: 'Canon acceptance failed',
  SUMMARY_INVALID: 'Summary is invalid',
  CHAPTER_NOT_ACCEPTED: 'Chapter is not accepted',
  WORKFLOW_NOT_FOUND: 'Workflow not found',
  LEASE_LOST: 'Target lease lost to another run',
  STEP_NONDETERMINISTIC: 'Workflow step is nondeterministic',
  INTERNAL: 'Internal error',
};

/** HTTP status for each code. Anything unmapped is 500, never an accidental 200. */
const STATUS: Partial<Record<ProblemCode, number>> = {
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  CSRF_REQUIRED: 403,
  FORBIDDEN: 403,
  NOT_A_MEMBER: 403,
  WORKSPACE_REQUIRED: 400,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  UNSUPPORTED_LANGUAGE: 422,
  INTAKE_INVALID: 422,
  SPEC_INVALID: 422,
  CONTRACT_INVALID: 422,
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENT_REQUEST_IN_PROGRESS: 409,
  CONFLICT: 409,
  SELECTION_CONFLICT: 409,
  SELECTION_REQUEST_CHANGED: 409,
  CONCURRENT_CALL: 409,
  CANON_STALE: 409,
  // Another run owns the target now: a conflict the operator resolves, not a server fault.
  LEASE_LOST: 409,
  APPROVAL_BLOCKED: 409,
  PREVIOUS_CHAPTER_NOT_ACCEPTED: 409,
  CHAPTER_NOT_ACCEPTED: 409,
  NOT_EXTRACTABLE: 409,
  PATCH_REGRESSED: 409,
  INVALID_CURSOR: 400,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  NOT_IMPLEMENTED_IN_TIER: 501,
  MODEL_CALL_FAILED: 502,
  NO_PROVIDER: 503,
};

export class ApiError extends Error {
  constructor(
    readonly code: ProblemCode,
    readonly publicDetail: string,
    readonly options: {
      readonly status?: number | undefined;
      readonly errors?: readonly { path: string; message: string }[] | undefined;
      readonly data?: Readonly<Record<string, unknown>> | undefined;
      readonly cause?: unknown;
    } = {},
  ) {
    super(`${code}: ${publicDetail}`);
    this.name = 'ApiError';
  }

  get status(): number {
    return this.options.status ?? STATUS[this.code] ?? 500;
  }
}

export function problemStatus(code: ProblemCode): number {
  return STATUS[code] ?? 500;
}

/**
 * Convert any thrown value into a problem document. Unrecognised errors become INTERNAL_ERROR with a generic
 * detail on purpose: the one case where inventing a message risks leaking is the case we know least about.
 */
export function toProblem(err: unknown, requestId: string): Problem {
  if (err instanceof ApiError)
    return {
      type: `urn:yeonjae:error:${err.code}`,
      title: TITLES[err.code],
      status: err.status,
      detail: err.publicDetail,
      code: err.code,
      request_id: requestId,
      ...(err.options.errors ? { errors: err.options.errors } : {}),
      ...(err.options.data ? { data: err.options.data } : {}),
    };

  if (err instanceof WorkflowError) {
    const code = err.code as ProblemCode;
    return {
      type: `urn:yeonjae:error:${code}`,
      // TITLES is total over ProblemCode, which includes every WorkflowErrorCode, so this is never absent.
      title: TITLES[code],
      status: problemStatus(code),
      // Workflow details are authored for operators and carry no secrets or SQL by construction.
      detail: err.detail,
      code,
      request_id: requestId,
      ...(err.options.recommendedActions?.length
        ? { data: { recommended_actions: err.options.recommendedActions, step: err.options.step } }
        : { data: { step: err.options.step } }),
    };
  }

  return {
    type: 'urn:yeonjae:error:INTERNAL_ERROR',
    title: TITLES.INTERNAL_ERROR,
    detail: 'The request could not be completed. Quote the request id when reporting this.',
    status: 500,
    code: 'INTERNAL_ERROR',
    request_id: requestId,
  };
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
