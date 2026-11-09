// sf metrics: what the Codex gate cost and what its items were worth, per job and in
// total, read from the state directory without sf serve: every job directory of the workspace (or
// of every workspace), current and archived, with its job.json, each iteration's gate.json and
// gate-level.json, and ledger.json. Unreadable files never stop it: each counts once in the
// unreadable records.
import { GATE_REVIEWER } from './gate.js';
import type { GateLevel } from './gate-level.js';
import { type GateLevelRecord, type GateRecord, type JobDir, JobStore } from './jobs.js';
import type { LedgerEntry, LedgerStatus } from './ledger.js';
import type { ReviewItem, Severity } from './review.js';

export const OUTCOMES = ['fixed', 'contested', 'accepted', 'nit', 'open'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type Outcomes = Record<Outcome, number>;

// The gate level of one iteration as the levels column shows it: F full, L light that ran, l light
// skipped, - none, · no gate decision (a Claude fix verdict, SF_GATE=off, an iteration without gate-level.json),
// ? a gate.json or gate-level.json that cannot be read.
export const LEVEL_MARKS = { full: 'F', light: 'L', light_skipped: 'l', none: '-', undecided: '·', unreadable: '?' } as const;

export interface JobMetrics {
  workspace: string;
  ticket: string;
  // The job's directory name (<ticket>, or <ticket>.<stamp> when archived).
  dir: string;
  archived: boolean;
  // The day the job was created (YYYY-MM-DD, UTC).
  started: string;
  state: string;
  iterations: number;
  // One mark per iteration (LEVEL_MARKS).
  levels: string[];
  // Every gate.json of the job, failed runs included.
  gate_runs: number;
  gate_tokens: number;
  items: Outcomes;
  // fixed over every gate item (nits included), as a percentage; null when the gate had no items.
  yield: number | null;
}

export interface MetricsTotals {
  jobs: number;
  gate_runs: number;
  gate_tokens: number;
  items: Outcomes;
  yield: number | null;
  // The iterations at each level and their share (a percentage) of the iterations with a gate
  // decision; share null when there are none.
  levels: Record<GateLevel, { iterations: number; share: number | null }>;
  // The files that could not be read or parsed (job.json, ledger.json, gate.json, gate-level.json).
  unreadable: number;
}

export interface Metrics {
  jobs: JobMetrics[];
  totals: MetricsTotals;
}

export interface MetricsOptions {
  // Only this workspace's jobs; every workspace when undefined.
  workspace?: string;
  // Only jobs created on or after this day (YYYY-MM-DD).
  since?: string;
}

const noOutcomes = (): Outcomes => ({ fixed: 0, contested: 0, accepted: 0, nit: 0, open: 0 });
const sum = (items: Outcomes): number => OUTCOMES.reduce((total, outcome) => total + items[outcome], 0);
const percent = (part: number, whole: number): number | null => (whole === 0 ? null : Math.round((part / whole) * 1000) / 10);

// The outcome of one gate item by the severity and the status of its ledger entry (none: no
// entry); the first rule that matches wins.
export function outcomeOf(severity: Severity, status: LedgerStatus | undefined): Outcome {
  if (severity === 'nit') {
    return 'nit';
  }
  if (status === 'fixed' || status === 'user_fix') {
    return 'fixed';
  }
  if (status === 'contested') {
    return 'contested';
  }
  // left is normally a nit's answer, counted as nit above; on a blocker or major it is accepted.
  if (status === 'accepted_risk' || status === 'left') {
    return 'accepted';
  }
  return 'open';
}

// The ledger entry of a reviewer's item of an iteration (the gate's by default), as
// src/job-stream.ts finds it: that reviewer's entry of the same iteration, path and problem; else
// the entry its reopens names (another reviewer's too: raised again); else none.
export function entryOf(ledger: readonly LedgerEntry[], iteration: number, item: ReviewItem, reviewer: string = GATE_REVIEWER): LedgerEntry | undefined {
  const own = ledger.find((entry) => entry.reviewer === reviewer && entry.iteration === iteration && entry.path === item.path && entry.problem === item.problem);
  if (own !== undefined) {
    return own;
  }
  const reopens = item.reopens ?? '';
  return reopens === '' ? undefined : ledger.find((entry) => entry.id === reopens);
}

// A gate.json read and shaped as a record (a verdict with its items array, or a failed run).
function usableGate(record: GateRecord): boolean {
  if (typeof record !== 'object' || record === null) {
    return false;
  }
  return !('verdict' in record) || Array.isArray(record.items);
}

// A read that cannot fail: its value, or not ok when it threw (a file that cannot be read or parsed).
async function readOr<T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await read() };
  } catch {
    return { ok: false };
  }
}

