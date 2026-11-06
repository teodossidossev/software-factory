// One morning digest run (SF-103, src/digest-run.ts) with a fake model on a temporary origin and
// read checkout: the output stored with the Git data, cost and period; an invalid output retried
// once, then the Git data stored with the error; the period from the last scheduled digest's end, the
// first one 24 hours; old digests deleted; digest_running for a second run; the notification of a
// scheduled run (counts only); and the model call's options: no tools but the structured output, no
// setting sources, the empty cwd. Then sf serve's timer, sf digest --now and sf digest through the
// socket, with the fake Claude as the model.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { dailyDays, DIGEST_SCHEMA, type DigestModel, type DigestOutput, Digests, digestSessionOptions, stamp } from '../src/digest-run.js';
import type { Notification } from '../src/notify.js';
import { saveRegistry } from '../src/registry.js';
import { readOnlySessionOptions } from '../src/review.js';
import { newEnv, newRepo, reviewLog, reviewScript, runCli, serve, stop } from './support/harness.js';

const ME = 'me@example.invalid';
let temp: string;
let checkout: string;
let web: string;
let count = 0;

function git(cwd: string, email: string, ...args: string[]): string {
  const date = new Date(Date.now() - 3_600_000).toISOString();
  return execFileSync('git', ['-c', 'user.name=Someone', '-c', `user.email=${email}`, '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

async function repo(name: string): Promise<string> {
  const seed = join(temp, `${name}-seed`);
  await mkdir(seed);
  git(seed, 'x@example.invalid', 'init', '-q', '-b', 'main');
  await writeFile(join(seed, 'README.md'), `# ${name}\n\nThe ${name} of the shop.\n`);
  git(seed, 'x@example.invalid', 'add', '.');
  execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@example.invalid', 'commit', '-q', '-m', 'Initial'], { cwd: seed, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
  const origin = join(temp, `${name}.git`);
  execFileSync('git', ['clone', '-q', '--bare', seed, origin]);
  // My branch starts before the colleague's change to the same file.
  const read = join(temp, name);
  execFileSync('git', ['clone', '-q', origin, read]);
  execFileSync('git', ['config', 'user.email', ME], { cwd: read });
  git(read, ME, 'switch', '-q', '-c', 'SHOP-8-mine');
  await writeFile(join(read, 'orders.ts'), 'export const orders = [1];\n');
  git(read, ME, 'add', '.');
  git(read, ME, 'commit', '-q', '-m', 'SHOP-8: My orders');
  const work = join(temp, `${name}-colleague`);
  execFileSync('git', ['clone', '-q', origin, work]);
  await writeFile(join(work, 'orders.ts'), 'export const orders = [];\n');
  git(work, 'colleague@example.invalid', 'add', '.');
  git(work, 'colleague@example.invalid', 'commit', '-q', '-m', 'SHOP-7: Add the orders\n\n## Why\n\nThe shop needs a list of the orders it took.');
  git(work, 'colleague@example.invalid', 'push', '-q', 'origin', 'main');
  return read;
}

before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'sf-digest-run-'));
  checkout = await repo('backend');
  web = await repo('frontend');
});

after(async () => {
  await rm(temp, { recursive: true, force: true });
});

const OUTPUT: DigestOutput = {
  repos: [{ name: 'backend', headline: 'The orders landed.', merged: [{ sha: 'abc', problem: 'The shop lists its orders.' }], branches: [], impact_on_me: ['SHOP-8 shares orders.ts.'] }],
  cross_repo: [{ ticket: 'SHOP-7', by_workspace: { backend: 'The list.', frontend: 'Nothing yet.' }, for_me: '' }],
  dailies: [{ app: 'shop', workspaces: ['backend', 'frontend'], yesterday: ['Worked on SHOP-8.'], problems: [], plan: [], next: ['Rebase SHOP-8.'] }],
};

interface Setup {
  digests: Digests;
  state: string;
  calls: Array<{ prompt: string; model: string; cwd: string }>;
  notifications: Notification[];
  clock: { now: Date };
}

// A state and config directory of its own; the model answers from outcomes in order.
async function setUp(outcomes: Array<Awaited<ReturnType<DigestModel>>>, now = new Date()): Promise<Setup> {
  count += 1;
  const state = join(temp, `state-${count}`);
  const config = join(temp, `config-${count}`);
  await saveRegistry({
    workspaces: {
      backend: { read_checkout: checkout, app: 'shop', digest: { track: true, my_work: true } },
      frontend: { read_checkout: web, app: 'shop', description: 'The shop\'s web front end.', digest: { track: true, my_work: true } },
      other: { read_checkout: checkout },
    },
    digest: { model: 'fake-model', language: 'Deutsch' },
  }, config);
  const calls: Setup['calls'] = [];
  const notifications: Notification[] = [];
  const clock = { now };
  const model: DigestModel = async (prompt, options) => {
    calls.push({ prompt, model: options.model, cwd: options.cwd });
    const outcome = outcomes.shift();
    assert.ok(outcome !== undefined, 'one model call too many');
    return outcome;
  };
  const digests = new Digests({
    stateDir: state, configDir: config, model, now: () => clock.now,
    notify: async (notification) => {
      notifications.push(notification);
      return [];
    },
  });
  return { digests, state, calls, notifications, clock };
}

