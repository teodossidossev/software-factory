// The start screen's server side (src/setup.ts) against throwaway repositories: the workspace
// list with live jobs and problems, add with the CLI's rules, remove and its guard, the ticket
// list (drafts, finished jobs, skipped files) and the ticket draft (exact content, the base from
// origin/HEAD, refusals).
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import type { ExclusiveScope } from '../src/execution.js';
import { type Job, JobStore } from '../src/jobs.js';
import { loadRegistry, saveRegistry } from '../src/registry.js';
import { defaultBranch, draftContent, DRAFT_MARKER, DRAFT_NOTE, isDraft, MAX_REQUEST_BYTES, Setup } from '../src/setup.js';
import { git, newEnv, newRepo, putTask, temp } from './support/harness.js';

// These tests have no finished job to retire: a call would be a bug.
const NO_RETIREMENT: ExclusiveScope = {
  retireFinished: async () => assert.fail('no job is retired here'),
};

function setupOf(config: string, jobs: JobStore): Setup {
  let lock: Promise<unknown> = Promise.resolve();
  return new Setup({
    configDir: config, jobs,
    exclusive: (work) => {
      const next = lock.catch(() => undefined).then(() => work(NO_RETIREMENT));
      lock = next;
      return next;
    },
  });
}

function jobOf(workspace: string, ticket: string, state: Job['state']): Job {
  return {
    workspace, ticket, branch: `${ticket}-x`, base: 'main', base_commit: null, target_commit: null, worktree: null, prepared_commit: null, mr_attempts: 0, fixes: 0, state,
    iteration: 0, session_id: null, created_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-11-01T10:00:00.000Z',
  };
}

async function refused(work: Promise<unknown>, code: string): Promise<string> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof FactoryError, String(error));
    assert.equal(error.code, code, error.message);
    return error.message;
  }
  assert.fail(`expected ${code}`);
}

test('setup: draftContent is the skeleton without the user\'s words; isDraft knows it and the older draft', () => {
  const content = draftContent('T-1', 'Do it', 'main');
  assert.equal(content, `---\nticket: T-1\ntitle: Do it\nbase: main\n---\n\n# T-1: Do it\n\n${DRAFT_MARKER}\n\n${DRAFT_NOTE}\n`);
  assert.equal(DRAFT_MARKER, '## Status: waiting for the Context owner');
  assert.equal(isDraft('---\nticket: T-1\n---\n## Status: draft\n'), true);
  assert.equal(isDraft(content), true);
  assert.equal(isDraft(content.replace(`${DRAFT_MARKER}\n\n${DRAFT_NOTE}\n`, '## Acceptance\n- done\n')), false);
  assert.equal(isDraft(`---\nticket: T-1\n---\n  ${DRAFT_MARKER}  \n`), true);
});

