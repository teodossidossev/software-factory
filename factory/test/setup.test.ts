// The start screen's server side (src/setup.ts) against throwaway repositories: the workspace
// list with live jobs and problems, add with the CLI's rules, remove and its guard, the ticket
// list (drafts, finished jobs, skipped files) and the ticket draft (exact content, the base from
// origin/HEAD, refusals).
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import type { ExclusiveScope } from '../src/execution.js';
import { type Job, JobStore } from '../src/jobs.js';
import { loadRegistry, saveRegistry } from '../src/registry.js';
import { defaultBranch, draftContent, DRAFT_MARKER, DRAFT_NOTE, isDraft, MAX_REQUEST_BYTES, MERGE_CHECK_TTL_MS, Setup } from '../src/setup.js';
import { taskSha256 } from '../src/task-file.js';
import { TicketHistory } from '../src/ticket-history.js';
import { git, newEnv, newRepo, putTask, temp } from './support/harness.js';

// These tests have no finished job to retire: a call would be a bug.
const NO_RETIREMENT: ExclusiveScope = {
  retireFinished: async () => assert.fail('no job is retired here'),
};

function setupOf(config: string, jobs: JobStore, now?: () => number, history?: TicketHistory): Setup {
  let lock: Promise<unknown> = Promise.resolve();
  return new Setup({
    configDir: config, jobs, ...(now !== undefined ? { now } : {}), ...(history !== undefined ? { history } : {}),
    exclusive: (work) => {
      const next = lock.catch(() => undefined).then(() => work(NO_RETIREMENT));
      lock = next;
      return next;
    },
  });
}