const ok = (output: unknown = OUTPUT, costUsd = 0.25) => ({ ok: true as const, output: output as DigestOutput, costUsd, model: 'fake-model', startedAt: '', endedAt: '' });
const failed = (message: string) => ({ ok: false as const, message, model: null, startedAt: '', endedAt: '' });

test('a manual digest: the output stored with the Git data, the cost and a first period of 24 hours; the prompt and the counts', async () => {
  const fx = await setUp([ok()]);
  const result = await fx.digests.run('manual');
  const record: any = JSON.parse(await readFile(result.path, 'utf8'));
  assert.equal(result.path, join(fx.state, 'digest', `${result.id}.json`));
  assert.match(result.id, /^\d{8}T\d{6}Z-manual$/);
  assert.deepEqual(JSON.parse(JSON.stringify(result.record)), { ...record });
  assert.equal(result.cost_usd, 0.25);
  assert.deepEqual(record.output, OUTPUT);
  assert.equal(record.error, null);
  assert.equal(Date.parse(record.period.to) - Date.parse(record.period.from), 86_400_000);
  assert.equal(record.period.to, record.started_at);
  assert.deepEqual(record.daily_days, dailyDays(new Date(record.started_at)));
  assert.deepEqual([record.model, record.language, record.trigger], ['fake-model', 'Deutsch', 'manual']);
  // Only the workspaces with track or my_work; the description from the workspace, else from the repository.
  assert.deepEqual(record.workspaces.map((workspace: { name: string }) => workspace.name), ['backend', 'frontend']);
  const [backend, frontend] = record.workspaces;
  assert.deepEqual([backend.description, backend.description_source], ['The backend of the shop.', 'repository']);
  assert.deepEqual([frontend.description, frontend.description_source], ['The shop\'s web front end.', 'workspace']);
  assert.equal(backend.fetch.status, 'ok');
  assert.deepEqual(backend.git.landed.map((entry: { subject: string }) => entry.subject), ['SHOP-7: Add the orders']);
  assert.deepEqual(backend.git.branches.map((branch: { name: string; local: boolean; mine: boolean; overlap: string[] }) => [branch.name, branch.local, branch.mine, branch.overlap]), [['SHOP-8-mine', true, true, ['orders.ts']]]);
  // The counts from the Git data: one landed per followed workspace, my local branch in each.
  assert.deepEqual(record.counts, { landed: 2, live_branches: 2, impact: 2 });
  assert.deepEqual(record.daily_sources.map((source: { app: string; workspaces: string[] }) => [source.app, source.workspaces]), [['shop', ['backend', 'frontend']]]);
  // One model call with the settings' model, the rules and the data.
  assert.equal(fx.calls.length, 1);
  const [call] = fx.calls;
  assert.equal(call!.model, 'fake-model');
  assert.match(call!.prompt, /Short, plain sentences in Deutsch, one fact per sentence\./);
  // The whole prompt, rules and data, within the cap.
  assert.ok(call!.prompt.length <= 150_000);
  assert.match(call!.prompt, /the data wins/);
  assert.match(call!.prompt, /Mark a guess with "likely"/);
  const data = JSON.parse(/<git_data>\n(.*)\n<\/git_data>/s.exec(call!.prompt)![1]!);
  assert.deepEqual(data.apps, { shop: ['backend', 'frontend'] });
  assert.equal(data.workspaces[1].description, 'The shop\'s web front end.');
  assert.equal(data.workspaces[0].landed[0].why, 'The shop needs a list of the orders it took.');
  // The empty session directory.
  assert.equal(call!.cwd, join(fx.state, 'digest', 'session'));
  assert.deepEqual(await readdir(call!.cwd), []);
  // A manual run does not notify.
  assert.deepEqual(fx.notifications, []);
  assert.deepEqual((await fx.digests.list()).digests.map((summary) => [summary.id, summary.counts, summary.cost_usd, summary.error]), [[result.id, { landed: 2, live_branches: 2, impact: 2 }, 0.25, null]]);
});

