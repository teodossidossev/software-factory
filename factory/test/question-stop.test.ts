// The Implementer's question before any change: the MR step stops with implementer_question when
// the reviewed change is empty and the iteration's Report asks something; otherwise it goes on as
// before. End to end with the fake Claude, and the decision's text rules alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobStore } from '../src/jobs.js';
import { IMPLEMENTER_QUESTION, MAX_QUESTION_CHARS, openQuestions, questionMessage } from '../src/question-stop.js';
import { canonicalStop, STOPS } from '../src/stops.js';
import { call, newEnv, newRepo, putTask, runCli, script, serve, stop, waitFor } from './support/harness.js';

function mrText(header: string): string {
  return [
    header, '',
    '## What', 'Changes the README.', '## Why', 'The ticket asks for it.', '', 'Readers need the new line.', '## How', 'One line.', '## Why the change', 'Readers need it.',
    '## Special things to note', '- None.', '## Change outline', '- a.txt', '## Testing', 'npm test: passed', '## Screenshots', 'N/A',
    '## Checklist', '- [x] Branch name', '- [x] Target branch', '',
  ].join('\n');
}

const report = (ticket: string, done: string, questions: string): string =>
  `# Report: ${ticket}, iteration 1\n\n## Done\n\n${done}\n\n## Checks\n\nNot run.\n\n## Open questions\n\n${questions}\n`;

test('openQuestions: the section with whitespace collapsed; none for a missing or empty section or "None." in any case, with or without its dot', () => {
  assert.equal(openQuestions(report('T-1', 'Nothing.', 'Is branch X\n  acceptable?\n\n- And Y?')), 'Is branch X acceptable? - And Y?');
  for (const none of ['None.', 'none', 'NONE.', '  None.  ', '']) {
    assert.equal(openQuestions(report('T-1', 'Nothing.', none)), undefined, JSON.stringify(none));
  }
  assert.equal(openQuestions('# Report: T-1, iteration 1\n\n## Done\n\nNothing.\n'), undefined);
  assert.equal(openQuestions(undefined), undefined);
  // "None" with more after it is a question.
  assert.equal(openQuestions(report('T-1', 'Nothing.', 'None of the branches fits: which one?')), 'None of the branches fits: which one?');
});

test('questionMessage: the questions as they are up to 400 characters; a longer text cut to 399 and "…", never inside a surrogate pair', () => {
  const prefix = 'The Implementer changed nothing and asks: ';
  assert.equal(questionMessage('Is branch X acceptable?'), `${prefix}Is branch X acceptable?`);
  const exact = 'q'.repeat(MAX_QUESTION_CHARS);
  assert.equal(questionMessage(exact), `${prefix}${exact}`);
  const cut = questionMessage(`${'a'.repeat(MAX_QUESTION_CHARS)}b`);
  assert.equal(cut, `${prefix}${'a'.repeat(MAX_QUESTION_CHARS - 1)}…`);
  assert.equal(cut.length - prefix.length, MAX_QUESTION_CHARS);
  // A character outside the BMP across the cut (UTF-16 units 398 and 399) is dropped whole, never halved.
  const astral = questionMessage(`${'a'.repeat(MAX_QUESTION_CHARS - 2)}😀${'b'.repeat(10)}`);
  assert.equal(astral, `${prefix}${'a'.repeat(MAX_QUESTION_CHARS - 2)}…`);
  assert.ok(astral.length - prefix.length <= MAX_QUESTION_CHARS);
  // One that ends just before the cut stays whole.
  const kept = questionMessage(`${'a'.repeat(MAX_QUESTION_CHARS - 3)}😀${'b'.repeat(10)}`);
  assert.equal(kept, `${prefix}${'a'.repeat(MAX_QUESTION_CHARS - 3)}😀…`);
  assert.equal(kept.length - prefix.length, MAX_QUESTION_CHARS);
});

