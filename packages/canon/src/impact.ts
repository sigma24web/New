/**
 * Impact reports for canon correction, chapter regeneration, retcon and rollback (Checkpoint 7).
 *
 * Every one of these operations changes canon that later artifacts were built from, so the MVP rule
 * (API plan §Canon, ADR-0032) is that the operator sees the consequences BEFORE anything is committed.
 * This module computes that report and nothing else: it performs no writes, so a dry run cannot have a
 * side effect, and the commit paths below reuse the same computation rather than a parallel one that might
 * disagree with what the operator was shown.
 *
 * The distinction that matters is ADR-0032's:
 *
 *  * MATERIAL dependents used the canon item as a constraint — a contract anchor, a T0/T1 state, a claim
 *    reference. If the item changes, they may now be wrong, so they become STALE and must be revisited.
 *  * CONTEXTUAL dependents merely retrieved the item as background. They become REVIEW SUGGESTIONS: worth
 *    a human glance, never automatically invalidated.
 *
 * Collapsing the two would either flood the operator with false staleness or silently hide real breakage,
 * which is why the edge table records materiality at write time and this module never infers it.
 */
import { type Client, type Pool } from '@yeonjae/db';

type Queryable = Pool | Client;

export type CanonItemKind =
  | 'fact'
  | 'event'
  | 'knowledge_state'
  | 'relationship_state'
  | 'proposition'
  | 'proposition_truth'
  | 'promise'
  | 'promise_event';

export interface ImpactedDependent {
  readonly dependentKind: 'manuscript_version' | 'chapter_contract' | 'summary';
  readonly dependentId: string;
  readonly canonItemKind: string;
  readonly canonItemRef: string;
  readonly basis: string;
  readonly canonVersionRead: number;
  /** The chapter the dependent belongs to, when it has one, so the report is legible to an operator. */
  readonly chapterNo: number | undefined;
}

export interface ImpactReport {
  readonly projectId: string;
  readonly canonVersion: number;
  readonly items: readonly { kind: string; ref: string }[];
  /** Dependents that used the item as a constraint: these become stale. */
  readonly material: readonly ImpactedDependent[];
  /** Dependents that merely saw the item as background: these become review suggestions. */
  readonly contextual: readonly ImpactedDependent[];
  /** Accepted chapters among the material dependents — the ones whose canon may now be wrong. */
  readonly affectedAcceptedChapters: readonly number[];
  /** True when nothing depends on the items, so the change is safe in the narrow sense. */
  readonly isolated: boolean;
}

/**
 * Compute the impact of changing a set of canon items.
 *
 * Read-only by construction. The `canon_version` in the report is the version the report was computed at;
 * a commit that follows must supply it as its expected version, so a concurrent commit in between is
 * detected instead of silently invalidating what the operator approved.
 */
export async function impactOf(
  db: Queryable,
  input: {
    projectId: string;
    // A caller may pass a known kind or a kind read back from the edge table, so this is widened to
    // string rather than the union alone.
    items: readonly { kind: string; ref: string }[];
  },
): Promise<ImpactReport> {
  const project = await db.query<{ canon_version: number }>(
    'SELECT canon_version FROM projects WHERE id = $1',
    [input.projectId],
  );
  const canonVersion = project.rows[0]?.canon_version;
  if (canonVersion === undefined) throw new Error(`project ${input.projectId} does not exist`);

  if (input.items.length === 0)
    return {
      projectId: input.projectId,
      canonVersion,
      items: [],
      material: [],
      contextual: [],
      affectedAcceptedChapters: [],
      isolated: true,
    };

  const kinds = input.items.map((i) => i.kind);
  const refs = input.items.map((i) => i.ref);
  const rows = await db.query<{
    dependent_kind: ImpactedDependent['dependentKind'];
    dependent_id: string;
    canon_item_kind: string;
    canon_item_ref: string;
    basis: string;
    materiality: 'material' | 'contextual';
    canon_version_read: number;
    chapter_no: number | null;
  }>(
    `SELECT e.dependent_kind, e.dependent_id, e.canon_item_kind, e.canon_item_ref, e.basis,
            e.materiality, e.canon_version_read,
            c.number AS chapter_no
       FROM dependency_edges e
       -- A manuscript version belongs to a chapter; other dependent kinds may not, hence the outer joins.
       LEFT JOIN manuscript_versions mv
              ON e.dependent_kind = 'manuscript_version' AND mv.id = e.dependent_id
       LEFT JOIN chapters c ON c.id = mv.chapter_id
      WHERE e.project_id = $1
        AND (e.canon_item_kind, e.canon_item_ref) IN (
              SELECT * FROM unnest($2::text[], $3::text[]))
      ORDER BY e.materiality, c.number NULLS LAST, e.dependent_id`,
    [input.projectId, kinds, refs],
  );

  const map = (r: (typeof rows.rows)[number]): ImpactedDependent => ({
    dependentKind: r.dependent_kind,
    dependentId: r.dependent_id,
    canonItemKind: r.canon_item_kind,
    canonItemRef: r.canon_item_ref,
    basis: r.basis,
    canonVersionRead: r.canon_version_read,
    chapterNo: r.chapter_no ?? undefined,
  });
  const material = rows.rows.filter((r) => r.materiality === 'material').map(map);
  const contextual = rows.rows.filter((r) => r.materiality === 'contextual').map(map);

  // Accepted chapters among the material dependents: the operator's real exposure.
  const accepted = await db.query<{ number: number }>(
    `SELECT DISTINCT c.number
       FROM dependency_edges e
       JOIN manuscript_versions mv ON mv.id = e.dependent_id AND e.dependent_kind = 'manuscript_version'
       JOIN chapters c ON c.id = mv.chapter_id
      WHERE e.project_id = $1 AND e.materiality = 'material'
        AND mv.status = 'accepted' AND c.status = 'accepted'
        AND (e.canon_item_kind, e.canon_item_ref) IN (
              SELECT * FROM unnest($2::text[], $3::text[]))
      ORDER BY c.number`,
    [input.projectId, kinds, refs],
  );

  return {
    projectId: input.projectId,
    canonVersion,
    items: input.items.map((i) => ({ kind: i.kind, ref: i.ref })),
    material,
    contextual,
    affectedAcceptedChapters: accepted.rows.map((r) => r.number),
    isolated: material.length === 0 && contextual.length === 0,
  };
}

