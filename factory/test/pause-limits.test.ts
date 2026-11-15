// SF-067 end to end, split from test/pause.test.ts (SF-152: one file ran near run-tests' per-file
// limit): the usage limit (SF-072) in a turn, the Claude review, the gate and the simplification
// pass, a parked job across an sf serve restart, and the images a Resume finds (SF-065). The shared
// helpers are test/support/pause.ts's.
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { addAttachment, removeAttachment } from '../src/attachments.js';
import { JobStore } from '../src/jobs.js';
import { firstPrompt, imagesChangedNote } from '../src/execution.js';
import { call, codexLog, codexScript, type Env, fakeCodex, fakeLog, git, newEnv, newRepo, putTask, reviewLog, reviewScript, runCli, script, serve, stop, task, turnsStarted, waitFor, jobPrompt } from './support/harness.js';
import { CLEAN, count, eventsOf, FIX, GATE_CLEAN, jobDir, LONG, mrText, nothingRuns, until, worktreeOf } from './support/pause.js';

// SF-072: the usage limit. The known messages as the sessions end with them.
const CLAUDE_LIMIT = "You've hit your 5-hour limit · resets 3am (Europe/Sofia)";
const LIMIT_ERROR = { subtype: 'error_during_execution', errors: [CLAUDE_LIMIT] };

async function waitParked(env: Env, ticket: string, other?: string): Promise<import('../src/jobs.js').Job> {
  const jobs = new JobStore(env.state);
  await until(`${ticket} to park`, async () => {
    const job = await jobs.read('app', ticket);
    return job?.state === 'waiting_limit' && job.paused?.at !== other;
  });
  return (await jobs.read('app', ticket))!;
}

