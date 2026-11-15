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
import { act, fakeActions, fakeSetup, fetchRaw, openStream, type Reply, served, ticketRow, workspaceRow } from './support/dashboard-client.js';
import { withDashboard } from './support/dashboard-state.js';
import { type FakeElement, loadPage } from './support/fake-dom.js';
import { newEnv, newRepo, putTask } from './support/harness.js';

const job = (ticket: string, state: Job['state']): Job => ({
  workspace: 'app', ticket, branch: `${ticket}-x`, base: 'main', continues: null, builds_on: null, builds_on_commit: null,base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
  mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state, iteration: 0, session_id: null, mr: null, created_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-11-01T10:00:00.000Z',
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
  const archived = await setup.archiveTicket('app', 'T-1');
  assert.deepEqual({ ...archived, retired: undefined }, { workspace: 'app', ticket: 'T-1', path: '.software-factory/archive/T-1.md', jobArchived: true, retired: undefined });
  assert.equal(archived.retired?.branch, 'T-1-x');
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
  }, setup);
});

test('dashboard (SF-103): workspace-edit and digest-settings are POST only with strict bodies, dispatch exactly, map the errors and refresh the setup', async () => {
  const setup = fakeSetup([workspaceRow('app')]);
  await withDashboard('dash-workspace-edit', fakeActions(), async (dashboard) => {
    const base = dashboard.url;
    const edit = { path: '/srv/app', description: 'The backend.', app: 'shop', handoff: 'default', color: 'auto', digest: { track: true, my_work: false } };
    for (const path of ['api/workspaces/app/edit', 'api/digest-settings']) {
      for (const method of ['GET', 'PUT']) {
        const reply = await act(base, path, {}, { method });
        assert.deepEqual([reply.status, reply.headers.allow], [405, 'POST'], `${method} ${path}`);
      }
      assert.deepEqual(error(await act(base, path, {}, { headers: { origin: `http://localhost:${base.port}` } })), { status: 403, code: 'invalid_origin' });
    }
    assert.equal((await act(base, 'api/workspaces/App/edit', edit)).status, 404);
    const bad: unknown[] = [
      {}, { ...edit, name: 'other' }, { ...edit, handoff: 'on' }, { ...edit, handoff: null }, { ...edit, color: 'pink' }, { ...edit, description: undefined },
      { ...edit, digest: { track: true } }, { ...edit, digest: { track: true, my_work: false, extra: 1 } }, { ...edit, work_checkout: '/x' }, [],
    ];
    for (const body of bad) {
      assert.deepEqual(error(await act(base, 'api/workspaces/app/edit', body)), { status: 400, code: 'invalid_body' }, JSON.stringify(body));
    }
    for (const body of [
      {}, { at: '08:00' }, { at: '08:00', weekdays_only: true }, { times: ['08:00'], weekdays_only: 'yes', language: 'English' }, { times: ['08:00'], weekdays_only: true, language: 'English', model: 'opus' },
      { times: '08:00' }, { times: [8] }, { times: null }, [],
    ]) {
      assert.deepEqual(error(await act(base, 'api/digest-settings', body)), { status: 400, code: 'invalid_body' }, JSON.stringify(body));
    }
    assert.deepEqual(setup.calls, []);

    const stream = await openStream(new URL('api/stream', base));
    const first = await stream.next('workspaces');
    assert.deepEqual([first.handoff_default, first.digest], ['checkout', { times: ['08:00'], weekdays_only: true, language: 'English' }]);
    const edited = JSON.parse((await act(base, 'api/workspaces/app/edit', edit)).body).result;
    assert.deepEqual([edited.app, edited.description, edited.digest], ['shop', 'The backend.', { track: true, my_work: false }]);
    assert.deepEqual(setup.calls.at(-1), ['editWorkspace', 'app', edit]);
    await stream.next('workspaces');
    const settings = { times: ['07:30', '12:00'], weekdays_only: false, language: 'Deutsch' };
    assert.deepEqual(JSON.parse((await act(base, 'api/digest-settings', settings)).body).result, settings);
    assert.deepEqual(setup.calls.at(-1), ['saveDigestSettings', settings]);
    await stream.next('workspaces');
    // Only times: it reaches saveDigestSettings as given.
    const times = { times: ['07:30', '12:00'] };
    assert.deepEqual(JSON.parse((await act(base, 'api/digest-settings', times)).body).result, { times: ['07:30', '12:00'], weekdays_only: true, language: 'English' });
    assert.deepEqual(setup.calls.at(-1), ['saveDigestSettings', times]);
    await stream.next('workspaces');
    for (const [code, status] of [['workspace_busy', 409], ['workspace_invalid', 400], ['workspace_not_found', 404]] as const) {
      setup.answer = new FactoryError(code, `The ${code} message.`);
      assert.deepEqual(error(await act(base, 'api/workspaces/app/edit', edit)), { status, code });
    }
    setup.answer = new FactoryError('invalid_digest_settings', 'The time must be HH:MM.');
    assert.deepEqual(error(await act(base, 'api/digest-settings', settings)), { status: 400, code: 'invalid_digest_settings' });
    stream.close();
  }, setup);
});

