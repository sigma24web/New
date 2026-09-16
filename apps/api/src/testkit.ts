/**
 * API integration-test fixtures (Checkpoint 7).
 *
 * `seedAcceptedChapterOne` produces a genuinely accepted chapter by running the Checkpoint 5 production
 * workflow over the frozen chapter-1 replay fixture. It deliberately does NOT insert an accepted row
 * directly: an export test that hand-wrote `status = 'accepted'` would prove the renderer works while
 * saying nothing about whether the accepted-only gate holds. Running the real acceptance path means the
 * export is reading exactly what production acceptance produced.
 *
 * All model calls are replayed from `examples/fixture/ch01` — no credentials, no live provider, no spend.
 */
import type { Pool } from '@yeonjae/db';
import { produceChapter } from '@yeonjae/workflows';
import { createHarness } from '@yeonjae/workflows/testkit';

export interface SeededProject {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly mainTimelineId: string;
  readonly acceptedVersionId: string;
  readonly acceptedCanonVersion: number;
}

/** Run the fixture chapter 1 through to acceptance and return its ids. */
export async function seedAcceptedChapterOne(pool: Pool): Promise<SeededProject> {
  const harness = await createHarness(pool);
  const result = await produceChapter(
    { pool, gateway: harness.gateway(), bindings: harness.bindings },
    harness.input(1),
  );
  if (!result.accepted)
    throw new Error(
      `fixture chapter 1 did not reach acceptance (status ${result.status}); the export fixture requires it`,
    );
  return {
    workspaceId: harness.workspaceId,
    projectId: harness.projectId,
    mainTimelineId: harness.mainTimelineId,
    acceptedVersionId: result.accepted.manuscript_version_id,
    acceptedCanonVersion: result.accepted.canon_version,
  };
}

/**
 * Ensure a chapter-2 row exists on a seeded project, for tests that plant working / rejected / losing
 * drafts there. Chapter 2 is deliberately left WITHOUT an accepted version: that is the condition the
 * accepted-only export has to respect.
 */
export async function ensureChapterTwo(pool: Pool, seeded: SeededProject): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    'SELECT id FROM chapters WHERE project_id = $1 AND number = 2',
    [seeded.projectId],
  );
  const found = existing.rows[0]?.id;
  if (found) return found;
  const created = await pool.query<{ id: string }>(
    `INSERT INTO chapters (workspace_id, project_id, number, status)
     VALUES ($1, $2, 2, 'planned') RETURNING id`,
    [seeded.workspaceId, seeded.projectId],
  );
  const id = created.rows[0]?.id;
  if (!id) throw new Error('could not create the chapter-2 fixture row');
  return id;
}
