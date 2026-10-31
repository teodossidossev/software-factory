// SF-010: the complete, verified review input of one review-ready event. Everything is read from
// the mediator job directory through the same checks the supervisor and factory_review_snapshot
// use (checkJobDirectory, readManaged, readJobFile without following symlinks, verifiedArtifacts),
// and bound to the exact current iteration, snapshot sha256, live session and context epoch.
//
// What blocks a review (it never becomes a clean verdict): a withheld export, an artifact that is
// missing, a symlink or does not hash to its record, malformed UTF-8, an instruction that is not the
// managed job's, a diff that does not cover every changed path (or covers paths that are not
// listed), content the export left out (too large, binary, not a regular file), a new file whose
// whole-file sha256 does not match the content in the diff, truncated path lists, and input larger
// than the delegation allows. The material is untrusted data: it is only hashed, parsed as a diff
// and handed to the provider as data; nothing in it is executed or followed.
import { FactoryJobError, readJobFile, type FactoryJobs } from '../factory-jobs.js';
import { INSTRUCTION_FILE, MAX_INSTRUCTION_BYTES } from '../instruction-store.js';
import { checkJobDirectory, contextEpoch, MAX_MANAGED_BYTES, readManaged, snapshotSchema, verifiedArtifacts, type ManagedRecord, type ReviewSnapshot } from '../executor/records.js';
import { ENDED_JOB_STATES, sha256, type ReviewReadyEvent } from './records.js';

// The export lists at most this many changed paths (service.ts MAX_LISTED_PATHS); a list of that
// length may be cut, so it cannot prove complete coverage.
const MAX_LISTED_PATHS = 100;
const NEW_FILE_IN_DIFF = 'in implementation.diff';

export interface ReviewInput {
  schema: 'software-factory.review-input/v1';
  event_id: string;
  app_id: string;
  job_id: string;
  iteration_id: string;
  iteration_number: number;
  snapshot_sha256: string;
  session_id: string;
  context_epoch: number;
  instruction: { sha256: string; text: string };
  snapshot: ReviewSnapshot;
  diff: { sha256: string; text: string };
  report: { sha256: string; text: string };
  // The paths a finding may reference: exactly the snapshot's changed paths.
  reviewable_paths: string[];
  bytes: number;
  // sha256 over the hashes and bindings above: what the provider saw.
  input_sha256: string;
}

// ok: the verified input. Otherwise a disposition and a code:
//   wait        not reviewable now, may become so (the job is not awaiting review, e.g. needs_operator)
//   superseded  the event's snapshot is no longer the current one
//   job_ended   the job reached a final or approved state
//   blocked     the material is withheld, oversized, malformed or incomplete
export type InputResult =
  | { ok: true; input: ReviewInput; managed: ManagedRecord }
  | { ok: false; disposition: 'wait' | 'superseded' | 'job_ended' | 'blocked'; code: string };

const decoder = new TextDecoder('utf-8', { fatal: true });
const utf8 = (data: Buffer): string | undefined => {
  try {
    return decoder.decode(data);
  } catch {
    return undefined;
  }
};

