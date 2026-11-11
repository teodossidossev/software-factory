// The history of a planned ticket: what the factory records of the Task file's writes,
// <state>/tickets/<ws>/<ticket>/history.jsonl, append-only, one line {ts, kind, by, sha256} per
// write (a Fix section adds its number), and the timeline the planned ticket page shows: those
// writes, the Task checks (<state>/checks/<ws>/<ticket>/*.json) and the jobs of the ticket
// (<state>/jobs/<ws>/<ticket>/job.json and its archived <ticket>.<stamp>/job.json), read here
// from the files the CheckStore and the JobStore write. Nothing else is shown: a write the factory
// did not see is "Changed outside the factory", and a ticket older than the recording says so once.
// deleteTicket keeps the history file on purpose, as the state directory keeps the jobs.
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FactoryError } from './errors.js';
import { TERMINAL_STATES, type JobState } from './jobs.js';
import { WORKSPACE_NAME_DESCRIPTION, WORKSPACE_NAME_PATTERN } from './registry.js';
import { TICKET_DESCRIPTION, TICKET_PATTERN } from './task-file.js';

// created: New ticket on the dashboard (you); written: write_task of the Context owner;
// edited: Save on the planned ticket page (you); fix_added: a "## Fix N" of the factory.
export const RECORDED_KINDS = ['created', 'written', 'edited', 'fix_added'] as const;
export type RecordedKind = (typeof RECORDED_KINDS)[number];
export const ACTORS = ['you', 'context_owner', 'factory'] as const;
export type Actor = (typeof ACTORS)[number];

export interface HistoryEvent {
  ts: string;
  kind: RecordedKind;
  by: Actor;
  // The sha256 of the Task file's text the write left.
  sha256: string;
  // fix_added: the N of "## Fix N".
  fix?: number;
}

export type TimelineKind = RecordedKind | 'checked' | 'started' | 'changed_outside' | 'note';

// One line of the page's History, newest first; ts null for the note on older tickets.
export interface TimelineEntry {
  ts: string | null;
  kind: TimelineKind;
  by: Actor | null;
  text: string;
}

// The current Task file, for "Changed outside the factory": its sha256 and its modification time.
export interface CurrentTask {
  sha256: string;
  mtime: string;
}

export const HISTORY_FILE = 'history.jsonl';
export const OLDER_NOTE = 'Older steps were not recorded; they are known only from checks and jobs.';
// An archived job directory of the ticket: <ticket>.<YYYYMMDDTHHMMSSZ> (JobStore.archive).
const ARCHIVED_JOB_STAMP = /^\d{8}T\d{6}Z$/;
const SHA256 = /^[0-9a-f]{64}$/;

// "1 blocker", "2 blockers".
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
// " · $0.48" of a cost, or nothing when it is not known.
const money = (cost: unknown): string => (typeof cost === 'number' && Number.isFinite(cost) ? ` · $${cost.toFixed(2)}` : '');

// The History's label of a recorded write.
function recordedText(event: HistoryEvent): string {
  switch (event.kind) {
    case 'created':
      return 'Created by you';
    case 'written':
      return 'Plan written by the Context owner (ChatGPT)';
    case 'edited':
      return 'Edited by you';
    case 'fix_added':
      return event.fix !== undefined ? `Fix ${event.fix} added by the factory` : 'A Fix added by the factory';
  }
}

// Whether a parsed line is a recorded write: a known kind and actor, a time and a sha256.
function isEvent(value: unknown): value is HistoryEvent {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const event = value as Record<string, unknown>;
  return typeof event.ts === 'string' && !Number.isNaN(Date.parse(event.ts)) && RECORDED_KINDS.includes(event.kind as RecordedKind)
    && ACTORS.includes(event.by as Actor) && typeof event.sha256 === 'string' && SHA256.test(event.sha256)
    && (event.fix === undefined || (Number.isInteger(event.fix) && (event.fix as number) > 0));
}

// A JSON object file (a check record, a job.json), or undefined when it is missing or not one.
async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(path, 'utf8'));
    return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
  } catch { // missing or not JSON: undefined
    return undefined;
  }
}

// The sorted entries of a directory; none when it is missing.
async function sortedEntries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch { // a missing directory: no entries
    return [];
  }
}

export class TicketHistory {
  readonly #stateDir: string;
  readonly #now: () => Date;

  constructor(stateDir: string, now: () => Date = () => new Date()) {
    this.#stateDir = stateDir;
    this.#now = now;
  }

