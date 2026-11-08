// The seam of SF-143: a part of the job lifecycle is built from its ports alone, without Core and
// without the other parts. StatusPart takes a real JobStore on a temporary directory and hand-made
// fakes of its other ports; its check and status read through them.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Config } from '../src/config.js';
import { FactoryError } from '../src/errors.js';
import { GATE_REVIEWER } from '../src/gate.js';
import { type Job, JobStore } from '../src/jobs.js';
import { REVIEWER } from '../src/review.js';
import type { JobStorePort, LivePort, SettingsPort } from '../src/execution/ports.js';
import type { RunningReview } from '../src/execution/shared.js';
import { StatusPart } from '../src/execution/status.js';

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function job(ticket: string, extra: Partial<Job> = {}): Job {
  const at = '2026-11-08T10:00:00.000Z';
  return {
    workspace: 'app', ticket, branch: `${ticket}-x`, base: 'main', base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
    mr_attempts: 0, mr_conflict_turn: false, state: 'working', iteration: 0, fixes: 0, gate_fixes: 0, gate_tokens: 0, session_id: null,
    created_at: at, updated_at: at, mr: null, ...extra,
  } as Job;
}

// The ports StatusPart takes: the job store over a real JobStore, the running reviews and the
// settings, each by hand. What StatusPart must not call throws.
async function ports(reviews: Map<string, RunningReview> = new Map()): Promise<{ jobs: JobStore; store: JobStorePort; sessions: LivePort; settings: SettingsPort }> {
  const root = await mkdtemp(join(tmpdir(), 'sf-execution-ports-'));
  roots.push(root);
  const jobs = new JobStore(root);
  const refused = (what: string) => (): never => {
    throw new Error(`StatusPart called ${what}`);
  };
  const store: JobStorePort = {
    jobs,
    job: async (workspace, ticket) => {
      const found = await jobs.read(workspace, ticket);
      if (found === undefined) {
        throw new FactoryError('job_not_found', `There is no job for ${workspace}/${ticket}.`);
      }
      return found;
    },
    transition: refused('transition'),
  };
  const sessions: LivePort = { live: new Map(), reviews, appendLive: refused('appendLive'), afterSession: refused('afterSession') };
  const config = { stateDir: root, checkAfterStartMin: 15, checkAfterFixMin: 5, review: true, gate: { on: true } } as Config;
  const settings: SettingsPort = { config, handbook: '', resolve: refused('resolve'), maxRunning: undefined };
  return { jobs, store, sessions, settings };
}

async function publish(jobs: JobStore, ticket: string, report: string): Promise<void> {
  const at = '2026-11-08T10:30:00.000Z';
  await jobs.writeIteration('app', ticket, {
    report, patch: Buffer.from('diff --git a/x b/x\n'),
    meta: { iteration: 1, started_at: at, ended_at: at, denials: [], changed_files: [], patch_truncated: false, submodule_changed: [], cost_usd: null, cost_usd_total: null, duration_ms: null },
  });
}

test('StatusPart is built from its ports alone: status lists the store\'s jobs and reads one through the job store port', async () => {
  const { jobs, store, sessions, settings } = await ports();
  await jobs.write(job('A-1'));
  await jobs.write(job('A-2', { state: 'needs_human', iteration: 1 }));
  const status = new StatusPart(store, sessions, settings);
  assert.deepEqual((await status.status()).map((one) => one.ticket).sort(), ['A-1', 'A-2']);
  assert.deepEqual((await status.status('app', 'A-2')).map((one) => one.state), ['needs_human']);
  await assert.rejects(status.status('app', 'A-3'), { code: 'job_not_found' });
});

test('check takes its wait from the settings port: the start\'s before the first iteration, the Fix\'s after', async () => {
  const { jobs, store, sessions, settings } = await ports();
  await jobs.write(job('B-1'));
  await jobs.write(job('B-2', { iteration: 1 }));
  const status = new StatusPart(store, sessions, settings);
  const first = await status.check('app', 'B-1');
  assert.equal(first.check_after_minutes, 15);
  assert.equal(first.report, undefined);
  assert.equal((await status.check('app', 'B-2')).check_after_minutes, 5);
});

test('check reads the running review from the live port, the Report from the job store, and the gate\'s status with the review settings', async () => {
  const reviews = new Map<string, RunningReview>([['app/C-1', { reviewer: REVIEWER, iteration: 1, controller: new AbortController() }]]);
  const { jobs, store, sessions, settings } = await ports(reviews);
  await jobs.write(job('C-1', { state: 'awaiting_review', iteration: 1 }));
  await publish(jobs, 'C-1', '# Report: C-1, iteration 1');
  const status = new StatusPart(store, sessions, settings);
  const result = await status.check('app', 'C-1');
  assert.equal(result.report, '# Report: C-1, iteration 1');
  assert.deepEqual(result.review, { status: 'running' });
  // Without the Claude review the gate's status shows; the running gate is the live port's.
  reviews.set('app/C-1', { reviewer: GATE_REVIEWER, iteration: 1, controller: new AbortController() });
  await jobs.write(job('C-1', { state: 'awaiting_review', iteration: 1, claude_review: false }));
  assert.deepEqual((await status.check('app', 'C-1')).review, { status: 'off', gate: { status: 'running' } });
  // With the review off in the settings, no gate status.
  const off = new StatusPart(store, sessions, { ...settings, config: { ...settings.config, review: false } });
  assert.deepEqual((await off.check('app', 'C-1')).review, { status: 'off' });
});
