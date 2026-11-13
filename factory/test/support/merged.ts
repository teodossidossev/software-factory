// The shared part of the tests of the pass of merged jobs and of Merged — archive (test/merged-archive.test.ts,
// test/handoff-merged.test.ts): sf serve's composition in process (Setup bound to the Execution), a
// second clone of origin where "someone else" merges, pushed and handed-over jobs written as the
// factory writes them, the archived job directories, and a git first on PATH that records every
// command. With a fake Git host, the work checkout's origin is a GitHub URL whose fetch is served
// from the local bare repository (core.sshCommand), so no test reaches a real host or origin.
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { Config } from '../../src/config.js';
import { Execution } from '../../src/execution.js';
import type { ForgeSettings } from '../../src/forge.js';
import { type Job, JobStore } from '../../src/jobs.js';
import { resolveWorkspace } from '../../src/registry.js';
import { Setup } from '../../src/setup.js';
import { type Env, FAKE, git, newEnv, newRepo } from './harness.js';

export interface World {
  env: Env;
  repo: string;
  // A second clone of origin, where "someone else" merges on the host.
  other: string;
  execution: Execution;
  setup: Setup;
  jobs: JobStore;
}

const NO_FORGE: ForgeSettings = { githubToken: undefined, githubApi: 'https://api.github.com', gitlabToken: undefined, gitlabUrl: undefined };

export function config(env: Env, forge: ForgeSettings = NO_FORGE): Config {
  return {
    stateDir: env.state, checkAfterStartMin: 15, checkAfterFixMin: 5, maxTurns: 10, turnLimitContinues: 1, maxIterations: 5, claudePath: FAKE,
    sandbox: undefined, model: undefined, worktreeRoot: join(env.state, 'worktrees'), maxJobs: 3, sensitivePaths: [],
    review: false, reviewModel: undefined, reviewMaxTurns: 60, simplify: false, taskCheckMaxTurns: 30, taskCheckAuto: false, taskCheckParallel: 1, rulesMaxBytes: 49152,
    gate: { on: false, reason: 'SF_GATE=off' }, codexModel: undefined, gateMaxRounds: 3, gateMaxTokens: 5_000_000, gateTimeoutMs: 900_000, gateLevel: 'auto', gateFullPaths: [],
    forge, handoff: 'off', smokeProbeAllow: undefined,
  };
}

// sf serve's composition: Setup bound to the Execution, and the Execution's ticket archive bound to
// Setup. forge: the hosts' settings (default: no token, so merge requests are off).
export async function world(name: string, forge?: ForgeSettings): Promise<World> {
  const env = await newEnv(name);
  process.env.HOME = env.home;
  const repo = await newRepo(env, `${name}-repo`, true);
  const other = join(env.home, 'other');
  execFileSync('git', ['clone', '-q', git(repo, 'remote', 'get-url', 'origin').trim(), other]);
  const jobs = new JobStore(env.state);
  let setup: Setup | undefined;
  const execution = new Execution(config(env, forge), (workspace) => resolveWorkspace(workspace, env.config), () => {}, '', {
    archiveTicket: async (workspace, ticket) => (await setup!.archiveTicket(workspace, ticket)).retired,
  });
  setup = new Setup({ configDir: env.config, jobs, exclusive: (work) => execution.exclusive(work) });
  return { env, repo, other, execution, setup, jobs };
}

// The fake GitHub's settings: a token, and its API on loopback.
export const fakeGithub = (url: string): ForgeSettings => ({ ...NO_FORGE, githubToken: 'github_pat_TEST', githubApi: url });

// The work checkout's origin becomes git@github.com:acme/app.git (the fake GitHub's repository) for
// the forge, while its fetch and push still reach the local bare repository: the fetch through
// core.sshCommand, a script that serves it with git upload-pack; the push through the push URL.
export async function githubOrigin(w: World): Promise<void> {
  const bare = git(w.repo, 'remote', 'get-url', 'origin').trim();
  const ssh = join(w.env.home, 'ssh-origin');
  await writeFile(ssh, `#!/bin/sh\nexec git upload-pack '${bare}'\n`);
  await chmod(ssh, 0o755);
  git(w.repo, 'config', 'core.sshCommand', ssh);
  git(w.repo, 'config', 'ssh.variant', 'simple');
  git(w.repo, 'remote', 'set-url', 'origin', 'git@github.com:acme/app.git');
  git(w.repo, 'remote', 'set-url', '--push', 'origin', bare);
}

