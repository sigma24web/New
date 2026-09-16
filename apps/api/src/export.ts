/**
 * Accepted-only TXT and DOCX export (Checkpoint 7; migration 0006's `exports` table).
 *
 * The accepted-only rule is NOT re-implemented here. `exportAccepted` (Checkpoint 5) resolves every chapter
 * through `acceptedChapter`, which requires `chapters.status = 'accepted'` AND an `accepted_version_id`
 * whose manuscript row is itself `accepted` with an `accepted_commit_id`. A working draft, a merely
 * approved draft, a rejected draft in `quarantine_versions` and a losing candidate all fail that gate. This
 * module renders what that service returns; adding a second, weaker accepted-only check here is exactly the
 * duplicate enforcement path the architecture forbids.
 *
 * Two further rules shape the rendering:
 *
 *  * ARTIFACTS LIVE IN THE DATABASE. The bytes are stored in `exports.content`, and a download names an
 *    export id. There is no filesystem path in the request at any point, so path traversal is not mitigated
 *    — it is absent by construction.
 *  * OUTPUT IS DETERMINISTIC WHERE THE FORMAT ALLOWS IT. TXT is byte-identical for identical input. DOCX is
 *    a ZIP container, so its bytes carry entry timestamps; the document's text content is deterministic and
 *    that is what is hashed and asserted.
 */
import { createHash } from 'node:crypto';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import { exportAccepted, type ExportResult } from '@yeonjae/workflows';
import type { Client, Pool } from '@yeonjae/db';
import { ApiError } from './problem.js';

export type ExportFormat = 'txt' | 'docx';

export interface ExportTypography {
  /**
   * Paragraph shape for the manuscript body. Korean-webnovel serialization on mobile favours short
   * paragraphs separated by blank lines over Western first-line indentation, so `blank_line` is the
   * default; `indent_first_line` exists for print-style output.
   */
  readonly paragraphStyle: 'blank_line' | 'indent_first_line';
  /** BCP 47 locale for the document's language metadata. English is the manuscript language (ADR-0026). */
  readonly locale: string;
  readonly includeChapterHeadings: boolean;
}

export const DEFAULT_TYPOGRAPHY: ExportTypography = {
  paragraphStyle: 'blank_line',
  locale: 'en-US',
  includeChapterHeadings: true,
};

/** Locales the MVP renders. The manuscript itself is always English; this is document metadata only. */
const SUPPORTED_LOCALES = ['en-US', 'en-GB'] as const;

function isSupportedLocale(value: unknown): value is (typeof SUPPORTED_LOCALES)[number] {
  return (SUPPORTED_LOCALES as readonly unknown[]).includes(value);
}

export function parseTypography(options: Record<string, unknown> | undefined): ExportTypography {
  if (!options) return DEFAULT_TYPOGRAPHY;
  const style: unknown = options.paragraph_style;
  const locale: unknown = options.locale;
  const headings: unknown = options.include_chapter_headings;
  if (style !== undefined && style !== 'blank_line' && style !== 'indent_first_line')
    throw new ApiError('VALIDATION_FAILED', 'options.paragraph_style is not a supported value.', {
      errors: [{ path: 'body.options.paragraph_style', message: 'blank_line | indent_first_line' }],
    });
  if (locale !== undefined && !isSupportedLocale(locale))
    throw new ApiError('VALIDATION_FAILED', 'options.locale is not a supported locale.', {
      errors: [{ path: 'body.options.locale', message: SUPPORTED_LOCALES.join(' | ') }],
    });
  if (headings !== undefined && typeof headings !== 'boolean')
    throw new ApiError('VALIDATION_FAILED', 'options.include_chapter_headings must be a boolean.', {
      errors: [{ path: 'body.options.include_chapter_headings', message: 'must be a boolean' }],
    });
  return {
    // The guards above narrowed each value to its literal union (or undefined), so the defaults apply
    // without a type assertion.
    paragraphStyle: style ?? DEFAULT_TYPOGRAPHY.paragraphStyle,
    locale: locale ?? DEFAULT_TYPOGRAPHY.locale,
    includeChapterHeadings: headings ?? DEFAULT_TYPOGRAPHY.includeChapterHeadings,
  };
}

/** Split manuscript text into paragraphs on blank lines, preserving order and dropping nothing. */
export function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+$/g, '').replace(/^\s+/g, ''))
    .filter((p) => p.length > 0);
}

