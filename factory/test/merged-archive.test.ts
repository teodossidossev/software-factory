// The pass of merged jobs (Execution.archiveMergedJobs): a pushed job without a merge request, or
// with a closed one, whose commit is on its target's history after a fetch of the target is logged
// merged_on_target and archived as the Done card's Archive does (its active Task file too); one
// not on it stays; a failed fetch leaves the jobs alone and is logged once. The pass never pulls,
// checks out or writes in the user's checkout: a git first on PATH records every command.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config.js';
import { Execution } from '../src/execution.js';
import { type Job, JobStore } from '../src/jobs.js';
import { resolveWorkspace } from '../src/registry.js';
import { Setup } from '../src/setup.js';
import { type Env, FAKE, git, newEnv, newRepo, putTask } from './support/harness.js';

const TIMEOUT = { timeout: 60_000 };

interface World {
  env: Env;
  repo: string;
  // A second clone of origin, where "someone else" merges on the host.
  other: string;
  execution: Execution;
  setup: Setup;
  jobs: JobStore;
}

function config(env: Env): Config {
  return {
    stateDir: env.state, checkAfterStartMin: 15, checkAfterFixMin: 5, maxTurns: 10, turnLimitContinues: 1, maxIterations: 5, claudePath: FAKE,
    sandbox: undefined, model: undefined, worktreeRoot: join(env.state, 'worktrees'), maxJobs: 3, sensitivePaths: [],
    review: false, reviewModel: undefined, reviewMaxTurns: 60, simplify: false, taskCheckMaxTurns: 30, taskCheckAuto: false, taskCheckParallel: 1, rulesMaxBytes: 49152,
    gate: { on: false, reason: 'SF_GATE=off' }, codexModel: undefined, gateMaxRounds: 3, gateMaxTokens: 5_000_000, gateTimeoutMs: 900_000, gateLevel: 'auto', gateFullPaths: [],
    forge: { githubToken: undefined, githubApi: 'https://api.github.com', gitlabToken: undefined, gitlabUrl: undefined }, handoff: 'off', smokeProbeAllow: undefined,
  };
}

// sf serve's composition: Setup bound to the Execution, and the Execution's ticket archive bound to Setup.
async function world(name: string): Promise<World> {
  const env = await newEnv(name);
  process.env.HOME = env.home;
  const repo = await newRepo(env, `${name}-repo`, true);
  const other = join(env.home, 'other');
  execFileSync('git', ['clone', '-q', git(repo, 'remote', 'get-url', 'origin').trim(), other]);
  const jobs = new JobStore(env.state);
  let setup: Setup | undefined;
  const execution = new Execution(config(env), (workspace) => resolveWorkspace(workspace, env.config), () => {}, '', {
    archiveTicket: async (workspace, ticket) => (await setup!.archiveTicket(workspace, ticket)).retired,
  });
  setup = new Setup({ configDir: env.config, jobs, exclusive: (work) => execution.exclusive(work) });
  return { env, repo, other, execution, setup, jobs };
}

// A branch with one commit, pushed to origin from the work checkout as the factory pushes it: its sha.
function pushedBranch(w: World, branch: string, file: string): string {
  git(w.repo, 'checkout', '-q', '-b', branch, 'main');
  execFileSync('sh', ['-c', `echo ${branch} > ${file}`], { cwd: w.repo });
  git(w.repo, 'add', file);
  git(w.repo, 'commit', '-q', '-m', `feat: ${branch}`);
  git(w.repo, 'push', '-q', 'origin', branch);
  git(w.repo, 'checkout', '-q', 'main');
  return git(w.repo, 'rev-parse', branch).trim();
}

// Merges origin's branch into main on origin from the other clone: the work checkout's
// origin/main does not know it until a fetch.
function mergeOnHost(w: World, branch: string): void {
  git(w.other, 'fetch', '-q', 'origin');
  git(w.other, 'merge', '-q', '--no-ff', '-m', `Merge ${branch}`, `origin/${branch}`);
  git(w.other, 'push', '-q', 'origin', 'main');
}

function pushedJob(ticket: string, branch: string, commit: string, mr: Job['mr'] = null): Job {
  return {
    workspace: 'app', ticket, branch, base: 'main', continues: null, base_commit: null, target_commit: null, worktree: null, prepared_commit: commit,
    mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state: 'pushed', iteration: 1, session_id: null, mr,
    created_at: '2026-11-04T10:00:00.000Z', updated_at: '2026-11-04T10:00:00.000Z',
  };
}

