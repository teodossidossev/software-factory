// Archive, restore and delete of a ticket (SF-027): the files move or go, a live job refuses, a
// finished job leaves the Jobs list through the lock's retireFinished; the HTTP routes with the
// action checks; the page's buttons, the delete confirmation and the archived list.
import assert from 'node:assert/strict';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import { type Job, JobStore } from '../src/jobs.js';
import { Setup } from '../src/setup.js';
import { act, fakeActions, fakeReviewers, fakeSetup, fetchRaw, openStream, type Reply, ticketRow, workspaceRow } from './support/dashboard-client.js';
import { withDashboard } from './support/dashboard-state.js';
import { type FakeElement, loadPage } from './support/fake-dom.js';
import { newEnv, newRepo, putTask } from './support/harness.js';

const job = (ticket: string, state: Job['state']): Job => ({
  workspace: 'app', ticket, branch: `${ticket}-x`, base: 'main', base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
  mr_attempts: 0, state, iteration: 0, session_id: null, created_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-11-01T10:00:00.000Z',
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test('setup: archive moves the Task file and the MR text, restore brings them back, delete removes them; a live job refuses; a finished job is retired', async () => {
  const env = await newEnv('ticket-actions');
  const repo = await newRepo(env, 'ticket-actions-repo', false);
  const jobs = new JobStore(env.state);
  const retired: string[] = [];
  // An immediate lock whose scope archives the job record; test/ticket-retirement.test.ts runs
  // the real Execution lock and retirement.
  const setup = new Setup({
    configDir: env.config, jobs,
    exclusive: (work) => work({
      retireFinished: async (workspace, ticket) => {
        retired.push(`${workspace}/${ticket}`);
        const { branch } = (await jobs.read(workspace, ticket))!;
        return { archived: `jobs/${workspace}/${await jobs.archive(workspace, ticket)}`, branch };
      },
    }),
  });
  const dir = join(repo, '.software-factory');
  await putTask(env, repo, 'T-1', 'One');
  await putTask(env, repo, 'T-2', 'Two');
  await writeFile(join(dir, 'T-1.mr.md'), 'feat(T-1): One\n');
  await jobs.write(job('T-1', 'pushed'));
  await jobs.write(job('T-2', 'working'));

  // A live job refuses every action.
  for (const action of ['archiveTicket', 'deleteTicket', 'restoreTicket'] as const) {
    await assert.rejects(setup[action]('app', 'T-2'), (error: unknown) => error instanceof FactoryError && error.code === 'job_active', action);
  }
  // Archive: both files move; the pushed job is retired.
  assert.deepEqual(await setup.archiveTicket('app', 'T-1'), { workspace: 'app', ticket: 'T-1', path: '.software-factory/archive/T-1.md', jobArchived: true });
  assert.deepEqual((await readdir(join(dir, 'archive'))).sort(), ['T-1.md', 'T-1.mr.md']);
  assert.equal(await exists(join(dir, 'T-1.md')), false);
  assert.deepEqual(retired, ['app/T-1']);
  assert.equal(await jobs.read('app', 'T-1'), undefined);
  assert.deepEqual((await setup.tickets()).map((row) => row.ticket), []);
  assert.deepEqual(await setup.archivedTickets(), [{ workspace: 'app', ticket: 'T-1', title: 'One' }]);
  await assert.rejects(setup.archiveTicket('app', 'T-1'), { code: 'task_not_found' });

  // Restore: back, with its MR text; a second restore is refused once a Task file exists.
  assert.deepEqual(await setup.restoreTicket('app', 'T-1'), { workspace: 'app', ticket: 'T-1', path: '.software-factory/T-1.md' });
  assert.equal(await readFile(join(dir, 'T-1.mr.md'), 'utf8'), 'feat(T-1): One\n');
  assert.deepEqual(await setup.archivedTickets(), []);
  await setup.archiveTicket('app', 'T-1');
  await putTask(env, repo, 'T-1', 'One again');
  await assert.rejects(setup.restoreTicket('app', 'T-1'), { code: 'ticket_exists' });

  // Delete: the active and the archived copies go; no job, nothing retired.
  const deleted = await setup.deleteTicket('app', 'T-1');
  assert.deepEqual(deleted.deleted.sort(), ['.software-factory/T-1.md', '.software-factory/archive/T-1.md', '.software-factory/archive/T-1.mr.md']);
  assert.equal(deleted.jobArchived, false);
  assert.equal(await exists(join(dir, 'T-1.md')), false);
  await assert.rejects(setup.deleteTicket('app', 'T-1'), { code: 'task_not_found' });
  await assert.rejects(setup.archiveTicket('app', '../x'), { code: 'invalid_ticket' });
  assert.deepEqual(retired, ['app/T-1']);
});

const error = (reply: Reply): { status: number; code: string } => ({ status: reply.status, code: JSON.parse(reply.body).error.code });

test('dashboard: the ticket action routes are POST only with the action checks, dispatch exactly, map the errors and refresh the jobs and tickets of every page', async () => {
  const setup = fakeSetup([workspaceRow('app')], [ticketRow('app', 'T-5')], [{ workspace: 'app', ticket: 'T-4', title: 'Old' }]);
  await withDashboard('dash-ticket-actions', fakeActions(), async (dashboard) => {
    const base = dashboard.url;
    const port = Number(base.port);
    assert.deepEqual(JSON.parse((await fetchRaw(new URL('api/tickets', base))).body).archived, [{ workspace: 'app', ticket: 'T-4', title: 'Old' }]);
    for (const action of ['archive', 'restore', 'delete']) {
      const path = `api/tickets/app/T-5/${action}`;
      for (const method of ['GET', 'HEAD', 'PUT']) {
        const reply = await act(base, path, {}, { method });
        assert.deepEqual([reply.status, reply.headers.allow], [405, 'POST'], `${method} ${action}`);
      }
      assert.deepEqual(error(await act(base, path, {}, { headers: { origin: `http://localhost:${port}` } })), { status: 403, code: 'invalid_origin' });
      assert.deepEqual(error(await act(base, path, undefined, { body: '{"x":1}' })), { status: 400, code: 'invalid_body' });
      assert.equal((await act(base, `api/tickets/App/T-5/${action}`, {})).status, 404);
    }
    assert.equal((await act(base, 'api/tickets/app/T-5/other', {})).status, 405);
    assert.deepEqual(setup.calls, []);

    const stream = await openStream(new URL('api/stream', base));
    await stream.next('tickets');
    assert.equal(JSON.parse((await act(base, 'api/tickets/app/T-5/archive', {})).body).result.path, '.software-factory/archive/T-5.md');
    await stream.next('jobs');
    await stream.next('tickets');
    assert.equal((await act(base, 'api/tickets/app/T-4/restore', {})).status, 200);
    await stream.next('tickets');
    assert.equal((await act(base, 'api/tickets/app/T-4/delete', {})).status, 200);
    await stream.next('jobs');
    assert.deepEqual(setup.calls, [['archiveTicket', 'app', 'T-5'], ['restoreTicket', 'app', 'T-4'], ['deleteTicket', 'app', 'T-4']]);
    for (const [code, status] of [['job_active', 409], ['task_not_found', 404], ['ticket_exists', 409]] as const) {
      setup.answer = new FactoryError(code, `The ${code} message.`);
      assert.deepEqual(error(await act(base, 'api/tickets/app/T-5/delete', {})), { status, code });
    }
    stream.close();
  }, fakeReviewers(), setup);
});

test('client: a ticket card has Archive and Delete…; delete asks first; the archived list restores and deletes; a selected job that leaves the list is replaced', async () => {
  const STATIC_DIR = new URL('../../static/', import.meta.url);
  const pushed = {
    workspace: 'app', ticket: 'T-1', branch: 'T-1-x', base: 'main', state: 'pushed', iteration: 1, mr_attempts: 1, updated_at: '2026-11-01T10:05:00.000Z',
    created_at: '2026-11-01T10:00:00.000Z', error: null, worktree: null, prepared_commit: 'a'.repeat(40), files: 0, undeclared: 0, deleted: 0, reviewer: 'none',
  };
  const page = await loadPage(STATIC_DIR, (path) => (path === 'api/jobs' ? { jobs: [pushed] } : path === 'api/jobs/app/T-1' ? { job: pushed, iterations: [], mr: false, history: [] } : undefined));
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs: [pushed] });
  stream.emit('workspaces', { workspaces: [workspaceRow('app')] });
  stream.emit('tickets', { tickets: [{ ...ticketRow('app', 'T-1', 'One', false, 'pushed'), reviewer: { status: 'none' }, conversation: { message: 'm', url: 'https://chatgpt.com/?q=m' } }], archived: [{ workspace: 'app', ticket: 'T-0', title: 'Zero' }] });
  await page.flush();
  const card = page.$('ticket-list').children[0] as FakeElement;
  const buttons = card.all().filter((element) => element.tagName === 'BUTTON');
  assert.deepEqual(buttons.map((button) => button.textContent), ['Archive', 'Delete…', 'Copy']);
  // Archive: one request, the outcome in the status line.
  buttons[0]!.click();
  buttons[0]!.click();
  await page.flush();
  const posts = (): typeof page.requests => page.requests.filter((request) => request.method === 'POST');
  assert.deepEqual([posts().length, posts()[0]!.path, posts()[0]!.body], [1, 'api/tickets/app/T-1/archive', '{}']);
  posts()[0]!.respond(200, { ok: true, result: { workspace: 'app', ticket: 'T-1', path: '.software-factory/archive/T-1.md', jobArchived: true } });
  await page.flush();
  assert.equal(page.$('ticket-action-status').textContent, 'Archived app/T-1: .software-factory/archive/T-1.md. Its finished job left the Jobs list.');
  // Delete… asks first; Cancel sends nothing; Confirm deletes.
  (page.$('ticket-list').children[0] as FakeElement).all().find((element) => element.textContent === 'Delete…')!.click();
  assert.equal(page.$('ticket-confirm').hidden, false);
  assert.equal(page.$('ticket-confirm-title').textContent, 'Delete app/T-1?');
  assert.match(page.$('ticket-confirm-text').textContent, /Cannot be undone; Archive keeps the file instead\./);
  assert.deepEqual([page.$('ticket-ok').textContent, page.$('ticket-ok').className], ['Delete the ticket', 'btn btn-danger']);
  page.$('ticket-cancel').click();
  assert.equal(posts().length, 1);
  (page.$('ticket-list').children[0] as FakeElement).all().find((element) => element.textContent === 'Delete…')!.click();
  page.$('ticket-ok').click();
  await page.flush();
  assert.deepEqual([posts().length, posts()[1]!.path], [2, 'api/tickets/app/T-1/delete']);
  // The archived list: Restore and Delete….
  assert.equal(page.$('archived').hidden, false);
  assert.equal(page.$('archived-count').textContent, '(1)');
  const archivedButtons = (page.$('archived-list').children[0] as FakeElement).all().filter((element) => element.tagName === 'BUTTON');
  assert.deepEqual(archivedButtons.map((button) => button.textContent), ['Restore', 'Delete…']);
  archivedButtons[0]!.click();
  await page.flush();
  assert.equal(posts()[2]!.path, 'api/tickets/app/T-0/restore');
  // The selected job leaves the list: the detail hides and the stream follows no job.
  stream.emit('jobs', { jobs: [] });
  await page.flush();
  assert.equal(page.$('detail').hidden, true);
  assert.doesNotMatch(page.streams.at(-1)!.url, /job=/);
});