export async function buildReviewInput(jobs: FactoryJobs, event: ReviewReadyEvent, maxInputBytes: number): Promise<InputResult> {
  return jobs.withJob(event.app_id, event.job_id, false, async (job): Promise<InputResult> => {
    const fail = (disposition: 'wait' | 'superseded' | 'job_ended' | 'blocked', code: string): InputResult => ({ ok: false, disposition, code });
    try {
      await checkJobDirectory(job);
    } catch {
      return fail('blocked', 'job_directory_unsafe');
    }
    let managed: ManagedRecord | undefined;
    try {
      managed = await readManaged(job);
    } catch {
      return fail('blocked', 'managed_record_invalid');
    }
    if (managed === undefined) {
      return fail('wait', 'not_managed');
    }
    if (ENDED_JOB_STATES.includes(managed.state)) {
      return fail('job_ended', `job_${managed.state}`);
    }
    const current = managed.iterations.find((entry) => entry.id === managed.current_iteration);
    if (current === undefined || current.number < event.iteration_number) {
      // An event can only follow its publication; a managed record behind it is not evidence.
      return fail('blocked', 'event_ahead_of_managed_record');
    }
    if (current.id !== event.iteration_id || current.snapshot?.sha256 !== event.snapshot_sha256) {
      return fail('superseded', 'stale_snapshot');
    }
    if (current.state !== 'ready_for_review') {
      return fail('superseded', `iteration_${current.state}`);
    }
    if (managed.state !== 'awaiting_review') {
      return fail('wait', `job_${managed.state}`);
    }
    if (managed.session.process !== 'alive' || managed.session.current_session_id === null) {
      return fail('wait', 'no_live_session');
    }
    // The snapshot: the exact bytes managed.json references, for this job and iteration.
    let bytes: Buffer | undefined;
    try {
      bytes = await readJobFile(job, current.snapshot.file, MAX_MANAGED_BYTES);
    } catch (error) {
      return fail('blocked', error instanceof FactoryJobError && error.code === 'forbidden_path' ? 'snapshot_not_regular_file' : 'snapshot_unreadable');
    }
    if (bytes === undefined || sha256(bytes) !== event.snapshot_sha256) {
      return fail('blocked', 'snapshot_hash_mismatch');
    }
    const snapshotText = utf8(bytes);
    let snapshot: ReviewSnapshot;
    try {
      snapshot = snapshotSchema.parse(JSON.parse(snapshotText ?? ''));
    } catch {
      return fail('blocked', 'snapshot_malformed');
    }
    if (snapshot.app_id !== event.app_id || snapshot.job_id !== event.job_id || snapshot.iteration_id !== event.iteration_id) {
      return fail('blocked', 'snapshot_names_other_iteration');
    }
    if (snapshot.export.withheld !== null) {
      return fail('blocked', 'input_withheld');
    }
    let artifacts: { diff: Buffer; report: Buffer };
    try {
      artifacts = await verifiedArtifacts(job, snapshot);
    } catch {
      return fail('blocked', 'artifact_invalid');
    }
    let instructionBytes: Buffer | undefined;
    try {
      instructionBytes = await readJobFile(job, INSTRUCTION_FILE, MAX_INSTRUCTION_BYTES);
    } catch {
      return fail('blocked', 'instruction_unreadable');
    }
    if (instructionBytes === undefined || sha256(instructionBytes) !== managed.instruction_sha256) {
      return fail('blocked', 'instruction_mismatch');
    }
    const total = bytes.byteLength + artifacts.diff.byteLength + artifacts.report.byteLength + instructionBytes.byteLength;
    if (total > maxInputBytes) {
      return fail('blocked', 'input_too_large');
    }
    const instruction = utf8(instructionBytes);
    const diff = utf8(artifacts.diff);
    const report = utf8(artifacts.report);
    if (instruction === undefined || diff === undefined || report === undefined) {
      return fail('blocked', 'input_malformed');
    }
    const gap = coverageGap(diff, snapshot.export);
    if (gap !== null) {
      return fail('blocked', gap);
    }
    const hashes = {
      instruction: managed.instruction_sha256,
      diff: snapshot.artifacts.diff.sha256,
      report: snapshot.artifacts.report.sha256,
    };
    const binding = {
      event_id: event.event_id,
      snapshot_sha256: event.snapshot_sha256,
      session_id: managed.session.current_session_id,
      context_epoch: contextEpoch(managed),
    };
    return {
      ok: true,
      managed,
      input: {
        schema: 'software-factory.review-input/v1',
        app_id: event.app_id,
        job_id: event.job_id,
        iteration_id: event.iteration_id,
        iteration_number: event.iteration_number,
        ...binding,
        instruction: { sha256: hashes.instruction, text: instruction },
        snapshot,
        diff: { sha256: hashes.diff, text: diff },
        report: { sha256: hashes.report, text: report },
        reviewable_paths: [...snapshot.export.changed_paths],
        bytes: total,
        input_sha256: sha256(JSON.stringify([binding, hashes])),
      },
    };
  });
}