function jobOf(workspace: string, ticket: string, state: Job['state']): Job {
  return {
    workspace, ticket, branch: `${ticket}-x`, base: 'main', continues: null, base_commit: null, target_commit: null, worktree: null, prepared_commit: null, mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state,
    iteration: 0, session_id: null, mr: null, created_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-11-01T10:00:00.000Z',
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
  assert.deepEqual(await setup.workspaces(), [{ name: 'app', path: repo, liveJobs: 0, problem: null, handoff: null, color: 'teal', app: 'app', description: null, derived_description: 'hello', digest: { track: false, my_work: false } }]);

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
  assert.deepEqual(added, { name: 'second', path: second, liveJobs: 0, problem: null, handoff: null, color: 'orange', app: 'second', description: null, derived_description: 'hello', digest: { track: false, my_work: false } });
  assert.deepEqual((await loadRegistry(env.config)).workspaces.second, { read_checkout: second });
  assert.deepEqual((await setup.workspaces()).map((row) => row.name), ['app', 'second']);
  // The workspace's own hand-over setting (SF-083): stored in the registry and shown in the row.
  const third = await newRepo({ ...env, config: join(temp, 'setup-ws-third-config') }, 'setup-ws-third', false);
  assert.deepEqual(await setup.addWorkspace('third', third, { handoff: 'off' }), { name: 'third', path: third, liveJobs: 0, problem: null, handoff: 'off', color: 'olive', app: 'third', description: null, derived_description: 'hello', digest: { track: false, my_work: false } });
  assert.deepEqual((await loadRegistry(env.config)).workspaces.third, { read_checkout: third, handoff: 'off' });
  assert.deepEqual((await setup.workspaces()).map((row) => [row.name, row.handoff]), [['app', null], ['second', null], ['third', 'off']]);
  await setup.removeWorkspace('third');
  // Its colour on the board (SF-084): stored when given, else the hash of the name.
  assert.equal((await setup.addWorkspace('third', third, { color: 'grey' })).color, 'grey');
  assert.deepEqual((await loadRegistry(env.config)).workspaces.third, { read_checkout: third, color: 'grey' });
  assert.deepEqual((await setup.workspaces()).map((row) => [row.name, row.color]), [['app', 'teal'], ['second', 'orange'], ['third', 'grey']]);
  await setup.removeWorkspace('third');

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

test('setup (SF-103): add with the digest fields; edit keeps the name and the keys the form does not show, writes atomically, validates the path; a path change with a live job is workspace_busy', async () => {
  const env = await newEnv('setup-edit');
  const repo = await newRepo(env, 'setup-edit-repo', true);
  const jobs = new JobStore(env.state);
  const setup = setupOf(env.config, jobs);
  const web = await newRepo({ ...env, config: join(temp, 'setup-edit-web-config') }, 'setup-edit-web', false);
  const added = await setup.addWorkspace('web', web, { description: '  The shop\'s web front end. ', app: ' shop ', digest: { track: true, my_work: false } });
  assert.deepEqual([added.app, added.description, added.derived_description, added.digest], ['shop', 'The shop\'s web front end.', 'hello', { track: true, my_work: false }]);
  assert.deepEqual((await loadRegistry(env.config)).workspaces.web, { read_checkout: web, description: 'The shop\'s web front end.', app: 'shop', digest: { track: true, my_work: false } });
  assert.match(await refused(setup.addWorkspace('long', web, { app: 'x'.repeat(65) }), 'workspace_invalid'), /app must be at most 64/);

  // Keys the form does not show stay; "" removes description and app, default and auto the handoff and color.
  const registry = await loadRegistry(env.config);
  registry.workspaces.app = { ...registry.workspaces.app!, rules_skip: ['docs/**'], handoff: 'off', color: 'red' };
  await saveRegistry(registry, env.config);
  const edit = { path: repo, description: 'The shop\'s backend.', app: 'shop', handoff: 'default' as const, color: 'auto' as const, digest: { track: true, my_work: true } };
  const row = await setup.editWorkspace('app', edit);
  assert.deepEqual(row, { name: 'app', path: repo, liveJobs: 0, problem: null, handoff: null, color: 'teal', app: 'shop', description: 'The shop\'s backend.', derived_description: 'hello', digest: { track: true, my_work: true } });
  assert.deepEqual((await loadRegistry(env.config)).workspaces.app, { read_checkout: repo, work_checkout: repo, rules_skip: ['docs/**'], description: 'The shop\'s backend.', app: 'shop', digest: { track: true, my_work: true } });
  await setup.editWorkspace('app', { ...edit, description: '', app: '', handoff: 'checkout', color: 'green', digest: { track: false, my_work: false } });
  assert.deepEqual((await loadRegistry(env.config)).workspaces.app, { read_checkout: repo, work_checkout: repo, rules_skip: ['docs/**'], handoff: 'checkout', color: 'green' });
  // No temp file left beside workspaces.json.
  assert.deepEqual((await readdir(env.config)).filter((name) => name.startsWith('.')), []);

  // Refusals: a bad path, an unknown or invalid name; nothing written.
  const before = await readFile(join(env.config, 'workspaces.json'), 'utf8');
  assert.equal(await refused(setup.editWorkspace('app', { ...edit, path: join(temp, 'missing') }), 'workspace_invalid'), 'The path does not exist.');
  assert.equal(await refused(setup.editWorkspace('app', { ...edit, path: 'relative' }), 'workspace_invalid'), 'The path must be absolute.');
  await refused(setup.editWorkspace('nope', edit), 'workspace_not_found');
  await refused(setup.editWorkspace('Nope', edit), 'invalid_name');
  assert.equal(await readFile(join(env.config, 'workspaces.json'), 'utf8'), before);

  // A live job: the path cannot change, the other fields can.
  await jobs.write(jobOf('app', 'A-1', 'working'));
  assert.match(await refused(setup.editWorkspace('app', { ...edit, path: web }), 'workspace_busy'), /has a live job \(A-1 working\)/);
  assert.equal((await setup.editWorkspace('app', { ...edit, path: `${repo}/`, description: 'Still the backend.' })).description, 'Still the backend.');
  assert.equal((await loadRegistry(env.config)).workspaces.app!.read_checkout, repo);
  await jobs.write(jobOf('app', 'A-1', 'aborted'));
  assert.equal((await setup.editWorkspace('app', { ...edit, path: web })).path, web);
});

test('setup (SF-103): the payload\'s settings and saveDigestSettings: validated, the model kept', async () => {
  const env = await newEnv('setup-digest');
  await newRepo(env, 'setup-digest-repo', false);
  const jobs = new JobStore(env.state);
  const setup = new Setup({ configDir: env.config, jobs, exclusive: (work) => work(NO_RETIREMENT), handoffDefault: 'off' });
  assert.deepEqual(await setup.workspaceSettings(), { handoff_default: 'off', digest: { at: '08:00', weekdays_only: true, language: 'English' } });
  const registry = await loadRegistry(env.config);
  await saveRegistry({ ...registry, digest: { model: 'opus' } }, env.config);
  assert.deepEqual(await setup.saveDigestSettings({ at: '07:30', weekdays_only: false, language: ' Deutsch ' }), { at: '07:30', weekdays_only: false, language: 'Deutsch' });
  assert.deepEqual((await loadRegistry(env.config)).digest, { model: 'opus', at: '07:30', weekdays_only: false, language: 'Deutsch' });
  for (const bad of [{ at: '7:30', language: 'English' }, { at: '24:00', language: 'English' }, { at: '08:00', language: ' ' }, { at: '08:00', language: 'x'.repeat(41) }]) {
    await refused(setup.saveDigestSettings({ ...bad, weekdays_only: true }), 'invalid_digest_settings');
  }
  assert.deepEqual((await setup.workspaceSettings()).digest, { at: '07:30', weekdays_only: false, language: 'Deutsch' });
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
  // Without an owner in the input, ChatGPT plans it, saved next to the words.
  assert.equal(await readFile(join(env.state, 'requests', 'app', 'T-1.owner'), 'utf8'), 'chatgpt');
  // The Task directory is excluded from Git, as write_task does it.
  assert.match(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.software-factory\/$/m);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.deepEqual(await setup.tickets(), [{ workspace: 'app', ticket: 'T-1', title: 'Add a thing', base: 'main', draft: true, request: 'Please add\nthe thing.', owner: 'chatgpt', planning_chat: null, job: null, lands_after: [], attachments: [] }]);

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
    { workspace: 'app', ticket: 'T-1', title: 'Add a thing', base: 'main', draft: true, request: 'Please add\nthe thing.', owner: 'chatgpt', planning_chat: null, job: null, lands_after: [], attachments: [] },
    { workspace: 'app', ticket: 'T-3', title: 'Third', base: 'main', draft: false, request: null, owner: 'chatgpt', planning_chat: null, job: 'pushed', lands_after: [], attachments: [] },
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

test('setup: a ticket\'s Context owner: saved by createTicket in <state>/requests/<ws>/<ticket>.owner, read safely (missing or unknown is chatgpt), switched by setTicketOwner with the ticket actions\' checks, deleted with the ticket', async () => {
  const env = await newEnv('setup-owner');
  const repo = await newRepo(env, 'setup-owner-repo', true);
  const jobs = new JobStore(env.state);
  const setup = setupOf(env.config, jobs);
  const ownerFile = (ticket: string): string => join(env.state, 'requests', 'app', `${ticket}.owner`);
  const rowOwner = async (ticket: string): Promise<string | undefined> => (await setup.tickets()).find((row) => row.ticket === ticket)?.owner;
  await setup.createTicket({ workspace: 'app', ticket: 'T-1', title: 'One', request: 'r', owner: 'claude_code' });
  await setup.createTicket({ workspace: 'app', ticket: 'T-2', title: 'Two', request: 'r', owner: 'chatgpt' });
  assert.deepEqual([await readFile(ownerFile('T-1'), 'utf8'), await readFile(ownerFile('T-2'), 'utf8')], ['claude_code', 'chatgpt']);
  assert.deepEqual([await rowOwner('T-1'), await rowOwner('T-2')], ['claude_code', 'chatgpt']);

  // Read safely: no file (a Task file written without New ticket), unknown text or a directory is chatgpt.
  await putTask(env, repo, 'T-3', 'Three');
  assert.equal(await rowOwner('T-3'), 'chatgpt');
  for (const text of ['claude', 'CLAUDE_CODE', '', 'chatgpt\n', 'claude_code and more']) {
    await writeFile(ownerFile('T-2'), text);
    assert.equal(await rowOwner('T-2'), 'chatgpt', JSON.stringify(text));
  }
  await writeFile(ownerFile('T-2'), 'claude_code\n');
  assert.equal(await rowOwner('T-2'), 'claude_code');
  await mkdir(ownerFile('T-3'));
  assert.equal(await rowOwner('T-3'), 'chatgpt');
  await rm(ownerFile('T-3'), { recursive: true });

  // The switch: the file rewritten, the ticket's row answered with the new owner.
  const switched = await setup.setTicketOwner('app', 'T-3', 'claude_code');
  assert.deepEqual([switched.ticket, switched.title, switched.owner], ['T-3', 'Three', 'claude_code']);
  assert.deepEqual([await readFile(ownerFile('T-3'), 'utf8'), await rowOwner('T-3')], ['claude_code', 'claude_code']);
  assert.equal((await setup.setTicketOwner('app', 'T-1', 'chatgpt')).owner, 'chatgpt');
  assert.equal(await readFile(ownerFile('T-1'), 'utf8'), 'chatgpt');

  // Refused as the other ticket actions: bad names, no Task file, a live job; nothing written.
  await refused(setup.setTicketOwner('App', 'T-1', 'claude_code'), 'invalid_name');
  await refused(setup.setTicketOwner('app', '../T-1', 'claude_code'), 'invalid_ticket');
  await refused(setup.setTicketOwner('app', 'T-9', 'claude_code'), 'task_not_found');
  await assert.rejects(readFile(ownerFile('T-9')), { code: 'ENOENT' });
  await jobs.write(jobOf('app', 'T-1', 'working'));
  await refused(setup.setTicketOwner('app', 'T-1', 'claude_code'), 'job_active');
  assert.equal(await readFile(ownerFile('T-1'), 'utf8'), 'chatgpt');
  // A finished job keeps the switch.
  await jobs.write(jobOf('app', 'T-1', 'pushed'));
  assert.equal((await setup.setTicketOwner('app', 'T-1', 'claude_code')).owner, 'claude_code');

  // Delete takes the owner with the words.
  await setup.deleteTicket('app', 'T-2');
  await assert.rejects(readFile(ownerFile('T-2')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(env.state, 'requests', 'app', 'T-2.md')), { code: 'ENOENT' });
});

test('setup: taskText reads the Task file or its archived copy through the reader; taskTitle is the title (active, else archived) or null', async () => {
  const env = await newEnv('setup-task-text');
  const repo = await newRepo(env, 'setup-task-text-repo', true);
  const jobs = new JobStore(env.state);
  const setup = setupOf(env.config, jobs);
  await putTask(env, repo, 'T-1', 'First <b>one</b>');
  const text = await setup.taskText('app', 'T-1');
  assert.equal(text, await readFile(join(repo, '.software-factory', 'T-1.md'), 'utf8'));
  assert.equal(await setup.taskTitle('app', 'T-1'), 'First <b>one</b>');
  // The archive only with archived; the active file is not read then.
  await refused(setup.taskText('app', 'T-1', true), 'task_not_found');
  await mkdir(join(repo, '.software-factory', 'archive'), { recursive: true });
  await writeFile(join(repo, '.software-factory', 'archive', 'T-0.md'), '---\nticket: T-0\ntitle: Zero\nbase: main\n---\n\nOld.\n');
  assert.equal(await setup.taskText('app', 'T-0', true), '---\nticket: T-0\ntitle: Zero\nbase: main\n---\n\nOld.\n');
  await refused(setup.taskText('app', 'T-0'), 'task_not_found');
  // The title of an archived Task file comes from the archive (SF-057); the active file wins.
  assert.equal(await setup.taskTitle('app', 'T-0'), 'Zero');
  await writeFile(join(repo, '.software-factory', 'archive', 'T-1.md'), '---\nticket: T-1\ntitle: Archived one\nbase: main\n---\n');
  assert.equal(await setup.taskTitle('app', 'T-1'), 'First <b>one</b>');
  // The reader's refusals: not a Task file of the ticket, bad names, an unknown workspace.
  await writeFile(join(repo, '.software-factory', 'T-2.md'), '---\nticket: T-9\ntitle: Wrong\nbase: main\n---\n');
  await refused(setup.taskText('app', 'T-2'), 'invalid_content');
  await refused(setup.taskText('App', 'T-1'), 'invalid_name');
  await refused(setup.taskText('app', '../T-1'), 'invalid_ticket');
  await refused(setup.taskText('other', 'T-1'), 'workspace_not_found');
  for (const [workspace, ticket] of [['App', 'T-1'], ['app', '../T-1'], ['other', 'T-1'], ['app', 'T-3']]) {
    assert.equal(await setup.taskTitle(workspace!, ticket!), null, `${workspace}/${ticket}`);
  }
});

test('setup (SF-081): createTicket records "created" by you; saveTask writes over the version read only, records "edited", and keeps the writer\'s refusals', async () => {
  const env = await newEnv('setup-save-task');
  const repo = await newRepo(env, 'setup-save-task-repo', true);
  const jobs = new JobStore(env.state);
  const history = new TicketHistory(env.state);
  const setup = setupOf(env.config, jobs, undefined, history);
  await setup.createTicket({ workspace: 'app', ticket: 'T-1', title: 'One', request: 'r' });
  const path = join(repo, '.software-factory', 'T-1.md');
  const skeleton = await readFile(path, 'utf8');
  assert.deepEqual((await history.read('app', 'T-1')).map((event) => [event.kind, event.by, event.sha256]), [['created', 'you', taskSha256(skeleton)]]);

  // taskFile: the text, its sha256 and the file's modification time.
  const file = await setup.taskFile('app', 'T-1');
  assert.deepEqual([file.text, file.sha256], [skeleton, taskSha256(skeleton)]);
  assert.ok(!Number.isNaN(Date.parse(file.mtime)));

  const plan = '---\nticket: T-1\ntitle: One\nbase: main\nscope: [src/**]\n---\n\n# T-1: One\n\nDo it.\n';
  const saved = await setup.saveTask('app', 'T-1', plan, file.sha256);
  assert.deepEqual(saved, { path: '.software-factory/T-1.md', status: 'replaced', bytes: Buffer.byteLength(plan), sha256: taskSha256(plan) });
  assert.equal(await readFile(path, 'utf8'), plan);
  assert.deepEqual((await history.read('app', 'T-1')).map((event) => [event.kind, event.by, event.sha256]), [['created', 'you', taskSha256(skeleton)], ['edited', 'you', taskSha256(plan)]]);

  // The page's version is not the file's any more (write_task wrote meanwhile): refused, unchanged.
  assert.match(await refused(setup.saveTask('app', 'T-1', `${plan}More.\n`, file.sha256), 'task_changed'), /changed since this version was read/);
  // The writer's own refusals: not a Task file of the ticket, a job running on it, bad names, an unknown workspace, a gone file.
  await refused(setup.saveTask('app', 'T-1', '---\nticket: T-2\ntitle: x\nbase: main\n---\n', taskSha256(plan)), 'invalid_content');
  await jobs.write(jobOf('app', 'T-1', 'working'));
  await refused(setup.saveTask('app', 'T-1', `${plan}More.\n`, taskSha256(plan)), 'job_active');
  await refused(setup.saveTask('App', 'T-1', plan, taskSha256(plan)), 'invalid_name');
  await refused(setup.saveTask('app', '../T-1', plan, taskSha256(plan)), 'invalid_ticket');
  await refused(setup.saveTask('other', 'T-1', plan, taskSha256(plan)), 'workspace_not_found');
  await refused(setup.saveTask('app', 'T-9', '---\nticket: T-9\ntitle: x\nbase: main\n---\n', taskSha256(plan)), 'task_not_found');
  assert.equal(await readFile(path, 'utf8'), plan);
  assert.equal((await history.read('app', 'T-1')).length, 2);

  // Without a history nothing is recorded.
  const plain = setupOf(env.config, jobs);
  await plain.createTicket({ workspace: 'app', ticket: 'T-2', title: 'Two', request: 'r' });
  assert.deepEqual(await history.read('app', 'T-2'), []);
});

// A Task file with lands_after, written as the Context owner would (raw, into .software-factory/).
async function putLanding(repo: string, ticket: string, landsAfter: string, archived = false): Promise<void> {
  const dir = join(repo, '.software-factory', ...(archived ? ['archive'] : []));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${ticket}.md`), `---\nticket: ${ticket}\ntitle: Title ${ticket}\nbase: main\nlands_after: [${landsAfter}]\n---\n\n# ${ticket}\n`);
}

// A commit on a new branch of the checkout, back on main after; its sha.
function branchWithCommit(repo: string, branch: string): string {
  git(repo, 'checkout', '-q', '-b', branch);
  git(repo, 'commit', '-q', '--allow-empty', '-m', `work of ${branch}`);
  const sha = git(repo, 'rev-parse', 'HEAD').trim();
  git(repo, 'checkout', '-q', 'main');
  return sha;
}

test('setup (SF-084): lands_after with each dependency state from the jobs, the merge request and Git; another workspace; missing; a cycle; the Git answer cached 30 s', async () => {
  const env = await newEnv('setup-deps');
  const repo = await newRepo(env, 'setup-deps-app', true);
  const web = await newRepo({ ...env, config: join(temp, 'setup-deps-web-config') }, 'setup-deps-web', true);
  await saveRegistry({ workspaces: { app: { read_checkout: repo }, web: { read_checkout: web } } }, env.config);
  const jobs = new JobStore(env.state);
  let clock = 1_000_000;
  const setup = setupOf(env.config, jobs, () => clock);

  // MERGED: pushed, no merge request recorded, its branch merged into origin/main (Git decides).
  branchWithCommit(repo, 'MERGED-x');
  git(repo, 'push', '-q', 'origin', 'MERGED-x:main');
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'merge', '-q', '--ff-only', 'origin/main');
  await jobs.write({ ...jobOf('app', 'MERGED', 'pushed'), branch: 'MERGED-x' });
  // RECORDED: pushed, the merge request recorded merged; no branch anywhere.
  await jobs.write({ ...jobOf('app', 'RECORDED', 'pushed'), branch: 'gone-x', mr: { host: 'github', number: 7, url: 'https://example.test/7', state: 'merged' } });
  // PUSHED: pushed, no merge request recorded, its branch not in origin/main (Git decides).
  branchWithCommit(repo, 'PUSHED-x');
  await jobs.write({ ...jobOf('app', 'PUSHED', 'pushed'), branch: 'PUSHED-x' });
  // OPEN and CLOSED: pushed, the merge request recorded open or closed: a known state, not merged,
  // even with the branch in origin/main (Git is not asked).
  for (const [ticket, mrState, number] of [['OPEN', 'open', 8], ['CLOSED', 'closed', 9]] as const) {
    branchWithCommit(repo, `${ticket}-x`);
    git(repo, 'push', '-q', 'origin', `${ticket}-x:main`);
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'merge', '-q', '--ff-only', 'origin/main');
    await jobs.write({ ...jobOf('app', ticket, 'pushed'), branch: `${ticket}-x`, mr: { host: 'github', number, url: `https://example.test/${number}`, state: mrState } });
  }
  // MOVED: pushed, the commit it pushed not merged; the local branch since reset onto main does not count.
  const pushedTip = branchWithCommit(repo, 'MOVED-x');
  git(repo, 'branch', '-q', '-f', 'MOVED-x', 'main');
  await jobs.write({ ...jobOf('app', 'MOVED', 'pushed'), branch: 'MOVED-x', prepared_commit: pushedTip });
  // RUNNING: a live job (with a Task file that lands after LOOP-A).
  await putLanding(repo, 'RUNNING', 'LOOP-A');
  await jobs.write(jobOf('app', 'RUNNING', 'awaiting_review'));
  // PLANNED: a Task file, a failed job. OLD: only an archived Task file, its job archived aborted.
  await putLanding(repo, 'PLANNED', '');
  await jobs.write(jobOf('app', 'PLANNED', 'failed'));
  await putLanding(repo, 'OLD', '', true);
  await jobs.write(jobOf('app', 'OLD', 'aborted'));
  await jobs.archive('app', 'OLD');
  // ARCHIVED: no Task file; its last job, archived, pushed and recorded merged (an older archived one aborted).
  await jobs.write(jobOf('app', 'ARCHIVED', 'aborted'));
  await jobs.archive('app', 'ARCHIVED');
  await new Promise((done) => setTimeout(done, 1100));
  await jobs.write({ ...jobOf('app', 'ARCHIVED', 'pushed'), mr: { host: 'gitlab', number: 2, url: 'https://example.test/2', state: 'merged' } });
  await jobs.archive('app', 'ARCHIVED');
  // SHELVED: its Task file archived with its job, pushed and not merged (no merge request, the
  // branch not in origin/main): planned, as an archived Task file whose job was not merged.
  // ABANDONED: the same job without any Task file: pushed.
  for (const ticket of ['SHELVED', 'ABANDONED']) {
    await jobs.write({ ...jobOf('app', ticket, 'pushed'), branch: `${ticket}-x`, prepared_commit: branchWithCommit(repo, `${ticket}-x`) });
    await jobs.archive('app', ticket);
  }
  await putLanding(repo, 'SHELVED', '', true);
  // web/W-1: planned in the other workspace.
  await putLanding(web, 'W-1', '');

  await putLanding(repo, 'MAIN', 'MERGED, RECORDED, PUSHED, OPEN, CLOSED, MOVED, RUNNING, PLANNED, OLD, ARCHIVED, SHELVED, ABANDONED, web/W-1, NOWHERE, ghost/G-1, app/MERGED');
  // A cycle of two: listed with its states, no recursion.
  await putLanding(repo, 'LOOP-A', 'LOOP-B');
  await putLanding(repo, 'LOOP-B', 'LOOP-A');

  const rows = await setup.tickets();
  assert.deepEqual(rows.map((row) => `${row.workspace}/${row.ticket}`), ['app/LOOP-A', 'app/LOOP-B', 'app/MAIN', 'app/PLANNED', 'web/W-1']);
  const main = rows.find((row) => row.ticket === 'MAIN')!;
  assert.deepEqual(main.lands_after, [
    { workspace: 'app', ticket: 'MERGED', state: 'merged' },
    { workspace: 'app', ticket: 'RECORDED', state: 'merged' },
    { workspace: 'app', ticket: 'PUSHED', state: 'pushed' },
    { workspace: 'app', ticket: 'OPEN', state: 'pushed' },
    { workspace: 'app', ticket: 'CLOSED', state: 'pushed' },
    { workspace: 'app', ticket: 'MOVED', state: 'pushed' },
    { workspace: 'app', ticket: 'RUNNING', state: 'running' },
    { workspace: 'app', ticket: 'PLANNED', state: 'planned' },
    { workspace: 'app', ticket: 'OLD', state: 'planned' },
    { workspace: 'app', ticket: 'ARCHIVED', state: 'merged' },
    { workspace: 'app', ticket: 'SHELVED', state: 'planned' },
    { workspace: 'app', ticket: 'ABANDONED', state: 'pushed' },
    { workspace: 'web', ticket: 'W-1', state: 'planned' },
    { workspace: 'app', ticket: 'NOWHERE', state: 'missing' },
    { workspace: 'ghost', ticket: 'G-1', state: 'missing' },
  ]);
  assert.deepEqual(rows.find((row) => row.ticket === 'LOOP-A')!.lands_after, [{ workspace: 'app', ticket: 'LOOP-B', state: 'planned' }]);
  assert.deepEqual(rows.find((row) => row.ticket === 'LOOP-B')!.lands_after, [{ workspace: 'app', ticket: 'LOOP-A', state: 'planned' }]);
  assert.deepEqual(rows.find((row) => row.ticket === 'PLANNED')!.lands_after, []);
  // The live job's Task file: the job page's Waits for.
  assert.deepEqual(await setup.jobDependencies(), [{ workspace: 'app', ticket: 'RUNNING', lands_after: [{ workspace: 'app', ticket: 'LOOP-A', state: 'planned' }] }]);

  // PUSHED gets merged on the host: Git's answer is kept for 30 s per ticket, then asked again.
  git(repo, 'checkout', '-q', '-b', 'host-merge', 'origin/main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge PUSHED-x', 'PUSHED-x');
  git(repo, 'push', '-q', 'origin', 'host-merge:main');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'fetch', '-q', 'origin');
  const stateOf = async (ticket: string) => (await setup.tickets()).find((row) => row.ticket === 'MAIN')!.lands_after.find((dep) => dep.ticket === ticket)!.state;
  clock += MERGE_CHECK_TTL_MS - 1;
  assert.equal(await stateOf('PUSHED'), 'pushed');
  clock += 1;
  assert.equal(await stateOf('PUSHED'), 'merged');
  // A job state change is seen at once (no cache beyond Git's answer): RUNNING pushed, not merged.
  await jobs.write({ ...jobOf('app', 'RUNNING', 'pushed'), branch: 'RUNNING-x', prepared_commit: branchWithCommit(repo, 'RUNNING-x') });
  git(repo, 'branch', '-q', '-D', 'RUNNING-x');
  assert.equal(await stateOf('RUNNING'), 'pushed');
  assert.deepEqual(await setup.jobDependencies(), []);
});

test('setup (SF-064): the images folder moves with archive and restore, goes with delete; restore over an existing folder is refused; a new ticket starts without images', async () => {
  const env = await newEnv('setup-images');
  const repo = await newRepo(env, 'setup-images-repo', false);
  const jobs = new JobStore(env.state);
  const setup = setupOf(env.config, jobs);
  const dir = join(repo, '.software-factory');
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  await setup.createTicket({ workspace: 'app', ticket: 'T-1', title: 'One', request: 'r' });
  assert.deepEqual(await setup.addAttachment('app', 'T-1', PNG), { name: '1.png', bytes: PNG.length, type: 'image/png' });
  assert.deepEqual((await setup.tickets())[0]!.attachments, [{ name: '1.png', bytes: PNG.length, type: 'image/png' }]);
  assert.deepEqual((await setup.readAttachment('app', 'T-1', '1.png')).data, PNG);

  // Archive: the folder follows the Task file and replaces an older archived one; the reference resolves next to it.
  await mkdir(join(dir, 'archive', 'T-1'), { recursive: true });
  await writeFile(join(dir, 'archive', 'T-1', 'old.png'), PNG);
  await setup.archiveTicket('app', 'T-1');
  assert.deepEqual(await readdir(join(dir, 'archive', 'T-1')), ['1.png']);
  assert.equal(await readFile(join(dir, 'archive', 'T-1.md'), 'utf8').then(() => true), true);
  await assert.rejects(readdir(join(dir, 'T-1')), { code: 'ENOENT' });
  // An archived ticket's images cannot be changed.
  await refused(setup.addAttachment('app', 'T-1', PNG), 'task_not_found');

  // Restore: refused while .software-factory/T-1/ exists, before anything moves; then the folder comes back.
  await mkdir(join(dir, 'T-1'));
  assert.match(await refused(setup.restoreTicket('app', 'T-1'), 'ticket_exists'), /T-1\/ already exists/);
  assert.deepEqual([await readdir(join(dir, 'archive', 'T-1')), (await readdir(join(dir, 'archive'))).includes('T-1.md')], [['1.png'], true]);
  await rm(join(dir, 'T-1'), { recursive: true });
  await setup.restoreTicket('app', 'T-1');
  assert.deepEqual(await readdir(join(dir, 'T-1')), ['1.png']);
  assert.deepEqual((await readdir(join(dir, 'archive'))).sort(), []);

  // Archive again without images: the older archived images go with the older archived Task file.
  await rm(join(dir, 'T-1'), { recursive: true });
  await setup.archiveTicket('app', 'T-1');
  await assert.rejects(readdir(join(dir, 'archive', 'T-1')), { code: 'ENOENT' });
  await setup.restoreTicket('app', 'T-1');
  await setup.addAttachment('app', 'T-1', PNG);

  // Delete: the active folder and an archived one go with the Task files.
  await mkdir(join(dir, 'archive', 'T-1'), { recursive: true });
  await writeFile(join(dir, 'archive', 'T-1', '2.png'), PNG);
  const deleted = await setup.deleteTicket('app', 'T-1');
  assert.deepEqual(deleted.deleted, ['.software-factory/T-1.md', '.software-factory/T-1/', '.software-factory/archive/T-1/']);
  await assert.rejects(readdir(join(dir, 'T-1')), { code: 'ENOENT' });
  await assert.rejects(readdir(join(dir, 'archive', 'T-1')), { code: 'ENOENT' });

  // A new ticket with the key of a deleted one (or of a Task file removed by hand) starts without images.
  await mkdir(join(dir, 'T-1'));
  await writeFile(join(dir, 'T-1', '1.png'), PNG);
  await setup.createTicket({ workspace: 'app', ticket: 'T-1', title: 'Again', request: 'r' });
  assert.deepEqual((await setup.tickets())[0]!.attachments, []);
  await assert.rejects(readdir(join(dir, 'T-1')), { code: 'ENOENT' });

  // The ticket "archive" (a valid key, the archive folder's name) has no images: creating, archiving
  // and deleting it never touch the archive folder.
  await mkdir(join(dir, 'archive', 'KEEP'), { recursive: true });
  await setup.createTicket({ workspace: 'app', ticket: 'archive', title: 'A', request: 'r' });
  await refused(setup.addAttachment('app', 'archive', PNG), 'invalid_ticket');
  await setup.archiveTicket('app', 'archive');
  await setup.deleteTicket('app', 'archive');
  assert.deepEqual(await readdir(join(dir, 'archive')), ['KEEP']);

  // The guard holds through the setup.
  await jobs.write(jobOf('app', 'T-1', 'working'));
  await refused(setup.addAttachment('app', 'T-1', PNG), 'job_active');
  await refused(setup.removeAttachment('app', 'T-1', '1.png'), 'job_active');
  await refused(setup.addAttachment('App', 'T-1', PNG), 'invalid_name');
});
