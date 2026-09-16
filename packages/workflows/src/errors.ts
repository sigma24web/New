/**
 * Workflow errors are actionable: every code names the step that failed, what the operator can do, and
 * carries the structured data the CLI prints. Nothing here is retried silently.
 */
export type WorkflowErrorCode =
  | 'INTAKE_INVALID'
  | 'NO_PROVIDER'
  | 'IDENTITY_UNPINNED'
  | 'POLICY_UNKNOWN'
  | 'SPEC_INVALID'
  | 'ARC_PLAN_INVALID'
  | 'CONTRACT_INVALID'
  | 'SCENE_PLAN_INVALID'
  | 'SCENE_DRAFT_INVALID'
  | 'PREVIOUS_CHAPTER_NOT_ACCEPTED'
  | 'PACK_FAILED'
  | 'MODEL_CALL_FAILED'
  | 'OUTPUT_LANGUAGE_FAILED'
  | 'EVALUATION_FAILED'
  | 'APPROVAL_BLOCKED'
  | 'SELECTION_CONFLICT'
  | 'SELECTION_REQUEST_CHANGED'
  | 'CONCURRENT_CALL'
  | 'REVISION_LIMIT'
  | 'PATCH_REGRESSED'
  | 'PATCH_UNANCHORED'
  | 'NOT_EXTRACTABLE'
  | 'EXTRACTION_REJECTED'
  | 'EXTRACTION_ENVELOPE_MISMATCH'
  | 'CANON_STALE'
  | 'ACCEPTANCE_FAILED'
  | 'SUMMARY_INVALID'
  | 'CHAPTER_NOT_ACCEPTED'
  | 'WORKFLOW_NOT_FOUND'
  | 'STEP_NONDETERMINISTIC'
  // The run lost its target lease (expired or fenced out by a newer holder). Distinct from
  // CONCURRENT_CALL, which is a transient contention the caller may retry: LEASE_LOST means another worker
  // now owns the target, so this run must stop rather than race it.
  | 'LEASE_LOST'
  | 'INTERNAL';

export type RecommendedAction =
  | 'retry_step'
  | 'regenerate'
  | 'accept_with_override'
  | 'edit_manually'
  | 'raise_budget'
  | 'revalidate_contract'
  | 'review_conflicts';

export class WorkflowError extends Error {
  constructor(
    readonly code: WorkflowErrorCode,
    readonly detail: string,
    readonly options: {
      readonly step?: string | undefined;
      readonly data?: Readonly<Record<string, unknown>> | undefined;
      readonly recommendedActions?: readonly RecommendedAction[] | undefined;
      /**
       * True when retrying the same step may succeed (a transient fault). False/absent means the failure
       * is deterministic and a retry would only burn budget while delaying the operator's decision.
       */
      readonly retriable?: boolean | undefined;
      readonly cause?: unknown;
    } = {},
  ) {
    super(`${code}: ${detail}`);
    this.name = 'WorkflowError';
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.detail,
      step: this.options.step,
      data: this.options.data,
      recommended_actions: this.options.recommendedActions ?? [],
      retriable: this.options.retriable ?? false,
    };
  }
}

export function asWorkflowError(err: unknown, step: string): WorkflowError {
  if (err instanceof WorkflowError) {
    return err.options.step
      ? err
      : new WorkflowError(err.code, err.detail, { ...err.options, step });
  }
  const e = err as { code?: unknown; detail?: unknown; message?: unknown; data?: unknown };
  const message = typeof e.message === 'string' ? e.message : String(err);
  const code = typeof e.code === 'string' ? e.code : undefined;
  if (code === 'PREVIOUS_CHAPTER_NOT_ACCEPTED')
    return new WorkflowError(
      'PREVIOUS_CHAPTER_NOT_ACCEPTED',
      typeof e.detail === 'string' ? e.detail : message,
      {
        step,
        data: (e.data as Record<string, unknown> | undefined) ?? {},
        recommendedActions: ['retry_step'],
        cause: err,
      },
    );
  if (code === 'STALE_CANON')
    return new WorkflowError('CANON_STALE', message, {
      step,
      recommendedActions: ['revalidate_contract', 'retry_step'],
      cause: err,
    });
  if (code === 'NOT_EXTRACTABLE' || code === 'PROHIBITED_SOURCE')
    return new WorkflowError('NOT_EXTRACTABLE', message, { step, cause: err });
  if (
    code &&
    /^(PACK_|CONSTRAINTS_|STRUCTURED_RETRIEVAL|TEMPLATE_ROLE|TASK_INVALID|CONSTRAINT_)/.test(code)
  )
    return new WorkflowError('PACK_FAILED', message, {
      step,
      data: { context_error: code },
      recommendedActions: ['revalidate_contract'],
      cause: err,
    });
  if (code === 'OUTPUT_LANGUAGE_FAILED')
    return new WorkflowError('OUTPUT_LANGUAGE_FAILED', message, {
      step,
      recommendedActions: ['regenerate'],
      cause: err,
    });
  if (
    code &&
    /^(NARRATIVE_IDENTITY|OUTPUT_LANGUAGE_CONTRACT|TRADITION_CONTRACT|BUDGET_|PROVIDER_FAILED|SCHEMA_INVALID|TRUNCATED)/.test(
      code,
    )
  )
    return new WorkflowError('MODEL_CALL_FAILED', message, {
      step,
      data: { gateway_error: code },
      recommendedActions: code.startsWith('BUDGET') ? ['raise_budget'] : ['retry_step'],
      cause: err,
    });
  // A concurrent caller already recorded a successful call for this idempotency key. The work is not lost:
  // retrying reads the recorded call instead of spending again, so this is retriable, never an INTERNAL.
  if (code === 'DUPLICATE_CALL' || message.startsWith('DUPLICATE_CALL:'))
    return new WorkflowError('CONCURRENT_CALL', message, {
      step,
      data: { concurrent: true },
      recommendedActions: ['retry_step'],
      cause: err,
    });
  if (message.startsWith('ReplayProvider:'))
    return new WorkflowError('MODEL_CALL_FAILED', message, {
      step,
      data: { gateway_error: 'PROVIDER_FAILED' },
      recommendedActions: ['retry_step'],
      cause: err,
    });
  if (message.startsWith('ARTIFACT_NONDETERMINISTIC'))
    return new WorkflowError('STEP_NONDETERMINISTIC', message, { step, cause: err });
  return new WorkflowError('INTERNAL', message, { step, cause: err });
}
