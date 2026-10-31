// Review publication regressions use a fake Claude and disposable repositories only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { acceptedJob, destroyFixture, git, invocations, jobDir } from './support/operator-fixture.js';
import { authorize, createExecutorFixture, enableApp, FAKE_STREAM_CLAUDE, gateway, messages, setStreamMode, startSupervisor, streamClaude, waitFor } from './support/executor-fixture.js';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Files are barriers: no timing assumption can make the final package appear early.
const PUBLICATION_CLAUDE = FAKE_STREAM_CLAUDE.replace(
  '  const denials = [];',
  String.raw`  const denials = [];
  if (text.startsWith('/implement ') && control.mode.startsWith('publication-')) {
    const task = (subtype, data) => out({ type: 'system', subtype, session_id: sid, ...data });
    const begin = () => {
      task('task_started', { task_id: 'review-a' });
      task('task_started', { task_id: 'review-b' });
      task('background_tasks_changed', { tasks: [{ task_id: 'review-a' }, { task_id: 'review-b' }] });
      fs.writeFileSync(path.join(__dirname, 'started'), 'yes');
    };
    if (control.mode !== 'publication-late') { begin(); }
    const timer = setInterval(() => {
      if (control.mode === 'publication-late' && fs.existsSync(path.join(__dirname, 'begin'))) {
        fs.unlinkSync(path.join(__dirname, 'begin'));
        begin();
      }
      if (!fs.existsSync(path.join(__dirname, 'finish'))) { return; }
      clearInterval(timer);
      fs.appendFileSync('README.md', 'collected reviews\n');
      fs.mkdirSync('review05', { recursive: true });
      fs.writeFileSync('review05/tests.log', 'focused checks passed\n');
      task('task_updated', { task_id: 'review-a', patch: { status: 'completed' } });
      task('task_notification', { task_id: 'review-b', status: 'completed' });
      task('background_tasks_changed', { tasks: [] });
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Package finalized.' }] } });
      out({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, session_id: sid, permission_denials: [] });
    }, 20);
  }`,
);

test('no snapshot before both reviewers finish; the same session publishes the full package and receives review', async () => {
  const fx = await createExecutorFixture();
  const job = 'publication-tasks';
  let running: Awaited<ReturnType<typeof startSupervisor>> | undefined;
  try {
    await writeFile(streamClaude(fx), PUBLICATION_CLAUDE, { mode: 0o755 });
    await setStreamMode(fx, 'publication-tasks');
    await enableApp(fx);
    const accepted = await acceptedJob(fx, job);
    const head = git(fx.appRepo, 'rev-parse', 'HEAD');
    const index = await readFile(join(fx.appRepo, '.git', 'index'));
    running = await startSupervisor(fx);
    await authorize(fx, job, accepted, randomUUID());
    await waitFor(async () => (await readdir(fx.fakeDir)).includes('started'), 'reviewers started');
    await pause(350);
    const gw = gateway(fx);
    assert.equal((await gw.status(fx.app, job)).status, 'running');
    assert.deepEqual((await gw.listReviewReady(fx.app)).ready, []);
    assert.ok(!(await readdir(jobDir(fx, job))).includes('iteration-001.snapshot.json'));
    await writeFile(join(fx.fakeDir, 'finish'), 'yes');
    await waitFor(async () => (await gw.status(fx.app, job)).status === 'awaiting_review', 'complete package');
    const snapshot = await gw.snapshot(fx.app, job, 'iteration-001');
    const diff = await readFile(join(fx.mediator, snapshot.diff.path), 'utf8');
    assert.match(diff, /collected reviews/);
    assert.match(diff, /review05\/tests.log/);
    assert.equal(snapshot.snapshot.background_processes, 0);
    const before = await readFile(join(jobDir(fx, job), 'iteration-001.snapshot.json'));
    await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snapshot.snapshot_sha256, review_id: randomUUID(), findings: [{ text: 'FAKE-EDIT notes.txt corrected' }] });
    await waitFor(async () => {
      const status = await gw.status(fx.app, job);
      return status.status === 'awaiting_review' && status.job?.current_iteration === 'iteration-002';
    }, 'correction in same session');
    assert.equal((await invocations(fx)).length, 1);
    const sent = await messages(fx);
    assert.equal(sent.length, 2);
    assert.equal(sent[0]!.pid, sent[1]!.pid);
    assert.deepEqual(await readFile(join(jobDir(fx, job), 'iteration-001.snapshot.json')), before);
    assert.equal(git(fx.appRepo, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(await readFile(join(fx.appRepo, '.git', 'index')), index);
  } finally {
    await running?.stop();
    await destroyFixture(fx);
  }
});

test('late work invalidates the review boundary and publishes a new immutable iteration without another launch', async () => {
  const fx = await createExecutorFixture();
  const job = 'publication-late';
  let running: Awaited<ReturnType<typeof startSupervisor>> | undefined;
  try {
    await writeFile(streamClaude(fx), PUBLICATION_CLAUDE, { mode: 0o755 });
    await setStreamMode(fx, 'publication-late');
    await enableApp(fx);
    const accepted = await acceptedJob(fx, job);
    running = await startSupervisor(fx);
    await authorize(fx, job, accepted, randomUUID());
    const gw = gateway(fx);
    await waitFor(async () => (await gw.status(fx.app, job)).status === 'awaiting_review', 'first snapshot');
    const first = await gw.snapshot(fx.app, job, 'iteration-001');
    const original = await readFile(join(jobDir(fx, job), 'iteration-001.snapshot.json'));
    await writeFile(join(fx.fakeDir, 'begin'), 'yes');
    await waitFor(async () => (await readdir(fx.fakeDir)).includes('started'), 'late reviewers');
    await waitFor(async () => (await gw.status(fx.app, job)).status === 'running', 'review boundary withdrawn');
    assert.deepEqual((await gw.listReviewReady(fx.app)).ready, []);
    await writeFile(join(fx.fakeDir, 'finish'), 'yes');
    await waitFor(async () => {
      const status = await gw.status(fx.app, job);
      return status.status === 'awaiting_review' && status.job?.current_iteration === 'iteration-002';
    }, 'late result published');
    const second = await gw.snapshot(fx.app, job, 'iteration-002');
    assert.notEqual(second.snapshot_sha256, first.snapshot_sha256);
    assert.match(await readFile(join(fx.mediator, second.diff.path), 'utf8'), /review05\/tests.log/);
    assert.deepEqual(await readFile(join(jobDir(fx, job), 'iteration-001.snapshot.json')), original);
    assert.equal((await invocations(fx)).length, 1);
    assert.equal((await messages(fx)).length, 1, 'no duplicate prompt or launch');
    await assert.rejects(gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: first.snapshot_sha256, review_id: randomUUID(), findings: [{ text: 'stale feedback' }] }));
  } finally {
    await running?.stop();
    await destroyFixture(fx);
  }
});
