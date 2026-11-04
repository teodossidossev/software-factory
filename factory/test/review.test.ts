// End-to-end tests of the Claude review of every iteration (SF-038) with the real sf serve and the
// fake Claude, whose runs with --json-schema are reviews scripted by $HOME/fake-review.json: a fix
// verdict becomes ## Fix N and the next iteration, a clean one runs Clean, undeclared sensitive
// paths, failures, SF_REVIEW=off and the review at serve start, abort during a review, the limit on
// Fix sections, and what check, sf watch, sf status and the dashboard show. Then the schema the CLI
// accepts (the fake refuses one it would not) and the retry of a failed review (SF-044).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { JobStore } from '../src/jobs.js';
import { handbookSection } from '../src/prompts.js';
import { actedVerdict, decide, fixContent, REVIEW_DENIED_TOOLS, REVIEW_SCHEMA, type ReviewItem, reviewPrompt, reviewSessionOptions, sensitiveItem, uniqueNits } from '../src/review.js';
import { loadHandbook } from '../src/server.js';
import { act, fetchRaw } from './support/dashboard-client.js';
import { call, type Env, FAKE, fakeLog, git, newEnv, newRepo, putTask, reviewLog, reviewScript, runCli, script, serve, stop, task, waitFor } from './support/harness.js';