test('Usage limit in a turn (SF-072): the job parks with the turn interrupted; sf say and sf pause are refused; sf resume with a message goes on; a second hit parks it again with the 30-minute retry', async () => {
  const env = await newEnv('limit-turn');
  const repo = await newRepo(env, 'limit-turn-repo', false);
  await putTask(env, repo, 'L-1', 'Limit');
  await script(env, [
    { write: { 'a.txt': 'a\n' }, ...LIMIT_ERROR },
    { subtype: 'error_during_execution', errors: ["You've hit your limit"] },
    { write: { 'b.txt': 'b\n' }, text: 'Went on.' },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-1' });
    const job = await waitParked(env, 'L-1');
    assert.deepEqual([job.iteration, job.paused?.from, job.paused?.step, job.limit?.provider, job.error], [0, 'working', 'turn', 'claude', undefined]);
    // 3am in Sofia, the next one after the park.
    const resets = Date.parse(job.limit!.resets_at);
    assert.equal(new Date(resets).toLocaleTimeString('en-GB', { timeZone: 'Europe/Sofia' }), '03:00:00');
    assert.ok(resets > Date.parse(job.paused!.at) && resets <= Date.parse(job.paused!.at) + 24 * 3600_000, job.limit!.resets_at);
    let events = await eventsOf(env, 'L-1');
    assert.deepEqual(events.filter((record) => record.type === 'interrupted').map((record) => [record.iteration, record.step]), [[1, 'turn']]);
    assert.deepEqual(events.filter((record) => record.state !== undefined).map((record) => record.state.to), ['starting', 'working', 'waiting_limit']);

    const said = await runCli(env, ['say', 'app', 'L-1', 'x']);
    assert.equal(said.code, 1);
    assert.match(said.stderr, /Resume the job with a message: sf resume app L-1 \[message\]/);
    assert.equal((await runCli(env, ['pause', 'app', 'L-1'])).code, 1);
    assert.match((await runCli(env, ['status', 'app', 'L-1'])).stdout, /waiting for the usage limit \(Claude\): resets at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d/);
    assert.match((await runCli(env, ['queue', 'list'])).stdout, /^running: 1\nheld: no\nusage limit: 1 parked job holds the queue, resets at /m);

    const resumed = await runCli(env, ['resume', 'app', 'L-1', 'Go', 'on']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /^state: working\niteration: 0\nstep: turn$/m);
    // The second hit has no reset time: the queue tries again 30 minutes after the park.
    const again = await waitParked(env, 'L-1', job.paused!.at);
    assert.equal(Date.parse(again.limit!.resets_at) - Date.parse(again.paused!.at), 30 * 60_000);
    assert.equal((await runCli(env, ['resume', 'app', 'L-1'])).code, 0);
    await waitFor(served, 'L-1', 'awaiting_review', 1);
    const log = await fakeLog(env);
    assert.equal(log.length, 3);
    assert.equal(log[1]!.sessionId, log[0]!.sessionId);
    assert.match(log[1]!.prompt, /^Go on\n/);
    assert.match(log[2]!.prompt, /^Continue where you stopped\.\n/);
    events = await eventsOf(env, 'L-1');
    assert.deepEqual(events.filter((record) => record.state !== undefined).map((record) => record.state.to), ['starting', 'working', 'waiting_limit', 'working', 'waiting_limit', 'working', 'awaiting_review']);
    const watched = (await runCli(env, ['watch', 'app', 'L-1', '--once'])).stdout;
    assert.match(watched, /\[0\] Parked: usage limit reached/);
    assert.match(watched, /\[0\] Resumed after the usage limit reset/);
    assert.equal((await new JobStore(env.state).read('app', 'L-1'))!.limit, undefined);
  } finally {
    await stop(served);
  }
});

test('Usage limit in the Claude review (SF-072): parked with no review.json and no review_failed; resumed, the review runs again; one that ends after the job moved on is recorded as ignored', async () => {
  const env = await newEnv('limit-review', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'limit-review-repo', false);
  await putTask(env, repo, 'L-1', 'Review');
  await putTask(env, repo, 'L-2', 'Moved on');
  await script(env, [
    { write: { 'a.txt': 'a\n' } },
    { write: { '.software-factory/L-1.mr.md': mrText('feat(L-1): Review') }, text: 'prepared' },
    { write: { 'c.txt': 'c\n' } },
    // Runs once the review has ended (released by the test, SF-105): the review ends while the job
    // works, not cancelled by the next one.
    { waitFile: 'release-turn', write: { 'd.txt': 'd\n' }, text: 'Answered.' },
    { write: { '.software-factory/L-2.mr.md': mrText('feat(L-2): Moved on') }, text: 'prepared' },
  ]);
  await reviewScript(env, [LIMIT_ERROR, { output: CLEAN }, { waitFile: 'release-review', ...LIMIT_ERROR }, { output: CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-1' });
    const job = await waitParked(env, 'L-1');
    assert.deepEqual([job.iteration, job.paused?.from, job.paused?.step, job.limit?.provider], [1, 'awaiting_review', 'review', 'claude']);
    const jobs = new JobStore(env.state);
    assert.equal(await jobs.readReview('app', 'L-1', 1), undefined);
    const events = await eventsOf(env, 'L-1');
    assert.deepEqual(events.filter((record) => record.type === 'interrupted').map((record) => [record.iteration, record.step, record.reviewer]), [[1, 'review', 'claude']]);
    assert.equal(events.filter((record) => record.type === 'review_failed').length, 0);
    // Resume takes no message after a review round.
    assert.equal((await runCli(env, ['resume', 'app', 'L-1', 'hello'])).code, 1);
    const resumed = await runCli(env, ['resume', 'app', 'L-1']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /^state: awaiting_review\niteration: 1\nstep: review$/m);
    await waitFor(served, 'L-1', 'ready_for_human_review', 1);
    const review = await jobs.readReview('app', 'L-1', 1);
    assert.ok(review !== undefined && 'verdict' in review && review.verdict === 'clean');

    // L-2: its review hits the limit after a message moved the job on: recorded, ignored, not parked.
    await call(served, 'start', { workspace: 'app', ticket: 'L-2' });
    await waitFor(served, 'L-2', 'awaiting_review', 1);
    await until('the review of L-2 to start', async () => (await count(env, 'fake-review')) >= 3);
    assert.equal((await runCli(env, ['say', 'app', 'L-2', 'One', 'more'])).code, 0);
    // The job has moved on (its next turn runs): only now does the review end at the limit.
    await until('L-2 to work again', async () => (await jobs.read('app', 'L-2'))?.state === 'working');
    await writeFile(join(env.home, 'release-review'), '');
    await until('the ignored review', async () => (await eventsOf(env, 'L-2')).some((record) => record.type === 'review_failed'));
    const ignored = (await eventsOf(env, 'L-2')).find((record) => record.type === 'review_failed')!;
    assert.deepEqual([ignored.iteration, ignored.ignored], [1, true]);
    const record = await jobs.readReview('app', 'L-2', 1);
    assert.ok(record !== undefined && 'error' in record && /hit your 5-hour limit/.test(record.error), JSON.stringify(record));
    assert.notEqual((await jobs.read('app', 'L-2'))!.state, 'waiting_limit');
    await writeFile(join(env.home, 'release-turn'), '');
    await waitFor(served, 'L-2', 'ready_for_human_review', 2);
  } finally {
    await runCli(env, ['abort', 'app', 'L-2']);
    await stop(served);
  }
});

test('Usage limit in the gate (SF-072): Codex\'s limit parks the job (provider codex, no gate.json); the run queue resumes it by itself at the reset and the gate runs again', async () => {
  const env = await newEnv('limit-gate', { SF_REVIEW: 'on', SF_GATE: 'codex', SF_GATE_LEVEL: 'full', SF_CODEX: fakeCodex });
  const repo = await newRepo(env, 'limit-gate-repo', false);
  await putTask(env, repo, 'L-1', 'Gate');
  await script(env, [{ write: { 'a.txt': 'a\n' } }, { write: { '.software-factory/L-1.mr.md': mrText('feat(L-1): Gate') }, text: 'prepared' }]);
  await reviewScript(env, [{ output: CLEAN }]);
  await codexScript(env, [{ error: "You've hit your usage limit. Try again in 3s." }, { output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-1' });
    const job = await waitParked(env, 'L-1');
    assert.deepEqual([job.paused?.from, job.paused?.step, job.limit?.provider], ['awaiting_review', 'gate', 'codex']);
    // The limit-hit run reported 1100 tokens (the fake's default usage): none is charged to the job.
    assert.equal(job.gate_tokens, 0);
    const delay = Date.parse(job.limit!.resets_at) - Date.parse(job.paused!.at);
    assert.ok(delay > 2000 && delay < 4000, String(delay));
    const jobs = new JobStore(env.state);
    assert.equal(await jobs.readGate('app', 'L-1', 1), undefined);
    // The joint round's other verdict stays: Claude's review is kept, and does not run again.
    const kept = await jobs.readReview('app', 'L-1', 1);
    assert.ok(kept !== undefined && 'verdict' in kept && kept.verdict === 'clean');
    const events = await eventsOf(env, 'L-1');
    assert.deepEqual(events.filter((record) => record.type === 'interrupted').map((record) => [record.step, record.reviewer]), [['gate', 'codex']]);
    assert.equal(events.filter((record) => record.reviewer === 'codex' && record.type === 'review_failed').length, 0);
    // Nothing by hand: the queue's timer resumes it.
    await waitFor(served, 'L-1', 'ready_for_human_review', 1);
    assert.equal((await codexLog(env)).length, 2);
    assert.equal((await reviewLog(env)).length, 1);
    const gate = await jobs.readGate('app', 'L-1', 1);
    assert.ok(gate !== undefined && 'verdict' in gate && gate.verdict === 'clean');
    // Only the run that gave the verdict counts.
    assert.equal((await jobs.read('app', 'L-1'))!.gate_tokens, 1100);
  } finally {
    await stop(served);
  }
});

test('Usage limit in the joint round\'s Claude review: parked at review once the gate ended, its gate.json kept; Resume runs the Claude review alone, then the round applies', async () => {
  const env = await newEnv('limit-joint-review', { SF_REVIEW: 'on', SF_GATE: 'codex', SF_GATE_LEVEL: 'full', SF_CODEX: fakeCodex });
  const repo = await newRepo(env, 'limit-joint-review-repo', false);
  await putTask(env, repo, 'L-3', 'Joint');
  await script(env, [{ write: { 'a.txt': 'a\n' } }, { write: { '.software-factory/L-3.mr.md': mrText('feat(L-3): Joint') }, text: 'prepared' }]);
  // The review ends at the limit only once the gate has its verdict.
  await reviewScript(env, [{ waitFile: 'release-review', ...LIMIT_ERROR }, { output: CLEAN }]);
  await codexScript(env, [{ output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-3' });
    const jobs = new JobStore(env.state);
    await until('the gate verdict', async () => (await jobs.readGate('app', 'L-3', 1)) !== undefined);
    // The gate ended first: the round waits for the review.
    assert.equal((await jobs.read('app', 'L-3'))!.state, 'awaiting_review');
    await writeFile(join(env.home, 'release-review'), '');
    const job = await waitParked(env, 'L-3');
    assert.deepEqual([job.paused?.step, job.limit?.provider], ['review', 'claude']);
    assert.equal(await jobs.readReview('app', 'L-3', 1), undefined);
    const gate = await jobs.readGate('app', 'L-3', 1);
    assert.ok(gate !== undefined && 'verdict' in gate && gate.verdict === 'clean');
    const resumed = await runCli(env, ['resume', 'app', 'L-3']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /^step: review$/m);
    await waitFor(served, 'L-3', 'ready_for_human_review', 1);
    assert.deepEqual([(await codexLog(env)).length, await count(env, 'fake-review')], [1, 2]);
  } finally {
    await stop(served);
  }
});

// The images of the SF-065 tests.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const PNG2 = Buffer.concat([PNG, Buffer.from('-second')]);
const PNG3 = Buffer.concat([PNG, Buffer.from('-third')]);
const GIF = Buffer.from('GIF89a-gif-body');
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

test('images (SF-065): a Resume finds an image changed while paused (the text unchanged), refuses an unusable one, copies the new one and names it; Restart and a Resume before the first turn give the blocks again', async () => {
  const env = await newEnv('pause-images');
  const repo = await newRepo(env, 'pause-images-repo', false);
  const workspace = { name: 'app', readCheckout: repo, workCheckout: repo };
  const jobs = new JobStore(env.state);
  await putTask(env, repo, 'P-1', 'Images');
  await addAttachment(workspace, 'P-1', PNG, jobs);
  const text = `${task('P-1', 'Images')}\nSee ![the error](P-1/1.png).\n`;
  await writeFile(join(repo, '.software-factory', 'P-1.md'), text);
  await script(env, [
    { write: { 'a.txt': 'a\n' } },
    { delayMs: LONG, write: { 'never.txt': 'x\n' } },
    { write: { 'b.txt': 'b\n' }, text: 'Went on.' },
    // The restarted job's first turn; restarted again, a first turn that never reports a session,
    // then the Resume's.
    { write: { 'c.txt': 'c\n' } },
    { delayMs: LONG },
    { write: { 'd.txt': 'd\n' } },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'P-1' });
    await waitFor(served, 'P-1', 'awaiting_review', 1);
    assert.equal((await runCli(env, ['say', 'app', 'P-1', 'Go', 'on'])).code, 0);
    await turnsStarted(env, 2);
    assert.equal((await runCli(env, ['pause', 'app', 'P-1'])).code, 0);
    await nothingRuns(env, served);

    // An image that cannot be used refuses the Resume; the job stays paused, its copies as they were.
    await writeFile(join(repo, '.software-factory', 'P-1', '1.png'), GIF);
    const refusal = await runCli(env, ['resume', 'app', 'P-1']);
    assert.equal(refusal.code, 1);
    assert.match(refusal.stderr, /P-1\/1\.png: not the image its name says/);
    assert.equal((await jobs.read('app', 'P-1'))!.state, 'paused');
    assert.deepEqual(await readFile(join(jobDir(env, 'P-1'), 'attachments', '1.png')), PNG);

    // The image changes while paused, the Task text does not: Resume copies it and names it.
    await removeAttachment(workspace, 'P-1', '1.png', jobs);
    await addAttachment(workspace, 'P-1', PNG2, jobs, '1.png');
    const resumed = await runCli(env, ['resume', 'app', 'P-1']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /^task_changed: false$/m);
    await waitFor(served, 'P-1', 'awaiting_review', 2);
    const record = { name: '1.png', type: 'image/png', bytes: PNG2.length, sha256: sha(PNG2) };
    assert.deepEqual((await jobs.read('app', 'P-1'))!.attachments, [record]);
    assert.deepEqual(await readFile(join(jobDir(env, 'P-1'), 'attachments', '1.png')), PNG2);
    assert.deepEqual(await readFile(join(worktreeOf(env, 'P-1'), '.software-factory', 'P-1', '1.png')), PNG2);
    const imagesLine = { dir: join(worktreeOf(env, 'P-1'), '.software-factory', 'P-1'), names: ['1.png'] };
    let log = await fakeLog(env);
    // The same session goes on: the line and the folder, no blocks.
    assert.equal(log.at(-1)!.prompt, await jobPrompt(env, `Continue where you stopped.\n\n${imagesChangedNote(['1.png'])}`, 'P-1', 2, imagesLine));
    assert.equal(log.at(-1)!.blocks, undefined);
    const attachments = (await eventsOf(env, 'P-1')).filter((event) => event.type === 'attachments').map((event) => event.images);
    assert.deepEqual(attachments, [[{ ...record, bytes: PNG.length, sha256: sha(PNG) }], [record]]);

    // Restart is refused while an image cannot be used, and nothing changes.
    assert.equal((await runCli(env, ['abort', 'app', 'P-1'])).code, 0);
    await rm(join(repo, '.software-factory', 'P-1', '1.png'));
    const early = await runCli(env, ['restart', 'app', 'P-1']);
    assert.equal(early.code, 1);
    assert.match(early.stderr, /P-1\/1\.png: missing/);
    assert.equal((await jobs.read('app', 'P-1'))!.state, 'aborted');
    await addAttachment(workspace, 'P-1', PNG3, jobs, '1.png');
    assert.equal((await runCli(env, ['restart', 'app', 'P-1'])).code, 0);
    await waitFor(served, 'P-1', 'awaiting_review', 1);
    const block = { type: 'image', media_type: 'image/png', bytes: PNG3.length, sha256: sha(PNG3) };
    const blocks = [
      { type: 'text', text: await jobPrompt(env, firstPrompt('P-1', []), 'P-1', 1, imagesLine) },
      { type: 'text', text: 'Image P-1/1.png ("the error"), referenced in the Task file:' },
      block,
    ];
    assert.deepEqual((await fakeLog(env)).at(-1)!.blocks, blocks);
    assert.deepEqual((await jobs.read('app', 'P-1'))!.attachments, [{ ...record, bytes: PNG3.length, sha256: sha(PNG3) }]);

    // Paused before its first turn reported a session: the Resume sends /implement with the blocks again.
    assert.equal((await runCli(env, ['abort', 'app', 'P-1'])).code, 0);
    assert.equal((await runCli(env, ['restart', 'app', 'P-1'])).code, 0);
    await turnsStarted(env, 5);
    assert.equal((await runCli(env, ['pause', 'app', 'P-1'])).code, 0);
    assert.equal((await runCli(env, ['resume', 'app', 'P-1'])).code, 0);
    await waitFor(served, 'P-1', 'awaiting_review', 1);
    log = await fakeLog(env);
    assert.deepEqual(log.at(-1)!.blocks, blocks);
  } finally {
    await stop(served);
  }
});

test('Usage limit in the simplification pass (SF-072): parked with no simplify.json and no simplify event; resumed, the pass runs again, then MR preparation; an MR turn that hits the limit stops in needs_human', async () => {
  const env = await newEnv('limit-simplify', { SF_REVIEW: 'on', SF_SIMPLIFY: 'on' });
  const repo = await newRepo(env, 'limit-simplify-repo', false);
  await putTask(env, repo, 'L-1', 'Simplify');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: '| R1 | fixed | Checked now. |' },
    { write: { '.software-factory/L-1.mr.md': mrText('feat(L-1): Simplify') }, ...LIMIT_ERROR },
  ]);
  await reviewScript(env, [{ output: FIX }, { output: CLEAN }, LIMIT_ERROR, { output: { summary: 'Nothing to remove.', suggestions: [] } }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-1' });
    const job = await waitParked(env, 'L-1');
    assert.deepEqual([job.iteration, job.paused?.from, job.paused?.step, job.simplify_iteration], [2, 'awaiting_review', 'simplify', undefined]);
    const jobs = new JobStore(env.state);
    assert.equal(await jobs.readSimplify('app', 'L-1', 2), undefined);
    let events = await eventsOf(env, 'L-1');
    assert.equal(events.filter((record) => record.type === 'simplify').length, 0);
    assert.deepEqual(events.filter((record) => record.type === 'interrupted').map((record) => [record.iteration, record.step, record.reviewer]), [[2, 'simplify', 'simplify']]);
    assert.equal((await runCli(env, ['resume', 'app', 'L-1'])).code, 0);
    // The pass runs again; then the MR turn hits the limit: no park, the old stop.
    const stopped = await waitFor(served, 'L-1', 'needs_human');
    assert.equal(stopped.error.code, 'turn_failed');
    assert.match(stopped.error.message, /hit your 5-hour limit/);
    const record = await jobs.readSimplify('app', 'L-1', 2);
    assert.ok(record !== undefined && 'suggestions' in record, JSON.stringify(record));
    events = await eventsOf(env, 'L-1');
    assert.equal(events.filter((record) => record.type === 'simplify').length, 1);
  } finally {
    await stop(served);
  }
});

test('Usage limit (SF-072): a parked job survives an sf serve restart; the queue resumes it at a reset passed meanwhile, and a resume that fails (worktree gone) leaves it in needs_human; abort ends a parked job', async () => {
  const env = await newEnv('limit-restart');
  const repo = await newRepo(env, 'limit-restart-repo', false);
  await putTask(env, repo, 'L-1', 'Restart');
  await putTask(env, repo, 'L-2', 'Gone');
  await putTask(env, repo, 'L-3', 'Abort');
  await script(env, [LIMIT_ERROR, LIMIT_ERROR, LIMIT_ERROR, { write: { 'a.txt': 'a\n' }, text: 'After the reset.' }]);
  let served = await serve(env);
  const jobs = new JobStore(env.state);
  try {
    for (const ticket of ['L-1', 'L-2', 'L-3']) {
      await call(served, 'start', { workspace: 'app', ticket });
      await waitParked(env, ticket);
    }
    assert.equal((await runCli(env, ['abort', 'app', 'L-3'])).code, 0);
    assert.equal((await jobs.read('app', 'L-3'))!.state, 'aborted');
    await stop(served);
    // While sf serve is down the resets pass; L-2's worktree goes.
    for (const ticket of ['L-1', 'L-2']) {
      const job = (await jobs.read('app', ticket))!;
      await jobs.write({ ...job, limit: { ...job.limit!, resets_at: new Date(Date.now() - 1000).toISOString() } });
    }
    git(repo, 'worktree', 'remove', '--force', worktreeOf(env, 'L-2'));
    served = await serve(env);
    await waitFor(served, 'L-1', 'awaiting_review', 1);
    const failed = await waitFor(served, 'L-2', 'needs_human');
    assert.equal(failed.error.code, 'worktree_missing');
    assert.equal((await fakeLog(env)).at(-1)!.prompt.split('\n')[0], 'Continue where you stopped.');
  } finally {
    await runCli(env, ['abort', 'app', 'L-1']);
    await stop(served);
  }
});

test('images (SF-065): a job paused outside working gets the new set on Resume with no prompt; the reviewers get it', async () => {
  const env = await newEnv('pause-images-review', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'pause-images-review-repo', false);
  const workspace = { name: 'app', readCheckout: repo, workCheckout: repo };
  const jobs = new JobStore(env.state);
  await putTask(env, repo, 'P-1', 'Review images');
  await addAttachment(workspace, 'P-1', PNG, jobs);
  await writeFile(join(repo, '.software-factory', 'P-1.md'), `${task('P-1', 'Review images')}\nSee ![shot](P-1/1.png).\n`);
  await script(env, [{ write: { 'a.txt': 'a\n' } }, { write: { '.software-factory/P-1.mr.md': mrText('feat(P-1): Review images') }, text: 'prepared' }]);
  await reviewScript(env, [{ delayMs: LONG, output: CLEAN }, { output: CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'P-1' });
    await waitFor(served, 'P-1', 'awaiting_review', 1);
    await until('the review to start', async () => (await count(env, 'fake-review')) >= 1);
    assert.equal((await runCli(env, ['pause', 'app', 'P-1'])).code, 0);
    await nothingRuns(env, served);
    await removeAttachment(workspace, 'P-1', '1.png', jobs);
    await addAttachment(workspace, 'P-1', PNG2, jobs, '1.png');
    assert.equal((await runCli(env, ['resume', 'app', 'P-1'])).code, 0);
    await waitFor(served, 'P-1', 'ready_for_human_review', 1);
    const reviews = await reviewLog(env);
    assert.equal(reviews.length, 1);
    assert.deepEqual(reviews[0]!.blocks?.slice(1), [
      { type: 'text', text: 'Image P-1/1.png ("shot"), referenced in the Task file:' },
      { type: 'image', media_type: 'image/png', bytes: PNG2.length, sha256: sha(PNG2) },
    ]);
    // No Implementer prompt on that Resume: the first turn and the MR text turn only.
    const log = await fakeLog(env);
    assert.equal(log.length, 2);
    assert.doesNotMatch(log[1]!.prompt, /images changed/);
  } finally {
    await stop(served);
  }
});
