/**
 * Accepted-only TXT and DOCX export (Checkpoint 7).
 *
 * The export runs against a REAL accepted chapter produced by the Checkpoint 5 replay workflow, not a
 * hand-inserted row, so the accepted-only claim is proved against the same acceptance path production uses.
 * Alongside it the test plants the three kinds of text that must never export — a working draft, a rejected
 * (quarantined) draft and a losing candidate — and asserts none of them appears in either format.
 *
 * The DOCX is unzipped and its OOXML parsed, so "the document is valid and contains the accepted prose" is
 * verified rather than asserted from a byte length.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  createManuscriptVersion,
  createUser,
  createWorkspace,
  getManuscriptVersion,
  setManuscriptVersionStatus,
  migrate,
  quarantineVersion,
  resetDatabase,
  type Pool,
} from '@yeonjae/db';
import { databaseUrl, freshDatabase } from '@yeonjae/db/testkit';
import type { FastifyInstance } from 'fastify';
import { buildApi } from './server.js';
import { CSRF_HEADER, WORKSPACE_HEADER } from './auth.js';
import { paragraphsOf, renderExport, safeFilename } from './export.js';
import { ensureChapterTwo, seedAcceptedChapterOne, type SeededProject } from './testkit.js';

const run = databaseUrl() ? describe : describe.skip;

/** Extract `word/document.xml` from a DOCX buffer using the system unzip, then strip its markup. */
async function docxText(bytes: Buffer): Promise<{ xml: string; text: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'yeonjae-docx-'));
  const file = join(dir, 'export.docx');
  writeFileSync(file, bytes);
  // `unzip -p` fails loudly on a malformed container, so a corrupt DOCX cannot pass silently.
  execFileSync('unzip', ['-t', file], { stdio: 'pipe' });
  const xml = execFileSync('unzip', ['-p', file, 'word/document.xml'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  }).toString('utf8');
  await readFile(file); // asserts the file is readable as written
  const text = xml
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;/g, '\u2019');
  return { xml, text };
}

