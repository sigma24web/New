/**
 * Workflow runtime: the Postgres-checkpointed step executor (ADR-0044, ADR-0046). A step runs at most once
 * per idempotency key; its result is persisted in `job_steps` and replayed on resume. Model calls go through
 * `PromptRegistry` → `Gateway` (Guard, budget, audit) with a deterministic idempotency key so a retried step
 * never re-spends, and every successful output is stored as a content-addressed artifact.
 */
import { createHash } from 'node:crypto';
import {
  beginJobStep,
  checkpointControl,
  completeJobStep,
  failJobStep,
  getArtifactById,
  getJobStep,
  leaseOwnership,
  putArtifact,
  updateJob,
  type GatewayAuditLike,
  type JobRow,
  type LlmOutputStore,
  type Pool,
} from '@yeonjae/db';
import { type Generated, type Uuid, validatorFor } from '@yeonjae/domain';
import {
  type Gateway,
  type GatewayRequest,
  type GatewayResponse,
  type NarrativeIdentityRef,
} from '@yeonjae/gateway';
import { type ComposedIdentity } from '@yeonjae/narrative';
import { type PromptRegistry, renderPrompt, type PromptSet } from '@yeonjae/prompts';
import { asWorkflowError, WorkflowError } from './errors.js';

export type ProductionPolicy = Generated.ProductionPolicySchema.ProductionPolicy;

export interface WorkflowPins {
  readonly promptSetId: string;
  readonly promptSet: Readonly<Record<string, string>>;
  readonly productionPolicyVersion: string;
  readonly productionPolicyHash: string;
  readonly narrativeIdentityVersionId: string;
  readonly narrativeIdentityRef: string;
  readonly canonVersionRead: number;
}

/**
 * The lease a run holds over its target, when it is running under the durable orchestrator.
 *
 * Optional because the CLI path runs without one: a single local operator invocation has no second worker
 * to race. When present, every step boundary re-verifies it.
 */
export interface HeldLease {
  readonly leaseId: string;
  readonly holderWorkflowId: string;
  readonly fence: string;
}

export interface WorkflowContext {
  readonly pool: Pool;
  readonly gateway: Gateway;
  readonly registry: PromptRegistry;
  readonly promptSet: PromptSet;
  readonly policy: ProductionPolicy;
  readonly identity: ComposedIdentity;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly job: JobRow;
  readonly workflowId: string;
  readonly pins: WorkflowPins;
  /** Steps that completed in this run or were replayed from a previous one. */
  readonly trace: StepTrace[];
  /** Bindings the replay provider may substitute into recordings (ids created during the run). */
  readonly bindings: Record<string, string>;
  /** Target lease held by this run, re-verified at every step boundary. */
  readonly lease?: HeldLease | undefined;
}

export interface StepTrace {
  readonly step: string;
  readonly idempotencyKey: string;
  readonly status: 'completed' | 'replayed' | 'failed';
  readonly attempt: number;
}

/**
 * Record an id the run created (chapter, version, canon item) so replay recordings can reference it by a
 * stable name and a resumed run (new process) sees the same table. Persisted on the job.
 */
export async function bind(
  ctx: WorkflowContext,
  entries: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [k, v] of Object.entries(entries)) ctx.bindings[k] = v;
  await updateJob(ctx.pool, ctx.job.id, { progress: { bindings: { ...ctx.bindings } } });
}

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;
const INT_PLACEHOLDER = /"\{\{int:([^{}]+)\}\}"/g;

/** Substitute `{{name}}` placeholders in authored fixture data with run-created ids; unbound names throw. */
export function substitute<T>(value: T, bindings: Readonly<Record<string, string>>): T {
  const text = JSON.stringify(value);
  if (!text.includes('{{')) return value;
  const unbound = new Set<string>();
  const ints = text.replace(INT_PLACEHOLDER, (m, name: string) => {
    const v = bindings[name];
    if (v === undefined || !/^-?\d+$/.test(v)) {
      unbound.add(`int:${name}`);
      return m;
    }
    return v;
  });
  const out = ints.replace(PLACEHOLDER, (m, name: string) => {
    const v = bindings[name];
    if (v === undefined) {
      unbound.add(name);
      return m;
    }
    return v;
  });
  if (unbound.size > 0)
    throw new WorkflowError('INTERNAL', `unbound placeholders: ${[...unbound].join(', ')}`);
  return JSON.parse(out) as T;
}