const FIX = {
  verdict: 'fix',
  summary: 'The greeting  is\nwrong.',
  items: [{ path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.', severity: 'major' }],
  accepted_sensitive: [],
};
const CLEAN = { verdict: 'clean', summary: 'The greeting is right.', items: [], accepted_sensitive: [] };
const FIX_SECTION = '## Fix 1\n\nReview by Claude: The greeting is wrong.\n\n1. [major] `README.md`: It greets the world. Expected: It greets the reader.\n';

function mrText(header: string): string {
  return [
    header, '',
    '## What', 'x', '## Why', 'The ticket asks for it.', '## How', 'x', '## Why the change', 'x', '## Special things to note', '- None.',
    '## Change outline', 'x', '## Testing', 'x', '## Screenshots', 'N/A', '## Checklist', '- [x] Branch name', '',
  ].join('\n');
}

const taskFile = (repo: string, ticket: string): Promise<string> => readFile(join(repo, '.software-factory', `${ticket}.md`), 'utf8');
const worktreeOf = (env: Env, ticket: string): string => join(env.state, 'worktrees', 'app', ticket);
const option = (argv: string[], name: string): string | undefined => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function eventsOf(env: Env, ticket: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(env.state, 'jobs', 'app', ticket, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

test('the review session sees the repository\'s settings and instructions only: no user settings, no auto-memory, no instruction file above the worktree', () => {
  const abortController = new AbortController();
  const cwd = '/home/u/state/worktrees/app/R-1';
  const options = reviewSessionOptions({ cwd, claudePath: undefined, sandbox: undefined, model: undefined, maxTurns: 7, }, abortController);
  assert.equal(options.cwd, cwd);
  assert.deepEqual(options.settingSources, ['project']);
  assert.equal(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  const excludes = (options.settings as { claudeMdExcludes?: string[] }).claudeMdExcludes ?? [];
  for (const dir of ['/home/u/state/worktrees/app', '/home/u/state/worktrees', '/home/u/state', '/home/u', '/home']) {
    for (const file of ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md', '.claude/AGENTS.md', '.claude/rules/**']) {
      assert.ok(excludes.includes(`${dir}/${file}`), `${dir}/${file} not in ${excludes.join(', ')}`);
    }
  }
  // The worktree's own files stay.
  assert.ok(!excludes.some((pattern) => pattern.startsWith(`${cwd}/`)), excludes.join(', '));
  // A glob character in a directory name is matched literally.
  const special = reviewSessionOptions({ cwd: '/srv/a (b)/w', claudePath: undefined, sandbox: undefined, model: undefined, maxTurns: 7, }, abortController);
  assert.ok((special.settings as { claudeMdExcludes: string[] }).claudeMdExcludes.includes('/srv/a \\(b\\)/CLAUDE.md'));
});

test('fix, then clean: the Fix section from the items, the next iteration, Clean; the read-only argv, the prompt, review.json, check, sf watch, sf status and the dashboard', async () => {
  const env = await newEnv('review-cycle', { SF_REVIEW: 'on', SF_REVIEW_MAX_TURNS: '7', SF_REVIEW_MODEL: 'fake-reviewer' });
  const repo = await newRepo(env, 'review-cycle-repo', false);
  await putTask(env, repo, 'R-1', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 2' },
    { write: { '.software-factory/R-1.mr.md': mrText('feat(R-1): Greet the reader') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: FIX }, { output: CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'R-1' });
    const ready = await waitFor(served, 'R-1', 'ready_for_human_review', 2);
    assert.deepEqual(ready.review, { status: 'done', verdict: 'clean', summary: CLEAN.summary });
    assert.equal(await taskFile(repo, 'R-1'), `${task('R-1', 'Greet the reader')}\n\n${FIX_SECTION}`);
    assert.equal(git(repo, 'show', 'R-1-greet-the-reader:README.md'), 'hello reader\n');
    const jobs = new JobStore(env.state);
    assert.equal((await jobs.read('app', 'R-1'))!.fixes, 1);

    // The Implementer: the first iteration, the Fix of the review, the MR text turn of Clean.
    const turns = await fakeLog(env);
    assert.deepEqual(turns.map((entry) => entry.prompt.split('\n')[0]), [
      '/implement .software-factory/R-1.md',
      '/implement .software-factory/R-1.md Fix 1',
      'MR preparation for R-1 on branch R-1-greet-the-reader. The user approved the reviewed change.',
    ]);

    // The reviews: fresh read-only sessions in the worktree with the schema and their own limits.
    const reviews = await reviewLog(env);
    assert.equal(reviews.length, 2);
    for (const entry of reviews) {
      assert.equal(entry.cwd, worktreeOf(env, 'R-1'));
      assert.equal(option(entry.argv, 'tools'), 'Read,Grep,Glob');
      assert.deepEqual(option(entry.argv, 'disallowedTools')!.split(','), REVIEW_DENIED_TOOLS);
      assert.deepEqual(JSON.parse(option(entry.argv, 'json-schema')!), REVIEW_SCHEMA);
      assert.deepEqual([option(entry.argv, 'max-turns'), option(entry.argv, 'model'), option(entry.argv, 'permission-mode')], ['7', 'fake-reviewer', 'auto']);
      assert.ok(!entry.argv.some((arg) => arg.startsWith('--resume')), entry.argv.join(' '));
      assert.ok(!turns.some((turn) => turn.sessionId === entry.sessionId));
      assert.ok(!entry.env.some((name) => name.startsWith('SF_')));
      // The repository's settings and instructions only: no user settings, no auto-memory.
      assert.equal(option(entry.argv, 'setting-sources'), 'project');
      assert.ok(entry.env.includes('CLAUDE_CODE_DISABLE_AUTO_MEMORY'), entry.env.join(','));
      const settings = JSON.parse(entry.argv[entry.argv.indexOf('--settings') + 1] ?? '{}') as { claudeMdExcludes?: string[] };
      assert.ok(settings.claudeMdExcludes?.includes(join(dirname(entry.cwd), 'CLAUDE.md')), entry.argv.join(' '));
    }
    // The Implementer's session keeps the user's settings.
    assert.ok(turns.every((turn) => option(turn.argv, 'setting-sources') === 'user,project'));
    assert.equal(REVIEW_DENIED_TOOLS.filter((tool) => ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Read(**/.env)'].includes(tool)).length, 9);
    const [first, second] = reviews.map((entry) => entry.prompt);
    assert.match(first!, /^Code review of iteration 1 of ticket R-1\. /);
    assert.ok(first!.includes(handbookSection((await loadHandbook()).text, '## Review rules')));
    assert.ok(first!.includes(`<task_file path=".software-factory/R-1.md">\n${task('R-1', 'Greet the reader').trimEnd()}\n</task_file>`));
    assert.ok(first!.includes('<report>\nReport of iteration 1\n'));
    assert.ok(first!.includes('<sensitive_and_deleted_paths>\nNone.\n</sensitive_and_deleted_paths>'));
    assert.match(first!, /<patch>\ndiff --git a\/README\.md b\/README\.md\n[\s\S]*\n\+hello world\n<\/patch>$/);
    assert.match(second!, /^Code review of iteration 2 of ticket R-1\. /);
    assert.ok(second!.includes(`${FIX_SECTION.trimEnd()}\n</task_file>`));
    assert.ok(second!.includes('+hello reader'));

    // review.json of each iteration, the events, check, sf watch, sf status and the dashboard.
    const recorded = await jobs.readReview('app', 'R-1', 1);
    assert.ok(recorded !== undefined && 'verdict' in recorded);
    const { started_at: startedAt, ended_at: endedAt, ...rest } = recorded;
    assert.deepEqual(rest, { reviewer: 'claude', ...FIX, cost_usd: 0.0456 });
    assert.ok(Date.parse(startedAt) <= Date.parse(endedAt));
    assert.deepEqual((await eventsOf(env, 'R-1')).filter((record) => record.type === 'review').map(({ ts: _ts, ...record }) => record), [
      { iteration: 1, type: 'review', reviewer: 'claude', verdict: 'fix', items: 1 },
      { iteration: 2, type: 'review', reviewer: 'claude', verdict: 'clean', items: 0 },
    ]);
    const watched = await runCli(env, ['watch', 'app', 'R-1', '--once']);
    assert.match(watched.stdout, /^\d\d:\d\d:\d\d \[1\] review by claude: fix \(1 item\)$/m);
    assert.match(watched.stdout, /^\d\d:\d\d:\d\d \[2\] review by claude: clean$/m);
    // The review sessions live (SF-045): every SDK message of each, then the verdict line.
    const live = (await eventsOf(env, 'R-1')).filter((record) => record.type === 'review_message' || record.type === 'review');
    assert.deepEqual(live.map((record) => [record.iteration, record.type, (record.message as { type?: string } | undefined)?.type ?? record.verdict]), [1, 2].flatMap((iteration) => [
      [iteration, 'review_message', 'system'], [iteration, 'review_message', 'assistant'], [iteration, 'review_message', 'user'],
      [iteration, 'review_message', 'assistant'], [iteration, 'review_message', 'result'], [iteration, 'review', iteration === 1 ? 'fix' : 'clean'],
    ]));
    assert.ok(live.filter((record) => record.type === 'review_message').every((record) => record.reviewer === 'claude' && Object.keys(record).sort().join() === 'iteration,message,reviewer,ts,type'));
    const reviewLines = watched.stdout.split('\n').filter((line) => / review( |$)/.test(line)).map((line) => line.slice(9));
    assert.deepEqual(reviewLines, [
      '[1] review | Read(README.md)', '[1] review | Reviewed.', '[1] review by claude: fix (1 item)',
      '[2] review | Read(README.md)', '[2] review | Reviewed.', '[2] review by claude: clean',
    ]);
    // The Implementer's cost (0.0123, then 0 more in the same session) and both reviews.
    assert.equal((await jobs.recordedCost('app', 'R-1', 2))!.toFixed(4), '0.1035');
    assert.match((await runCli(env, ['status'])).stdout, /\bR-1\b.*\b0\.1035\b/);
    const detail = JSON.parse((await fetchRaw(new URL('api/jobs/app/R-1', served.dashboard!))).body);
    assert.deepEqual(detail.iterations.map((iteration: { review: { verdict: string } | null }) => iteration.review?.verdict), ['fix', 'clean']);
    assert.deepEqual(detail.iterations[0].review.items, FIX.items);
  } finally {
    await stop(served);
  }
});

test('clean with an undeclared sensitive path it does not accept becomes a fix; accepted, Clean passes it on', async () => {
  const env = await newEnv('review-sensitive', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'review-sensitive-repo', false);
  await putTask(env, repo, 'S-1', 'Add a script');
  await script(env, [
    { write: { 'package.json': '{}\n', 'a.txt': 'a\n' }, text: 'iteration 1' },
    { text: 'package.json is needed: the tests run with npm.' },
    { write: { '.software-factory/S-1.mr.md': mrText('feat(S-1): Add a script') }, text: 'prepared' },
  ]);
  const accepted = { ...CLEAN, summary: 'package.json is accepted: the tests run with npm.', accepted_sensitive: ['package.json'] };
  await reviewScript(env, [{ output: CLEAN }, { output: accepted }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-1' });
    const ready = await waitFor(served, 'S-1', 'ready_for_human_review', 2);
    assert.equal(ready.review.summary, accepted.summary);
    assert.ok((await taskFile(repo, 'S-1')).endsWith(
      '\n\n## Fix 1\n\nReview by Claude: The greeting is right.\n\n1. [major] `package.json`: Undeclared sensitive path. Expected: Remove it, or justify it in the Report.\n',
    ));
    const [first] = await reviewLog(env);
    assert.ok(first!.prompt.includes('<sensitive_and_deleted_paths>\n- sensitive, undeclared: package.json\n</sensitive_and_deleted_paths>'));
    assert.equal(git(repo, 'show', '--name-only', '--format=', 'S-1-add-a-script').trim(), 'a.txt\npackage.json');
    // The review's own verdict is what the event records, with the one acted on when it differs.
    assert.deepEqual((await eventsOf(env, 'S-1')).filter((record) => record.type === 'review').map((record) => [record.iteration, record.verdict, record.effective]), [[1, 'clean', 'fix'], [2, 'clean', undefined]]);
  } finally {
    await stop(served);
  }
});

// SF-051: the severity of review items.
const major = (path: string, problem: string): ReviewItem => ({ path, problem, expected: 'Fixed.', severity: 'major' });
const nit = (path: string, problem: string, expected = 'Nicer.'): ReviewItem => ({ path, problem, expected, severity: 'nit' });

test('the review schema gives every item a severity (blocker, major, nit) and the prompt defines them', async () => {
  const items = (REVIEW_SCHEMA.properties as { items: { items: { properties: Record<string, { enum?: string[] }>; required: string[] } } }).items.items;
  assert.deepEqual(items.properties.severity?.enum, ['blocker', 'major', 'nit']);
  assert.ok(items.required.includes('severity'));
  const prompt = reviewPrompt({ ticket: 'R-1', iteration: 1, task: 't', report: 'r', patch: Buffer.from('p'), patchTruncated: false, files: [], handbook: (await loadHandbook()).text });
  assert.ok(prompt.includes("- `blocker`: the change is wrong, unsafe or breaks the Task's acceptance."), prompt);
  assert.ok(prompt.includes('- `major`: a real defect or a Task requirement not met, but contained.'));
  assert.ok(prompt.includes('- `nit`: style, naming, wording, a narrower variant of a risk already accepted, a nice-to-have.'));
});

test('the verdict rule: fix only with a blocker or major item or an unaccepted sensitive path; the Fix section lists the nits last as optional', () => {
  const nits = [nit('a.txt', 'Wording.'), nit('b.txt', 'Naming.')];
  assert.deepEqual(decide({ items: nits }, []), { verdict: 'clean', items: [] });
  assert.equal(actedVerdict({ items: nits }), 'clean');
  // The items decide, whatever the reviewer wrote: a major item in a clean verdict is a fix too.
  assert.equal(actedVerdict({ items: [...nits, major('c.txt', 'Broken.')] }), 'fix');
  assert.deepEqual(decide({ items: [major('c.txt', 'Broken.'), ...nits] }, []), { verdict: 'fix', items: [major('c.txt', 'Broken.'), ...nits] });
  const sensitive = sensitiveItem('package.json');
  assert.equal(sensitive.severity, 'major');
  assert.deepEqual(decide({ items: nits }, [sensitive]), { verdict: 'fix', items: [sensitive, ...nits] });
  const blocker: ReviewItem = { ...major('c.txt', 'Unsafe.'), severity: 'blocker' };
  assert.deepEqual(decide({ items: [nits[0]!, blocker, nits[1]!] }, [sensitive]).items, [blocker, sensitive, ...nits]);
  assert.equal(fixContent('Two  things.', [blocker, sensitive, ...nits], 'Codex'), [
    'Review by Codex: Two things.', '',
    '1. [blocker] `c.txt`: Unsafe. Expected: Fixed.',
    '2. [major] `package.json`: Undeclared sensitive path. Expected: Remove it, or justify it in the Report.', '',
    'Nits (optional):',
    '3. [nit] `a.txt`: Wording. Expected: Nicer.',
    '4. [nit] `b.txt`: Naming. Expected: Nicer.',
  ].join('\n'));
  // Deduplicated by path and problem text across both reviewers.
  assert.deepEqual(uniqueNits([{ items: [...nits, major('a.txt', 'Wording.')] }, { items: [nit('a.txt', ' Wording. ', 'Other.'), nit('a.txt', 'Other.')] }]), [...nits, nit('a.txt', 'Other.')]);
});

test('a review or gate stored before severity existed reads with every item major', async () => {
  const env = await newEnv('review-old-records');
  const jobs = new JobStore(env.state);
  const item = { path: 'README.md', problem: 'Old.', expected: 'New.' };
  const dir = jobs.iterationDir('app', 'O-1', 1);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'review.json'), JSON.stringify({ reviewer: 'claude', verdict: 'fix', summary: 's', items: [item, { ...item, severity: 'nit' }], accepted_sensitive: [], cost_usd: null, started_at: 'a', ended_at: 'b' }));
  await writeFile(join(dir, 'gate.json'), JSON.stringify({ reviewer: 'codex', verdict: 'fix', summary: 's', items: [item], accepted_sensitive: [], tokens: { input: 0, cached_input: 0, output: 0 }, started_at: 'a', ended_at: 'b' }));
  await writeFile(join(dir, 'gate-override.json'), JSON.stringify({ at: 'a', code: 'gate_rounds', unapplied: [item] }));
  const review = await jobs.readReview('app', 'O-1', 1);
  assert.ok(review !== undefined && 'items' in review);
  assert.deepEqual(review.items, [{ ...item, severity: 'major' }, { ...item, severity: 'nit' }]);
  assert.equal(actedVerdict(review), 'fix');
  const gate = await jobs.readGate('app', 'O-1', 1);
  assert.ok(gate !== undefined && 'items' in gate);
  assert.deepEqual(gate.items, [{ ...item, severity: 'major' }]);
  assert.deepEqual((await jobs.readGateOverride('app', 'O-1', 1))!.unapplied, [{ ...item, severity: 'major' }]);
});

test('one major among nits is a Fix section with the nits as optional; a fix with nits only goes on as clean and its nits reach the MR text', async () => {
  const env = await newEnv('review-nits', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'review-nits-repo', false);
  await putTask(env, repo, 'N-1', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 2' },
    { write: { '.software-factory/N-1.mr.md': mrText('feat(N-1): Greet the reader') }, text: 'prepared' },
  ]);
  const first = { verdict: 'fix', summary: 'One real problem.', items: [nit('README.md', 'No capital.'), major('README.md', 'It greets the world.')], accepted_sensitive: [] };
  const second = { verdict: 'fix', summary: 'Only nits left.', items: [nit('README.md', 'No capital.'), nit('README.md', 'No  capital.', 'Same.'), nit('a.txt', 'Could say more.')], accepted_sensitive: [] };
  await reviewScript(env, [{ output: first }, { output: second }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'N-1' });
    const ready = await waitFor(served, 'N-1', 'ready_for_human_review', 2);
    assert.equal(await taskFile(repo, 'N-1'), `${task('N-1', 'Greet the reader')}\n\n${[
      '## Fix 1', '', 'Review by Claude: One real problem.', '',
      '1. [major] `README.md`: It greets the world. Expected: Fixed.', '',
      'Nits (optional):',
      '2. [nit] `README.md`: No capital. Expected: Nicer.', '',
    ].join('\n')}`);
    // Recorded as given; the event carries the verdict acted on.
    assert.deepEqual(ready.review, { status: 'done', verdict: 'fix', summary: second.summary });
    const jobs = new JobStore(env.state);
    const recorded = await jobs.readReview('app', 'N-1', 2);
    assert.ok(recorded !== undefined && 'verdict' in recorded);
    assert.deepEqual([recorded.verdict, recorded.items], ['fix', second.items]);
    assert.deepEqual((await eventsOf(env, 'N-1')).filter((record) => record.type === 'review').map((record) => [record.iteration, record.verdict, record.effective]), [[1, 'fix', undefined], [2, 'fix', 'clean']]);
    assert.match((await runCli(env, ['watch', 'app', 'N-1', '--once'])).stdout, /^\d\d:\d\d:\d\d \[2\] review by claude: fix \(3 items\), acted on as clean$/m);
    assert.equal((await jobs.read('app', 'N-1'))!.fixes, 1);
    // The nits of the clean iteration, deduplicated, in the MR text by the factory; the model's "- None." goes.
    const mr = (await jobs.readMrText('app', 'N-1'))!;
    assert.ok(mr.includes([
      '## Special things to note',
      '### Nits not applied',
      '- [nit] `README.md`: No capital. Expected: Nicer.',
      '- [nit] `a.txt`: Could say more. Expected: Nicer.',
      '',
      '## Change outline',
    ].join('\n')), mr);
  } finally {
    await stop(served);
  }
});

test('a fix with nits only still makes a fix when an undeclared sensitive path is not accepted, whatever severity the reviewer gave it', async () => {
  const env = await newEnv('review-nits-sensitive', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'review-nits-sensitive-repo', false);
  await putTask(env, repo, 'N-2', 'Add a script');
  await script(env, [
    { write: { 'package.json': '{}\n' }, text: 'iteration 1' },
    { text: 'package.json is needed.' },
    { write: { '.software-factory/N-2.mr.md': mrText('feat(N-2): Add a script') }, text: 'prepared' },
  ]);
  const nitsOnly = { verdict: 'fix', summary: 'Only nits.', items: [nit('package.json', 'Undeclared, but small.')], accepted_sensitive: [] };
  const accepted = { ...CLEAN, summary: 'package.json is accepted: the tests run with npm.', accepted_sensitive: ['package.json'] };
  await reviewScript(env, [{ output: nitsOnly }, { output: accepted }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'N-2' });
    await waitFor(served, 'N-2', 'ready_for_human_review', 2);
    assert.ok((await taskFile(repo, 'N-2')).endsWith([
      '## Fix 1', '', 'Review by Claude: Only nits.', '',
      '1. [major] `package.json`: Undeclared sensitive path. Expected: Remove it, or justify it in the Report.', '',
      'Nits (optional):',
      '2. [nit] `package.json`: Undeclared, but small. Expected: Nicer.', '',
    ].join('\n')));
    assert.deepEqual((await eventsOf(env, 'N-2')).filter((record) => record.type === 'review').map((record) => [record.iteration, record.verdict, record.effective]), [[1, 'fix', undefined], [2, 'clean', undefined]]);
    // The clean iteration had no nits: no list in the MR text.
    assert.ok(!(await new JobStore(env.state).readMrText('app', 'N-2'))!.includes('### Nits not applied'));
  } finally {
    await stop(served);
  }
});

test('a failed review (a turn that is not a success, no output, an invalid verdict, fix without items) is needs_human review_failed', async () => {
  const env = await newEnv('review-failed', { SF_REVIEW: 'on', SF_MAX_JOBS: '4' });
  const repo = await newRepo(env, 'review-failed-repo', false);
  const cases = [
    { review: { subtype: 'error_max_turns' }, message: /^The review ended with error_max_turns: fake review failure$/ },
    { review: { noOutput: true }, message: /^The review returned no structured output\.$/ },
    { review: { output: { ...CLEAN, verdict: 'maybe' } }, message: /^The review returned an invalid verdict: verdict: / },
    { review: { output: { ...FIX, items: [] } }, message: /^The review returned fix without items\.$/ },
  ];
  await script(env, cases.map((_, index) => ({ write: { [`f${index}.txt`]: 'f\n' } })));
  await reviewScript(env, cases.map((entry) => entry.review));
  const served = await serve(env);
  try {
    for (const [index, entry] of cases.entries()) {
      const ticket = `F-${index + 1}`;
      await putTask(env, repo, ticket, `Fail ${index + 1}`);
      await call(served, 'start', { workspace: 'app', ticket });
      const failed = await waitFor(served, ticket, 'needs_human', 1);
      assert.equal(failed.error.code, 'review_failed');
      assert.match(failed.error.message, entry.message);
      assert.deepEqual(failed.review, { status: 'failed', summary: failed.error.message });
      assert.deepEqual(await new JobStore(env.state).readReview('app', ticket, 1), { reviewer: 'claude', error: failed.error.message });
      assert.doesNotMatch(await taskFile(repo, ticket), /## Fix/);
    }
    assert.match((await runCli(env, ['watch', 'app', 'F-2', '--once'])).stdout, /\[1\] review by claude failed: The review returned no structured output\.$/m);
  } finally {
    await stop(served);
  }
});

test('SF_REVIEW=off: the job stays awaiting_review; at the next sf serve with the review on, the iteration without a review gets one', async () => {
  const env = await newEnv('review-off');
  const repo = await newRepo(env, 'review-off-repo', false);
  await putTask(env, repo, 'O-1', 'Off');
  await script(env, [{ write: { 'o.txt': 'o\n' } }, { write: { 'o.txt': 'oo\n' } }]);
  await reviewScript(env, [{ output: FIX }, { delayMs: 5000 }]);
  let served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'O-1' });
    await waitFor(served, 'O-1', 'awaiting_review', 1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const off = await call(served, 'check', { workspace: 'app', ticket: 'O-1' });
    assert.deepEqual([off.state, off.review], ['awaiting_review', { status: 'off' }]);
    assert.equal(await exists(join(env.home, 'fake-review.log')), false);
  } finally {
    await stop(served);
  }
  env.extra = { SF_REVIEW: 'on' };
  served = await serve(env);
  try {
    // The review of iteration 1 runs at start: its Fix starts iteration 2, whose review is running.
    const second = await waitFor(served, 'O-1', 'awaiting_review', 2);
    assert.deepEqual(second.review, { status: 'running' });
    assert.ok((await taskFile(repo, 'O-1')).endsWith(`\n\n${FIX_SECTION}`));
    assert.equal((await reviewLog(env)).length, 1);
  } finally {
    await stop(served);
  }
});