// The metrics of one job directory; unreadable counts its files that could not be read.
async function jobMetrics(store: JobStore, dir: JobDir & { job: NonNullable<JobDir['job']> }): Promise<{ metrics: JobMetrics; unreadable: number; levels: GateLevel[] }> {
  const { job } = dir;
  let unreadable = 0;
  const ledgerRead = await readOr(() => store.readLedger(dir.workspace, dir.name));
  if (!ledgerRead.ok) {
    unreadable += 1;
  }
  const ledger = ledgerRead.ok ? ledgerRead.value : [];
  const marks: string[] = [];
  const decided: GateLevel[] = [];
  let runs = 0;
  // Counted once per ledger entry; an item without one once per occurrence.
  const byEntry = new Map<string, Outcome>();
  const items = noOutcomes();
  for (let number = 1; number <= job.iteration; number += 1) {
    const level = await readOr<GateLevelRecord | undefined>(() => store.readGateLevel(dir.workspace, dir.name, number));
    const gate = await readOr<GateRecord | undefined>(() => store.readGate(dir.workspace, dir.name, number));
    const gateOk = gate.ok && (gate.value === undefined || usableGate(gate.value));
    unreadable += (level.ok ? 0 : 1) + (gateOk ? 0 : 1);
    if (!level.ok || !gateOk) {
      marks.push(LEVEL_MARKS.unreadable);
      continue;
    }
    const record = level.value;
    if (record === undefined) {
      marks.push(LEVEL_MARKS.undecided);
    } else {
      decided.push(record.level);
      marks.push(record.level === 'light' && !record.ran ? LEVEL_MARKS.light_skipped : LEVEL_MARKS[record.level]);
    }
    const run = gate.ok ? gate.value : undefined;
    if (run === undefined) {
      continue;
    }
    runs += 1;
    if (!('verdict' in run)) {
      continue;
    }
    for (const item of run.items) {
      const entry = ledgerRead.ok ? entryOf(ledger, number, item) : undefined;
      // An invalid ledger leaves every item open.
      const outcome = ledgerRead.ok ? outcomeOf(entry?.severity ?? item.severity ?? 'major', entry?.status) : 'open';
      if (entry !== undefined) {
        byEntry.set(entry.id, outcome);
      } else {
        items[outcome] += 1;
      }
    }
  }
  for (const outcome of byEntry.values()) {
    items[outcome] += 1;
  }
  return {
    metrics: {
      workspace: dir.workspace, ticket: job.ticket, dir: dir.name, archived: dir.archived, started: job.created_at.slice(0, 10), state: job.state,
      iterations: job.iteration, levels: marks, gate_runs: runs, gate_tokens: job.gate_tokens, items, yield: percent(items.fixed, sum(items)),
    },
    unreadable,
    levels: decided,
  };
}

// The metrics of the jobs of the state directory's JobStore, sorted by workspace, start and ticket.
export async function collectMetrics(store: JobStore, options: MetricsOptions = {}): Promise<Metrics> {
  const jobs: JobMetrics[] = [];
  const levelCounts: Record<GateLevel, number> = { full: 0, light: 0, none: 0 };
  let unreadable = 0;
  for (const dir of await store.listAll()) {
    if (options.workspace !== undefined && dir.workspace !== options.workspace) {
      continue;
    }
    const { job } = dir;
    if (job === undefined) {
      unreadable += 1;
      continue;
    }
    if (options.since !== undefined && job.created_at.slice(0, 10) < options.since) {
      continue;
    }
    const one = await jobMetrics(store, { ...dir, job });
    jobs.push(one.metrics);
    unreadable += one.unreadable;
    for (const level of one.levels) {
      levelCounts[level] += 1;
    }
  }
  jobs.sort((a, b) => a.workspace.localeCompare(b.workspace) || a.started.localeCompare(b.started) || a.dir.localeCompare(b.dir));
  const items = noOutcomes();
  for (const job of jobs) {
    for (const outcome of OUTCOMES) {
      items[outcome] += job.items[outcome];
    }
  }
  const decided = levelCounts.full + levelCounts.light + levelCounts.none;
  const share = (level: GateLevel): { iterations: number; share: number | null } => ({ iterations: levelCounts[level], share: percent(levelCounts[level], decided) });
  return {
    jobs,
    totals: {
      jobs: jobs.length,
      gate_runs: jobs.reduce((total, job) => total + job.gate_runs, 0),
      gate_tokens: jobs.reduce((total, job) => total + job.gate_tokens, 0),
      items,
      yield: percent(items.fixed, sum(items)),
      levels: { full: share('full'), light: share('light'), none: share('none') },
      unreadable,
    },
  };
}

const shown = (value: number | null): string => (value === null ? '-' : `${value}%`);

// The table of sf metrics: one row per job, then the totals and the unreadable records.
export function metricsLines(metrics: Metrics): string[] {
  const cells = [
    ['WORKSPACE', 'TICKET', 'STARTED', 'STATE', 'ITER', 'LEVELS', 'RUNS', 'TOKENS', 'FIXED', 'CONTESTED', 'ACCEPTED', 'NIT', 'OPEN', 'YIELD'],
    ...metrics.jobs.map((job) => [
      job.workspace, job.archived ? `${job.ticket} (archived)` : job.ticket, job.started, job.state, String(job.iterations), job.levels.join(' '),
      String(job.gate_runs), String(job.gate_tokens), ...OUTCOMES.map((outcome) => String(job.items[outcome])), shown(job.yield),
    ]),
  ];
  const widths = cells[0]!.map((_, column) => Math.max(...cells.map((row) => row[column]!.length)));
  const rows = metrics.jobs.length === 0 ? ['No jobs.'] : cells.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd());
  const { totals } = metrics;
  const levels = (['full', 'light', 'none'] as const).map((level) => `${level} ${totals.levels[level].iterations} (${shown(totals.levels[level].share)})`).join(', ');
  return [
    ...rows,
    '',
    `jobs: ${totals.jobs}`,
    `gate runs: ${totals.gate_runs}`,
    `gate tokens: ${totals.gate_tokens}`,
    `gate items: ${OUTCOMES.map((outcome) => `${outcome} ${totals.items[outcome]}`).join(', ')}`,
    `gate yield: ${shown(totals.yield)}`,
    `gate levels: ${levels}`,
    `unreadable records: ${totals.unreadable}`,
  ];
}