test('client: a Queue card has Archive and Delete…; delete asks first; the archived list restores and deletes; an open job that leaves the board closes its page', async () => {
  const STATIC_DIR = new URL('../../static/', import.meta.url);
  // A failed job: its ticket is in the Queue (a pushed one is only on Done, SF-057).
  const finished = {
    workspace: 'app', ticket: 'T-1', branch: 'T-1-x', base: 'main', state: 'failed', iteration: 1, mr_attempts: 1, updated_at: '2026-11-01T10:05:00.000Z',
    created_at: '2026-11-01T10:00:00.000Z', error: null, worktree: null, prepared_commit: 'a'.repeat(40), files: 0, undeclared: 0, deleted: 0,
  };
  const page = await loadPage(STATIC_DIR, (path) => (path === 'api/jobs' ? { jobs: [finished] } : path === 'api/jobs/app/T-1' ? { job: finished, iterations: [], mr: false, history: [] } : undefined));
  page.location.hash = '#app/T-1';
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs: [finished] });
  stream.emit('workspaces', { workspaces: [workspaceRow('app')] });
  // With the run queue (SF-071): T-1 is not queued, below "Not queued".
  const queue = { max_running: 3, running: 0, held: false, hold_reason: null, next: null };
  stream.emit('tickets', {
    tickets: [{ ...ticketRow('app', 'T-1', 'One', false, 'failed'), conversation: { message: 'm', url: 'https://chatgpt.com/?q=m' }, queue_position: null, queue_error: null }],
    archived: [{ workspace: 'app', ticket: 'T-0', title: 'Zero' }], queue,
  });
  await page.flush();
  const queueCard = (): FakeElement => page.$('qlist').children.find((child) => (child as FakeElement).dataset?.ticket === 'app/T-1') as FakeElement;
  const buttons = queueCard().all().filter((element) => element.tagName === 'BUTTON');
  // SF-084: the check chip (twice: first line, or under the title when narrow), Task, and the ⋯ menu;
  // SF-071: the queue toggle after Start.
  assert.deepEqual(buttons.map((button) => button.textContent), ['last job failed', 'not checked', 'not checked', 'Start', 'Add to queue', 'Task', '⋯', 'Archive', 'Delete…']);
  // Archive: one request, the outcome in the toast.
  buttons.find((button) => button.textContent === 'Archive')!.click();
  queueCard().all().find((element) => element.textContent === 'Archive')!.click();
  await page.flush();
  const posts = (): typeof page.requests => page.requests.filter((request) => request.method === 'POST');
  assert.deepEqual([posts().length, posts()[0]!.path, posts()[0]!.body], [1, 'api/tickets/app/T-1/archive', '{}']);
  posts()[0]!.respond(200, { ok: true, result: { workspace: 'app', ticket: 'T-1', path: '.software-factory/archive/T-1.md', jobArchived: true } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'Archived app/T-1: .software-factory/archive/T-1.md. Its finished job left the board.');
  // Delete… asks first; Cancel sends nothing; Confirm deletes.
  queueCard().all().find((element) => element.textContent === 'Delete…')!.click();
  assert.equal(page.$('ticket-confirm').hidden, false);
  assert.equal(page.$('ticket-confirm-title').textContent, 'Delete app/T-1?');
  assert.match(page.$('ticket-confirm-text').textContent, /Cannot be undone; Archive keeps the file instead\./);
  assert.deepEqual([page.$('ticket-ok').textContent, page.$('ticket-ok').className], ['Delete the ticket', 'btn btn-danger']);
  page.$('ticket-cancel').click();
  assert.equal(posts().length, 1);
  queueCard().all().find((element) => element.textContent === 'Delete…')!.click();
  page.$('ticket-ok').click();
  await page.flush();
  assert.deepEqual([posts().length, posts()[1]!.path], [2, 'api/tickets/app/T-1/delete']);
  // The archived list, behind the header's Archived link: Task, Restore and Delete….
  assert.equal(page.$('archived-count').textContent, '(1)');
  const archivedButtons = (page.$('archived-list').children[0] as FakeElement).all().filter((element) => element.tagName === 'BUTTON');
  assert.deepEqual(archivedButtons.map((button) => button.textContent), ['Task', 'Restore', 'Delete…']);
  archivedButtons[1]!.click();
  await page.flush();
  assert.equal(posts()[2]!.path, 'api/tickets/app/T-0/restore');
  // The open job leaves the board: its page closes, the board shows, and the stream follows no job.
  page.$('drawer-close').click();
  page.location.hash = '#app/T-1';
  page.window.dispatch('hashchange');
  await page.flush();
  page.streams.at(-1)!.emit('job', { job: finished, iterations: [], mr: false, history: [] });
  assert.deepEqual([page.$('job').hidden, page.$('scrStream').hidden], [false, false]);
  page.streams.at(-1)!.emit('jobs', { jobs: [] });
  await page.flush();
  assert.deepEqual([page.$('job').hidden, page.$('board').hidden], [true, false]);
  assert.equal(page.$('drawer').hidden, true);
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
  // The job as the server sends it, with its actions (SF-129).
  const shape = (state: string) => served({
    workspace: 'app', ticket: 'T-1', branch: 'T-1-x', base: 'main', state, iteration: 0, mr_attempts: 0, updated_at: '2026-11-01T10:05:00.000Z',
    created_at: '2026-11-01T10:00:00.000Z', error: null, worktree: null, prepared_commit: null, files: 0, undeclared: 0, deleted: 0,
  });
  const page = await loadPage(STATIC_DIR, (path) => (path === 'api/jobs' ? { jobs: [shape('aborted')] } : path === 'api/jobs/app/T-1' ? { job: shape('aborted'), iterations: [], mr: false, history: [] } : undefined));
  page.location.hash = '#app/T-1';
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('job', { job: shape('aborted'), iterations: [], mr: false, history: [] });
  // The composer of a finished job: Restart… and Archive, no Approve or Abort. Archive asks first.
  const shown = (id: string): boolean => page.document.getElementById(id) !== null;
  assert.deepEqual([shown('archive-button'), shown('approve-button'), shown('abort-button')], [true, false, false]);
  assert.deepEqual(page.$('acts').children.map((button) => button.textContent), ['Restart…', 'Archive']);
  page.$('archive-button').click();
  await page.flush();
  assert.deepEqual([page.$('confirm').hidden, page.$('confirm-title').textContent, page.$('confirm-ok').textContent], [false, 'Archive app/T-1?', 'Archive']);
  assert.equal(page.requests.filter((request) => request.method === 'POST').length, 0);
  page.$('confirm-ok').click();
  await page.flush();
  const post = page.requests.filter((request) => request.method === 'POST');
  assert.deepEqual([post.length, post[0]!.path, post[0]!.body], [1, 'api/jobs/app/T-1/archive', '{}']);
  post[0]!.respond(200, { ok: true, result: { archived: 'jobs/app/T-1.20261103T100000Z', branch: 'T-1-x' } });
  await page.flush();
  assert.equal(page.$('action-status').textContent, 'Archived: the job left the list (its history is in jobs/app/T-1.20261103T100000Z); the branch T-1-x is untouched.');
  stream.emit('job', { job: shape('working'), iterations: [], mr: false, history: [] });
  assert.deepEqual([shown('archive-button'), shown('abort-button')], [false, true]);
});
