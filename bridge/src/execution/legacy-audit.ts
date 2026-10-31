// Read-only audit of execution records written before Review 02, whose
// ChatGPT-readable execution.json may still carry the ignored-file baseline
// (ignored_initial: ignored entry names, credential file names and content
// fingerprints). Reports counts and states only, never names or values, and
// changes nothing. See docs/runbooks/claude-execution.md, "Legacy records".
// Review 05: the audit fails closed. Every execution.json is either fully read,
// strictly decoded and parsed (verified) or reported as unverified, and every
// directory on the way is either inspected or reported as a coverage gap; symlinks
// are never followed. Possible exposure and coverage are reported separately.
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { APPS_PATH, FactoryJobError, FactoryJobs, ID_PATTERN, readJobFile } from '../factory-jobs.js';
import {
  EXECUTION_FILE,
  EXECUTION_SCHEMA,
  hasOnlyKnownExecutionFields,
  isCurrentExecutionRecord,
  keptEveryKey,
  legacyIgnoredSchema,
  privateBaselineName,
  STATES,
  readPrivateBaselineFile,
} from './service.js';

const MAX_RECORD_BYTES = 1024 * 1024;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type RecordIssue =
  | 'symlink'
  | 'not_regular'
  | 'too_large'
  | 'unreadable'
  | 'invalid_utf8'
  | 'invalid_json'
  | 'not_record'
  | 'duplicate_key'
  | 'unknown_shape';

export interface LegacyAuditEntry {
  app_id: string;
  job_id: string;
  // ok: the current schema; legacy-format: the schema marker without the current schema
  // (an earlier SF-006 format or a malformed field; the adapter refuses it as
  // invalid_record); unreadable: an existing file that is not a verified execution record.
  record: 'ok' | 'legacy-format' | 'unreadable';
  // verified: read in full, strict UTF-8, a JSON object with the schema marker, no
  // duplicate keys, and only known fields of their current types.
  // unverified: it exists but its contents are not fully known (issue says why).
  coverage: 'verified' | 'unverified';
  issue: null | RecordIssue;
  state: string | null;
  // The pre-Review 02 field: absent, null (current records), present with counts, or malformed;
  // unknown when the record could not be parsed.
  ignored_initial: 'absent' | 'null' | 'malformed' | 'unknown' | { entries: number; credentials: number };
  private_baseline: 'valid' | 'invalid' | 'missing';
  // True when the ChatGPT-readable record itself may name ignored entries or credential files;
  // null when that is unknown (an unverified record without a known exposure), never a clean result.
  exposes_names: boolean | null;
}

// A directory the audit could not inspect: the records below it are unaccounted for.
// path is repository-relative and built from verified ids only.
export interface CoverageGap {
  path: string;
  kind: 'data' | 'apps' | 'app' | 'jobs' | 'job';
  // unexpected_name: entries of the directory whose names are outside the id pattern
  // (count only, names never printed).
  reason: 'symlink' | 'not_directory' | 'unreadable' | 'unexpected_name';
  count?: number;
}

export interface LegacyAudit {
  // absent: factory-data or factory-data/apps does not exist (ENOENT): never initialized, nothing to audit.
  data: 'present' | 'absent';
  entries: LegacyAuditEntry[];
  gaps: CoverageGap[];
  // Job directories confirmed to have no execution.json (ENOENT): never prepared.
  unprepared: Array<{ app_id: string; job_id: string }>;
}

type DirectoryState = 'present' | 'missing' | 'symlink' | 'not_directory' | 'unreadable';

// lstat without following: a plain directory, missing (ENOENT only), or the reason it cannot be inspected.
async function directory(path: string): Promise<DirectoryState> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return 'symlink';
    return stats.isDirectory() ? 'present' : 'not_directory';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

// A directory that was listed but is gone by now is a gap too, not an absence.
function gapReason(state: Exclude<DirectoryState, 'present'>): CoverageGap['reason'] {
  return state === 'missing' ? 'unreadable' : state;
}

// Ids of a verified directory's entries; other names are counted as a gap, never returned.
async function listIds(path: string, relative: string, kind: CoverageGap['kind'], gaps: CoverageGap[]): Promise<string[] | undefined> {
  let names: string[];
  try {
    names = await readdir(path);
  } catch {
    gaps.push({ path: relative, kind, reason: 'unreadable' });
    return undefined;
  }
  const ids = names.filter((name) => ID_PATTERN.test(name)).sort();
  if (ids.length < names.length) {
    gaps.push({ path: relative, kind, reason: 'unexpected_name', count: names.length - ids.length });
  }
  return ids;
}

// Counts of a legacy ignored_initial that matches the shared strict shape exactly;
// anything else (extra keys, wrong nested types, an array as the credential map) is
// 'malformed' and treated as exposing names, whatever it seems to hold.
function legacyCounts(record: Record<string, unknown>): LegacyAuditEntry['ignored_initial'] {
  if (!('ignored_initial' in record)) return 'absent';
  if (record.ignored_initial === null) return 'null';
  const parsed = legacyIgnoredSchema.safeParse(record.ignored_initial);
  if (!parsed.success || !keptEveryKey(record.ignored_initial, parsed.data)) return 'malformed';
  return { entries: parsed.data.entries.length, credentials: Object.keys(parsed.data.credentials).length };
}