export interface RenderedExport {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly filename: string;
  /** Hash of the deterministic *text* content, so DOCX container nondeterminism cannot mask a change. */
  readonly contentHash: string;
  readonly chapterNumbers: readonly number[];
  readonly canonVersion: number;
}

/**
 * A filename safe for `Content-Disposition`. Only ASCII word characters, hyphen and underscore survive, so
 * no quote, newline, path separator or directory traversal fragment can reach the header.
 */
export function safeFilename(title: string, format: ExportFormat): string {
  const slug =
    title
      .normalize('NFC')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .toLowerCase() || 'manuscript';
  return `${slug}.${format}`;
}

/** The plain-text artifact: deterministic, NFC, LF-terminated. */
export function renderTxt(
  result: ExportResult,
  input: { title: string; typography: ExportTypography },
): string {
  const lines: string[] = [input.title.normalize('NFC'), ''];
  for (const chapter of result.chapters) {
    if (input.typography.includeChapterHeadings) lines.push(`Chapter ${chapter.chapter_no}`, '');
    for (const paragraph of paragraphsOf(chapterTextOf(result, chapter.chapter_no))) {
      lines.push(
        input.typography.paragraphStyle === 'indent_first_line' ? `    ${paragraph}` : paragraph,
        '',
      );
    }
  }
  // A single trailing newline: no accumulated blank lines, so two runs of the same input match byte for byte.
  return `${lines.join('\n').replace(/\n+$/, '')}\n`.normalize('NFC');
}

/**
 * Pull one chapter's accepted text back out of the service result.
 *
 * `exportAccepted` returns the assembled document plus per-chapter metadata. Splitting on its own heading
 * markers keeps this module from issuing a second, unscoped manuscript query — which would be a way to read
 * a version the accepted-only gate had refused.
 */
function chapterTextOf(result: ExportResult, chapterNo: number): string {
  const marker = result.format === 'markdown' ? `## Chapter ${chapterNo}` : `Chapter ${chapterNo}`;
  const start = result.text.indexOf(marker);
  if (start < 0) return '';
  const after = start + marker.length;
  const nextIndex = result.chapters
    .map((c) => c.chapter_no)
    .filter((n) => n > chapterNo)
    .map((n) =>
      result.text.indexOf(result.format === 'markdown' ? `## Chapter ${n}` : `Chapter ${n}`, after),
    )
    .filter((i) => i > 0)
    .sort((a, b) => a - b)[0];
  return result.text.slice(after, nextIndex ?? result.text.length).trim();
}

/** The DOCX artifact, via a standards-compliant OOXML writer (never a hand-rolled ZIP). */
export async function renderDocx(
  result: ExportResult,
  input: { title: string; typography: ExportTypography },
): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      text: input.title.normalize('NFC'),
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }),
  ];
  for (const chapter of result.chapters) {
    if (input.typography.includeChapterHeadings)
      children.push(
        new Paragraph({ text: `Chapter ${chapter.chapter_no}`, heading: HeadingLevel.HEADING_1 }),
      );
    for (const paragraph of paragraphsOf(chapterTextOf(result, chapter.chapter_no)))
      children.push(
        new Paragraph({
          children: [new TextRun({ text: paragraph })],
          ...(input.typography.paragraphStyle === 'indent_first_line'
            ? { indent: { firstLine: 480 } }
            : { spacing: { after: 200 } }),
        }),
      );
  }
  return Packer.toBuffer(
    new Document({
      creator: 'Yeonjae Studio',
      title: input.title,
      description: `Accepted manuscript export (canon version ${canonVersionOf(result)})`,
      sections: [{ children }],
    }),
  ).then((bytes) => Buffer.from(bytes));
}

function canonVersionOf(result: ExportResult): number {
  return result.chapters.reduce((max, c) => Math.max(max, c.canon_version), 0);
}