/**
 * Impact of regenerating a chapter: which later artifacts were built on the canon this chapter committed.
 *
 * Regenerating chapter k does not merely replace its text — chapter k's accepted commit may be the source
 * of facts that chapters k+1… were written against. Those are the dependents the operator must see.
 */
export async function regenerationImpact(
  db: Queryable,
  input: { projectId: string; chapterNo: number },
): Promise<ImpactReport> {
  // The canon items this chapter's accepted commit introduced, addressed the way dependency edges are.
  const items = await db.query<{ kind: string; ref: string }>(
    `SELECT DISTINCT i->>'table' AS kind, i->>'id' AS ref
       FROM canon_commits cc
       JOIN chapters c ON c.id = cc.chapter_id
       CROSS JOIN LATERAL jsonb_array_elements(coalesce(cc.inverse->'inserted', '[]'::jsonb)) AS i
      WHERE cc.project_id = $1 AND c.number = $2 AND cc.source = 'chapter_acceptance'`,
    [input.projectId, input.chapterNo],
  );
  // Dependency edges name kinds in the singular ('fact'), while the commit inverse names tables
  // ('facts'). Normalizing here keeps the edge table's vocabulary authoritative.
  const normalized = items.rows.map((r) => ({
    kind: singularizeTable(r.kind),
    ref: r.ref,
  }));
  const report = await impactOf(db, { projectId: input.projectId, items: normalized });
  // A chapter is not its own dependent for the operator's purposes: regenerating it is the intent.
  return {
    ...report,
    material: report.material.filter((d) => d.chapterNo !== input.chapterNo),
    contextual: report.contextual.filter((d) => d.chapterNo !== input.chapterNo),
    affectedAcceptedChapters: report.affectedAcceptedChapters.filter((n) => n !== input.chapterNo),
  };
}

/** Map a canon table name to the dependency-edge item kind. */
export function singularizeTable(table: string): string {
  const map: Readonly<Record<string, string>> = {
    facts: 'fact',
    events: 'event',
    knowledge_states: 'knowledge_state',
    relationship_states: 'relationship_state',
    propositions: 'proposition',
    proposition_truths: 'proposition_truth',
    promises: 'promise',
    promise_events: 'promise_event',
  };
  return map[table] ?? table;
}

/** Impact of rolling back the project's latest commit, computed from that commit's own inverse. */
export async function rollbackImpact(
  db: Queryable,
  input: { projectId: string },
): Promise<ImpactReport & { rollbackable: boolean; reason?: string | undefined }> {
  const latest = await db.query<{ id: string; version: number; source: string }>(
    `SELECT cc.id, cc.version, cc.source FROM canon_commits cc
       JOIN projects p ON p.id = cc.project_id AND p.canon_version = cc.version
      WHERE cc.project_id = $1`,
    [input.projectId],
  );
  const commit = latest.rows[0];
  if (!commit) {
    const empty = await impactOf(db, { projectId: input.projectId, items: [] });
    return { ...empty, rollbackable: false, reason: 'nothing to roll back' };
  }
  // The MVP rule (API plan §Canon, enforced by canon.rollback_latest) is latest-only, and a rollback
  // cannot itself be rolled back. Reporting it here means the UI can disable the action with a reason
  // instead of letting the operator discover it as an error.
  const rollbackable = commit.source !== 'rollback';
  const items = await db.query<{ kind: string; ref: string }>(
    `SELECT DISTINCT i->>'table' AS kind, i->>'id' AS ref
       FROM canon_commits cc
       CROSS JOIN LATERAL jsonb_array_elements(coalesce(cc.inverse->'inserted', '[]'::jsonb)) AS i
      WHERE cc.id = $1`,
    [commit.id],
  );
  const report = await impactOf(db, {
    projectId: input.projectId,
    items: items.rows.map((r) => ({ kind: singularizeTable(r.kind), ref: r.ref })),
  });
  return {
    ...report,
    rollbackable,
    ...(rollbackable ? {} : { reason: 'a rollback cannot be rolled back in MVP' }),
  };
}