// The archived job directories of the ticket, with their events.
async function archivedDirs(w: World, ticket: string): Promise<Array<{ job: Job; events: Array<Record<string, unknown>> }>> {
  const root = join(w.env.state, 'jobs', 'app');
  const names = (await readdir(root)).filter((name) => name.startsWith(`${ticket}.`)).sort();
  return Promise.all(names.map(async (name) => ({
    job: JSON.parse(await readFile(join(root, name, 'job.json'), 'utf8')) as Job,
    events: (await readFile(join(root, name, 'events.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>),
  })));
}

// What the user's checkout shows: its HEAD, its branches with their commits, its status.
function checkoutView(repo: string): string {
  return [git(repo, 'symbolic-ref', 'HEAD'), git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'), git(repo, 'status', '--porcelain')].join('\n');
}

// A git first on PATH that logs each command's directory and arguments, then runs the real git.
async function recordingGit(env: Env): Promise<{ log: string; restore: () => void }> {
  const bin = join(env.home, 'git-bin');
  await mkdir(bin, { recursive: true });
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const log = join(env.home, 'git.log');
  await writeFile(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\t%s\\n' "$PWD" "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  await chmod(join(bin, 'git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path ?? ''}`;
  return { log, restore: () => (process.env.PATH = path) };
}

// The subcommand of a logged git command line: the first word after the -c pairs.
function subcommand(args: string): string {
  const words = args.split(' ');
  let index = 0;
  while (words[index] === '-c' || words[index] === '-C') {
    index += 2;
  }
  return words.slice(index).join(' ');
}

test('merged pass: a pushed job whose commit is on the target after a fetch is logged and archived with its Task file; one not on it stays', TIMEOUT, async () => {
  const w = await world('merged-pass');
  const merged = pushedBranch(w, 'T-1-one', 'one.txt');
  const open = pushedBranch(w, 'T-2-two', 'two.txt');
  mergeOnHost(w, 'T-1-one');
  await putTask(w.env, w.repo, 'T-1', 'One');
  await putTask(w.env, w.repo, 'T-2', 'Two');
  await w.jobs.write(pushedJob('T-1', 'T-1-one', merged));
  await w.jobs.write(pushedJob('T-2', 'T-2-two', open));
  const before = checkoutView(w.repo);
  const recorder = await recordingGit(w.env);
  let archived: Job[];
  try {
    archived = await w.execution.archiveMergedJobs();
  } finally {
    recorder.restore();
  }

  assert.deepEqual(archived.map((job) => job.ticket), ['T-1']);
  assert.equal(await w.jobs.read('app', 'T-1'), undefined);
  const [dir] = await archivedDirs(w, 'T-1');
  assert.equal(dir?.job.ticket, 'T-1');
  const event = dir!.events.find((record) => record.type === 'merged_on_target');
  assert.deepEqual(event === undefined ? undefined : { commit: event.commit, target: event.target }, { commit: merged, target: 'main' });
  // The active Task file went to the archive, as the Done card's Archive does.
  assert.deepEqual(await readdir(join(w.repo, '.software-factory', 'archive')), ['T-1.md']);
  // T-2 is not on main: untouched.
  assert.equal((await w.jobs.read('app', 'T-2'))?.state, 'pushed');
  assert.ok((await readdir(join(w.repo, '.software-factory'))).includes('T-2.md'));
  // The branches and their commits stay; the checkout's HEAD, branches and files are as they were.
  assert.equal(git(w.repo, 'rev-parse', 'refs/remotes/origin/T-1-one').trim(), merged);
  assert.equal(checkoutView(w.repo), before);
  // No pull, checkout, reset, merge, commit or branch change; the fetch is the one of the target.
  const commands = (await readFile(recorder.log, 'utf8')).trim().split('\n').map((line) => line.split('\t')).map(([cwd, args]) => ({ cwd, command: subcommand(args!) }));
  for (const { command } of commands) {
    assert.doesNotMatch(command, /^(pull|checkout|switch|reset|commit|rebase|push|restore|stash|branch|update-ref|tag)\b|^merge (?!--is-ancestor)/, command);
  }
  assert.ok(commands.some(({ cwd, command }) => cwd === w.repo && command === 'fetch --no-tags origin main'), JSON.stringify(commands));
});

test('merged pass: a job with an open or merged merge request is left to the merge request; a closed one is checked', TIMEOUT, async () => {
  const w = await world('merged-pass-mr');
  const mr = (state: 'open' | 'closed' | 'merged'): Job['mr'] => ({ host: 'github', number: 7, url: 'https://github.com/o/r/pull/7', state, merge_commit: null });
  const one = pushedBranch(w, 'T-1-one', 'one.txt');
  const two = pushedBranch(w, 'T-2-two', 'two.txt');
  const three = pushedBranch(w, 'T-3-three', 'three.txt');
  for (const branch of ['T-1-one', 'T-2-two', 'T-3-three']) {
    mergeOnHost(w, branch);
  }
  await w.jobs.write(pushedJob('T-1', 'T-1-one', one, mr('open')));
  await w.jobs.write(pushedJob('T-2', 'T-2-two', two, mr('merged')));
  await w.jobs.write(pushedJob('T-3', 'T-3-three', three, mr('closed')));
  // T-9 lands after the three: before the pass, a closed merge request is not merged.
  await mkdir(join(w.repo, '.software-factory'), { recursive: true });
  await writeFile(join(w.repo, '.software-factory', 'T-9.md'), '---\nticket: T-9\ntitle: Nine\nbase: main\nlands_after: [T-1, T-3]\n---\n\n# T-9: Nine\n');
  const landsAfter = async (): Promise<string[]> => ((await w.setup.tickets()).find((row) => row.ticket === 'T-9')?.lands_after ?? []).map((row) => `${row.ticket} ${row.state}`);
  assert.deepEqual(await landsAfter(), ['T-1 pushed', 'T-3 pushed']);
  assert.deepEqual((await w.execution.archiveMergedJobs()).map((job) => job.ticket), ['T-3']);
  assert.equal((await w.jobs.read('app', 'T-1'))?.state, 'pushed');
  assert.equal((await w.jobs.read('app', 'T-2'))?.state, 'pushed');
  assert.equal(await w.jobs.read('app', 'T-3'), undefined);
  // The auto-archived job counts as merged for the ticket that lands after it (its merged_on_target).
  assert.deepEqual(await landsAfter(), ['T-1 pushed', 'T-3 merged']);
});

test('merged pass: a failed fetch leaves the jobs untouched and is logged once until a fetch works again', TIMEOUT, async () => {
  const w = await world('merged-pass-fetch');
  const merged = pushedBranch(w, 'T-1-one', 'one.txt');
  mergeOnHost(w, 'T-1-one');
  // The checkout's own origin/main already has the merge, so only the failed fetch keeps the job.
  git(w.repo, 'fetch', '-q', 'origin');
  await w.jobs.write(pushedJob('T-1', 'T-1-one', merged));
  const url = git(w.repo, 'remote', 'get-url', 'origin').trim();
  git(w.repo, 'remote', 'set-url', 'origin', join(w.env.home, 'no-such-origin.git'));
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
  try {
    assert.deepEqual(await w.execution.archiveMergedJobs(), []);
    assert.deepEqual(await w.execution.archiveMergedJobs(), []);
  } finally {
    console.error = error;
  }
  assert.equal((await w.jobs.read('app', 'T-1'))?.state, 'pushed');
  assert.equal(logged.length, 1, logged.join('\n'));
  assert.match(logged[0]!, /app.*fetch.*main/);
  git(w.repo, 'remote', 'set-url', 'origin', url);
  assert.deepEqual((await w.execution.archiveMergedJobs()).map((job) => job.ticket), ['T-1']);
});

test('Archive of a Done job: with an active Task file the Task file goes to the archive too; without one the job alone; the branch and its commits stay; a live job is refused', TIMEOUT, async () => {
  const w = await world('archive-done');
  const commit = pushedBranch(w, 'T-1-one', 'one.txt');
  await putTask(w.env, w.repo, 'T-1', 'One');
  await w.jobs.write(pushedJob('T-1', 'T-1-one', commit));
  const failed: Job = { ...pushedJob('T-2', 'T-2-two', commit), state: 'failed', prepared_commit: null };
  await w.jobs.write(failed);
  await putTask(w.env, w.repo, 'T-3', 'Three');
  await w.jobs.write({ ...pushedJob('T-3', 'T-3-three', commit), state: 'aborted', prepared_commit: null });
  await w.jobs.write({ ...pushedJob('T-4', 'T-4-four', commit), state: 'needs_human', prepared_commit: null });
  const before = git(w.repo, 'for-each-ref', '--format=%(refname) %(objectname)');

  const pushed = await w.execution.archiveFinished('app', 'T-1');
  assert.deepEqual([pushed.branch, /^jobs\/app\/T-1\.\d{8}T\d{6}Z$/.test(pushed.archived)], ['T-1-one', true]);
  // T-2 has no Task file: the job alone.
  assert.equal((await w.execution.archiveFinished('app', 'T-2')).branch, 'T-2-two');
  assert.equal((await w.execution.archiveFinished('app', 'T-3')).branch, 'T-3-three');
  await assert.rejects(w.execution.archiveFinished('app', 'T-4'), (error: Error & { code?: string }) => error.code === 'invalid_state');
  for (const ticket of ['T-1', 'T-2', 'T-3']) {
    assert.equal(await w.jobs.read('app', ticket), undefined, ticket);
  }
  assert.equal((await w.jobs.read('app', 'T-4'))?.state, 'needs_human');
  assert.deepEqual((await readdir(join(w.repo, '.software-factory', 'archive'))).sort(), ['T-1.md', 'T-3.md']);
  assert.equal(git(w.repo, 'for-each-ref', '--format=%(refname) %(objectname)'), before);
});
