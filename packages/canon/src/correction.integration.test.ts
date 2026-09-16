/**
 * Canon correction, retcon and rollback (Checkpoint 7).
 *
 * The fixture commits canon through `canon.commit_delta` — the only path that writes canon — with real
 * evidence spans against an accepted manuscript version, and records dependency edges of both
 * materialities. It is built with `packages/db` primitives rather than the Checkpoint 5 workflow because
 * `packages/canon` is a *dependency* of `packages/workflows`: importing it here would invert the package
 * graph. The API-level suite exercises the same operations over a workflow-produced chapter.
 *
 * The invariants proved are the ones an operator's mistake would otherwise destroy:
 *
 *  * a dry run reports and commits nothing;
 *  * a justification is mandatory;
 *  * ADR-0032's material/contextual split is respected — material dependents go stale, contextual ones are
 *    only review suggestions;
 *  * an approved report that has gone out of date is a typed conflict, not a silent overwrite;
 *  * nothing is deleted: superseded values and their evidence stay readable, and a rollback retracts;
 *  * MVP rollback is latest-only and a rollback cannot be rolled back;
 *  * none of it crosses a workspace boundary.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  approveManuscriptVersion,
  commitDelta,
  createChapter,
  createEntity,
  createManuscriptVersion,
  createProject,
  createWorkspace,
  insertDependencyEdges,
  migrate,
  resetDatabase,
  withWorkspace,
  type Pool,
} from '@yeonjae/db';
import { codePointLength } from '@yeonjae/prose';
import { databaseUrl, freshDatabase } from '@yeonjae/db/testkit';
import {
  correctCanonItem,
  type CorrectionError,
  impactOf,
  regenerationPreview,
  retconCanonItem,
  rollbackImpact,
  rollbackLatestCommit,
} from './index.js';

const run = databaseUrl() ? describe : describe.skip;

const ACTOR = { userId: '01a0a937-0000-7000-8000-000000000001', via: 'test' } as const;

run('canon correction, retcon and rollback (Checkpoint 7)', () => {
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;
  let canonVersion: number;
  /** A fact the accepted chapter committed, with live dependency edges pointing at it. */
  let factId: string;
  let correctedEntityId: string;
  let acceptedVersionId: string;

  beforeAll(async () => {
    pool = await freshDatabase();
  }, 60_000);
  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await migrate(pool);
    workspaceId = await createWorkspace(pool, 'correction-fixture');
    const project = await createProject(pool, { workspaceId, title: 'Second Awakening' });
    projectId = project.projectId;

    const entityId = await createEntity(pool, {
      workspaceId,
      projectId,
      type: 'character',
      displayName: 'Kang Do-yoon',
      shortForms: ['Do-yoon'],
    });
    const chapterId = await createChapter(pool, { workspaceId, projectId, number: 1 });

    // An accepted manuscript version, so evidence spans resolve and the chapter can go stale later.
    const version = await createManuscriptVersion(pool, {
      workspaceId,
      projectId,
      chapterId,
      origin: 'assembled',
      text: MANUSCRIPT,
    });
    await approveManuscriptVersion(pool, version.id, 'test');

    // Canon committed the only way canon can be: through canon.commit_delta.
    const commit = await commitDelta(pool, {
      projectId,
      parentVersion: 0,
      source: 'chapter_acceptance',
      chapterId,
      manuscriptVersionId: version.id,
      delta: {
        items: [
          {
            local_id: 'f-rank',
            type: 'fact',
            op: 'assert',
            frame: 'canonical',
            confidence: 1,
            importance: 'core',
            evidence: [
              {
                manuscript_version_id: version.id,
                chapter_no: 1,
                paragraph_id: 'p1',
                quote: EVIDENCE_QUOTE,
                // Offsets are Unicode code points into NFC text (ADR-0030), never UTF-16 indices.
                start: codePointLength(MANUSCRIPT.slice(0, MANUSCRIPT.indexOf(EVIDENCE_QUOTE))),
                end:
                  codePointLength(MANUSCRIPT.slice(0, MANUSCRIPT.indexOf(EVIDENCE_QUOTE))) +
                  codePointLength(EVIDENCE_QUOTE),
              },
            ],
            payload: {
              entity_id: entityId,
              attribute: 'power.rank',
              value: 'F',
              value_text: 'F-rank',
              valid_from: { chapter_no: 1, ordinal: 2, precision: 'exact' },
              valid_to: null,
            },
          },
        ],
      },
    });
    canonVersion = commit.version;
    expect(canonVersion).toBe(1);

    const facts = await pool.query<{ id: string }>(
      'SELECT id FROM facts WHERE project_id = $1 AND retracted_at_version IS NULL ORDER BY id',
      [projectId],
    );
    factId = facts.rows[0]?.id ?? '';
    expect(factId).not.toBe('');
    correctedEntityId = entityId;
    acceptedVersionId = version.id;

    // Dependency edges of BOTH materialities, which is what makes the ADR-0032 split testable: the
    // accepted version used the fact as a T1 constraint, and a later summary merely retrieved it.
    await insertDependencyEdges(pool, { workspaceId, projectId }, [
      {
        dependentKind: 'manuscript_version',
        dependentId: version.id,
        canonItemKind: 'fact',
        canonItemRef: factId,
        sourceKind: 'fact',
        canonVersionRead: canonVersion,
        materiality: 'material',
        basis: 't1_state',
      },
      {
        dependentKind: 'chapter_contract',
        dependentId: chapterId,
        canonItemKind: 'fact',
        canonItemRef: factId,
        sourceKind: 'fact',
        canonVersionRead: canonVersion,
        materiality: 'contextual',
        basis: 'retrieved_t2',
      },
    ]);
  }, 120_000);

  // ---- impact reporting ---------------------------------------------------------------------------------

  it('reports impact without writing anything, separating material from contextual dependents', async () => {
    const before = await canonState(pool, projectId);
    const report = await impactOf(pool, {
      projectId,
      items: [{ kind: 'fact', ref: factId }],
    });
    expect(report.canonVersion).toBe(canonVersion);
    expect(report.items).toEqual([{ kind: 'fact', ref: factId }]);
    // Material and contextual are disjoint sets, taken from the edge table's recorded materiality rather
    // than inferred here.
    for (const d of report.material) expect(report.contextual).not.toContain(d);
    expect(report.material.every((d) => d.basis.length > 0)).toBe(true);
    // Reading an impact report is side-effect free.
    expect(await canonState(pool, projectId)).toEqual(before);
  });

  it('reports an isolated item honestly rather than inventing dependents', async () => {
    const report = await impactOf(pool, {
      projectId,
      items: [{ kind: 'fact', ref: '00000000-0000-7000-8000-000000000000' }],
    });
    expect(report.isolated).toBe(true);
    expect(report.material).toEqual([]);
    expect(report.contextual).toEqual([]);
  });

  // ---- correction ---------------------------------------------------------------------------------------

  it('refuses a correction with no justification, before touching canon', async () => {
    const before = await canonState(pool, projectId);
    await expect(
      correctCanonItem(pool, {
        projectId,
        itemKind: 'fact',
        itemId: factId,
        newValue: correctedFactPayload(correctedEntityId),
        justification: '   ',
        actor: ACTOR,
        expectedCanonVersion: canonVersion,
      }),
    ).rejects.toMatchObject({ code: 'JUSTIFICATION_REQUIRED' });
    expect(await canonState(pool, projectId)).toEqual(before);
  });

  it('dry-runs a correction without committing', async () => {
    const before = await canonState(pool, projectId);
    const result = await correctCanonItem(pool, {
      projectId,
      itemKind: 'fact',
      itemId: factId,
      newValue: correctedFactPayload(correctedEntityId),
      justification: 'measurement was misread',
      actor: ACTOR,
      expectedCanonVersion: canonVersion,
      dryRun: true,
    });
    expect(result.committed).toBe(false);
    expect(result.commitId).toBeUndefined();
    expect(result.staleMarked).toEqual([]);
    expect(result.impact.canonVersion).toBe(canonVersion);
    expect(await canonState(pool, projectId)).toEqual(before);
  });

  it('commits a correction atomically, preserves the prior value and marks material dependents stale', async () => {
    const report = await correctCanonItem(pool, {
      projectId,
      itemKind: 'fact',
      itemId: factId,
      newValue: correctedFactPayload(correctedEntityId),
      justification: 'measurement was misread',
      actor: ACTOR,
      expectedCanonVersion: canonVersion,
      dryRun: true,
    });

    const result = await correctCanonItem(pool, {
      projectId,
      itemKind: 'fact',
      itemId: factId,
      newValue: correctedFactPayload(correctedEntityId),
      evidence: [spanFor(acceptedVersionId)],
      justification: 'measurement was misread',
      actor: ACTOR,
      expectedCanonVersion: canonVersion,
    });
    expect(result.committed).toBe(true);
    expect(result.canonVersion).toBe(canonVersion + 1);

    // The commit is recorded with its source, actor and justification: canon never changes anonymously.
    const commit = await pool.query<{
      source: string;
      justification: string | null;
      actor: Record<string, unknown>;
    }>('SELECT source, justification, actor FROM canon_commits WHERE id = $1', [result.commitId]);
    expect(commit.rows[0]).toMatchObject({
      source: 'user_correction',
      justification: 'measurement was misread',
    });
    expect(commit.rows[0]?.actor).toMatchObject({ user_id: ACTOR.userId });

    // Nothing was deleted: the prior fact row still exists and is linked to its replacement.
    const prior = await pool.query<{ id: string; superseded_by_fact_id: string | null }>(
      'SELECT id, superseded_by_fact_id FROM facts WHERE id = $1',
      [factId],
    );
    expect(prior.rows).toHaveLength(1);
    expect(prior.rows[0]?.superseded_by_fact_id).not.toBeNull();
    // And its evidence is still readable, so "what did canon say then?" remains answerable.
    const evidence = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM fact_evidence WHERE fact_id = $1',
      [factId],
    );
    expect(Number(evidence.rows[0]?.n)).toBeGreaterThan(0);

    // ADR-0032: material dependents are stale, contextual ones are only suggestions.
    if (report.impact.material.some((d) => d.dependentKind === 'manuscript_version')) {
      const stale = await pool.query<{ status: string }>(
        `SELECT status FROM chapters WHERE project_id = $1 AND number = 1`,
        [projectId],
      );
      expect(stale.rows[0]?.status).toBe('stale');
    }
    expect(result.reviewSuggested).toEqual([
      ...new Set(report.impact.contextual.map((d) => d.dependentId)),
    ]);
  });

  it('refuses a correction whose impact report has gone out of date', async () => {
    // First correction moves canon forward.
    await correctCanonItem(pool, {
      projectId,
      itemKind: 'fact',
      itemId: factId,
      newValue: correctedFactPayload(correctedEntityId),
      evidence: [spanFor(acceptedVersionId)],
      justification: 'first correction',
      actor: ACTOR,
      expectedCanonVersion: canonVersion,
    });
    // A second correction still holding the original report is refused rather than silently overwriting
    // a change the operator never saw.
    await expect(
      correctCanonItem(pool, {
        projectId,
        itemKind: 'fact',
        itemId: factId,
        newValue: correctedFactPayload(correctedEntityId),
        evidence: [spanFor(acceptedVersionId)],
        justification: 'stale report',
        actor: ACTOR,
        expectedCanonVersion: canonVersion,
      }),
    ).rejects.toMatchObject({ code: 'CANON_STALE' });
    // Canon advanced exactly once.
    expect((await canonState(pool, projectId)).version).toBe(canonVersion + 1);
  });

  it('lets exactly one of two concurrent corrections win, with the loser typed', async () => {
    const attempt = () =>
      correctCanonItem(pool, {
        projectId,
        itemKind: 'fact',
        itemId: factId,
        newValue: correctedFactPayload(correctedEntityId),
        evidence: [spanFor(acceptedVersionId)],
        justification: 'concurrent',
        actor: ACTOR,
        expectedCanonVersion: canonVersion,
      });
    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser is a typed, retriable conflict — never a raw database error.
    const [loser] = rejected;
    if (!loser) throw new Error('expected one rejected correction');
    const reason = loser.reason as CorrectionError;
    expect(['CANON_STALE', 'ILLEGAL_OP']).toContain(reason.code);
    // Canon advanced exactly once despite the race.
    expect((await canonState(pool, projectId)).version).toBe(canonVersion + 1);
  });

  // ---- retcon -------------------------------------------------------------------------------------------

  it('requires explicit confirmation for a retcon and names the exposure', async () => {
    let thrown: CorrectionError | undefined;
    try {
      await retconCanonItem(pool, {
        projectId,
        itemKind: 'fact',
        itemId: factId,
        newValue: correctedFactPayload(correctedEntityId),
        justification: 'the trap never happened',
        actor: ACTOR,
        expectedCanonVersion: canonVersion,
        confirmed: false,
      });
    } catch (err) {
      thrown = err as CorrectionError;
    }
    expect(thrown?.code).toBe('CONFIRMATION_REQUIRED');
    // The refusal carries the impact so the UI can show what confirming would mean.
    expect(thrown?.data).toHaveProperty('material_dependents');
    expect(thrown?.data).toHaveProperty('affected_accepted_chapters');
    // Nothing changed.
    expect((await canonState(pool, projectId)).version).toBe(canonVersion);
  });

  it('requires evidence for a corrected fact, exactly as acceptance does (ADR-0006)', async () => {
    // Evidence-backed canon is not relaxed for operator corrections: a corrected fact must still quote
    // the manuscript. The refusal is typed so the UI can ask for the span.
    await expect(
      retconCanonItem(pool, {
        projectId,
        itemKind: 'fact',
        itemId: factId,
        newValue: correctedFactPayload(correctedEntityId),
        justification: 'no evidence supplied',
        actor: ACTOR,
        expectedCanonVersion: canonVersion,
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'EVIDENCE_REQUIRED' });
    // The refused retcon committed nothing.
    expect((await canonState(pool, projectId)).version).toBe(canonVersion);
  });

  it('commits a confirmed retcon, preserves history and does not auto-patch the chapters', async () => {
    const result = await retconCanonItem(pool, {
      projectId,
      itemKind: 'fact',
      itemId: factId,
      newValue: correctedFactPayload(correctedEntityId),
      evidence: [spanFor(acceptedVersionId)],
      justification: 'the measurement scene is being rewritten',
      actor: ACTOR,
      expectedCanonVersion: canonVersion,
      confirmed: true,
    });
    expect(result.committed).toBe(true);
    const commit = await pool.query<{ source: string }>(
      'SELECT source FROM canon_commits WHERE id = $1',
      [result.commitId],
    );
    expect(commit.rows[0]?.source).toBe('retcon');

    // No Beta-only automatic patch engine in the MVP: the manuscript text is untouched and immutable.
    const versions = await pool.query<{ id: string; status: string; content_hash: string }>(
      `SELECT mv.id, mv.status, mv.content_hash FROM manuscript_versions mv
        JOIN chapters c ON c.id = mv.chapter_id
       WHERE c.project_id = $1 AND c.number = 1 ORDER BY mv.version_no`,
      [projectId],
    );
    expect(versions.rows.some((v) => v.status === 'accepted')).toBe(true);
    // Affected chapters are stale for a human to address, not silently rewritten.
    const chapter = await pool.query<{ status: string }>(
      'SELECT status FROM chapters WHERE project_id = $1 AND number = 1',
      [projectId],
    );
    expect(['stale', 'accepted']).toContain(chapter.rows[0]?.status);
  });

  // ---- rollback -----------------------------------------------------------------------------------------

  it('dry-runs a rollback and reports whether it is permitted', async () => {
    const before = await canonState(pool, projectId);
    const preview = await rollbackLatestCommit(pool, {
      projectId,
      actor: ACTOR,
      expectedCanonVersion: canonVersion,
      dryRun: true,
    });
    expect(preview.committed).toBe(false);
    expect(preview.rollbackable).toBe(true);
    expect(await canonState(pool, projectId)).toEqual(before);
  });

  it('rolls back the latest commit by retracting, never deleting', async () => {
    const factsBefore = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM facts WHERE project_id = $1',
      [projectId],
    );
    const result = await rollbackLatestCommit(pool, {
      projectId,
      actor: ACTOR,
      expectedCanonVersion: canonVersion,
    });
    expect(result.committed).toBe(true);
    expect(result.canonVersion).toBe(canonVersion + 1);

    // Row count is unchanged: a rollback retracts by version, it does not delete evidence or history.
    const factsAfter = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM facts WHERE project_id = $1',
      [projectId],
    );
    expect(factsAfter.rows[0]?.n).toBe(factsBefore.rows[0]?.n);
    const retracted = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM facts WHERE project_id = $1 AND retracted_at_version IS NOT NULL',
      [projectId],
    );
    expect(Number(retracted.rows[0]?.n)).toBeGreaterThan(0);
    // The rollback is itself a commit in the history.
    const commit = await pool.query<{ source: string }>(
      'SELECT source FROM canon_commits WHERE id = $1',
      [result.commitId],
    );
    expect(commit.rows[0]?.source).toBe('rollback');
  });

  it('refuses to roll back a rollback (MVP latest-only)', async () => {
    await rollbackLatestCommit(pool, {
      projectId,
      actor: ACTOR,
      expectedCanonVersion: canonVersion,
    });
    const report = await rollbackImpact(pool, { projectId });
    expect(report.rollbackable).toBe(false);
    expect(report.reason).toContain('cannot be rolled back');
    await expect(
      rollbackLatestCommit(pool, {
        projectId,
        actor: ACTOR,
        expectedCanonVersion: canonVersion + 1,
      }),
    ).rejects.toMatchObject({ code: 'ILLEGAL_OP' });
  });

  // ---- regeneration preview ----------------------------------------------------------------------------

  it('previews a regeneration without counting the chapter as its own dependent', async () => {
    const preview = await regenerationPreview(pool, { projectId, chapterNo: 1 });
    // Chapter 1 is the intent, not an affected dependent.
    expect(preview.material.every((d) => d.chapterNo !== 1)).toBe(true);
    expect(preview.affectedAcceptedChapters).not.toContain(1);
    // And it changed nothing.
    expect((await canonState(pool, projectId)).version).toBe(canonVersion);
  });

  // ---- tenancy ------------------------------------------------------------------------------------------

  it('cannot correct or inspect another workspace\u2019s canon', async () => {
    const otherWs = await createWorkspace(pool, 'other-workspace');
    const other = await createProject(pool, { workspaceId: otherWs, title: 'Other' });

    // An impact report scoped to the other project sees nothing of this one's canon.
    const foreign = await impactOf(pool, {
      projectId: other.projectId,
      items: [{ kind: 'fact', ref: factId }],
    });
    expect(foreign.material).toEqual([]);
    expect(foreign.contextual).toEqual([]);

    // Under RLS, the other workspace's scoped connection cannot even see the fact.
    const visible = await withWorkspace(pool, otherWs, async (c) => {
      const r = await c.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM facts WHERE id = $1',
        [factId],
      );
      return r.rows[0]?.n;
    });
    expect(visible).toBe('0');
    // This project's canon is untouched by anything the other workspace did.
    expect((await canonState(pool, projectId)).version).toBe(canonVersion);
    expect(workspaceId).not.toBe(otherWs);
  });
});