export const CONTENT_TYPES: Readonly<Record<ExportFormat, string>> = {
  txt: 'text/plain; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * Render an accepted-only artifact. `chapters` narrows the scope; omitting it exports every accepted
 * chapter in ascending order. A requested chapter that is not accepted fails with the service's own
 * `CHAPTER_NOT_ACCEPTED` rather than being silently skipped, so an export can never be quietly short.
 */
export async function renderExport(
  pool: Pool,
  input: {
    projectId: string;
    title: string;
    format: ExportFormat;
    chapters?: readonly number[] | undefined;
    typography?: ExportTypography | undefined;
  },
): Promise<RenderedExport> {
  const typography = input.typography ?? DEFAULT_TYPOGRAPHY;
  const result = await exportAccepted(pool, {
    projectId: input.projectId,
    format: 'text',
    title: input.title,
    ...(input.chapters ? { chapters: input.chapters } : {}),
  });
  const text = renderTxt(result, { title: input.title, typography });
  const bytes =
    input.format === 'txt'
      ? Buffer.from(text, 'utf8')
      : await renderDocx(result, { title: input.title, typography });
  return {
    bytes,
    contentType: CONTENT_TYPES[input.format],
    filename: safeFilename(input.title, input.format),
    // Hash the canonical text for both formats: it is the content that must be reproducible.
    contentHash: `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`,
    chapterNumbers: result.chapters.map((c) => c.chapter_no),
    canonVersion: canonVersionOf(result),
  };
}

export interface ExportRow {
  id: string;
  project_id: string;
  format: ExportFormat;
  status: 'pending' | 'ready' | 'failed';
  canon_version: number | null;
  chapter_numbers: number[];
  content_hash: string | null;
  byte_size: number | null;
  error: Record<string, unknown> | null;
  created_at: Date;
  completed_at: Date | null;
}

/** Persist a completed export inside the caller's RLS scope. The bytes never leave the database. */
export async function persistExport(
  c: Client,
  input: {
    workspaceId: string;
    projectId: string;
    requestedBy: string;
    format: ExportFormat;
    scope: Record<string, unknown>;
    options: Record<string, unknown>;
    rendered: RenderedExport;
  },
): Promise<ExportRow> {
  const r = await c.query<ExportRow>(
    `INSERT INTO exports (workspace_id, project_id, requested_by, format, scope, options, status,
                          canon_version, chapter_numbers, content_hash, byte_size, content, completed_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'ready', $7, $8, $9, $10, $11, now())
     RETURNING id, project_id, format, status, canon_version, chapter_numbers, content_hash, byte_size,
               error, created_at, completed_at`,
    [
      input.workspaceId,
      input.projectId,
      input.requestedBy,
      input.format,
      JSON.stringify(input.scope),
      JSON.stringify(input.options),
      input.rendered.canonVersion,
      input.rendered.chapterNumbers,
      input.rendered.contentHash,
      input.rendered.bytes.byteLength,
      input.rendered.bytes,
    ],
  );
  const row = r.rows[0];
  if (!row) throw new ApiError('INTERNAL_ERROR', 'The export could not be recorded.');
  return row;
}

/** Record a failed export so the operator sees why, instead of an export that simply never appears. */
export async function persistFailedExport(
  c: Client,
  input: {
    workspaceId: string;
    projectId: string;
    requestedBy: string;
    format: ExportFormat;
    scope: Record<string, unknown>;
    options: Record<string, unknown>;
    error: { code: string; detail: string };
  },
): Promise<ExportRow> {
  const r = await c.query<ExportRow>(
    `INSERT INTO exports (workspace_id, project_id, requested_by, format, scope, options, status, error,
                          completed_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'failed', $7::jsonb, now())
     RETURNING id, project_id, format, status, canon_version, chapter_numbers, content_hash, byte_size,
               error, created_at, completed_at`,
    [
      input.workspaceId,
      input.projectId,
      input.requestedBy,
      input.format,
      JSON.stringify(input.scope),
      JSON.stringify(input.options),
      JSON.stringify(input.error),
    ],
  );
  const row = r.rows[0];
  if (!row) throw new ApiError('INTERNAL_ERROR', 'The export could not be recorded.');
  return row;
}

/** Read an export's metadata in scope. Invisible (other workspace) and absent are the same 404. */
export async function exportOr404(c: Client, exportId: string): Promise<ExportRow> {
  const r = await c.query<ExportRow>(
    `SELECT id, project_id, format, status, canon_version, chapter_numbers, content_hash, byte_size,
            error, created_at, completed_at
       FROM exports WHERE id = $1`,
    [exportId],
  );
  const row = r.rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 'The export does not exist.');
  return row;
}

/** Read an export's bytes in scope, for an authorized download. */
export async function exportContent(
  c: Client,
  exportId: string,
): Promise<{ row: ExportRow; content: Buffer }> {
  const row = await exportOr404(c, exportId);
  if (row.status !== 'ready')
    throw new ApiError(
      'CONFLICT',
      `The export is ${row.status}; only a ready export can be downloaded.`,
    );
  const r = await c.query<{ content: Buffer }>('SELECT content FROM exports WHERE id = $1', [
    exportId,
  ]);
  const content = r.rows[0]?.content;
  if (!content) throw new ApiError('NOT_FOUND', 'The export content is unavailable.');
  return { row, content };
}