  // <state>/tickets/<ws>/<ticket>/history.jsonl, both names checked.
  path(workspace: string, ticket: string): string {
    if (!WORKSPACE_NAME_PATTERN.test(workspace)) {
      throw new FactoryError('invalid_name', `workspace name must be ${WORKSPACE_NAME_DESCRIPTION}.`);
    }
    if (!TICKET_PATTERN.test(ticket)) {
      throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}.`);
    }
    return join(this.#stateDir, 'tickets', workspace, ticket, HISTORY_FILE);
  }

  // One line, one appendFile call: lines of concurrent appends never interleave.
  async append(workspace: string, ticket: string, event: Omit<HistoryEvent, 'ts'>): Promise<void> {
    const path = this.path(workspace, ticket);
    const line: HistoryEvent = { ts: this.#now().toISOString(), kind: event.kind, by: event.by, sha256: event.sha256, ...(event.fix !== undefined ? { fix: event.fix } : {}) };
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  // The recorded events in the order they were written; a line that is not one is skipped, a
  // missing file is none.
  async read(workspace: string, ticket: string): Promise<HistoryEvent[]> {
    let text: string;
    try {
      text = await readFile(this.path(workspace, ticket), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    const events: HistoryEvent[] = [];
    for (const line of text.split('\n')) {
      try {
        const value: unknown = JSON.parse(line);
        if (isEvent(value)) {
          events.push(value);
        }
      } catch { // not a line of the history (a cut last line): skipped
      }
    }
    return events;
  }

  // Every stored Task check of the ticket (one per checked version), as "checked" entries.
  async #checks(workspace: string, ticket: string): Promise<TimelineEntry[]> {
    const dir = join(this.#stateDir, 'checks', workspace, ticket);
    const entries: TimelineEntry[] = [];
    for (const name of (await sortedEntries(dir)).filter((entry) => /^[0-9a-f]{16}\.json$/.test(entry))) {
      const record = await readJson(join(dir, name));
      if (record === undefined || record.workspace !== workspace || record.ticket !== ticket || typeof record.ended_at !== 'string') {
        continue;
      }
      const output = record.output as { verdict?: unknown; findings?: Array<{ severity?: unknown }> } | null | undefined;
      let text: string;
      if (record.status !== 'checked' || output === null || typeof output !== 'object') {
        text = `Check failed${money(record.cost_usd)}`;
      } else if (output.verdict === 'ready') {
        text = `Checked: ready${money(record.cost_usd)}`;
      } else {
        const findings = Array.isArray(output.findings) ? output.findings : [];
        const count = (severity: string): number => findings.filter((item) => item?.severity === severity).length;
        text = `Checked: not ready (${plural(count('blocker'), 'blocker')}, ${plural(count('major'), 'major')})${money(record.cost_usd)}`;
      }
      entries.push({ ts: record.ended_at, kind: 'checked', by: 'factory', text });
    }
    return entries;
  }

  // Every job of the ticket, the current one and the archived ones, as "started" entries; a
  // directory whose job.json names another ticket (ticket names may contain a dot) is not one.
  async #jobs(workspace: string, ticket: string): Promise<TimelineEntry[]> {
    const dir = join(this.#stateDir, 'jobs', workspace);
    const entries: TimelineEntry[] = [];
    for (const name of await sortedEntries(dir)) {
      if (name !== ticket && !(name.startsWith(`${ticket}.`) && ARCHIVED_JOB_STAMP.test(name.slice(ticket.length + 1)))) {
        continue;
      }
      const job = await readJson(join(dir, name, 'job.json'));
      if (job === undefined || job.workspace !== workspace || job.ticket !== ticket || typeof job.created_at !== 'string' || typeof job.state !== 'string') {
        continue;
      }
      const ended = TERMINAL_STATES.includes(job.state as JobState);
      entries.push({ ts: job.created_at, kind: 'started', by: 'you', text: `Started as a job (${ended ? 'ended' : 'now'}: ${job.state})` });
    }
    return entries;
  }

  // The page's History, newest first: the recorded writes, the checks and the jobs; "Changed
  // outside the factory" when the current file is not the version the last recorded write left;
  // the note on older tickets last, once.
  async timeline(workspace: string, ticket: string, current?: CurrentTask): Promise<TimelineEntry[]> {
    const recorded = await this.read(workspace, ticket);
    const checksAndJobs = [...(await this.#checks(workspace, ticket)), ...(await this.#jobs(workspace, ticket))];
    const entries: TimelineEntry[] = [...recorded.map((event): TimelineEntry => ({ ts: event.ts, kind: event.kind, by: event.by, text: recordedText(event) })), ...checksAndJobs];
    const last = recorded.at(-1);
    if (current !== undefined && last !== undefined && last.sha256 !== current.sha256) {
      entries.push({ ts: current.mtime, kind: 'changed_outside', by: null, text: 'Changed outside the factory' });
    }
    const time = (entry: TimelineEntry): number => Date.parse(entry.ts ?? '') || 0;
    entries.sort((a, b) => time(b) - time(a));
    // Older than the recording, conservatively: nothing recorded, a first recorded write that is not
    // the ticket's creation by New ticket (a write_task, a Save or a Fix of a Task file made before
    // the recording; a ticket write_task creates afresh is marked too, as the line cannot tell
    // them apart), or a check or job before the first recorded write.
    const first = recorded[0];
    const older = first === undefined || first.kind !== 'created' || checksAndJobs.some((entry) => time(entry) < Date.parse(first.ts));
    if (older) {
      entries.push({ ts: null, kind: 'note', by: null, text: OLDER_NOTE });
    }
    return entries;
  }
}