test('abort during a running review: the review is cancelled, its outcome never applied, the job stays aborted', async () => {
  const env = await newEnv('review-abort', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'review-abort-repo', false);
  await putTask(env, repo, 'A-1', 'Abort');
  await script(env, [{ write: { 'a.txt': 'a\n' } }, { text: 'never' }]);
  await reviewScript(env, [{ delayMs: 1500, output: FIX }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'A-1' });
    const waiting = await waitFor(served, 'A-1', 'awaiting_review', 1);
    assert.deepEqual(waiting.review, { status: 'running' });
    const aborted = await runCli(env, ['abort', 'app', 'A-1']);
    assert.equal(aborted.code, 0, aborted.stderr);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const checked = await call(served, 'check', { workspace: 'app', ticket: 'A-1' });
    assert.deepEqual([checked.state, checked.iteration, checked.review], ['aborted', 1, undefined]);
    assert.equal(await new JobStore(env.state).readReview('app', 'A-1', 1), undefined);
    assert.doesNotMatch(await taskFile(repo, 'A-1'), /## Fix/);
    assert.equal((await eventsOf(env, 'A-1')).filter((record) => (record.type === 'review' || record.type === 'review_failed')).length, 0);
    assert.equal((await fakeLog(env)).length, 1);
  } finally {
    await stop(served);
  }
});