export function stepKey(workflowId: string, step: string, suffix?: string): string {
  return `${workflowId}:${step}${suffix ? `:${suffix}` : ''}`;
}

/**
 * Run `fn` once per idempotency key. A completed step returns its persisted result without running again;
 * a failed step is retried as a new attempt. Failures are persisted with an actionable code before rethrow.
 *
 * THIS IS THE CONTROL BOUNDARY. Before a step begins — and only before, never inside one — the run observes
 * the operator's persisted pause/cancel intent and, when it holds a target lease, re-checks that it still
 * owns it. Both checks happen here rather than in the orchestration layer because this is the only place
 * that knows a unit of work has not yet started:
 *
 *  * a pause or cancel requested at any moment during drafting, evaluation, revision or extraction is
 *    honoured at the next step, so nothing is torn in half and no partial canon exists;
 *  * a step that is already `completed` replays without consulting control, because replay performs no
 *    work and no spend — stopping there would strand a resumable run;
 *  * a worker that has lost its lease (expired, or stolen by a higher fence) stops BEFORE the next durable
 *    side effect, so a zombie cannot draft, evaluate, accept or commit after being fenced out.
 */
export async function runStep<T>(
  ctx: WorkflowContext,
  step: string,
  fn: () => Promise<T>,
  suffix?: string,
): Promise<T> {
  const key = stepKey(ctx.workflowId, step, suffix);
  const prior = await getJobStep(ctx.pool, key);
  if (prior?.status === 'completed') {
    ctx.trace.push({ step, idempotencyKey: key, status: 'replayed', attempt: prior.attempt });
    return prior.result as T;
  }
  // Ownership first: a fenced-out worker must not even record that it began a step.
  await assertStillOwner(ctx, step);
  // Then the operator's intent. `checkpointControl` throws JobControlStop, which the caller translates
  // into a clean, resumable halt.
  await checkpointControl(ctx.pool, { jobId: ctx.job.id, step });
  const row = await beginJobStep(ctx.pool, { jobId: ctx.job.id, step, idempotencyKey: key });
  await updateJob(ctx.pool, ctx.job.id, { status: 'running', currentStep: step, error: null });
  try {
    const result = await fn();
    await completeJobStep(ctx.pool, key, result);
    ctx.trace.push({ step, idempotencyKey: key, status: 'completed', attempt: row.attempt });
    return result;
  } catch (err) {
    const wf = asWorkflowError(err, step);
    await failJobStep(ctx.pool, key, { code: wf.code, message: wf.detail, data: wf.options.data });
    await updateJob(ctx.pool, ctx.job.id, {
      status: wf.code === 'APPROVAL_BLOCKED' ? 'needs_attention' : 'failed',
      currentStep: step,
      error: wf.toJSON(),
    });
    ctx.trace.push({ step, idempotencyKey: key, status: 'failed', attempt: row.attempt });
    throw wf;
  }
}

/**
 * Verify the run still owns its target lease before starting a step.
 *
 * The distinction that matters is transient failure versus definitive loss of ownership, because the two
 * demand opposite responses:
 *
 *  * DEFINITIVELY LOST (released, expired, or a higher fence now holds it) — another worker may already be
 *    producing this chapter. Continuing risks two runs drafting, accepting and committing the same target,
 *    so the run stops here, before any further durable side effect, with a typed non-retryable error.
 *  * TRANSIENTLY UNKNOWN (the database could not be reached) — this says nothing about ownership. Failing
 *    closed would abort a healthy run on a blip, so it is raised as a retryable error and the orchestrator
 *    retries the step; the lease's own TTL is what protects the target if the outage outlasts it.
 */