test('setup: workspaces, add with the CLI rules, remove and its live-job guard', async () => {
  const env = await newEnv('setup-ws');
  const repo = await newRepo(env, 'setup-ws-repo', true);
  const jobs = new JobStore(env.state);
  const setup = setupOf(env.config, jobs);
  assert.deepEqual(await setup.workspaces(), [{ name: 'app', path: repo, liveJobs: 0, problem: null }]);

  // The CLI's rules: the name pattern, an absolute path, an existing Git work tree root, no duplicate.
  assert.match(await refused(setup.addWorkspace('Bad', repo), 'invalid_name'), /workspace name must be/);
  assert.equal(await refused(setup.addWorkspace('rel', 'relative/path'), 'workspace_invalid'), 'The path must be absolute.');
  assert.equal(await refused(setup.addWorkspace('gone', join(temp, 'missing')), 'workspace_invalid'), 'The path does not exist.');
  const plain = join(temp, 'setup-plain');
  await mkdir(plain);
  assert.equal(await refused(setup.addWorkspace('plain', plain), 'workspace_invalid'), 'The path is not the root of a non-bare Git work tree.');
  await mkdir(join(repo, 'sub'));
  assert.equal(await refused(setup.addWorkspace('sub', join(repo, 'sub')), 'workspace_invalid'), 'The path is not the root of a non-bare Git work tree.');
  await rm(join(repo, 'sub'), { recursive: true });
  assert.match(await refused(setup.addWorkspace('app', repo), 'workspace_exists'), /already registered/);
  // Added: the real path, read and work alike, and the CLI's registry sees it.
  const second = await newRepo({ ...env, config: join(temp, 'setup-ws-other') }, 'setup-ws-second', false);
  const added = await setup.addWorkspace('second', `${second}/`);
  assert.deepEqual(added, { name: 'second', path: second, liveJobs: 0, problem: null });
  assert.deepEqual((await loadRegistry(env.config)).workspaces.second, { read_checkout: second });
  assert.deepEqual((await setup.workspaces()).map((row) => row.name), ['app', 'second']);

  // Live jobs are counted; a workspace with a live job cannot be removed; a missing checkout is a problem, not a failure.
  await jobs.write(jobOf('second', 'S-1', 'working'));
  await jobs.write(jobOf('second', 'S-2', 'pushed'));
  await jobs.write(jobOf('app', 'A-1', 'failed'));
  assert.deepEqual((await setup.workspaces()).map((row) => [row.name, row.liveJobs]), [['app', 0], ['second', 1]]);
  assert.match(await refused(setup.removeWorkspace('second'), 'workspace_busy'), /has a live job \(S-1 working\)/);
  await refused(setup.removeWorkspace('nope'), 'workspace_not_found');
  await refused(setup.removeWorkspace('Nope'), 'invalid_name');
  await jobs.write(jobOf('second', 'S-1', 'aborted'));
  assert.deepEqual(await setup.removeWorkspace('second'), { removed: 'second' });
  assert.deepEqual(Object.keys((await loadRegistry(env.config)).workspaces), ['app']);
  await rm(second, { recursive: true });
  await saveRegistry({ workspaces: { app: { read_checkout: repo, work_checkout: repo }, lost: { read_checkout: second, work_checkout: second } } }, env.config);
  const rows = await setup.workspaces();
  assert.deepEqual(rows.map((row) => [row.name, row.problem]), [['app', null], ['lost', 'The checkout does not exist.']]);
});

