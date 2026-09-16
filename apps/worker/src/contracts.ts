/**
 * Versioned, serializable contracts between workflow code and activities (Checkpoint 7).
 *
 * These types are the wire format of the durable orchestration, so they follow the reliability plan's
 * rules rather than convenience:
 *
 *  * SERIALIZABLE AND BOUNDED. Only JSON primitives cross the boundary. Manuscript prose, prompt text and
 *    provider payloads never do — activities exchange IDs and hashes, and the text itself stays in
 *    `manuscript_versions` / `workflow_artifacts` where it is already immutable and access-controlled. A
 *    workflow history that contained chapter prose would be both enormous and a second, unguarded copy of
 *    customer content.
 *  * VERSIONED. Every payload carries `v`. A worker deployed mid-run must be able to recognise an older
 *    activity input from history rather than mis-parsing it, and a replay of an old history must not be
 *    silently reinterpreted under new field meanings.
 *  * IDEMPOTENCY-CARRYING. Each activity input carries the idempotency scope its effect is keyed on, so a
 *    retried activity converges on the same row instead of doing the work twice.
 */

/** Current contract version. Bump when a field's MEANING changes, never merely when one is added. */
export const CONTRACT_VERSION = 1 as const;

export type ContractVersion = typeof CONTRACT_VERSION;

/** The task queue the chapter-production worker polls. */
export const CHAPTER_TASK_QUEUE = 'yeonjae.chapter-production';

interface Versioned {
  readonly v: ContractVersion;
}

/**
 * Input to the chapter-production workflow.
 *
 * Deliberately narrow: the workflow receives identifiers and the deterministic plan ids, and activities
 * load the rest from Postgres. That keeps workflow history small, and it means a replay reads today's
 * committed state rather than a stale copy embedded in history.
 */
export interface ChapterWorkflowInput extends Versioned {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly chapterNo: number;
  /** Deterministic plan ids the replay fixtures reference (same contract as `produceChapter`). */
  readonly ids: { readonly arcId: string; readonly seasonId: string; readonly contractId: string };
  /**
   * Content-addressed artifact ids for the story intake and bible, NOT the documents themselves. The
   * activity loads them from `workflow_artifacts`, so workflow history stays bounded and a replay reads
   * the exact immutable inputs the run started from (the id IS the content hash).
   */
  readonly inputsRef: { readonly intakeArtifactId: string; readonly bibleArtifactId: string };
  readonly requestedBy: string;
  /** Test hook, mirrored from the existing workflow input so failure/resume proofs stay expressible. */
  readonly failAfterStep?: string | undefined;
  readonly stage?: 'full' | 'contract_and_pack' | undefined;
}

export interface LeaseHandle extends Versioned {
  readonly leaseId: string;
  readonly holderWorkflowId: string;
  readonly fence: string;
}

export interface AcquireLeaseActivityInput extends Versioned {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly chapterNo: number;
  readonly workflowId: string;
}

export interface AcquireLeaseActivityResult extends Versioned {
  readonly acquired: boolean;
  readonly lease?: LeaseHandle | undefined;
  /** When contended: which workflow holds the target, so the operator sees what is in the way. */
  readonly heldBy?: string | undefined;
}

export interface ProduceActivityInput extends Versioned {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly chapterNo: number;
  readonly ids: ChapterWorkflowInput['ids'];
  readonly inputsRef: ChapterWorkflowInput['inputsRef'];
  readonly workflowId: string;
  readonly lease: LeaseHandle;
  readonly failAfterStep?: string | undefined;
  readonly stage?: 'full' | 'contract_and_pack' | undefined;
}

/**
 * Result of the production activity.
 *
 * Only outcome metadata, no prose. `accepted` is present exactly when canon advanced, which is what the
 * workflow (and the tests) treat as the exactly-once effect.
 */
export interface ProduceActivityResult extends Versioned {
  readonly jobId: string;
  readonly chapterId: string;
  readonly status: 'completed' | 'planned' | 'needs_attention' | 'failed';
  readonly accepted:
    | {
        readonly manuscriptVersionId: string;
        readonly commitId: string;
        readonly canonVersion: number;
      }
    | undefined;
  readonly llmCalls: number;
  readonly spendCents: string;
  readonly steps: readonly { readonly step: string; readonly status: string }[];
}

export interface ControlActivityInput extends Versioned {
  readonly jobId: string;
  readonly step: string;
}

/** What a control check observed at a checkpoint boundary. */
export interface ControlActivityResult extends Versioned {
  readonly control: 'run' | 'pause' | 'cancel';
  readonly stopped: boolean;
}

export interface FinishActivityInput extends Versioned {
  readonly jobId: string;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly detail?: Readonly<Record<string, string | number | boolean>> | undefined;
}

export interface ReleaseLeaseActivityInput extends Versioned {
  readonly lease: LeaseHandle;
}

export interface JobLookupInput extends Versioned {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly workflowId: string;
}

export interface JobLookupResult extends Versioned {
  readonly jobId: string | undefined;
  readonly status: string | undefined;
}

/** Progress reported by a query, so an operator can read a running workflow without touching the DB. */
export interface ChapterWorkflowProgress extends Versioned {
  readonly phase:
    'starting' | 'lease_contended' | 'producing' | 'paused' | 'cancelled' | 'completed' | 'failed';
  readonly chapterNo: number;
  readonly jobId: string | undefined;
  readonly acceptedCanonVersion: number | undefined;
  readonly lastStep: string | undefined;
}

/** Final workflow result. */
export interface ChapterWorkflowResult extends Versioned {
  /**
   * `too_late` means a cancel was requested but lost the race with the atomic canon commit. It is a
   * distinct outcome from `cancelled` on purpose: the chapter IS accepted and canon HAS advanced, and
   * labelling that `cancelled` would describe a state the database does not contain.
   */
  readonly outcome:
    'accepted' | 'planned' | 'needs_attention' | 'paused' | 'cancelled' | 'too_late' | 'lease_held';
  readonly jobId: string | undefined;
  readonly acceptedCanonVersion: number | undefined;
  readonly heldBy?: string | undefined;
}

export function versioned<T extends object>(value: T): T & Versioned {
  return { v: CONTRACT_VERSION, ...value };
}
