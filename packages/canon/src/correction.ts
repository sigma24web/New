/**
 * Canon correction, retcon and rollback (Checkpoint 7; API plan §Canon, ADR-0032, ADR-0038).
 *
 * These are the only operator actions that change canon outside chapter acceptance, so they are written to
 * the same standard as the acceptance path and reuse its enforcement rather than adding a second one:
 *
 *  * THE WRITE PATH IS STILL THE SQL FUNCTION. `canon.commit_delta` and `canon.rollback_latest` remain the
 *    only ways canon changes. The triggers from migration 0001 refuse any canon write that does not come
 *    through them, so a correction cannot bypass the change-class, evidence, frame or validity rules by
 *    writing rows directly.
 *  * NOTHING IS DELETED. A correction supersedes; a rollback retracts by setting `retracted_at_version`.
 *    History and its evidence stay readable, because "what did canon say when chapter 7 was written?" must
 *    remain answerable after any correction.
 *  * THE OPERATOR SEES THE IMPACT FIRST. `dryRun` returns the report and commits nothing. The commit then
 *    takes the canon version the report was computed at as its expected version, so a concurrent commit
 *    between the report and the approval is a typed conflict rather than a silent overwrite of work the
 *    operator never saw.
 *  * JUSTIFICATION IS REQUIRED. `canon_commits.justification` is the audit record of why canon changed;
 *    a correction without a reason is refused before any work happens.
 */
import { asCanonError, type Client, type Pool } from '@yeonjae/db';
import {
  impactOf,
  regenerationImpact,
  rollbackImpact,
  type CanonItemKind,
  type ImpactReport,
} from './impact.js';

/** Typed failures these operations raise. Each maps to a distinct operator action. */
export type CorrectionErrorCode =
  | 'JUSTIFICATION_REQUIRED'
  | 'CANON_STALE'
  | 'NOT_FOUND'
  | 'ILLEGAL_OP'
  | 'EVIDENCE_REQUIRED'
  | 'CONFIRMATION_REQUIRED';

export class CorrectionError extends Error {
  constructor(
    readonly code: CorrectionErrorCode,
    readonly detail: string,
    readonly data: Readonly<Record<string, unknown>> = {},
  ) {
    super(`${code}: ${detail}`);
    this.name = 'CorrectionError';
  }
}

export interface CorrectionActor {
  readonly userId: string;
  readonly via: string;
}

export interface CorrectionResult {
  readonly committed: boolean;
  readonly canonVersion: number;
  readonly commitId: string | undefined;
  readonly impact: ImpactReport;
  /** Material dependents marked stale by this commit. */
  readonly staleMarked: readonly string[];
  /** Contextual dependents raised as review suggestions (never invalidated). */
  readonly reviewSuggested: readonly string[];
}

export interface CorrectFactInput {
  readonly projectId: string;
  readonly itemKind: CanonItemKind;
  readonly itemId: string;
  /** The corrected value, validated by `canon.commit_delta`'s change-class rules like any other delta. */
  readonly newValue: Record<string, unknown>;
  /** Reality frame of the corrected item (ADR-0007). Defaults to the canonical frame. */
  readonly frame?: string | undefined;
  /** Evidence spans for the corrected value, verified by the commit function's evidence trigger. */
  readonly evidence?: readonly Record<string, unknown>[] | undefined;
  readonly justification: string;
  readonly actor: CorrectionActor;
  /** The canon version the operator's impact report was computed at. */
  readonly expectedCanonVersion: number;
  readonly dryRun?: boolean | undefined;
}

/**
 * Correct a canon item.
 *
 * The correction is expressed as a normal `supersede` delta through `canon.commit_delta`, which means it
 * inherits every check the acceptance path gets: evidence must resolve, the change class must be legal for
 * the item kind, validity intervals cannot overlap, and the commit is atomic against
 * `expectedCanonVersion`. This module adds only what is specific to a *correction*: the mandatory
 * justification, the pre-commit impact report, and the material/contextual consequences.
 */