async function assertStillOwner(ctx: WorkflowContext, step: string): Promise<void> {
  const lease = ctx.lease;
  if (!lease) return;
  let state;
  try {
    state = await leaseOwnership(ctx.pool, {
      leaseId: lease.leaseId,
      holderWorkflowId: lease.holderWorkflowId,
      fence: lease.fence,
    });
  } catch {
    throw new WorkflowError(
      'CONCURRENT_CALL',
      `lease ownership could not be verified before ${step}`,
      {
        step,
        retriable: true,
        recommendedActions: ['retry_step'],
        data: { lease_id: lease.leaseId, cause: 'lease_check_failed' },
      },
    );
  }
  if (state.owned) return;
  throw new WorkflowError(
    'LEASE_LOST',
    `this run no longer holds the lease on its target (${state.reason}); stopping before ${step}`,
    {
      step,
      recommendedActions: ['review_conflicts'],
      data: {
        lease_id: lease.leaseId,
        fence: lease.fence,
        reason: state.reason,
        current_holder: state.currentHolder ?? null,
      },
    },
  );
}

/** Store a step artifact (content-addressed, append-only) and return its reference for the step result. */
export async function saveArtifact(
  ctx: WorkflowContext,
  input: { step: string; kind: string; key: string; schema?: string | undefined; payload: unknown },
): Promise<{ artifact_id: string; content_hash: string }> {
  if (input.schema) {
    const v = validatorFor(input.schema)(input.payload);
    if (!v.ok)
      throw new WorkflowError(
        'INTERNAL',
        `artifact ${input.kind}/${input.key} does not validate against ${input.schema}: ${v.errors
          .map((e) => `${e.path} ${e.message}`)
          .join('; ')}`,
        { step: input.step },
      );
  }
  const { artifact } = await putArtifact(ctx.pool, {
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    jobId: ctx.job.id,
    step: input.step,
    kind: input.kind,
    key: input.key,
    schema: input.schema,
    payload: input.payload,
  });
  return { artifact_id: artifact.id, content_hash: artifact.content_hash };
}

export async function loadArtifact<T>(ctx: WorkflowContext, artifactId: string): Promise<T> {
  const a = await getArtifactById(ctx.pool, artifactId);
  if (!a) throw new WorkflowError('INTERNAL', `artifact ${artifactId} not found`);
  return a.payload as T;
}

/** Artifact-backed output store for PgAuditStore: outputs live in workflow_artifacts, never in llm_calls. */
export class ArtifactLlmOutputStore implements LlmOutputStore {
  constructor(
    private readonly pool: Pool,
    private readonly scope: { workspaceId: string; projectId: string; jobId?: string | undefined },
  ) {}
  async get(key: string) {
    const r = await this.pool.query<{ payload: { text?: string; json?: unknown } }>(
      `SELECT payload FROM workflow_artifacts WHERE project_id = $1 AND kind = 'llm_output' AND key = $2`,
      [this.scope.projectId, key],
    );
    return r.rows[0]?.payload;
  }
  async set(
    key: string,
    output: { text?: string | undefined; json?: unknown },
    record: GatewayAuditLike,
  ) {
    const { artifact } = await putArtifact(this.pool, {
      workspaceId: this.scope.workspaceId,
      projectId: this.scope.projectId,
      jobId: this.scope.jobId,
      step: `llm:${record.role}`,
      kind: 'llm_output',
      key,
      payload: { text: output.text, json: output.json },
    });
    return { artifactRef: { artifact_id: artifact.id, content_hash: artifact.content_hash } };
  }
}

export interface ModelCallInput {
  readonly step: string;
  readonly family: string;
  readonly activityId: string;
  readonly variables: Readonly<Record<string, string>>;
  /** Rendered pack the call is bound to (writer/planner/checker/extractor). Absent for pack-less roles. */
  readonly pack?:
    | {
        readonly id: string;
        readonly hash: string;
        readonly tokenEstimate: number;
        readonly narrativeIdentityRef: NarrativeIdentityRef | undefined;
        readonly variables: Readonly<Record<string, string>>;
      }
    | undefined;
  /** Compiled identity block for pack-less style-sensitive roles (judges, reviser, summarizer). */
  readonly block?:
    | {
        readonly text: string;
        readonly hash: string;
        readonly identityTail: string | undefined;
        readonly outputLanguageContractHash: string;
        readonly traditionContractHash: string;
        readonly roleVariant: string;
      }
    | undefined;
  readonly outputSchemaRef?: string | undefined;
}

export interface ModelCallResult<T = unknown> {
  readonly llmCallId: string;
  readonly output: T;
  readonly replayed: boolean;
  readonly promptVersionId: string;
  readonly promptHash: string;
  readonly outputLanguageCheck: GatewayResponse['outputLanguageCheck'];
}

