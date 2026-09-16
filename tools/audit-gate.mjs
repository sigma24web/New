/**
 * Dependency audit gate.
 *
 * `pnpm audit --audit-level=high` reports advisories but the CI step that wrapped it previously ended in
 * `|| (echo ... && exit 0)`, which turned every finding into a success: the step was named as a gate but
 * behaved as a report. This script is the gate.
 *
 * High and critical advisories fail the build. An advisory that genuinely must be tolerated is listed in
 * `.audit-allowlist.json` with a justification, the scope it applies to and an expiry date — so the
 * exception is reviewable, narrow, and cannot outlive its review. An expired or malformed entry does not
 * suppress anything.
 */
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ALLOWLIST = '.audit-allowlist.json';
const BLOCKING = new Set(['high', 'critical']);

/** `pnpm audit --json` exits non-zero when it finds anything, so the output is read from the error too. */
async function auditJson() {
  try {
    const { stdout } = await run('pnpm', ['audit', '--json'], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    if (typeof err?.stdout === 'string' && err.stdout.trim()) return err.stdout;
    throw err;
  }
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST)) return [];
  const parsed = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  const entries = Array.isArray(parsed?.allow) ? parsed.allow : [];
  const today = new Date().toISOString().slice(0, 10);
  return entries.filter((entry) => {
    const complete =
      typeof entry?.id === 'string' &&
      typeof entry?.justification === 'string' &&
      entry.justification.trim().length > 0 &&
      typeof entry?.expires === 'string';
    if (!complete) {
      console.error(
        `::warning::audit allowlist entry ignored (incomplete): ${JSON.stringify(entry)}`,
      );
      return false;
    }
    if (entry.expires < today) {
      console.error(`::warning::audit allowlist entry for ${entry.id} expired on ${entry.expires}`);
      return false;
    }
    return true;
  });
}

const raw = await auditJson();
let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error('::error::could not parse pnpm audit output');
  console.error(raw.slice(0, 2000));
  process.exit(1);
}

const advisories = Object.values(report.advisories ?? {});
const allowed = new Set(loadAllowlist().map((e) => String(e.id)));
const blocking = advisories.filter(
  (a) => BLOCKING.has(String(a.severity)) && !allowed.has(String(a.id ?? a.github_advisory_id)),
);

for (const a of advisories) {
  const severity = String(a.severity);
  const id = String(a.id ?? a.github_advisory_id ?? 'unknown');
  const line = `${severity} ${id} ${a.module_name ?? ''} ${a.title ?? ''}`.trim();
  if (BLOCKING.has(severity) && !allowed.has(id)) console.error(`::error::${line}`);
  else if (BLOCKING.has(severity)) console.error(`::warning::allowlisted ${line}`);
}

if (blocking.length > 0) {
  console.error(
    `::error::${blocking.length} high/critical advisory(ies) without a current allowlist entry`,
  );
  process.exit(1);
}
console.log(
  `dependency audit: ${advisories.length} advisory(ies), 0 blocking (${allowed.size} allowlisted)`,
);