test('implementer_question is a decision with Send and Abort; its code is its own row', () => {
  assert.equal(canonicalStop(IMPLEMENTER_QUESTION, 'x', new Date()), 'implementer_question');
  const row = STOPS.implementer_question;
  assert.deepEqual([row.kind, row.group, row.settle, row.aliases], ['decision', null, null, []]);
  assert.deepEqual(row.actions.map((action) => [action.id, action.precondition]), [['say', 'always'], ['abort', 'always']]);
});

test('MR step: no change and an open question stop with implementer_question before the MR text is read; a message resumes the job', async () => {
  const env = await newEnv('question');
  const repo = await newRepo(env, 'question-repo', true);
  await putTask(env, repo, 'Q-1', 'Ask first');
  const long = `Is branch X acceptable? ${'Or should it be another one, given the base? '.repeat(12)}`;
  await script(env, [
    // An ignored file is no change.
    { write: { 'run.log': 'x\n' }, text: report('Q-1', 'Nothing.', long) },
    // The MR turn writes a valid MR text: it is never read.
    { write: { '.software-factory/Q-1.mr.md': mrText('feat(Q-1): Ask first') }, text: 'prepared' },
    { write: { 'a.txt': 'a\n' }, text: 'iteration 2' },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'Q-1' });
  await waitFor(served, 'Q-1', 'awaiting_review', 1);
  assert.equal((await call(served, 'mark_clean', { workspace: 'app', ticket: 'Q-1' })).state, 'preparing_mr');
  const stopped = await waitFor(served, 'Q-1', 'needs_human');
  assert.equal(stopped.error.code, 'implementer_question');
  const questions = long.replace(/\s+/g, ' ').trim();
  assert.equal(stopped.error.message, `The Implementer changed nothing and asks: ${questions.slice(0, 399)}…`);
  const jobs = new JobStore(env.state);
  // The MR text was never read into the job, and nothing was committed.
  assert.equal(await jobs.readMrText('app', 'Q-1'), undefined);
  assert.equal((await jobs.read('app', 'Q-1'))!.prepared_commit, null);
  // Send a message: the job goes on with a new iteration.
  assert.equal((await runCli(env, ['say', 'app', 'Q-1', 'Branch X is fine, go on.'])).code, 0);
  await waitFor(served, 'Q-1', 'awaiting_review', 2);
  await stop(served);
});

test('MR step: no change and "None." stops as before (mr_text_missing); a change with an open question goes on to the MR text', async () => {
  const env = await newEnv('question-none');
  const repo = await newRepo(env, 'question-none-repo', true);
  await putTask(env, repo, 'Q-2', 'Nothing asked');
  await putTask(env, repo, 'Q-3', 'Changed and asked');
  await script(env, [
    { text: report('Q-2', 'Nothing.', 'None.') },
    { text: 'no MR text' },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'Q-2' });
  await waitFor(served, 'Q-2', 'awaiting_review', 1);
  await call(served, 'mark_clean', { workspace: 'app', ticket: 'Q-2' });
  const none = await waitFor(served, 'Q-2', 'needs_human');
  assert.deepEqual([none.error.code, none.error.message], ['mr_text_missing', '.software-factory/Q-2.mr.md does not exist.']);

  await script(env, [
    { write: { 'a.txt': 'a\n' }, text: report('Q-3', 'Added a.txt.', 'Is branch X acceptable?') },
    { write: { '.software-factory/Q-3.mr.md': mrText('feat(Q-3): Changed and asked') }, text: 'prepared' },
  ]);
  await call(served, 'start', { workspace: 'app', ticket: 'Q-3' });
  await waitFor(served, 'Q-3', 'awaiting_review', 1);
  await call(served, 'mark_clean', { workspace: 'app', ticket: 'Q-3' });
  await waitFor(served, 'Q-3', 'ready_for_human_review');
  assert.notEqual((await new JobStore(env.state).read('app', 'Q-3'))!.prepared_commit, null);
  await stop(served);
});