export async function correctCanonItem(
  pool: Pool,
  input: CorrectFactInput,
): Promise<CorrectionResult> {
  if (!input.justification.trim())
    throw new CorrectionError(
      'JUSTIFICATION_REQUIRED',
      'A correction must record why canon is being changed.',
    );

  const impact = await impactOf(pool, {
    projectId: input.projectId,
    items: [{ kind: input.itemKind, ref: input.itemId }],
  });

  if (input.dryRun)
    return {
      committed: false,
      canonVersion: impact.canonVersion,
      commitId: undefined,
      impact,
      staleMarked: [],
      reviewSuggested: [],
    };

  // The operator approved a report computed at a specific version. If canon moved since, the report they
  // saw is no longer the truth, so this is a conflict to surface rather than a change to apply blindly.
  if (impact.canonVersion !== input.expectedCanonVersion)
    throw new CorrectionError(
      'CANON_STALE',
      'Canon changed since the impact report was produced; review the new report and retry.',
      { expected: input.expectedCanonVersion, actual: impact.canonVersion },
    );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const committed = await commitCorrection(client, input, impact);
    await client.query('COMMIT');
    return committed;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw asCorrectionError(err);
  } finally {
    client.release();
  }
}

async function commitCorrection(
  client: Client,
  input: CorrectFactInput,
  impact: ImpactReport,
): Promise<CorrectionResult> {
  // The delta uses the SQL function's own vocabulary (`type`/`op`/`supersedes_ref`/`payload`) so a
  // correction is validated by exactly the checks an acceptance delta gets. `supersede` keeps the prior
  // row and links it, which is why nothing is deleted.
  const delta = correctionDelta(input);
  const r = await client.query<{ result: { commit_id: string; version: number } }>(
    `SELECT canon.commit_delta($1, $2, 'user_correction', $3::jsonb, $4::jsonb, NULL, NULL, $5) AS result`,
    [
      input.projectId,
      input.expectedCanonVersion,
      JSON.stringify(delta),
      JSON.stringify({ user_id: input.actor.userId, via: input.actor.via }),
      input.justification,
    ],
  );
  const result = r.rows[0]?.result;
  if (!result) throw new CorrectionError('ILLEGAL_OP', 'The correction produced no commit.');

  const consequences = await applyDependencyConsequences(client, {
    projectId: input.projectId,
    impact,
    canonVersion: result.version,
  });

  return {
    committed: true,
    canonVersion: result.version,
    commitId: result.commit_id,
    impact,
    ...consequences,
  };
}

/**
 * Apply ADR-0032's two different consequences.
 *
 * Material dependents become STALE — their constraint changed, so they may now be wrong and must be
 * revisited. Contextual dependents are only REVIEW SUGGESTIONS; marking them stale would flood the
 * operator with false positives and teach them to ignore staleness, which is worse than not marking it.
 *
 * Accepted chapters are marked `stale` rather than rewritten: the manuscript stays immutable and its canon
 * stays committed. Staleness is a statement about the relationship between them, not a change to either.
 */
async function applyDependencyConsequences(
  client: Client,
  input: { projectId: string; impact: ImpactReport; canonVersion: number },
): Promise<{ staleMarked: readonly string[]; reviewSuggested: readonly string[] }> {
  const materialChapters = [
    ...new Set(
      input.impact.material
        .filter((d) => d.dependentKind === 'manuscript_version')
        .map((d) => d.chapterNo)
        .filter((n): n is number => n !== undefined),
    ),
  ];
  const staleMarked: string[] = [];
  if (materialChapters.length > 0) {
    const marked = await client.query<{ id: string }>(
      `UPDATE chapters SET status = 'stale', updated_at = now()
        WHERE project_id = $1 AND number = ANY($2::int[]) AND status = 'accepted'
        RETURNING id`,
      [input.projectId, materialChapters],
    );
    staleMarked.push(...marked.rows.map((r) => r.id));
  }
  // Contextual dependents are reported, not mutated.
  const reviewSuggested = [...new Set(input.impact.contextual.map((d) => d.dependentId))];
  return { staleMarked, reviewSuggested };
}

export interface RetconInput {
  readonly projectId: string;
  readonly itemKind: CanonItemKind;
  readonly itemId: string;
  readonly newValue: Record<string, unknown>;
  readonly frame?: string | undefined;
  readonly evidence?: readonly Record<string, unknown>[] | undefined;
  readonly justification: string;
  readonly actor: CorrectionActor;
  readonly expectedCanonVersion: number;
  /**
   * A retcon rewrites established story history, so the MVP requires the human to say so explicitly.
   * There is no automatic patch engine in the MVP (that is Beta scope): affected chapters become stale for
   * a human to address.
   */
  readonly confirmed: boolean;
  readonly dryRun?: boolean | undefined;
}

