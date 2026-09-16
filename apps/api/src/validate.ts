/**
 * Boundary validation (Checkpoint 7).
 *
 * Everything crossing the HTTP boundary is validated here before it reaches a domain service, and
 * language-bearing text is NFC-normalized at the same point — ADR-0030 makes code-point offsets meaningful
 * only against NFC text, so normalizing later would mean evidence offsets computed against a different
 * string than the one stored.
 *
 * These helpers deliberately produce `VALIDATION_FAILED` problems with a path per field rather than throwing
 * raw type errors, so a client can fix its request without reading server logs.
 */
import { toNfcText } from '@yeonjae/prose';
import { ApiError } from './problem.js';

export type Json = Record<string, unknown>;

export class FieldErrors {
  private readonly errors: { path: string; message: string }[] = [];

  add(path: string, message: string): void {
    this.errors.push({ path, message });
  }

  throwIfAny(detail = 'One or more fields are invalid.'): void {
    if (this.errors.length > 0)
      throw new ApiError('VALIDATION_FAILED', detail, { errors: [...this.errors] });
  }
}

export function asObject(body: unknown, path = 'body'): Json {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new ApiError('VALIDATION_FAILED', 'A JSON object body is required.', {
      errors: [{ path, message: 'must be a JSON object' }],
    });
  return body as Json;
}

export function requireString(
  body: Json,
  field: string,
  options: { max?: number; min?: number; nfc?: boolean } = {},
): string {
  const raw = body[field];
  if (typeof raw !== 'string' || raw.trim() === '')
    throw new ApiError('VALIDATION_FAILED', `Field "${field}" is required.`, {
      errors: [{ path: `body.${field}`, message: 'must be a non-empty string' }],
    });
  // NFC at the boundary (ADR-0030): offsets are code-point indices into NFC text.
  const value = options.nfc === false ? raw : toNfcText(raw).text;
  const min = options.min ?? 1;
  const max = options.max ?? 10_000;
  if (value.length < min || value.length > max)
    throw new ApiError('VALIDATION_FAILED', `Field "${field}" has an invalid length.`, {
      errors: [{ path: `body.${field}`, message: `must be between ${min} and ${max} characters` }],
    });
  return value;
}

export function optionalString(
  body: Json,
  field: string,
  options: { max?: number; nfc?: boolean } = {},
): string | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  return requireString(body, field, options);
}

export function requireUuid(value: string | undefined, path: string): string {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new ApiError('VALIDATION_FAILED', `"${path}" must be a UUID.`, {
      errors: [{ path, message: 'must be a UUID' }],
    });
  return value;
}

export function requireInt(
  value: string | number | undefined,
  path: string,
  options: { min?: number; max?: number } = {},
): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n))
    throw new ApiError('VALIDATION_FAILED', `"${path}" must be an integer.`, {
      errors: [{ path, message: 'must be an integer' }],
    });
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (n < min || n > max)
    throw new ApiError('VALIDATION_FAILED', `"${path}" is out of range.`, {
      errors: [{ path, message: `must be between ${min} and ${max}` }],
    });
  return n;
}

export function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T))
    throw new ApiError('VALIDATION_FAILED', `"${path}" is not one of the allowed values.`, {
      errors: [{ path, message: `must be one of: ${allowed.join(', ')}` }],
    });
  return value as T;
}

/**
 * English-only manuscript input (ADR-0026). The system composes English directly; accepting another
 * manuscript language here would quietly introduce the translation stage the architecture forbids.
 *
 * Operator *instructions* may be in any language — only manuscript-bearing fields go through this.
 */
export function requireEnglishManuscript(text: string, path: string): string {
  const nfc = toNfcText(text);
  // A conservative structural check: manuscript prose in another script is refused at the boundary rather
  // than being discovered by a judge after it has been paid for.
  if (/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af\u3040-\u30ff\u4e00-\u9fff]/.test(nfc.text))
    throw new ApiError(
      'UNSUPPORTED_LANGUAGE',
      'Manuscript text must be English (ADR-0026); instructions may be in any language.',
      { errors: [{ path, message: 'must be English manuscript text' }] },
    );
  return nfc.text;
}

// ---------------------------------------------------------------------------------------------------------
// cursor pagination
// ---------------------------------------------------------------------------------------------------------

export interface Page {
  readonly limit: number;
  readonly after: string | undefined;
}

export function parsePage(query: Readonly<Record<string, unknown>>, max = 100): Page {
  const limitRaw = query.limit;
  const limit =
    limitRaw === undefined ? 25 : requireInt(limitRaw as string, 'query.limit', { min: 1, max });
  const cursor = query.cursor;
  if (cursor === undefined || cursor === null) return { limit, after: undefined };
  if (typeof cursor !== 'string' || cursor.length > 200)
    throw new ApiError('INVALID_CURSOR', 'The cursor is not valid.');
  const decoded = decodeCursor(cursor);
  return { limit, after: decoded };
}

/** Cursors are opaque but verifiable: an unparseable or foreign cursor is refused, never guessed at. */
export function encodeCursor(value: string): string {
  return Buffer.from(`v1:${value}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new ApiError('INVALID_CURSOR', 'The cursor is not valid.');
  }
  if (!decoded.startsWith('v1:')) throw new ApiError('INVALID_CURSOR', 'The cursor is not valid.');
  return decoded.slice(3);
}
