// SF-007 operator console: the local approval interface since Review 01. It
// runs in the operator's own terminal (opened by the desktop launcher or by
// hand), lists the queue, shows a job's exact instruction, and takes the
// operator's decision from the keyboard. Approve & Run then runs the whole
// SF-006 sequence for that job right here (attend.ts): this terminal is the
// interactive Claude Code session.
//
// It opens no network listener, socket or file another account could reach:
// the only way to approve is typing into this terminal, which only the logged-in
// operator can do. (The earlier loopback web page was withdrawn: a page at
// http://127.0.0.1:<port>/ cannot prove to the browser that it is the operator's
// own server, so another local account squatting the port could have run
// script in that origin. See docs/design/SF-007-local-operator.md.)
//
// Everything printed from job data is made inert first (text.ts): control
// characters and bidirectional overrides are shown as escapes, so instruction
// text cannot move the cursor, rewrite lines, change the title or hide text.
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import type { ExecutionService } from '../execution/service.js';
import { FactoryJobs, readJobFile } from '../factory-jobs.js';
import { INSTRUCTION_FILE, MAX_INSTRUCTION_BYTES } from '../instruction-store.js';
import { approve, cancel, later, reject } from './approval.js';
import { attend } from './attend.js';
import { inspectJob, isTruncated, QUEUE_LIMITS, scanQueue, type QueueEntry, type Truncation } from './queue.js';
import { isCodedError, type OperatorStore } from './store.js';
import { inertLine, printable } from './text.js';

export interface ConsoleDeps {
  mediatorRoot: string;
  store: OperatorStore;
  service: Pick<ExecutionService, 'preflight' | 'prepare' | 'run' | 'status'>;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  isTTY: boolean;
  now: () => Date;
  // Optional banner (the demo marks itself).
  banner?: string;
}

const STATUS_TEXT: Record<QueueEntry['status'], string> = {
  accepted: 'accepted by OpenClaw; this app cannot run here',
  awaiting_operator: 'awaiting your decision',
  approved: 'approved, about to start',
  launching: 'starting in an operator console',
  running: 'Claude Code session running',
  prepared: 'prepared, not started',
  pending_manual: 'handed off (manual SF-006 CLI)',
  completed: 'completed',
  rejected: 'rejected',
  interrupted: 'interrupted',
  failed: 'failed',
  needs_inspection: 'needs inspection',
  invalid: 'acceptance not proven or record invalid',
};

export function describeTruncation(truncation: Truncation): string[] {
  if (!isTruncated(truncation)) return [];
  const lines = ['LIST INCOMPLETE:'];
  if (truncation.apps_omitted > 0) lines.push(`  ${truncation.apps_omitted} app(s) beyond the first ${QUEUE_LIMITS.apps} are not listed`);
  for (const { app_id, omitted } of truncation.jobs_omitted_in) {
    lines.push(`  ${app_id}: ${omitted} job(s) beyond the first ${QUEUE_LIMITS.jobsPerApp} are not listed`);
  }
  if (truncation.total_omitted > 0) lines.push(`  ${truncation.total_omitted} job(s) beyond the total limit of ${QUEUE_LIMITS.jobs} are not listed`);
  for (const { path, reason } of truncation.uninspected) lines.push(`  ${path}: ${reason}; not inspected`);
  lines.push('  (Session limits do not depend on this list: the session gate counts every session.)');
  return lines;
}

// The whole coverage statement for the console: an explicit clean-empty state, or what is missing.
export function describeCoverage(truncation: Truncation): string[] {
  if (truncation.uninitialized) return ['The mediator is not initialized yet (no factory-data/apps): nothing has been dispatched.'];
  return describeTruncation(truncation);
}

export function entryNotes(entry: QueueEntry): string[] {
  const parts: string[] = [];
  if (entry.problem) parts.push(entry.problem.message);
  if (entry.approval) parts.push(`approved ${entry.approval.approved_at}${entry.approval.expired ? ' (expired: cancel it)' : ''}`);
  if (entry.last_launch && !['finished', 'started'].includes(entry.last_launch.outcome)) {
    parts.push(
      `last launch ${entry.last_launch.outcome}${entry.last_launch.code ? ` (${entry.last_launch.code})` : ''}${entry.last_launch.message ? `: ${entry.last_launch.message}` : ''}`,
    );
  }
  if (entry.execution?.error) parts.push(`${entry.execution.error.code}: ${entry.execution.error.message}`);
  if (entry.execution?.process_alive === false && entry.status === 'running') parts.push('the session process is gone');
  if (entry.execution?.recovery) parts.push(`next: ${entry.execution.recovery}`);
  if (entry.next) parts.push(`recovery (in a terminal): ${entry.next}`);
  if (entry.status === 'prepared' && entry.actions.includes('approve')) parts.push('approve again to resume it');
  if (entry.deferred_at) parts.push(`deferred ${entry.deferred_at}`);
  return parts.map(inertLine);
}