test('an invalid output is retried once; a second failure stores the Git data with the error', async () => {
  const retried = await setUp([failed('The digest returned an invalid digest: repos: required'), ok(OUTPUT, 0.1)]);
  const first = await retried.digests.run('manual');
  assert.equal(retried.calls.length, 2);
  assert.deepEqual([first.record.output, first.record.error], [OUTPUT, null]);
  const broken = await setUp([failed('first'), failed('The digest ended with error_during_execution: boom')]);
  const second = await broken.digests.run('manual');
  assert.equal(broken.calls.length, 2);
  assert.equal(second.record.output, null);
  assert.equal(second.record.error, 'The digest ended with error_during_execution: boom');
  assert.equal(second.record.workspaces[0]!.git!.landed.length, 1);
  assert.equal(second.record.cost_usd, null);
});

test('the period starts at the last scheduled digest\'s end; a scheduled run notifies with counts only; a manual one uses the same from', async () => {
  // Near the commits, which are an hour old.
  const start = new Date(Math.floor(Date.now() / 1000) * 1000);
  const later = (hours: number): Date => new Date(start.getTime() + hours * 3_600_000);
  const fx = await setUp([ok(), ok(), ok()], start);
  const scheduled = await fx.digests.run('scheduled');
  assert.equal(scheduled.id, `${stamp(start)}-scheduled`);
  assert.deepEqual(fx.notifications, [{ title: 'Morning digest ready', body: 'Morning digest ready: 2 landed, 2 of mine need attention', priority: 'default', tags: 'newspaper' }]);
  fx.clock.now = later(2.5);
  const manual = await fx.digests.run('manual');
  assert.deepEqual(manual.record.period, { from: start.toISOString(), to: later(2.5).toISOString() });
  assert.equal(fx.notifications.length, 1);
  // The next scheduled one starts where the scheduled one ended, not the manual one.
  fx.clock.now = later(72);
  const monday = await fx.digests.run('scheduled');
  assert.equal(monday.record.period.from, start.toISOString());
  assert.equal(await fx.digests.scheduledSince(later(71)), true);
  assert.equal(await fx.digests.scheduledSince(later(73)), false);
  assert.deepEqual((await fx.digests.list()).digests.map((summary) => summary.id), [monday.id, manual.id, scheduled.id]);
});

test('a record is never overwritten: the same start gets -2; digests older than 60 days are deleted at the next run', async () => {
  const start = new Date('2026-11-06T07:00:00Z');
  const fx = await setUp([ok(), ok()], start);
  await mkdir(join(fx.state, 'digest'), { recursive: true });
  const old = join(fx.state, 'digest', '20260901T060000Z-scheduled.json');
  const recent = join(fx.state, 'digest', '20261001T060000Z-manual.json');
  for (const path of [old, recent]) {
    await writeFile(path, JSON.stringify({ trigger: 'scheduled', started_at: '2026-09-01T06:00:00.000Z', ended_at: '2026-09-01T06:01:00.000Z', period: { from: '2026-08-31T06:00:00.000Z', to: '2026-09-01T06:00:00.000Z' }, workspaces: [], cost_usd: null, error: null }));
  }
  const first = await fx.digests.run('manual');
  const second = await fx.digests.run('manual');
  assert.deepEqual([first.id, second.id], [`${stamp(start)}-manual`, `${stamp(start)}-manual-2`]);
  const files = (await readdir(join(fx.state, 'digest'))).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(files, ['20261001T060000Z-manual.json', `${stamp(start)}-manual-2.json`, `${stamp(start)}-manual.json`]);
});

test('digest_running: a second run is refused while one goes; the flag is cleared after a failure', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fx = await setUp([]);
  const slow = new Digests({
    stateDir: fx.state, configDir: join(temp, `config-${count}`), now: () => new Date(),
    model: async () => {
      await gate;
      return failed('no model');
    },
  });
  assert.deepEqual(slow.start('manual'), { started: true });
  assert.equal(slow.running, true);
  assert.equal((await slow.list()).running, true);
  await assert.rejects(slow.run('scheduled'), { code: 'digest_running' });
  assert.throws(() => slow.start('manual'), { code: 'digest_running' });
  release();
  for (let tries = 0; slow.running && tries < 200; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(slow.running, false);
  const [stored] = (await slow.list()).digests;
  assert.equal(stored!.error, 'no model');
  // A registry that cannot be read fails the run, and the next one may start.
  const broken = new Digests({ stateDir: fx.state, configDir: join(temp, 'no-such-config'), model: async () => ok(), now: () => new Date() });
  const bad = join(temp, 'bad-config');
  await mkdir(bad, { recursive: true });
  await writeFile(join(bad, 'workspaces.json'), '{');
  const failing = new Digests({ stateDir: fx.state, configDir: bad, model: async () => ok(), now: () => new Date() });
  await assert.rejects(failing.run('manual'), { code: 'registry_invalid' });
  assert.equal(failing.running, false);
  // No workspace that follows: the digest says so, no model call.
  const none = await broken.run('manual');
  assert.equal(none.record.error, 'No workspace is followed or has My daily on.');
});