test('dashboard: a finished job is archived from its card; a live one is refused; the page shows Archive only for a finished job', async () => {
  const actions = fakeActions({ archived: 'jobs/app/T-0.20261103T100000Z', branch: 'T-0-old' });
  await withDashboard('dash-archive-job', actions, async (dashboard) => {
    const base = dashboard.url;
    // T-0 is failed in the fixture, T-1 awaiting_review. The terminal guard is the Execution's
    // archiveFinished (never reset); its refusal reaches the page as 409 invalid_state.
    const done = await act(base, 'api/jobs/app/T-0/archive', {});
    assert.equal(done.status, 200, done.body);
    assert.deepEqual(actions.calls, [['archiveFinished', 'app', 'T-0']]);
    actions.answer = new FactoryError('invalid_state', 'Only a finished job can be archived; the job is awaiting_review. Abort it first.');
    assert.deepEqual(error(await act(base, 'api/jobs/app/T-1/archive', {})), { status: 409, code: 'invalid_state' });
    assert.deepEqual(error(await act(base, 'api/jobs/app/T-0/archive', undefined, { body: '{"x":1}' })), { status: 400, code: 'invalid_body' });
    assert.equal((await act(base, 'api/jobs/app/T-0/archive', {}, { method: 'GET' })).status, 405);
    assert.deepEqual(actions.calls, [['archiveFinished', 'app', 'T-0'], ['archiveFinished', 'app', 'T-1']]);
  });

  const STATIC_DIR = new URL('../../static/', import.meta.url);
  const shape = (state: string) => ({
    workspace: 'app', ticket: 'T-1', branch: 'T-1-x', base: 'main', state, iteration: 0, mr_attempts: 0, updated_at: '2026-11-01T10:05:00.000Z',
    created_at: '2026-11-01T10:00:00.000Z', error: null, worktree: null, prepared_commit: null, files: 0, undeclared: 0, deleted: 0, reviewer: 'none',
  });
  const page = await loadPage(STATIC_DIR, (path) => (path === 'api/jobs' ? { jobs: [shape('aborted')] } : path === 'api/jobs/app/T-1' ? { job: shape('aborted'), iterations: [], mr: false, history: [] } : undefined));
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('job', { job: shape('aborted'), iterations: [], mr: false, history: [] });
  assert.deepEqual([page.$('archive-job-button').hidden, page.$('approve-button').hidden, page.$('abort-button').hidden], [false, true, true]);
  page.$('archive-job-button').click();
  await page.flush();
  const post = page.requests.filter((request) => request.method === 'POST');
  assert.deepEqual([post.length, post[0]!.path, post[0]!.body], [1, 'api/jobs/app/T-1/archive', '{}']);
  post[0]!.respond(200, { ok: true, result: { archived: 'jobs/app/T-1.20261103T100000Z', branch: 'T-1-x' } });
  await page.flush();
  assert.equal(page.$('action-status').textContent, 'Archived: the job left the list (its history is in jobs/app/T-1.20261103T100000Z); the branch T-1-x is untouched.');
  stream.emit('job', { job: shape('working'), iterations: [], mr: false, history: [] });
  assert.deepEqual([page.$('archive-job-button').hidden, page.$('abort-button').hidden], [true, false]);
});