test('setup: tickets lists the Task files without a live job; createTicket writes the draft once', async () => {
  const env = await newEnv('setup-tickets');
  const repo = await newRepo(env, 'setup-tickets-repo', true);
  const jobs = new JobStore(env.state);
  const setup = setupOf(env.config, jobs);
  assert.deepEqual(await setup.tickets(), []);
  assert.equal(await defaultBranch(repo), 'main');

  const created = await setup.createTicket({ workspace: 'app', ticket: 'T-1', title: '  Add a thing  ', request: 'Please add\nthe thing.' });
  assert.deepEqual(created, { workspace: 'app', ticket: 'T-1', path: '.software-factory/T-1.md', base: 'main' });
  assert.equal(await readFile(join(repo, '.software-factory', 'T-1.md'), 'utf8'), draftContent('T-1', 'Add a thing', 'main'));
  // The user's words are kept for the conversation in the state directory, not in the repository.
  assert.equal(await readFile(join(env.state, 'requests', 'app', 'T-1.md'), 'utf8'), 'Please add\nthe thing.');
  // The Task directory is excluded from Git, as write_task does it.
  assert.match(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.software-factory\/$/m);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.deepEqual(await setup.tickets(), [{ workspace: 'app', ticket: 'T-1', title: 'Add a thing', base: 'main', draft: true, request: 'Please add\nthe thing.', job: null }]);

  // Refused: an existing ticket (never replaced), bad names, an empty or oversized title or request, an unknown workspace.
  assert.match(await refused(setup.createTicket({ workspace: 'app', ticket: 'T-1', title: 'Again', request: 'x' }), 'ticket_exists'), /already exists in workspace "app"/);
  assert.equal(await readFile(join(repo, '.software-factory', 'T-1.md'), 'utf8'), draftContent('T-1', 'Add a thing', 'main'));
  await refused(setup.createTicket({ workspace: 'App', ticket: 'T-2', title: 't', request: 'r' }), 'invalid_name');
  await refused(setup.createTicket({ workspace: 'app', ticket: '.T-2', title: 't', request: 'r' }), 'invalid_ticket');
  await refused(setup.createTicket({ workspace: 'app', ticket: '../T-2', title: 't', request: 'r' }), 'invalid_ticket');
  for (const title of ['', '  ', 'two\nlines', 'x'.repeat(201)]) {
    assert.match(await refused(setup.createTicket({ workspace: 'app', ticket: 'T-2', title, request: 'r' }), 'invalid_content'), /title must be one line/);
  }
  for (const request of ['', ' \n ', 'a\0b', 'x'.repeat(MAX_REQUEST_BYTES + 1)]) {
    assert.match(await refused(setup.createTicket({ workspace: 'app', ticket: 'T-2', title: 't', request }), 'invalid_content'), /request must be/);
  }
  await refused(setup.createTicket({ workspace: 'other', ticket: 'T-2', title: 't', request: 'r' }), 'workspace_not_found');
  assert.deepEqual((await setup.tickets()).map((row) => row.ticket), ['T-1']);

  // A ticket with a live job is not listed; one with a finished job is, with that state; the
  // Task file written by write_task is not a draft; files that are not Task files are skipped.
  await putTask(env, repo, 'T-2', 'Second');
  await putTask(env, repo, 'T-3', 'Third');
  await jobs.write(jobOf('app', 'T-2', 'awaiting_review'));
  await jobs.write(jobOf('app', 'T-3', 'pushed'));
  await writeFile(join(repo, '.software-factory', 'T-3.mr.md'), 'feat(T-3): x\n');
  await writeFile(join(repo, '.software-factory', 'notes.txt'), 'x\n');
  await writeFile(join(repo, '.software-factory', 'T-4.md'), 'no front matter\n');
  await writeFile(join(repo, '.software-factory', 'T-5.md'), '---\nticket: T-9\ntitle: Other\nbase: main\n---\n');
  await writeFile(join(repo, '.software-factory', '.T-6.md'), '---\nticket: .T-6\ntitle: Hidden\nbase: main\n---\n');
  assert.deepEqual(await setup.tickets(), [
    { workspace: 'app', ticket: 'T-1', title: 'Add a thing', base: 'main', draft: true, request: 'Please add\nthe thing.', job: null },
    { workspace: 'app', ticket: 'T-3', title: 'Third', base: 'main', draft: false, request: null, job: 'pushed' },
  ]);
  await refused(setup.createTicket({ workspace: 'app', ticket: 'T-2', title: 't', request: 'r' }), 'ticket_exists');

  // The base follows origin/HEAD when the clone has one; a workspace whose checkout is gone is skipped.
  git(repo, 'remote', 'set-head', 'origin', '-a');
  git(repo, 'branch', '-q', 'develop');
  git(repo, 'push', '-q', 'origin', 'develop');
  git(repo, 'remote', 'set-head', 'origin', 'develop');
  assert.equal(await defaultBranch(repo), 'develop');
  assert.equal((await setup.createTicket({ workspace: 'app', ticket: 'T-7', title: 'Dev', request: 'r' })).base, 'develop');
  assert.match(await readFile(join(repo, '.software-factory', 'T-7.md'), 'utf8'), /^base: develop$/m);
  const gone = join(temp, 'setup-gone');
  await saveRegistry({ workspaces: { app: { read_checkout: repo, work_checkout: repo }, gone: { read_checkout: gone, work_checkout: gone } } }, env.config);
  assert.deepEqual((await setup.tickets()).map((row) => `${row.workspace}/${row.ticket}`), ['app/T-1', 'app/T-3', 'app/T-7']);
});