test('SF_MAX_ITERATIONS=1 counts Fix sections: an sf say turn and one Fix are allowed, the second Fix is refused; a review the job outran is not applied', async () => {
  const env = await newEnv('review-limit', { SF_REVIEW: 'on', SF_MAX_ITERATIONS: '1' });
  const repo = await newRepo(env, 'review-limit-repo', false);
  await putTask(env, repo, 'L-1', 'Limit');
  await script(env, [{ write: { 'a.txt': '1\n' } }, { write: { 'a.txt': '2\n' }, text: 'said' }, { write: { 'a.txt': '3\n' }, text: 'fixed' }]);
  await reviewScript(env, [{ delayMs: 1500, output: FIX }, { output: FIX }, { output: FIX }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-1' });
    await waitFor(served, 'L-1', 'awaiting_review', 1);
    // The review of iteration 1 still runs: the user's message moves the job on.
    const said = await runCli(env, ['say', 'app', 'L-1', 'also', 'this']);
    assert.equal(said.code, 0, said.stderr);
    const limited = await waitFor(served, 'L-1', 'needs_human', 3);
    assert.deepEqual(limited.error, { code: 'iteration_limit', message: '1 Fix sections were written, the limit of SF_MAX_ITERATIONS; the user decides how to go on.' });
    const text = await taskFile(repo, 'L-1');
    assert.deepEqual(text.match(/^## Fix \d+$/gm), ['## Fix 2']);
    assert.equal((await new JobStore(env.state).read('app', 'L-1'))!.fixes, 1);
    assert.deepEqual((await fakeLog(env)).map((entry) => entry.prompt.split('\n')[0]), ['/implement .software-factory/L-1.md', 'also this', '/implement .software-factory/L-1.md Fix 2']);
    // Iteration 1's review was cancelled by the next one, or recorded as ignored; never applied.
    const reviews = (await eventsOf(env, 'L-1')).filter((record) => record.type === 'review');
    assert.deepEqual(reviews.filter((record) => record.ignored !== true).map((record) => record.iteration), [2, 3]);
  } finally {
    await stop(served);
  }
});

test('the review schema is draft-07 without $schema; the fake refuses a $schema the CLI does not know, as the CLI does', async () => {
  assert.equal(REVIEW_SCHEMA.$schema, undefined);
  assert.doesNotMatch(JSON.stringify(REVIEW_SCHEMA), /2020-12|prefixItems|\$defs|unevaluated|dependentRequired|dependentSchemas/);
  assert.deepEqual(REVIEW_SCHEMA.required, ['verdict', 'summary', 'items', 'accepted_sensitive']);
  assert.equal(REVIEW_SCHEMA.additionalProperties, false);
  const env = await newEnv('review-schema');
  const runFake = (schema: Record<string, unknown>): { status: number | null; stderr: string } =>
    spawnSync(process.execPath, [FAKE, '--json-schema', JSON.stringify(schema)], { env: { PATH: process.env.PATH, HOME: env.home }, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  const refused = runFake({ ...REVIEW_SCHEMA, $schema: 'https://json-schema.org/draft/2020-12/schema' });
  assert.deepEqual([refused.status, refused.stderr], [1, 'Error: --json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"\n']);
  for (const schema of [REVIEW_SCHEMA, { ...REVIEW_SCHEMA, $schema: 'http://json-schema.org/draft-07/schema#' }]) {
    const accepted = runFake(schema);
    assert.deepEqual([accepted.status, accepted.stderr], [0, '']);
  }
});

test('retry a failed review: sf review and the dashboard put the job back to awaiting_review and review the same iteration again; refused in other states and with the review off', async () => {
  const env = await newEnv('review-retry', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'review-retry-repo', false);
  await putTask(env, repo, 'R-2', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 2' },
    { write: { '.software-factory/R-2.mr.md': mrText('feat(R-2): Greet the reader') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ subtype: 'error_max_turns' }, { noOutput: true }, { output: FIX }, { output: CLEAN }]);
  const jobs = new JobStore(env.state);
  let served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'R-2' });
    const failed = await waitFor(served, 'R-2', 'needs_human', 1);
    assert.equal(failed.error.code, 'review_failed');
  } finally {
    await stop(served);
  }

  // With the review off nothing would review it: refused, the job as it was.
  env.extra = { SF_REVIEW: 'off' };
  served = await serve(env);
  try {
    const off = await runCli(env, ['review', 'app', 'R-2']);
    assert.equal(off.code, 1);
    assert.match(off.stderr, /The Claude review is off \(SF_REVIEW=off\)/);
    assert.equal((await jobs.read('app', 'R-2'))!.state, 'needs_human');
  } finally {
    await stop(served);
  }

  env.extra = { SF_REVIEW: 'on' };
  served = await serve(env);
  try {
    // sf review: the same iteration, the error cleared; the second review fails too.
    const retried = await runCli(env, ['review', 'app', 'R-2']);
    assert.equal(retried.code, 0, retried.stderr);
    assert.match(retried.stdout, /^state: awaiting_review\niteration: 1$/m);
    const again = await waitFor(served, 'R-2', 'needs_human', 1);
    assert.equal(again.error.message, 'The review returned no structured output.');
    assert.deepEqual(await jobs.readReview('app', 'R-2', 1), { reviewer: 'claude', error: again.error.message });

    // The dashboard's route: the third review's fix starts iteration 2, whose review is clean.
    const reply = await act(served.dashboard!, 'api/jobs/app/R-2/review', {});
    assert.equal(reply.status, 200, reply.body);
    assert.deepEqual(JSON.parse(reply.body).result, { state: 'awaiting_review', iteration: 1 });
    await waitFor(served, 'R-2', 'ready_for_human_review', 2);
    assert.equal(await taskFile(repo, 'R-2'), `${task('R-2', 'Greet the reader')}\n\n${FIX_SECTION}`);
    const recorded = await jobs.readReview('app', 'R-2', 1);
    assert.ok(recorded !== undefined && 'verdict' in recorded && recorded.verdict === 'fix');
    assert.equal((await reviewLog(env)).length, 4);
    assert.deepEqual((await reviewLog(env)).map((entry) => entry.prompt.split('\n')[0]), [1, 1, 1, 2].map((n) => `Code review of iteration ${n} of ticket R-2. You review; you change nothing.`));
    const events = await eventsOf(env, 'R-2');
    assert.deepEqual(events.filter((record) => (record.type === 'review' || record.type === 'review_failed')).map((record) => [record.iteration, record.type, record.verdict]), [
      [1, 'review_failed', undefined], [1, 'review_failed', undefined], [1, 'review', 'fix'], [2, 'review', 'clean'],
    ]);
    const retries = events.filter((record) => (record.state as { from?: string } | undefined)?.from === 'needs_human');
    assert.deepEqual(retries.map((record) => [record.iteration, (record.state as { to: string }).to, 'error' in (record.state as object)]), [[1, 'awaiting_review', false], [1, 'awaiting_review', false]]);

    // Any other state is refused, by sf review and by the route.
    const ready = await runCli(env, ['review', 'app', 'R-2']);
    assert.equal(ready.code, 1);
    assert.match(ready.stderr, /sf review needs needs_human after a failed review \(review_failed\); the job is ready_for_human_review\./);
    const refusedRoute = await act(served.dashboard!, 'api/jobs/app/R-2/review', {});
    assert.deepEqual([refusedRoute.status, JSON.parse(refusedRoute.body).error.code], [409, 'invalid_state']);
    assert.equal((await reviewLog(env)).length, 4);
  } finally {
    await stop(served);
  }
});