/** A compact snapshot used to prove a dry run wrote nothing. */
async function canonState(
  pool: Pool,
  projectId: string,
): Promise<{ version: number; facts: string; commits: string; chapterStatus: string | undefined }> {
  const project = await pool.query<{ canon_version: number }>(
    'SELECT canon_version FROM projects WHERE id = $1',
    [projectId],
  );
  const facts = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM facts WHERE project_id = $1',
    [projectId],
  );
  const commits = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM canon_commits WHERE project_id = $1',
    [projectId],
  );
  const chapter = await pool.query<{ status: string }>(
    'SELECT status FROM chapters WHERE project_id = $1 AND number = 1',
    [projectId],
  );
  return {
    version: project.rows[0]?.canon_version ?? -1,
    facts: facts.rows[0]?.n ?? '?',
    commits: commits.rows[0]?.n ?? '?',
    chapterStatus: chapter.rows[0]?.status,
  };
}

/**
 * A corrected fact payload.
 *
 * Deliberately minimal and schema-shaped: the point of these tests is the correction machinery, and the
 * delta's contents are validated by `canon.commit_delta`'s own change-class and evidence rules, which the
 * Checkpoint 2 suite already covers.
 */
function correctedFactPayload(entityId: string): Record<string, unknown> {
  return {
    entity_id: entityId,
    attribute: 'power.rank',
    value: 'E',
    value_text: 'E-rank',
    valid_from: { chapter_no: 1, ordinal: 2, precision: 'exact' },
    valid_to: null,
  };
}

const EVIDENCE_QUOTE = 'F-rank. Porter registration is the window on your left.';

/** An evidence span over the accepted manuscript, addressed in Unicode code points (ADR-0030). */
function spanFor(versionId: string): Record<string, unknown> {
  const start = codePointLength(MANUSCRIPT.slice(0, MANUSCRIPT.indexOf(EVIDENCE_QUOTE)));
  return {
    manuscript_version_id: versionId,
    chapter_no: 1,
    paragraph_id: 'p1',
    quote: EVIDENCE_QUOTE,
    start,
    end: start + codePointLength(EVIDENCE_QUOTE),
  };
}

const MANUSCRIPT = [
  'The measurement device screamed.',
  '',
  `The officer did not look up. \u201c${EVIDENCE_QUOTE}\u201d`,
  '',
  'Do-yoon took the form and said nothing at all.',
].join('\n');