interface DiffSection {
  path: string | null;
  added: string[];
  noNewlineAtEnd: boolean;
  binary: boolean;
}

// The path of a section header `diff --git X Y` written without prefixes by the export, where X and
// Y are a/<path> or b/<path> with the same path; null when it cannot be read unambiguously (a quoted
// or unusual name).
function headerPath(rest: string): string | null {
  if ((rest.length - 1) % 2 !== 0) {
    return null;
  }
  const half = (rest.length - 1) / 2;
  const [left, right] = [rest.slice(0, half), rest.slice(half + 1)];
  if (rest[half] !== ' ' || !/^[ab]\//.test(left) || !/^[ab]\//.test(right) || left.slice(2) !== right.slice(2)) {
    return null;
  }
  return left.slice(2);
}

function sections(diff: string): DiffSection[] | null {
  const found: DiffSection[] = [];
  let current: DiffSection | undefined;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const path = headerPath(line.slice('diff --git '.length));
      current = { path, added: [], noNewlineAtEnd: false, binary: false };
      found.push(current);
      inHunk = false;
      continue;
    }
    if (current === undefined) {
      continue;
    }
    if (!inHunk && (line.startsWith('--- ') || line.startsWith('+++ '))) {
      const name = line.slice(4);
      if (name.startsWith('"')) {
        return null;
      }
      if (name !== '/dev/null') {
        const path = /^[ab]\//.test(name) ? name.slice(2) : null;
        if (path === null || (current.path !== null && current.path !== path)) {
          return null;
        }
        current.path = path;
      }
      continue;
    }
    if (line.startsWith('Binary files ')) {
      current.binary = true;
      continue;
    }
    if (line.startsWith('@@ ')) {
      inHunk = true;
      continue;
    }
    if (inHunk && line.startsWith('+')) {
      current.added.push(line.slice(1));
    } else if (inHunk && line.startsWith('\\ No newline at end of file')) {
      current.noNewlineAtEnd = true;
    }
  }
  return found.some((section) => section.path === null) ? null : found;
}

// Why the diff is not complete evidence of the export, or null. Exported for the tests.
export function coverageGap(diff: string, exported: ReviewSnapshot['export']): string | null {
  if (exported.changed_paths.length >= MAX_LISTED_PATHS) {
    return 'changed_paths_truncated';
  }
  if ((exported.preexisting?.changed_more ?? 0) > 0 || (exported.preexisting?.removed_more ?? 0) > 0) {
    return 'preexisting_list_truncated';
  }
  if (/^# .*(content not exported|no longer a regular file)/m.test(diff)) {
    return 'content_not_exported';
  }
  const parsed = sections(diff);
  if (parsed === null) {
    return 'diff_unparseable';
  }
  if (parsed.some((section) => section.binary)) {
    return 'binary_content';
  }
  const listed = new Set(exported.changed_paths);
  const covered = new Map(parsed.map((section) => [section.path!, section]));
  if (covered.size !== parsed.length) {
    return 'diff_path_repeated';
  }
  for (const path of covered.keys()) {
    if (!listed.has(path)) {
      return 'diff_path_not_listed';
    }
  }
  for (const path of listed) {
    if (!covered.has(path)) {
      return 'changed_path_not_in_diff';
    }
  }
  // New files: complete content in the diff, matching the export's whole-file sha256.
  for (const file of exported.new_files) {
    if (file.note !== NEW_FILE_IN_DIFF) {
      return 'new_file_not_in_diff';
    }
    const section = covered.get(file.path);
    if (section === undefined) {
      return 'changed_path_not_in_diff';
    }
    const content = section.added.length === 0 ? '' : `${section.added.join('\n')}${section.noNewlineAtEnd ? '' : '\n'}`;
    if (Buffer.byteLength(content) !== file.bytes || sha256(content) !== file.sha256) {
      return 'new_file_hash_mismatch';
    }
  }
  return null;
}