export async function runConsole(deps: ConsoleDeps): Promise<number> {
  const say = (text = '') => deps.output.write(`${text}\n`);
  if (!deps.isTTY) {
    say('The operator console needs an interactive terminal; nothing was done.');
    return 1;
  }
  const ask = async (question: string): Promise<string | undefined> => {
    const prompt = createInterface({ input: deps.input, output: deps.output, terminal: true });
    try {
      return (await prompt.question(question)).trim();
    } catch {
      return undefined;
    } finally {
      prompt.close();
    }
  };

  for (;;) {
    const { entries, truncation } = await scanQueue(deps);
    say();
    say('=== Software Factory operator console ===');
    if (deps.banner) say(deps.banner);
    say('No network listener: decisions are taken only here, from this keyboard.');
    say(`${new Date(deps.now()).toLocaleString()}: ${entries.length} job(s)`);
    for (const text of describeCoverage(truncation)) say(text);
    say();
    entries.forEach((entry, index) => {
      const sha = entry.instruction_sha256 ? `${entry.instruction_sha256.slice(0, 12)}…` : '-';
      say(`${String(index + 1).padStart(3)}  ${entry.app_id}/${entry.job_id}  [${entry.status}] ${STATUS_TEXT[entry.status]}  sha ${sha}${entry.actions.length ? '  <- action available' : ''}`);
      for (const note of entryNotes(entry)) say(`       ${note}`);
    });
    if (entries.length === 0) say('  (no accepted jobs)');
    say();
    const choice = await ask('Number (or app/job) to review, r to refresh, q to quit: ');
    if (choice === undefined || choice === 'q') return 0;
    if (choice === 'r' || choice === '') continue;
    // A list number, or the job as app/job.
    const index = Number(choice);
    const selected = /^\d+$/.test(choice) ? entries[index - 1] : entries.find((entry) => `${entry.app_id}/${entry.job_id}` === choice);
    if (selected === undefined) {
      say(`No job ${inertLine(choice)}.`);
      continue;
    }
    await review(deps, say, ask, selected);
  }
}

async function review(
  deps: ConsoleDeps,
  say: (text?: string) => void,
  ask: (question: string) => Promise<string | undefined>,
  listed: QueueEntry,
): Promise<void> {
  // Read again: the decision is about the job as it is now, and as it is shown here.
  const entry = await inspectJob(deps, listed.app_id, listed.job_id);
  if (entry === undefined) {
    say('The job is no longer an accepted job.');
    return;
  }
  const label = `${entry.app_id}/${entry.job_id}`;
  say();
  say(`--- ${label} ---`);
  say(`status:             ${entry.status} (${STATUS_TEXT[entry.status]})`);
  say(`request id:         ${inertLine(entry.request_id ?? '-')}`);
  say(`instruction sha256: ${entry.instruction_sha256 ?? '-'}`);
  say(`instruction bytes:  ${entry.instruction_bytes ?? '-'}`);
  say(`accepted at:        ${inertLine(entry.accepted_at ?? '-')}`);
  for (const [name, digest] of Object.entries(entry.execution?.artifacts ?? {})) say(`${inertLine(name).padEnd(20)}${inertLine(digest)}`);
  for (const note of entryNotes(entry)) say(`note: ${note}`);
  if (entry.actions.includes('approve') || entry.actions.includes('reject') || entry.actions.includes('later')) {
    const text = await readInstruction(deps, entry).catch(() => undefined);
    if (text === undefined) {
      say('The instruction cannot be shown (it changed or cannot be read); no decision is offered. Refresh.');
      return;
    }
    say('--- instruction (exact text as accepted; control characters shown as escapes) ---');
    say(printable(text));
    say('--- end of instruction ---');
  }
  const options: Array<[string, string]> = [];
  if (entry.actions.includes('approve')) options.push(['a', entry.status === 'prepared' ? 'Approve & Run (resume)' : 'Approve & Run']);
  if (entry.actions.includes('later')) options.push(['l', 'Later']);
  if (entry.actions.includes('reject')) options.push(['x', 'Reject (final)']);
  if (entry.actions.includes('cancel')) options.push(['c', 'Cancel approval']);
  if (options.length === 0) {
    say('No decision is available for this status.');
    await ask('Press Enter to return to the queue. ');
    return;
  }
  const answer = await ask(`${options.map(([key, text]) => `${key} = ${text}`).join(', ')}, anything else = back: `);
  const shown = { request_id: entry.request_id ?? '', instruction_sha256: entry.instruction_sha256 ?? '' };
  try {
    if (answer === 'a' && entry.actions.includes('approve')) {
      await approve(deps, entry.app_id, entry.job_id, shown);
      await attend({ ...deps, closePrompt: 'Press Enter to return to the queue.' }, entry.app_id, entry.job_id);
    } else if (answer === 'l' && entry.actions.includes('later')) {
      await later(deps, entry.app_id, entry.job_id, shown);
      say(`${label} stays in the queue for later.`);
    } else if (answer === 'x' && entry.actions.includes('reject')) {
      const sure = await ask(`Reject ${label} for good? It will never run under this job id. Type "reject" to confirm: `);
      if (sure === 'reject') {
        await reject(deps, entry.app_id, entry.job_id, shown);
        say(`Rejected ${label}.`);
      } else {
        say('Not rejected.');
      }
    } else if (answer === 'c' && entry.actions.includes('cancel') && entry.approval) {
      await cancel(deps, entry.app_id, entry.job_id, entry.approval.id);
      say(`Approval of ${label} cancelled; nothing was started.`);
    }
  } catch (error) {
    say(isCodedError(error) ? `${error.code}: ${inertLine(error.message)}` : 'An unexpected error occurred; nothing was started.');
  }
}

// The exact accepted instruction (strict UTF-8, same SHA-256 as listed), or an error.
async function readInstruction(deps: ConsoleDeps, entry: QueueEntry): Promise<string> {
  const buffer = await new FactoryJobs(deps.mediatorRoot).withJob(entry.app_id, entry.job_id, false, (job) => readJobFile(job, INSTRUCTION_FILE, MAX_INSTRUCTION_BYTES));
  if (buffer === undefined || createHash('sha256').update(buffer).digest('hex') !== entry.instruction_sha256) throw new Error('changed');
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}