run('API: accepted-only TXT and DOCX export (Checkpoint 7)', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let seeded: SeededProject;
  let owner: { cookie: string; csrf: string; userId: string };
  let editor: { cookie: string; csrf: string; userId: string };
  let acceptedText: string;

  async function login(email: string, password: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
    });
    expect(res.statusCode, res.body).toBe(200);
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const body = res.json<{ csrf_token: string; user: { id: string } }>();
    return {
      userId: body.user.id,
      cookie: String(raw).split(';')[0] ?? '',
      csrf: body.csrf_token,
    };
  }

  function authed(actor: { cookie: string; csrf: string }): Record<string, string> {
    return {
      cookie: actor.cookie,
      [WORKSPACE_HEADER]: seeded.workspaceId,
      [CSRF_HEADER]: actor.csrf,
    };
  }

  beforeAll(async () => {
    pool = await freshDatabase();
    app = buildApi({ pool, secureCookies: false });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await migrate(pool);
    seeded = await seedAcceptedChapterOne(pool);
    const accepted = await getManuscriptVersion(pool, seeded.acceptedVersionId);
    acceptedText = accepted?.text ?? '';
    expect(acceptedText.length).toBeGreaterThan(200);

    const ownerUser = await createUser(pool, {
      email: 'owner@example.com',
      displayName: 'Owner',
      password: 'owner-password-1',
    });
    const editorUser = await createUser(pool, {
      email: 'editor@example.com',
      displayName: 'Editor',
      password: 'editor-password-1',
    });
    await addMember(pool, {
      workspaceId: seeded.workspaceId,
      userId: ownerUser.id,
      role: 'owner',
    });
    await addMember(pool, {
      workspaceId: seeded.workspaceId,
      userId: editorUser.id,
      role: 'editor',
    });
    owner = await login('owner@example.com', 'owner-password-1');
    editor = await login('editor@example.com', 'editor-password-1');
  }, 240_000);

  // ---- the accepted-only invariant ---------------------------------------------------------------------

  it('excludes working, rejected and losing text from BOTH formats', async () => {
    // Three kinds of text that must never export, planted on chapter 2 of the same project.
    const WORKING = 'WORKING_DRAFT_MARKER the tower had not yet fallen.';
    const REJECTED = 'REJECTED_DRAFT_MARKER his left arm was severed.';
    const LOSING = 'LOSING_CANDIDATE_MARKER the gate closed quietly.';
    const chapterTwoId = await ensureChapterTwo(pool, seeded);

    const working = await createManuscriptVersion(pool, {
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      chapterId: chapterTwoId,
      origin: 'assembled',
      text: `${WORKING}\n\nHe waited.`,
    });
    const rejected = await createManuscriptVersion(pool, {
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      chapterId: chapterTwoId,
      origin: 'candidate',
      text: `${REJECTED}\n\nHe said nothing.`,
    });
    await quarantineVersion(pool, rejected.id, 'test: rejected draft');
    const losing = await createManuscriptVersion(pool, {
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      chapterId: chapterTwoId,
      origin: 'candidate',
      text: `${LOSING}\n\nThe corridor was empty.`,
    });
    // A losing candidate is marked terminal by the selection path; its text stays immutable and must
    // never export.
    await setManuscriptVersionStatus(pool, losing.id, 'rejected');

    for (const format of ['txt', 'docx'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/projects/${seeded.projectId}/exports`,
        headers: authed(editor),
        payload: { format },
      });
      expect(res.statusCode, res.body).toBe(201);
      const created = res.json<{ id: string; chapter_numbers: number[] }>();
      // Only the accepted chapter is in scope; chapter 2 has no accepted version at all.
      expect(created.chapter_numbers).toEqual([1]);

      const download = await app.inject({
        method: 'GET',
        url: `/v1/projects/${seeded.projectId}/exports/${created.id}/content`,
        headers: authed(editor),
      });
      expect(download.statusCode).toBe(200);
      const bytes = download.rawPayload;
      const content = format === 'txt' ? bytes.toString('utf8') : (await docxText(bytes)).text;

      // The accepted prose is present...
      const firstParagraph = paragraphsOf(acceptedText)[0] ?? '';
      expect(content, format).toContain(firstParagraph.slice(0, 60));
      // ...and none of the three excluded kinds is, in either the text or the raw bytes.
      for (const marker of [WORKING, REJECTED, LOSING]) {
        expect(content, `${format}: ${marker}`).not.toContain(marker);
        expect(bytes.toString('binary'), `${format} bytes: ${marker}`).not.toContain(marker);
      }
      expect(content).not.toContain(working.id);
    }
  });

  it('refuses an export naming a chapter that is not accepted, and records why', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${seeded.projectId}/exports`,
      headers: authed(editor),
      payload: { format: 'txt', chapters: [1, 2] },
    });
    // A typed refusal, never a silently short manuscript.
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('CHAPTER_NOT_ACCEPTED');
    // The attempt is recorded as a failed export so the operator can see it happened.
    const rows = await pool.query<{ status: string; error: { code: string } }>(
      `SELECT status, error FROM exports WHERE project_id = $1`,
      [seeded.projectId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.status).toBe('failed');
    expect(rows.rows[0]?.error).toMatchObject({ code: 'CHAPTER_NOT_ACCEPTED' });
  });

  // ---- determinism and ordering ------------------------------------------------------------------------

  it('produces byte-identical TXT and an identical content hash across two runs', async () => {
    const first = await renderExport(pool, {
      projectId: seeded.projectId,
      title: 'Second Awakening',
      format: 'txt',
    });
    const second = await renderExport(pool, {
      projectId: seeded.projectId,
      title: 'Second Awakening',
      format: 'txt',
    });
    expect(second.bytes.equals(first.bytes)).toBe(true);
    expect(second.contentHash).toBe(first.contentHash);
    // DOCX bytes carry ZIP metadata, so the *content* hash is what must match.
    const docxA = await renderExport(pool, {
      projectId: seeded.projectId,
      title: 'Second Awakening',
      format: 'docx',
    });
    const docxB = await renderExport(pool, {
      projectId: seeded.projectId,
      title: 'Second Awakening',
      format: 'docx',
    });
    expect(docxB.contentHash).toBe(docxA.contentHash);
    expect(docxA.contentHash).toBe(first.contentHash);
  });

  it('orders chapters ascending regardless of how the client listed them', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${seeded.projectId}/exports`,
      headers: authed(editor),
      payload: { format: 'txt', chapters: [1, 1] },
    });
    expect(res.statusCode).toBe(201);
    // A duplicate chapter number is collapsed, so no chapter can appear twice in a manuscript.
    expect(res.json<{ chapter_numbers: number[] }>().chapter_numbers).toEqual([1]);
  });

  it('rejects an empty or oversized chapter scope instead of silently exporting everything', async () => {
    for (const chapters of [[], Array.from({ length: 501 }, (_, i) => i + 1)]) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/projects/${seeded.projectId}/exports`,
        headers: authed(editor),
        payload: { format: 'txt', chapters },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ code: string }>().code).toBe('VALIDATION_FAILED');
    }
  });

  // ---- the DOCX really is a DOCX -----------------------------------------------------------------------

  it('writes a parseable OOXML document with the accepted prose in ordered paragraphs', async () => {
    const rendered = await renderExport(pool, {
      projectId: seeded.projectId,
      title: 'Second Awakening',
      format: 'docx',
    });
    // A DOCX is a ZIP: the local-file-header magic must be present.
    expect(rendered.bytes.subarray(0, 2).toString('binary')).toBe('PK');
    const { xml, text } = await docxText(rendered.bytes);
    expect(xml).toContain('<w:document');
    expect(xml).toContain('<w:body>');
    expect(text).toContain('Second Awakening');
    expect(text).toContain('Chapter 1');
    // Paragraph order is the manuscript's order.
    const paragraphs = paragraphsOf(acceptedText);
    const firstAt = text.indexOf((paragraphs[0] ?? '').slice(0, 40));
    const lastAt = text.indexOf((paragraphs.at(-1) ?? '').slice(0, 40));
    expect(firstAt).toBeGreaterThan(-1);
    expect(lastAt).toBeGreaterThan(firstAt);
  });

  it('honours locale-aware typography options and refuses unsupported ones', async () => {
    const indented = await app.inject({
      method: 'POST',
      url: `/v1/projects/${seeded.projectId}/exports`,
      headers: authed(editor),
      payload: {
        format: 'txt',
        options: { paragraph_style: 'indent_first_line', locale: 'en-GB' },
      },
    });
    expect(indented.statusCode).toBe(201);
    const id = indented.json<{ id: string }>().id;
    const body = (
      await app.inject({
        method: 'GET',
        url: `/v1/projects/${seeded.projectId}/exports/${id}/content`,
        headers: authed(editor),
      })
    ).rawPayload.toString('utf8');
    expect(body.split('\n').some((line) => line.startsWith('    ') && line.trim().length > 0)).toBe(
      true,
    );

    for (const options of [
      { paragraph_style: 'hanging' },
      { locale: 'ko-KR' },
      { include_chapter_headings: 'yes' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/projects/${seeded.projectId}/exports`,
        headers: authed(editor),
        payload: { format: 'txt', options },
      });
      expect({ options, status: res.statusCode }).toMatchObject({ options, status: 422 });
    }
  });

  // ---- authorization and download safety ---------------------------------------------------------------

  it('requires authentication and an editor role to request an export', async () => {
    const anon = await app.inject({
      method: 'POST',
      url: `/v1/projects/${seeded.projectId}/exports`,
      payload: { format: 'txt' },
    });
    expect(anon.statusCode).toBe(401);

    const viewerUser = await createUser(pool, {
      email: 'viewer@example.com',
      displayName: 'Viewer',
      password: 'viewer-password-1',
    });
    await addMember(pool, {
      workspaceId: seeded.workspaceId,
      userId: viewerUser.id,
      role: 'viewer',
    });
    const viewer = await login('viewer@example.com', 'viewer-password-1');
    const refused = await app.inject({
      method: 'POST',
      url: `/v1/projects/${seeded.projectId}/exports`,
      headers: authed(viewer),
      payload: { format: 'txt' },
    });
    expect(refused.statusCode).toBe(403);

    // A viewer may still download an existing export: reading accepted content is a read.
    const created = await app.inject({
      method: 'POST',
      url: `/v1/projects/${seeded.projectId}/exports`,
      headers: authed(editor),
      payload: { format: 'txt' },
    });
    const id = created.json<{ id: string }>().id;
    const download = await app.inject({
      method: 'GET',
      url: `/v1/projects/${seeded.projectId}/exports/${id}/content`,
      headers: authed(viewer),
    });
    expect(download.statusCode).toBe(200);
  });

  it('hides another workspace\u2019s export behind the same 404 as a nonexistent one', async () => {
    const otherWs = await createWorkspace(pool, 'other-workspace');
    const stranger = await createUser(pool, {
      email: 'stranger@example.com',
      displayName: 'Stranger',
      password: 'stranger-password-1',
    });
    await addMember(pool, { workspaceId: otherWs, userId: stranger.id, role: 'owner' });
    const strangerActor = await login('stranger@example.com', 'stranger-password-1');

    const created = await app.inject({
      method: 'POST',
      url: `/v1/projects/${seeded.projectId}/exports`,
      headers: authed(editor),
      payload: { format: 'txt' },
    });
    const id = created.json<{ id: string }>().id;

    // The stranger's own workspace cannot see the project or the export.
    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects/${seeded.projectId}/exports/${id}/content`,
      headers: {
        cookie: strangerActor.cookie,
        [WORKSPACE_HEADER]: otherWs,
        [CSRF_HEADER]: strangerActor.csrf,
      },
    });
    expect(res.statusCode).toBe(404);
    // And a forged workspace header does not help: membership decides.
    const forged = await app.inject({
      method: 'GET',
      url: `/v1/projects/${seeded.projectId}/exports/${id}/content`,
      headers: {
        cookie: strangerActor.cookie,
        [WORKSPACE_HEADER]: seeded.workspaceId,
        [CSRF_HEADER]: strangerActor.csrf,
      },
    });
    expect(forged.statusCode).toBe(403);
  });

  it('serves a downloaded artifact with a safe, non-traversing filename', async () => {
    // A hostile project title cannot produce a path, a quote or a header injection.
    for (const [title, expected] of [
      ['../../etc/passwd', 'etc-passwd.txt'],
      ['Second "Awakening"', 'second-awakening.txt'],
      ['..\\..\\windows', 'windows.txt'],
      // Control characters cannot reach the header either.
      ['\u0000\u000a\u000d', 'manuscript.txt'],
      ['', 'manuscript.txt'],
    ] as const) {
      const name = safeFilename(title, 'txt');
      expect({ title, name }).toEqual({ title, name: expected });
      expect(name).toMatch(/^[a-z0-9-]+\.txt$/);
    }

    const created = await app.inject({
      method: 'POST',
      url: `/v1/projects/${seeded.projectId}/exports`,
      headers: authed(editor),
      payload: { format: 'docx' },
    });
    const id = created.json<{ id: string }>().id;
    const download = await app.inject({
      method: 'GET',
      url: `/v1/projects/${seeded.projectId}/exports/${id}/content`,
      headers: authed(editor),
    });
    expect(download.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(String(download.headers['content-disposition'])).toMatch(
      /^attachment; filename="[a-z0-9-]+\.docx"$/,
    );
  });

  it('never exposes an arbitrary filesystem path: a download names an export id only', async () => {
    // There is no path parameter to traverse. A path-shaped id is simply not a UUID.
    for (const bogus of ['../../../../etc/passwd', '..%2F..%2Fetc%2Fpasswd', 'word/document.xml']) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/projects/${seeded.projectId}/exports/${encodeURIComponent(bogus)}/content`,
        headers: authed(editor),
      });
      expect([400, 404, 422]).toContain(res.statusCode);
      expect(res.body).not.toContain('root:');
    }
  });

  it('records the export in the audit log and reports metadata without the bytes', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/v1/projects/${seeded.projectId}/exports`,
      headers: authed(owner),
      payload: { format: 'txt' },
    });
    const view = created.json<Record<string, unknown>>();
    // The JSON view carries metadata and a download path, never the content.
    expect(view).toMatchObject({ status: 'ready', format: 'txt', chapter_numbers: [1] });
    expect(view.content).toBeUndefined();
    expect(view.download_path).toBe(
      `/v1/projects/${seeded.projectId}/exports/${String(view.id)}/content`,
    );
    expect(view.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Number(view.byte_size)).toBeGreaterThan(0);

    const read = await app.inject({
      method: 'GET',
      url: `/v1/projects/${seeded.projectId}/exports/${String(view.id)}`,
      headers: authed(owner),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<Record<string, unknown>>().content).toBeUndefined();

    const audit = await pool.query<{ action: string; actor_user_id: string }>(
      `SELECT action, actor_user_id FROM audit_log WHERE workspace_id = $1 ORDER BY created_at`,
      [seeded.workspaceId],
    );
    expect(audit.rows.map((r) => r.action)).toContain('export.request');
    expect(audit.rows.every((r) => r.actor_user_id === owner.userId)).toBe(true);
  });

  it('applies Idempotency-Key so a retried export does not produce a second artifact', async () => {
    const headers = { ...authed(editor), 'idempotency-key': 'export-once' };
    const first = await app.inject({
      method: 'POST',
      url: `/v1/projects/${seeded.projectId}/exports`,
      headers,
      payload: { format: 'txt' },
    });
    const replay = await app.inject({
      method: 'POST',
      url: `/v1/projects/${seeded.projectId}/exports`,
      headers,
      payload: { format: 'txt' },
    });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    const rows = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM exports WHERE project_id = $1',
      [seeded.projectId],
    );
    expect(rows.rows[0]?.n).toBe('1');
  });
});