/**
 * Apply an MVP retcon.
 *
 * Mechanically this is a correction with `source = 'retcon'`, and it deliberately does NOT attempt to
 * repair the affected chapters. The Beta-only automatic patch engine is out of scope; what the MVP
 * guarantees is that the consequences are visible, material dependents are stale, contextual dependents
 * are review suggestions, and history is preserved.
 */
export async function retconCanonItem(pool: Pool, input: RetconInput): Promise<CorrectionResult> {
  if (!input.justification.trim())
    throw new CorrectionError(
      'JUSTIFICATION_REQUIRED',
      'A retcon must record why established history is being changed.',
    );
  const impact = await impactOf(pool, {
    projectId: input.projectId,
    items: [{ kind: input.itemKind, ref: input.itemId }],
  });
  if (input.dryRun)
    return {
      committed: false,
      canonVersion: impact.canonVersion,
      commitId: undefined,
      impact,
      staleMarked: [],
      reviewSuggested: [],
    };
  // Explicit human confirmation is required precisely because the impact can be wide and unrepaired.
  if (!input.confirmed)
    throw new CorrectionError(
      'CONFIRMATION_REQUIRED',
      'A retcon changes established story history and requires explicit confirmation.',
      {
        material_dependents: impact.material.length,
        contextual_dependents: impact.contextual.length,
        affected_accepted_chapters: impact.affectedAcceptedChapters,
      },
    );
  if (impact.canonVersion !== input.expectedCanonVersion)
    throw new CorrectionError(
      'CANON_STALE',
      'Canon changed since the impact report was produced; review the new report and retry.',
      { expected: input.expectedCanonVersion, actual: impact.canonVersion },
    );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const delta = correctionDelta(input);
    const r = await client.query<{ result: { commit_id: string; version: number } }>(
      `SELECT canon.commit_delta($1, $2, 'retcon', $3::jsonb, $4::jsonb, NULL, NULL, $5) AS result`,
      [
        input.projectId,
        input.expectedCanonVersion,
        JSON.stringify(delta),
        JSON.stringify({ user_id: input.actor.userId, via: input.actor.via }),
        input.justification,
      ],
    );
    const result = r.rows[0]?.result;
    if (!result) throw new CorrectionError('ILLEGAL_OP', 'The retcon produced no commit.');
    const consequences = await applyDependencyConsequences(client, {
      projectId: input.projectId,
      impact,
      canonVersion: result.version,
    });
    await client.query('COMMIT');
    return {
      committed: true,
      canonVersion: result.version,
      commitId: result.commit_id,
      impact,
      ...consequences,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw asCorrectionError(err);
  } finally {
    client.release();
  }
}

export interface RollbackInput {
  readonly projectId: string;
  readonly actor: CorrectionActor;
  readonly expectedCanonVersion: number;
  readonly dryRun?: boolean | undefined;
}

/**
 * Roll back the latest canon commit.
 *
 * MVP policy is latest-only, and `canon.rollback_latest` is what enforces it — along with refusing to roll
 * back a rollback, and retracting rather than deleting so the history and its evidence survive. This
 * wrapper adds the dry-run report and the optimistic version check.
 */
