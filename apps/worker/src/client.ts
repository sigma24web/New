/**
 * Starting and controlling durable chapter runs (Checkpoint 7).
 *
 * This is the seam the API uses. It exists so that "start a chapter" and "pause/resume/cancel a chapter"
 * have exactly one implementation, and so the duplicate-start rule is stated once:
 *
 *  * the workflow id is deterministic (`chapter:<project>:<n>`), so the same logical run has one identity;
 *  * the reuse policy is REJECT_DUPLICATE while a run is live, so a second start is refused rather than
 *    silently queued behind the first;
 *  * a refusal is reported as `already_running`, not as an error, because an operator double-click and a
 *    retried HTTP request are both ordinary.
 */
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
  type Client,
  type WorkflowHandle,
} from '@temporalio/client';
import {
  CHAPTER_TASK_QUEUE,
  versioned,
  type ChapterWorkflowInput,
  type ChapterWorkflowProgress,
  type ChapterWorkflowResult,
} from './contracts.js';

export interface StartChapterInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly chapterNo: number;
  readonly ids: ChapterWorkflowInput['ids'];
  readonly inputsRef: ChapterWorkflowInput['inputsRef'];
  readonly requestedBy: string;
  readonly failAfterStep?: string | undefined;
  readonly stage?: 'full' | 'contract_and_pack' | undefined;
  readonly taskQueue?: string | undefined;
}

export interface StartChapterResult {
  readonly workflowId: string;
  readonly runId: string | undefined;
  /** False when a live run already owns this workflow id. */
  readonly started: boolean;
  readonly reason?: 'already_running' | undefined;
}

export function chapterWorkflowId(projectId: string, chapterNo: number): string {
  return `chapter:${projectId}:${chapterNo}`;
}

/** Start a chapter run, or report that one is already live. */
export async function startChapterProduction(
  client: Client,
  input: StartChapterInput,
): Promise<StartChapterResult> {
  const workflowId = chapterWorkflowId(input.projectId, input.chapterNo);
  const payload: ChapterWorkflowInput = versioned({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    chapterNo: input.chapterNo,
    ids: input.ids,
    inputsRef: input.inputsRef,
    requestedBy: input.requestedBy,
    ...(input.failAfterStep ? { failAfterStep: input.failAfterStep } : {}),
    ...(input.stage ? { stage: input.stage } : {}),
  });
  try {
    const handle = await client.workflow.start('chapterProductionWorkflow', {
      workflowId,
      taskQueue: input.taskQueue ?? CHAPTER_TASK_QUEUE,
      args: [payload],
      // The whole point of the deterministic id: a duplicate start is refused, not queued.
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
      workflowExecutionTimeout: '4 hours',
    });
    return { workflowId, runId: handle.firstExecutionRunId, started: true };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError)
      return { workflowId, runId: undefined, started: false, reason: 'already_running' };
    throw err;
  }
}

export type ChapterControl = 'pause' | 'resume' | 'cancel';

/**
 * Deliver an operator control signal.
 *
 * Signals are idempotent in the workflow (they set a flag), so a duplicate delivery is harmless and this
 * function does not need to deduplicate. A signal to a workflow that has already closed is reported rather
 * than thrown, because losing a race with completion is normal.
 */
export async function signalChapterControl(
  client: Client,
  input: { projectId: string; chapterNo: number; control: ChapterControl },
): Promise<{ delivered: boolean; reason?: 'not_running' | undefined }> {
  const handle = client.workflow.getHandle(chapterWorkflowId(input.projectId, input.chapterNo));
  try {
    if (input.control === 'cancel') {
      // Signal first so the workflow can run its own cleanup path, then request cancellation so a
      // workflow blocked in an activity is actually interrupted.
      await handle.signal('cancel');
      await handle.cancel();
    } else {
      await handle.signal(input.control);
    }
    return { delivered: true };
  } catch {
    return { delivered: false, reason: 'not_running' };
  }
}

/** Read a live run's progress without touching the database. */
export async function queryChapterProgress(
  client: Client,
  input: { projectId: string; chapterNo: number },
): Promise<ChapterWorkflowProgress | undefined> {
  const handle = client.workflow.getHandle(chapterWorkflowId(input.projectId, input.chapterNo));
  try {
    return await handle.query<ChapterWorkflowProgress>('progress');
  } catch {
    return undefined;
  }
}

export async function chapterResult(handle: WorkflowHandle): Promise<ChapterWorkflowResult> {
  return handle.result() as Promise<ChapterWorkflowResult>;
}