test('the model call\'s options: no tools but the structured output, no setting sources, the empty cwd, three turns', () => {
  const signal = new AbortController().signal;
  const options = readOnlySessionOptions(digestSessionOptions('/state/digest/session', 'sonnet', '/bin/claude', signal), new AbortController(), DIGEST_SCHEMA);
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.cwd, '/state/digest/session');
  assert.equal(options.maxTurns, 3);
  assert.equal(options.model, 'sonnet');
  assert.equal(options.pathToClaudeCodeExecutable, '/bin/claude');
  assert.deepEqual(options.outputFormat, { type: 'json_schema', schema: DIGEST_SCHEMA });
  assert.equal(options.sandbox, undefined);
  assert.equal('$schema' in DIGEST_SCHEMA, false);
});

test('the daily\'s days: yesterday is the last working day (Friday on a Monday), today until now', () => {
  const monday = new Date(2026, 10, 9, 8, 15);
  const days = dailyDays(monday);
  assert.deepEqual(days.yesterday, { from: new Date(2026, 10, 6).toISOString(), to: new Date(2026, 10, 7).toISOString() });
  assert.deepEqual(days.today, { from: new Date(2026, 10, 9).toISOString(), to: monday.toISOString() });
  assert.equal(dailyDays(new Date(2026, 10, 4, 9)).yesterday.from, new Date(2026, 10, 3).toISOString());
});

test('sf serve starts the timer; sf digest --now and sf digest through the socket; digest_running through the socket', async () => {
  const env = await newEnv('digest-cli');
  const repo = await newRepo(env, 'digest-cli-repo', true);
  // Due at once: 00:00 every day, the workspace followed.
  await saveRegistry({ workspaces: { app: { read_checkout: repo, digest: { track: true, my_work: true } } }, digest: { at: '00:00', weekdays_only: false, model: 'fake-digest' } }, env.config);
  const output = { repos: [{ name: 'app', headline: 'Nothing landed.', merged: [], branches: [], impact_on_me: [] }], cross_repo: [], dailies: [] };
  await reviewScript(env, [{ output, delayMs: 3000, costTotal: 0.31 }, { output, costTotal: 0.27 }]);
  const before = (await stat(join(repo, '.git', 'index'))).mtimeMs;
  const served = await serve(env);
  try {
    // The scheduled run started by serve()'s timer is going: a second run is refused.
    const busy = await runCli(env, ['digest', '--now']);
    assert.equal(busy.code, 1);
    assert.match(busy.stderr, /^sf: A digest \(scheduled\) is running; it is not started twice\./);
    let files: string[] = [];
    for (let tries = 0; files.length === 0 && tries < 200; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      files = (await readdir(join(env.state, 'digest')).catch(() => [])).filter((name) => name.endsWith('.json'));
    }
    assert.match(files[0]!, /^\d{8}T\d{6}Z-scheduled\.json$/);
    const now = await runCli(env, ['digest', '--now']);
    assert.equal(now.code, 0, now.stderr);
    const [pathLine, costLine] = now.stdout.trim().split('\n');
    assert.match(pathLine!, new RegExp(`^digest: ${join(env.state, 'digest').replace(/[.]/g, '\\.')}/\\d{8}T\\d{6}Z-manual\\.json$`));
    assert.equal(costLine, 'cost: $0.2700');
    const latest = await runCli(env, ['digest']);
    assert.equal(latest.code, 0, latest.stderr);
    assert.match(latest.stdout, /^digest: \d{8}T\d{6}Z-manual\nperiod: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d to \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\nlanded: 0\nlive branches: 0\nmine need attention: 0\n$/);
    // The sessions: no tools but the structured output, no setting sources, the empty cwd.
    const sessions = await reviewLog(env);
    assert.equal(sessions.length, 2);
    for (const entry of sessions) {
      assert.equal(entry.cwd, join(env.state, 'digest', 'session'));
      assert.ok(entry.argv.includes('--model') || entry.argv.some((arg) => arg.startsWith('--model')), entry.argv.join(' '));
      const value = (name: string): string | undefined => {
        const index = entry.argv.indexOf(`--${name}`);
        return index >= 0 ? entry.argv[index + 1] : entry.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
      };
      assert.equal(value('tools'), '');
      assert.equal(value('setting-sources'), '');
      assert.equal(value('model'), 'fake-digest');
    }
    // The read checkout is untouched.
    assert.equal((await stat(join(repo, '.git', 'index'))).mtimeMs, before);
  } finally {
    await stop(served);
  }
});