export async function rollbackLatestCommit(
  pool: Pool,
  input: RollbackInput,
): Promise<CorrectionResult & { rollbackable: boolean; reason?: string | undefined }> {
  const report = await rollbackImpact(pool, { projectId: input.projectId });
  if (input.dryRun)
    return {
      committed: false,
      canonVersion: report.canonVersion,
      commitId: undefined,
      impact: report,
      staleMarked: [],
      reviewSuggested: [],
      rollbackable: report.rollbackable,
      ...(report.reason ? { reason: report.reason } : {}),
    };
  if (!report.rollbackable)
    throw new CorrectionError('ILLEGAL_OP', report.reason ?? 'This commit cannot be rolled back.');
  if (report.canonVersion !== input.expectedCanonVersion)
    throw new CorrectionError(
      'CANON_STALE',
      'Canon changed since the impact report was produced; review the new report and retry.',
      { expected: input.expectedCanonVersion, actual: report.canonVersion },
    );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query<{ result: { commit_id: string; version: number } }>(
      'SELECT canon.rollback_latest($1, $2::jsonb) AS result',
      [input.projectId, JSON.stringify({ user_id: input.actor.userId, via: input.actor.via })],
    );
    const result = r.rows[0]?.result;
    if (!result) throw new CorrectionError('ILLEGAL_OP', 'The rollback produced no commit.');
    const consequences = await applyDependencyConsequences(client, {
      projectId: input.projectId,
      impact: report,
      canonVersion: result.version,
    });
    await client.query('COMMIT');
    return {
      committed: true,
      canonVersion: result.version,
      commitId: result.commit_id,
      impact: report,
      ...consequences,
      rollbackable: true,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw asCorrectionError(err);
  } finally {
    client.release();
  }
}

/**
 * Report what regenerating a chapter would affect, and mark nothing.
 *
 * Regeneration itself goes through the normal production path (a new immutable version that must pass the
 * usual gates); what this adds is the operator's advance view of which later chapters were written against
 * the canon the current version committed.
 */
export async function regenerationPreview(
  pool: Pool,
  input: { projectId: string; chapterNo: number },
): Promise<ImpactReport> {
  return regenerationImpact(pool, input);
}

/**
 * Build the one-item supersede delta a correction or retcon commits.
 *
 * `op: 'supersede'` with `supersedes_ref` is what makes the change non-destructive: the SQL function
 * closes the prior row's validity and links the new row to it, so the old value and its evidence remain
 * readable at their original canon version.
 */
function correctionDelta(input: {
  readonly itemKind: CanonItemKind;
  readonly itemId: string;
  readonly newValue: Record<string, unknown>;
  readonly frame?: string | undefined;
  readonly evidence?: readonly Record<string, unknown>[] | undefined;
}): Record<string, unknown> {
  return {
    items: [
      {
        local_id: `correction-${input.itemId}`,
        type: input.itemKind,
        op: 'supersede',
        supersedes_ref: input.itemId,
        // `frame` is NOT NULL on the canon tables (ADR-0007), so it is always sent. A correction stays in
        // the frame it corrects unless the caller says otherwise; silently defaulting to `canonical`
        // would let an in-world rumour be corrected into established fact.
        frame: input.frame ?? 'canonical',
        confidence: 1,
        importance: 'core',
        // Evidence is the caller's to supply. An empty list is legal only where the change class permits
        // it; `canon.commit_delta` decides, not this module.
        evidence: input.evidence ?? [],
        payload: input.newValue,
      },
    ],
  };
}

/** Translate the SQL layer's typed canon errors into correction errors, preserving the code. */
function asCorrectionError(err: unknown): unknown {
  if (err instanceof CorrectionError) return err;
  // The canon functions raise typed errors as P0001 with the code in HINT. `asCanonError` is the one
  // place that decoding lives, so a direct client call gets the same typed result `commitDelta` does
  // rather than leaking a raw PostgreSQL error to the caller.
  const canon = asCanonError(err);
  const e = (canon ?? err) as { name?: string; code?: string; detail?: string; message?: string };
  if (e.name === 'CanonDbError') {
    const code = e.code ?? '';
    if (code === 'STALE_CANON' || code === 'CANON_STALE')
      return new CorrectionError('CANON_STALE', e.detail ?? 'Canon moved under this operation.');
    if (code === 'NOT_FOUND')
      return new CorrectionError('NOT_FOUND', e.detail ?? 'The canon item does not exist.');
    if (code === 'ILLEGAL_OP')
      return new CorrectionError('ILLEGAL_OP', e.detail ?? 'The operation is not permitted.');
    // Evidence-backed canon (ADR-0006) applies to corrections too: a corrected fact must still quote the
    // manuscript. Surfacing it as a typed code lets the UI ask for the span instead of showing a 500.
    if (code === 'EVIDENCE_REQUIRED')
      return new CorrectionError(
        'EVIDENCE_REQUIRED',
        e.detail ?? 'The corrected value needs at least one evidence span.',
      );
  }
  return err;
}
