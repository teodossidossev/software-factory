// The Stats page's arm tables (src/stats.ts): the jobs started in the period split in two by a
// field of their job.json, each arm measured as ArmRow. The Claude review experiment
// (claude_review on or off), the fix session (fix_session fresh or resume) and the recurring
// findings checklist (findings_checklist a sha or null); a job without the field is in neither
// arm of that table.
import { type Job, type JobState, statesWith } from './jobs.js';
import type { TaskFixSession } from './task-file.js';

const DELIVERED_STATES = statesWith('delivered');

// One arm of the Claude review experiment: the jobs started in the period whose
// claude_review is true (on) or false (off).
export interface ArmRow {
  arm: 'on' | 'off';
  jobs: number;
  // In pushed or handed_over.
  delivered: number;
  aborted: number;
  // The sum of its jobs' JobRow.cost_usd; false when one of them is incomplete.
  cost_usd: number;
  cost_complete: boolean;
  // null with none delivered.
  usd_per_delivered: number | null;
  // Of the delivered jobs; null with none.
  median_iterations: number | null;
  // The Codex gate's blockers and majors of its jobs (JobRow.codex).
  codex_findings: number;
  // null with no job.
  codex_findings_per_job: number | null;
}

// One arm of the fix session comparison: the jobs started in the period whose job.json has
// fix_session fresh or resume, measured as ArmRow, by mean_iterations (of all its jobs; null with
// no job) and by the Implementer's cost per fix round (an iteration after the first: its meta.json
// cost_usd), the sum of the known costs over every fix round (null with none); fix_round_complete
// false when a round's cost is unknown, fix_round_usd then a lower bound.
export interface FixSessionArmRow extends Omit<ArmRow, 'arm'> {
  arm: TaskFixSession;
  mean_iterations: number | null;
  fix_round_usd: number | null;
  fix_round_complete: boolean;
}

// One arm of the recurring findings checklist comparison: the jobs started in the period whose
// job.json has findings_checklist, a sha (with) or null (without), measured as ArmRow, by the
// Codex gate's fix verdicts (its gate.json records with verdict fix; per job null with no job),
// by mean_iterations (of all its jobs; null with no job) and by the Implementer's cost: the sum
// of its jobs' known meta.json costs (implementer_complete false when one is unknown or an
// iteration has no ended meta.json, the sum then a lower bound), per delivered job (null with
// none delivered).
export interface FindingsChecklistArmRow extends Omit<ArmRow, 'arm'> {
  arm: 'with' | 'without';
  codex_fix_verdicts: number;
  codex_fix_verdicts_per_job: number | null;
  mean_iterations: number | null;
  implementer_usd: number;
  implementer_complete: boolean;
  implementer_usd_per_delivered: number | null;
}

// A job row as the arms read it: src/stats.ts JobRow with its job.json and what its directory
// holds (fix round costs, gate verdicts, costs by role).
export interface ArmJob {
  state: JobState;
  created_at: string;
  iterations: number;
  cost_usd: number;
  cost_complete: boolean;
  codex: { blocker: number; major: number };
  claude_review: boolean | null;
  data: {
    job: Pick<Job, 'fix_session' | 'findings_checklist'>;
    summary: {
      fixRounds: ReadonlyArray<number | null>;
      gates: ReadonlyMap<number, { fix: boolean }>;
      costs: ReadonlyArray<{ role: string; cost: number | null }>;
    };
  };
}

type InPeriod = (ts: unknown) => boolean;

// The median of the values: the mean of the middle two of an even count; null of none.
export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const meanIterations = (jobs: readonly ArmJob[]): number | null => (jobs.length === 0 ? null : jobs.reduce((total, row) => total + row.iterations, 0) / jobs.length);

// The arms of the Claude review experiment, on then off: the job rows started in the
// period with claude_review true or false, before the job list is cut to MAX_JOB_ROWS.
export function armRows(rows: readonly ArmJob[], inPeriod: InPeriod): ArmRow[] {
  return (['on', 'off'] as const).map((arm) => armRow(arm, rows.filter((row) => row.claude_review === (arm === 'on') && inPeriod(row.created_at))));
}

// The fix session arms, fresh then resume, as armRows: the job rows with that fix_session.
export function fixSessionArmRows(rows: readonly ArmJob[], inPeriod: InPeriod): FixSessionArmRow[] {
  return (['fresh', 'resume'] as const).map((arm): FixSessionArmRow => {
    const jobs = rows.filter((row) => row.data.job.fix_session === arm && inPeriod(row.created_at));
    const rounds = jobs.flatMap((row) => row.data.summary.fixRounds);
    return {
      ...armRow(arm, jobs),
      mean_iterations: meanIterations(jobs),
      fix_round_usd: rounds.length === 0 ? null : rounds.reduce((total: number, cost) => total + (cost ?? 0), 0) / rounds.length,
      fix_round_complete: rounds.every((cost) => cost !== null),
    };
  });
}

// The recurring findings checklist arms, with then without, as armRows: the job rows whose
// findings_checklist is a sha or null; one without the field is in neither.
export function findingsChecklistArmRows(rows: readonly ArmJob[], inPeriod: InPeriod): FindingsChecklistArmRow[] {
  return (['with', 'without'] as const).map((arm): FindingsChecklistArmRow => {
    const jobs = rows.filter((row) => {
      const checklist = row.data.job.findings_checklist;
      return checklist !== undefined && (checklist !== null) === (arm === 'with') && inPeriod(row.created_at);
    });
    const shared = armRow(arm, jobs);
    const fixVerdicts = jobs.reduce((total, row) => total + [...row.data.summary.gates.values()].filter((gate) => gate.fix).length, 0);
    const implementerOf = (row: ArmJob) => row.data.summary.costs.filter((cost) => cost.role === 'implementer');
    const implementer = jobs.flatMap(implementerOf);
    const implementerUsd = implementer.reduce((total, cost) => total + (cost.cost ?? 0), 0);
    // An iteration without an ended meta.json (running, missing or unreadable) has no cost entry: unknown.
    const implementerComplete = implementer.every((cost) => cost.cost !== null) && jobs.every((row) => implementerOf(row).length === row.iterations);
    return {
      ...shared,
      codex_fix_verdicts: fixVerdicts,
      codex_fix_verdicts_per_job: jobs.length === 0 ? null : fixVerdicts / jobs.length,
      mean_iterations: meanIterations(jobs),
      implementer_usd: implementerUsd,
      implementer_complete: implementerComplete,
      implementer_usd_per_delivered: shared.delivered === 0 ? null : implementerUsd / shared.delivered,
    };
  });
}

// An arm's ArmRow measures over its job rows.
function armRow<A extends string>(arm: A, jobs: readonly ArmJob[]): Omit<ArmRow, 'arm'> & { arm: A } {
  const delivered = jobs.filter((row) => DELIVERED_STATES.includes(row.state));
  const cost = jobs.reduce((total, row) => total + row.cost_usd, 0);
  const findings = jobs.reduce((total, row) => total + row.codex.blocker + row.codex.major, 0);
  return {
    arm, jobs: jobs.length, delivered: delivered.length, aborted: jobs.filter((row) => row.state === 'aborted').length,
    cost_usd: cost, cost_complete: jobs.every((row) => row.cost_complete), usd_per_delivered: delivered.length === 0 ? null : cost / delivered.length,
    median_iterations: median(delivered.map((row) => row.iterations)), codex_findings: findings, codex_findings_per_job: jobs.length === 0 ? null : findings / jobs.length,
  };
}