/**
 * One model call: prompt family → pinned version → rendered with pack variables → Gateway. The Narrative
 * Identity Guard runs inside the gateway; the block is embedded either by the pack (system position) or by
 * the prompt's own `{{narrative_identity_block}}` slot for pack-less roles.
 */
export async function modelCall<T = unknown>(
  ctx: WorkflowContext,
  input: ModelCallInput,
): Promise<ModelCallResult<T>> {
  const versionId = ctx.promptSet.mapping[input.family];
  if (!versionId)
    throw new WorkflowError('INTERNAL', `prompt set ${ctx.promptSet.id} has no ${input.family}`, {
      step: input.step,
    });
  const pv = ctx.registry.get(versionId);
  const vars: Record<string, string> = { ...(input.pack?.variables ?? {}), ...input.variables };
  for (const v of pv.input_variables) vars[v] ??= '(none)';
  let identityRef: NarrativeIdentityRef | undefined;
  if (pv.style_sensitive) {
    // A role-specific block wins (planner/judge/editor variants); otherwise the pack's own block is embedded.
    if (input.block) {
      vars.narrative_identity_block = input.block.text;
      vars.identity_tail = input.block.identityTail ?? '';
      identityRef = {
        blockHash: input.block.hash,
        identityVersionId: ctx.pins.narrativeIdentityVersionId as Uuid,
        roleVariant: input.block.roleVariant,
        outputLanguage: 'en',
        outputLanguageContractHash: input.block.outputLanguageContractHash,
        traditionContractHash: input.block.traditionContractHash,
      };
    } else if (input.pack?.narrativeIdentityRef) {
      vars.narrative_identity_block = input.pack.variables.narrative_identity_block ?? '';
      vars.identity_tail = input.pack.variables.identity_tail ?? '';
      identityRef = input.pack.narrativeIdentityRef;
    } else {
      throw new WorkflowError(
        'IDENTITY_UNPINNED',
        `${input.family} is style-sensitive but no Narrative Identity block was supplied`,
        { step: input.step },
      );
    }
  }
  const rendered = renderPrompt(pv, vars);
  const idempotencyKey = stepKey(ctx.workflowId, 'llm', input.activityId);
  const req: GatewayRequest = {
    workspaceId: ctx.workspaceId as Uuid,
    projectId: ctx.projectId as Uuid,
    jobId: ctx.job.id as Uuid,
    activityId: input.activityId,
    idempotencyKey,
    role: pv.role,
    styleSensitive: pv.style_sensitive,
    manuscriptProducing: pv.manuscript_producing,
    promptVersionId: pv.id as Uuid,
    promptHash: pv.content_hash,
    productionPolicyVersion: ctx.pins.productionPolicyVersion,
    pack: {
      id: (input.pack?.id ?? packlessId(input.activityId)) as Uuid,
      hash: input.pack?.hash ?? `sha256:${'0'.repeat(64)}`,
      renderedSystem: rendered.system,
      renderedUser: rendered.user,
      tokenEstimate:
        input.pack?.tokenEstimate ?? Math.ceil((rendered.system.length + rendered.user.length) / 4),
    },
    narrativeIdentityRef: identityRef,
    outputSchemaRef: input.outputSchemaRef ?? pv.output_schema ?? undefined,
    params: { temperature: pv.params.temperature, max_tokens: pv.params.max_tokens },
    modelClass: pv.model_class,
  };
  let res: GatewayResponse;
  try {
    res = await ctx.gateway.call(req);
  } catch (err) {
    throw asWorkflowError(err, input.step);
  }
  const output = (res.output.json ?? res.output.text) as T;
  if (output === undefined)
    throw new WorkflowError('MODEL_CALL_FAILED', `${input.family} returned no output`, {
      step: input.step,
    });
  return {
    llmCallId: res.llmCallId,
    output,
    replayed: res.replayed,
    promptVersionId: pv.id,
    promptHash: pv.content_hash,
    outputLanguageCheck: res.outputLanguageCheck,
  };
}

/** Pack-less calls still need a pack id column: derive a stable v8 UUID from the activity id. */
function packlessId(activityId: string): string {
  const hex = createHash('sha256').update(activityId, 'utf8').digest('hex').slice(0, 32);
  const b = Buffer.from(hex, 'hex');
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
