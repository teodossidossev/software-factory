// A state directory for in-process Dashboard tests: two jobs (T-1 awaiting_review with one
// published iteration and its events, T-0 failed) and a running Dashboard over it.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type DashboardActions, type DashboardDigests, type DashboardQueue, type DashboardSetup, type RunningDashboard, startDashboard } from '../../src/dashboard.js';
import { type EventRecord, type Job, type JobState, JobStore } from '../../src/jobs.js';
import { temp } from './harness.js';

const stateRecord = (from: JobState | null, to: JobState, ts: string): EventRecord => ({ ts, iteration: 0, state: { from, to } });

export interface Fixture {
  state: string;
  jobs: JobStore;
  job: Job;
}

export async function fixture(name: string): Promise<Fixture> {
  const state = join(temp, name);
  await mkdir(state, { recursive: true });
  const jobs = new JobStore(state);
  const job: Job = {
    workspace: 'app', ticket: 'T-1', branch: 'T-1-demo', base: 'main', base_commit: null, target_commit: null,
    worktree: null, prepared_commit: null, mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state: 'awaiting_review', iteration: 1, session_id: 's1', mr: null,
    created_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-11-01T10:05:00.000Z',
  };
  await jobs.write(job);
  await jobs.write({ ...job, ticket: 'T-0', branch: 'T-0-old', state: 'failed', iteration: 0, error: { code: 'start_failed', message: 'Git failed.' } });
  await jobs.appendEvent('app', 'T-1', stateRecord(null, 'starting', '2026-11-01T10:00:00.000Z'));
  await jobs.appendEvent('app', 'T-1', stateRecord('starting', 'working', '2026-11-01T10:00:01.000Z'));
  await jobs.appendEvent('app', 'T-1', { ts: '2026-11-01T10:00:02.000Z', iteration: 0, prompt: '/implement .software-factory/T-1.md' });
  await jobs.appendEvent('app', 'T-1', {
    ts: '2026-11-01T10:00:03.000Z', iteration: 0,
    message: { type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
  });
  await jobs.appendEvent('app', 'T-1', { ts: '2026-11-01T10:04:00.000Z', iteration: 0, message: { type: 'result', subtype: 'success', total_cost_usd: 0.5, duration_ms: 2000, num_turns: 3 } });
  await jobs.appendEvent('app', 'T-1', stateRecord('working', 'awaiting_review', '2026-11-01T10:05:00.000Z'));
  await jobs.writeIteration('app', 'T-1', {
    report: '# Report: T-1, iteration 1\n## Done\nThings.\n',
    patch: Buffer.from('diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-hello\n+hello world\n'),
    meta: {
      iteration: 1, started_at: '2026-11-01T10:00:01.000Z', ended_at: '2026-11-01T10:05:00.000Z', denials: ['Bash'],
      changed_files: [{ path: 'README.md', added: 1, removed: 1 }], patch_truncated: false, submodule_changed: [],
      cost_usd: 0.5, cost_usd_total: 0.5, duration_ms: 2000,
    },
  });
  return { state, jobs, job };
}

export async function withDashboard(
  name: string,
  actions: DashboardActions,
  work: (dashboard: RunningDashboard, store: Fixture) => Promise<void>,
  setup?: DashboardSetup,
  options: { queue?: DashboardQueue; digests?: DashboardDigests } = {},
): Promise<void> {
  const store = await fixture(name);
  const dashboard = await startDashboard(0, store.state, store.jobs, actions, setup, options);
  try {
    await work(dashboard, store);
  } finally {
    await dashboard.close();
  }
}