type Inspection =
  | { kind: 'absent' }
  | { kind: 'parsed'; record: Record<string, unknown>; issue: null | 'duplicate_key' | 'unknown_shape' }
  | { kind: 'unverified'; issue: RecordIssue };

// Number of object keys in valid JSON text: every string token followed by ':' is a key.
function rawKeyCount(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '"') continue;
    index += 1;
    while (text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
    let next = index + 1;
    while (/\s/.test(text[next] ?? '')) next += 1;
    if (text[next] === ':') count += 1;
  }
  return count;
}

// Own keys of every object in a parsed JSON value; true in found when one is "__proto__",
// which JSON.parse keeps as an own key but zod may drop without rejecting it.
function parsedKeyCount(value: unknown, found: { proto: boolean }): number {
  if (value === null || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce<number>((sum, child) => sum + parsedKeyCount(child, found), 0);
  const keys = Object.keys(value);
  if (keys.includes('__proto__')) found.proto = true;
  return keys.length + Object.values(value).reduce<number>((sum, child) => sum + parsedKeyCount(child, found), 0);
}

// Reads one execution.json through FactoryJobs and readJobFile (no symlinks on the way,
// none at the file). Only a file that is fully read, decoded and parsed is inspected;
// duplicate keys (JSON.parse keeps the last) or unknown fields leave part of it unseen.
async function inspect(jobs: FactoryJobs, appId: string, jobId: string, jobDir: string): Promise<Inspection> {
  let buffer: Buffer | undefined;
  try {
    buffer = await jobs.withJob(appId, jobId, false, (job) => readJobFile(job, EXECUTION_FILE, MAX_RECORD_BYTES));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // Anything but a file-system or FactoryJobs error is a defect, not a coverage finding.
    if (!(error instanceof FactoryJobError) && typeof code !== 'string') throw error;
    if (code === 'too_large') return { kind: 'unverified', issue: 'too_large' };
    if (code === 'forbidden_path') {
      // readJobFile refuses both; tell them apart for the operator without following anything.
      const file = await lstat(join(jobDir, EXECUTION_FILE)).catch(() => undefined);
      return { kind: 'unverified', issue: file?.isSymbolicLink() ? 'symlink' : 'not_regular' };
    }
    return { kind: 'unverified', issue: 'unreadable' };
  }
  // readJobFile returns undefined for ENOENT only.
  if (buffer === undefined) return { kind: 'absent' };
  let text: string;
  try {
    text = strictUtf8.decode(buffer);
  } catch {
    return { kind: 'unverified', issue: 'invalid_utf8' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unverified', issue: 'invalid_json' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as Record<string, unknown>).schema !== EXECUTION_SCHEMA) {
    return { kind: 'unverified', issue: 'not_record' };
  }
  const record = parsed as Record<string, unknown>;
  const found = { proto: false };
  if (rawKeyCount(text) !== parsedKeyCount(record, found)) return { kind: 'parsed', record, issue: 'duplicate_key' };
  if (found.proto || !hasOnlyKnownExecutionFields(record)) return { kind: 'parsed', record, issue: 'unknown_shape' };
  return { kind: 'parsed', record, issue: null };
}

export async function auditLegacyRecords(mediatorRoot: string): Promise<LegacyAudit> {
  const audit: LegacyAudit = { data: 'present', entries: [], gaps: [], unprepared: [] };
  for (const [relative, kind] of [['factory-data', 'data'], [APPS_PATH, 'apps']] as const) {
    const state = await directory(join(mediatorRoot, relative));
    if (state === 'missing') return { ...audit, data: 'absent' };
    if (state !== 'present') return { ...audit, gaps: [{ path: relative, kind, reason: state }] };
  }
  const apps = join(mediatorRoot, APPS_PATH);
  const jobs = new FactoryJobs(mediatorRoot);
  for (const appId of (await listIds(apps, APPS_PATH, 'apps', audit.gaps)) ?? []) {
    // Each app and job is independent: a gap is recorded and the walk goes on.
    const appState = await directory(join(apps, appId));
    if (appState !== 'present') {
      audit.gaps.push({ path: `${APPS_PATH}/${appId}`, kind: 'app', reason: gapReason(appState) });
      continue;
    }
    const jobsPath = `${APPS_PATH}/${appId}/jobs`;
    const jobsState = await directory(join(mediatorRoot, jobsPath));
    // A registered app gets its jobs directory with its first job.
    if (jobsState === 'missing') continue;
    if (jobsState !== 'present') {
      audit.gaps.push({ path: jobsPath, kind: 'jobs', reason: jobsState });
      continue;
    }
    for (const jobId of (await listIds(join(mediatorRoot, jobsPath), jobsPath, 'jobs', audit.gaps)) ?? []) {
      const jobDir = join(mediatorRoot, jobsPath, jobId);
      const jobState = await directory(jobDir);
      if (jobState !== 'present') {
        audit.gaps.push({ path: `${jobsPath}/${jobId}`, kind: 'job', reason: gapReason(jobState) });
        continue;
      }
      const inspection = await inspect(jobs, appId, jobId, jobDir);
      if (inspection.kind === 'absent') {
        audit.unprepared.push({ app_id: appId, job_id: jobId });
        continue;
      }
      const private_baseline = (await readPrivateBaselineFile(join(apps, appId, privateBaselineName(jobId)))).status;
      if (inspection.kind === 'unverified') {
        audit.entries.push({
          app_id: appId,
          job_id: jobId,
          record: 'unreadable',
          coverage: 'unverified',
          issue: inspection.issue,
          state: null,
          ignored_initial: 'unknown',
          private_baseline,
          exposes_names: null,
        });
        continue;
      }
      const { record, issue } = inspection;
      const counts = legacyCounts(record);
      const exposing = counts === 'malformed' || (typeof counts === 'object' && counts.entries + counts.credentials > 0);
      audit.entries.push({
        app_id: appId,
        job_id: jobId,
        record: isCurrentExecutionRecord(record) ? 'ok' : 'legacy-format',
        coverage: issue === null ? 'verified' : 'unverified',
        issue,
        // Only a known state is reported: the field is free text in a malformed record.
        state: (STATES as readonly unknown[]).includes(record.state) ? (record.state as string) : null,
        ignored_initial: counts,
        private_baseline,
        // A known exposure stands; otherwise an unverified record's exposure is unknown.
        exposes_names: exposing || (issue === null ? false : null),
      });
    }
  }
  return audit;
}

const GAP_KINDS: Record<CoverageGap['kind'], string> = {
  data: 'data directory',
  apps: 'apps directory',
  app: 'app directory',
  jobs: 'jobs directory',
  job: 'job directory',
};
const GAP_REASONS: Record<Exclude<CoverageGap['reason'], 'unexpected_name'>, string> = {
  symlink: 'is a symlink, not followed',
  not_directory: 'is not a directory',
  unreadable: 'could not be inspected',
};

function describeGap(gap: CoverageGap): string {
  if (gap.reason === 'unexpected_name') {
    return `${gap.count} ${gap.count === 1 ? 'entry' : 'entries'} with a name outside the id pattern, not inspected`;
  }
  return `${GAP_KINDS[gap.kind]} ${GAP_REASONS[gap.reason]}`;
}

// The audit as printable lines with its exit code: 1 when any record may expose names
// or when coverage is incomplete (an unverified record or a coverage gap); 0 only when
// every record and directory was inspected and none exposes names. Lines carry ids,
// repository-relative paths built from ids, categorical statuses and counts only.
export function formatLegacyAudit(audit: LegacyAudit): { lines: string[]; exitCode: 0 | 1 } {
  const lines: string[] = [];
  if (audit.data === 'absent') lines.push('factory-data/apps does not exist: never initialized, no execution records.');
  for (const entry of audit.entries) {
    const legacy =
      typeof entry.ignored_initial === 'object'
        ? `present (entries ${entry.ignored_initial.entries}, credential files ${entry.ignored_initial.credentials})`
        : entry.ignored_initial;
    const record = entry.coverage === 'verified' ? entry.record : `${entry.record}, UNVERIFIED (${entry.issue})`;
    lines.push(
      `${entry.app_id}/${entry.job_id}: record ${record}, state ${entry.state ?? '-'}, ignored_initial ${legacy}, ` +
        `private baseline ${entry.private_baseline}${entry.exposes_names === true ? ', EXPOSES NAMES' : ''}`,
    );
  }
  for (const gap of audit.gaps) lines.push(`${gap.path}: COVERAGE GAP (${describeGap(gap)})`);
  const exposing = audit.entries.filter((entry) => entry.exposes_names === true).length;
  const unverified = audit.entries.filter((entry) => entry.coverage === 'unverified').length;
  lines.push(
    `${audit.entries.length} execution record(s): ${audit.entries.length - unverified} verified, ${unverified} unverified; ` +
      `${exposing} may expose ignored-file names in execution.json; ${audit.gaps.length} coverage gap(s); ` +
      `${audit.unprepared.length} job(s) without execution.json (not prepared).`,
  );
  const incomplete = unverified + audit.gaps.length > 0;
  if (exposing > 0) lines.push(`Audit FAILED: ${exposing} record(s) may expose ignored-file names in execution.json.`);
  if (incomplete) {
    lines.push(
      `Audit FAILED: coverage INCOMPLETE (${unverified} unverified record(s), ${audit.gaps.length} coverage gap(s)); ` +
        'what they contain is unknown, so no global result can be claimed.',
    );
  }
  if (exposing === 0 && !incomplete) lines.push('Audit coverage complete: every record and directory was inspected; none exposes ignored-file names.');
  return { lines, exitCode: exposing === 0 && !incomplete ? 0 : 1 };
}