// A branch with one commit, pushed to origin from the work checkout as the factory pushes it: its sha.
export function pushedBranch(w: World, branch: string, file: string): string {
  git(w.repo, 'checkout', '-q', '-b', branch, 'main');
  execFileSync('sh', ['-c', `echo ${branch} > ${file}`], { cwd: w.repo });
  git(w.repo, 'add', file);
  git(w.repo, 'commit', '-q', '-m', `feat: ${branch}`);
  git(w.repo, 'push', '-q', 'origin', branch);
  git(w.repo, 'checkout', '-q', 'main');
  return git(w.repo, 'rev-parse', branch).trim();
}

// Merges origin's branch into main on origin from the other clone (a merge commit): the work
// checkout's origin/main does not know it until a fetch.
export function mergeOnHost(w: World, branch: string): void {
  git(w.other, 'fetch', '-q', 'origin');
  git(w.other, 'merge', '-q', '--no-ff', '-m', `Merge ${branch}`, `origin/${branch}`);
  git(w.other, 'push', '-q', 'origin', 'main');
}

export function pushedJob(ticket: string, branch: string, commit: string, mr: Job['mr'] = null): Job {
  return {
    workspace: 'app', ticket, branch, base: 'main', continues: null, base_commit: null, target_commit: null, worktree: null, prepared_commit: commit,
    mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state: 'pushed', iteration: 1, session_id: null, mr,
    created_at: '2026-11-04T10:00:00.000Z', updated_at: '2026-11-04T10:00:00.000Z',
  };
}

// A job handed over to the work checkout as the hand-over leaves it: the checkout on the job's
// branch at the hand-over base (main's tip), the factory's commit.template (the prefilled message)
// and commit.cleanup set, the user's own unset before. The job's record, not yet written.
export async function handedOver(w: World, ticket: string, branch: string): Promise<Job> {
  const base = git(w.repo, 'rev-parse', 'main').trim();
  git(w.repo, 'checkout', '-q', '-b', branch, 'main');
  const template = git(w.repo, 'rev-parse', '--path-format=absolute', '--git-path', `factory/${ticket}.commit-msg`).trim();
  await mkdir(join(template, '..'), { recursive: true });
  await writeFile(template, `feat(${ticket}): hand it over\n`);
  git(w.repo, 'config', '--local', 'commit.template', template);
  git(w.repo, 'config', '--local', 'commit.cleanup', 'scissors');
  return {
    ...pushedJob(ticket, branch, base), state: 'handed_over',
    handover: { branch, saved: base, base, previous: { branch: 'main' }, untracked: [], template: null, cleanup: null, at: '2026-11-04T11:00:00.000Z', checked_at: null, step: null },
  };
}

// The local config value, or null when unset.
export function localConfig(repo: string, key: string): string | null {
  try {
    return git(repo, 'config', '--local', key).trim();
  } catch { // unset: git config exits 1
    return null;
  }
}

export type Archived = { job: Job; events: Array<Record<string, unknown>> };

// The archived job directories of the ticket, with their events.
export async function archivedDirs(w: Pick<World, 'env'>, ticket: string): Promise<Archived[]> {
  const root = join(w.env.state, 'jobs', 'app');
  const names = (await readdir(root)).filter((name) => name.startsWith(`${ticket}.`)).sort();
  return Promise.all(names.map(async (name) => ({
    job: JSON.parse(await readFile(join(root, name, 'job.json'), 'utf8')) as Job,
    events: (await readFile(join(root, name, 'events.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>),
  })));
}

// The merged_on_target events of an archived job, by their fields.
export const mergedEvents = (dir: Archived | undefined): Array<Record<string, unknown>> =>
  (dir?.events ?? []).filter((event) => event.type === 'merged_on_target').map(({ commit, target, how, mr }) => ({ commit, target, how, ...(mr !== undefined ? { mr } : {}) }));

// What the user's checkout shows: its HEAD, its branches with their commits, its status.
export function checkoutView(repo: string): string {
  return [git(repo, 'symbolic-ref', 'HEAD'), git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'), git(repo, 'status', '--porcelain')].join('\n');
}

// A git first on PATH that logs each command's directory and arguments, then runs the real git.
export async function recordingGit(env: Env): Promise<{ log: string; restore: () => void }> {
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

// The logged git commands: their directory and their subcommand (the words after the -c and -C pairs).
export async function loggedCommands(log: string): Promise<Array<{ cwd: string; command: string }>> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text.trim().split('\n').filter((line) => line !== '').map((line) => line.split('\t')).map(([cwd, args]) => {
    const words = args!.split(' ');
    let index = 0;
    while (words[index] === '-c' || words[index] === '-C') {
      index += 2;
    }
    return { cwd: cwd!, command: words.slice(index).join(' ') };
  });
}

// The commands that change the checkout or reach origin, beyond a fetch.
export const WRITES = /^(pull|checkout|switch|reset|commit|rebase|push|restore|stash|branch|update-ref|tag|ls-remote)\b|^merge (?!--is-ancestor)/;
