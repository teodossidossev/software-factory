// SF-009 vertical slice with a fake stream-json Claude: one authorization, one auto-mode launch,
// review iterations in the same session, compact and reset, and the final acceptance.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DENIED_TOOLS } from '../src/execution/runner.js';
import { acceptedJob, destroyFixture, git, invocations, jobDir, sha256, type Fixture } from './support/operator-fixture.js';
import { authorize, createExecutorFixture, enableApp, gateway, messages, startSupervisor, waitFor } from './support/executor-fixture.js';

let fx: Fixture;

before(async () => {
  fx = await createExecutorFixture();
  await enableApp(fx);
});

after(async () => {
  await destroyFixture(fx);
});

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

test('one authorization: one auto-mode session through review, compact, reset and acceptance', async () => {
  const job = 'job-slice';
  const accepted = await acceptedJob(fx, job);
  const gw = gateway(fx);
  const head = git(fx.appRepo, 'rev-parse', 'HEAD').trim();
  const index = await readFile(join(fx.appRepo, '.git', 'index'));
  const running = await startSupervisor(fx);
  try {
    const before = await gw.status(fx.app, job);
    assert.equal(before.status, 'not_authorized');
    assert.equal(before.policy?.enabled, true);
    assert.equal(before.policy?.permission_mode, 'auto');

    // The only approval: one ChatGPT-equivalent call. No console, no preflight/prepare/run/collect commands.
    await authorize(fx, job, accepted, randomUUID());
    const ready1 = await waitFor(async () => {
      const status = await gw.status(fx.app, job);
      return status.status === 'awaiting_review' ? status : undefined;
    }, 'iteration-001 ready');
    assert.equal(ready1.job?.current_iteration, 'iteration-001');
    // Claude being idle is not completion: SF-006 still records the session as running.
    assert.equal((await readJson(join(jobDir(fx, job), 'execution.json'))).state, 'running');
    assert.equal(ready1.job?.session_process, 'alive');

    const calls = await invocations(fx);
    assert.equal(calls.length, 1, 'exactly one Claude process');
    const argv = calls[0]!.argv;
    assert.deepEqual(argv.slice(argv.indexOf('--permission-mode'), argv.indexOf('--permission-mode') + 2), ['--permission-mode', 'auto']);
    assert.ok(argv.includes('-p') && argv.includes('stream-json'));
    for (const forbidden of ['bypassPermissions', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', 'manual']) {
      assert.ok(!argv.includes(forbidden), `argv must not contain ${forbidden}`);
    }
    for (const denied of DENIED_TOOLS) assert.ok(argv.includes(denied), `${denied} is denied`);
    assert.deepEqual(calls[0]!.tty, { stdin: false, stdout: false, stderr: false });
    assert.deepEqual(calls[0]!.env, []);

    const list = await gw.listReviewReady(fx.app);
    assert.deepEqual(list.ready.map((entry) => [entry.job_id, entry.iteration_id]), [[job, 'iteration-001']]);
    assert.equal(list.complete, true);
    const snap1 = await gw.snapshot(fx.app, job, 'iteration-001');
    assert.equal(snap1.snapshot_sha256, sha256(await readFile(join(jobDir(fx, job), 'iteration-001.snapshot.json'))));
    const diff1 = await readFile(join(fx.mediator, snap1.diff.path), 'utf8');
    assert.equal(sha256(diff1), snap1.diff.sha256);
    assert.match(diff1, /\+iteration 1/);
    assert.equal(snap1.snapshot.baseline.head, head);
    assert.deepEqual(snap1.snapshot.export.changed_paths, ['README.md']);
    assert.deepEqual(snap1.snapshot.checks, [{ command: 'npm test', ok: true }]);

    // Stale or mismatched reviews are refused before anything reaches Claude.
    const review = { app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap1.snapshot_sha256 };
    assert.equal(await code(gw.submitReview({ ...review, snapshot_sha256: '0'.repeat(64), review_id: randomUUID(), findings: [{ text: 'x' }] })), 'sha256_mismatch');
    assert.equal(await code(gw.submitReview({ ...review, iteration_id: 'iteration-002', review_id: randomUUID(), findings: [{ text: 'x' }] })), 'conflict');
    assert.equal(await code(gw.submitReview({ ...review, app_id: 'app-two', review_id: randomUUID(), findings: [{ text: 'x' }] })), 'app_not_found');

    const r1 = randomUUID();
    const first = await gw.submitReview({ ...review, review_id: r1, summary: 'Add notes.', findings: [{ text: 'Please add a notes file. FAKE-EDIT notes.txt second' }] });
    assert.equal(first.replayed, false);
    const replay = await gw.submitReview({ ...review, review_id: r1, summary: 'Add notes.', findings: [{ text: 'Please add a notes file. FAKE-EDIT notes.txt second' }] });
    assert.equal(replay.replayed, true);
    assert.equal(await code(gw.submitReview({ ...review, review_id: r1, findings: [{ text: 'different' }] })), 'conflict');

    const ready2 = await waitFor(async () => {
      const status = await gw.status(fx.app, job);
      return status.status === 'awaiting_review' && status.job?.current_iteration === 'iteration-002' ? status : undefined;
    }, 'iteration-002 ready');
    assert.deepEqual(ready2.job?.iterations.map((entry) => entry.state), ['changes_requested', 'ready_for_review']);
    const snap2 = await gw.snapshot(fx.app, job, 'iteration-002');
    assert.match(await readFile(join(fx.mediator, snap2.diff.path), 'utf8'), /\+second/);
    assert.notEqual(snap2.snapshot_sha256, snap1.snapshot_sha256);
    // The feedback went to the same process, as a message.
    const sent = await messages(fx);
    assert.equal(sent.length, 2);
    assert.equal(sent[1]!.pid, sent[0]!.pid);
    assert.match(sent[1]!.text, /^Software Factory review .* of iteration-001/);
    assert.match(sent[1]!.text, /Do not stage, commit, push/);
    // A review of the old iteration is stale now; iteration 1's snapshot stays readable and unchanged.
    assert.equal(await code(gw.submitReview({ ...review, review_id: randomUUID(), findings: [{ text: 'late' }] })), 'conflict');
    assert.equal((await gw.snapshot(fx.app, job, 'iteration-001')).snapshot_sha256, snap1.snapshot_sha256);

    // compact at the review boundary.
    const sessionBefore = ready2.job!.current_session_id!;
    assert.equal(await code(gw.manageContext({ app_id: fx.app, job_id: job, iteration_id: 'iteration-002', session_id: randomUUID(), action: 'compact', request_id: randomUUID() })), 'conflict');
    const compactId = randomUUID();
    await gw.manageContext({ app_id: fx.app, job_id: job, iteration_id: 'iteration-002', session_id: sessionBefore, action: 'compact', request_id: compactId, focus: 'Keep the notes requirement.' });
    const compacted = await waitFor(async () => {
      const status = await gw.status(fx.app, job);
      const action = status.job?.context_actions.find((entry) => entry.request_id === compactId);
      return action?.outcome === 'performed' && status.status === 'awaiting_review' ? status : undefined;
    }, 'compact performed');
    assert.equal(compacted.job?.current_session_id, sessionBefore);
    const note1 = await readFile(join(jobDir(fx, job), 'continuation-001.md'), 'utf8');
    assert.equal(await readFile(join(fx.appRepo, '.software-factory', 'jobs', job, 'continuation-001.md'), 'utf8'), note1);
    assert.match(note1, /Do not stage, unstage, commit, push/);
    assert.match(note1, /FAKE-EDIT notes.txt second/);
    assert.match(note1, new RegExp(`snapshot sha256 ${snap2.snapshot_sha256}`));
    assert.match(note1, /Keep the notes requirement/);
    assert.ok((await messages(fx)).at(-1)!.text.startsWith('/compact '));

    // A bounded correction after the compaction: same session, next iteration.
    await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-002', snapshot_sha256: snap2.snapshot_sha256, review_id: randomUUID(), findings: [{ text: 'One more line. FAKE-EDIT notes.txt third' }] });
    await waitFor(async () => (await gw.status(fx.app, job)).job?.current_iteration === 'iteration-003' && (await gw.status(fx.app, job)).status === 'awaiting_review', 'iteration-003 ready');
    const snap3 = await gw.snapshot(fx.app, job, 'iteration-003');

    // reset: a fresh process under the same claim.
    const claimBefore = await readFile(join(jobDir(fx, job), 'launch.claim'), 'utf8');
    const resetId = randomUUID();
    await gw.manageContext({ app_id: fx.app, job_id: job, iteration_id: 'iteration-003', session_id: sessionBefore, action: 'reset', request_id: resetId });
    const reset = await waitFor(async () => {
      const status = await gw.status(fx.app, job);
      return status.job?.context_actions.find((entry) => entry.request_id === resetId)?.outcome === 'performed' && status.status === 'awaiting_review' ? status : undefined;
    }, 'reset performed');
    assert.notEqual(reset.job?.current_session_id, sessionBefore);
    assert.equal(reset.job?.sessions, 2);
    assert.equal(await readFile(join(jobDir(fx, job), 'launch.claim'), 'utf8'), claimBefore, 'one claim, unchanged');
    const afterReset = await invocations(fx);
    assert.equal(afterReset.length, 2, 'the reset is the only second process');
    assert.deepEqual(afterReset[1]!.argv.filter((arg) => !/^[0-9a-f-]{36}$/.test(arg)), afterReset[0]!.argv.filter((arg) => !/^[0-9a-f-]{36}$/.test(arg)), 'same fixed flags');
    const resetPrompt = (await messages(fx)).at(-1)!;
    assert.equal(resetPrompt.pid, afterReset[1]!.pid);
    assert.match(resetPrompt.text, /continuation-002\.md/);
    assert.ok(!resetPrompt.text.includes('/implement'), 'the initial job is not re-run');
    const execution = await readJson(join(jobDir(fx, job), 'execution.json'));
    assert.deepEqual(execution.session_lineage, [sessionBefore, reset.job?.current_session_id]);

    // A correction after the reset reaches the new process and keeps the scope.
    await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-003', snapshot_sha256: snap3.snapshot_sha256, review_id: randomUUID(), findings: [{ text: 'Final line. FAKE-EDIT notes.txt fourth' }] });
    await waitFor(async () => (await gw.status(fx.app, job)).job?.current_iteration === 'iteration-004' && (await gw.status(fx.app, job)).status === 'awaiting_review', 'iteration-004 ready');
    const last = (await messages(fx)).at(-1)!;
    assert.equal(last.pid, afterReset[1]!.pid);
    assert.match(last.text, /Do not stage, commit, push/);
    const snap4 = await gw.snapshot(fx.app, job, 'iteration-004');
    assert.match(await readFile(join(fx.mediator, snap4.diff.path), 'utf8'), /\+fourth/);

    // Final acceptance: its own transition, bound to the snapshot.
    assert.equal(await code(gw.accept({ app_id: fx.app, job_id: job, iteration_id: 'iteration-003', snapshot_sha256: snap3.snapshot_sha256, acceptance_id: randomUUID() })), 'conflict');
    await gw.accept({ app_id: fx.app, job_id: job, iteration_id: 'iteration-004', snapshot_sha256: snap4.snapshot_sha256, acceptance_id: randomUUID() });
    const closed = await waitFor(async () => {
      const status = await gw.status(fx.app, job);
      return status.status === 'closed' ? status : undefined;
    }, 'closed');
    assert.equal(closed.job?.execution_state, 'completed');
    assert.equal(closed.job?.session_process, 'ended');
    const final = await readJson(join(jobDir(fx, job), 'execution.json'));
    assert.equal(final.state, 'completed');
    assert.equal(final.completion, 'operator_confirmed');
    assert.deepEqual((final.history as Array<{ state: string }>).map((entry) => entry.state), ['prepared', 'running', 'completed']);
    // Still exactly two processes; Git is untouched (nothing staged or committed).
    assert.equal((await invocations(fx)).length, 2);
    assert.equal(git(fx.appRepo, 'rev-parse', 'HEAD').trim(), head);
    assert.deepEqual(await readFile(join(fx.appRepo, '.git', 'index')), index);
    assert.equal(git(fx.appRepo, 'diff', '--cached', '--name-only'), '');
    // The audit log records the MCP-sourced approval and its consumption.
    const events = (await readFile(join(fx.stateHome, 'software-factory', 'operator', 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(events.some((event) => event.event === 'approved' && event.source === 'mcp_authorization'));
    assert.ok(events.some((event) => event.event === 'acceptance' && event.outcome === 'accepted'));
    assert.ok(!JSON.stringify(events).includes(fx.appRepo), 'no host paths in the audit log');
    // Nothing readable through the bridge holds the app repository's host path.
    for (const name of await readdir(jobDir(fx, job))) {
      if (name.startsWith('.')) continue;
      assert.ok(!(await readFile(join(jobDir(fx, job), name), 'utf8')).includes(fx.appRepo), `${name} holds no host path`);
    }
  } finally {
    await running.stop();
  }
});
