// The Task check of a Task with builds_on: the chain read from the Task files (buildsOnChain), its
// lines in the check's sha256, what the check sends of it (checkChain), the prompt's blocks, and end
// to end with the fake Claude: sf check-task with a chain partly merged, a chain that cannot be
// used, a cycle, the stale view once a Task file of the chain changes, and the record's line.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildsOnChain, chainLines, checkChain, type CheckChain } from '../src/builds-on.js';
import { DECISION_CHECK_LINES } from '../src/decisions.js';
import { type Job, JobStore, now } from '../src/jobs.js';
import { checkPrompt } from '../src/prompts.js';
import type { Workspace } from '../src/registry.js';
import { draftContent } from '../src/setup.js';
import { type CheckOutput, type CheckRecord, CheckStore, checkLines, currentCheckSha256, TaskChecks, taskCheckSha256, taskSha256 } from '../src/task-check.js';
import { MAX_SLICES, writeTask } from '../src/task-file.js';
import { type Env, newEnv, newRepo, reviewLog, reviewScript, runCli, temp } from './support/harness.js';

const OUTPUT: CheckOutput = {
  paraphrase: 'The Task greets the reader in the README. It changes one line. It is accepted when the README says hello reader.',
  findings: [],
  files: [{ path: 'README.md', action: 'modify' }],
  verdict: 'ready',
};

function taskText(ticket: string, buildsOn?: string, body = 'Greet the reader in README.md.'): string {
  return `---\nticket: ${ticket}\ntitle: Greet the reader\nbase: main\n${buildsOn === undefined ? '' : `builds_on: ${buildsOn}\n`}---\n\n# ${ticket}: Greet the reader\n\n${body}\n`;
}

// A workspace with the given Task files, written as write_task writes them.
async function checkEnv(name: string, tasks: Record<string, string>): Promise<{ env: Env; repo: string; workspace: Workspace; jobs: JobStore }> {
  const env = await newEnv(name, { SF_REVIEW_MODEL: 'fake-checker', SF_TASK_CHECK_MAX_TURNS: '9' });
  const repo = await newRepo(env, `${name}-repo`, false);
  const workspace: Workspace = { name: 'app', readCheckout: repo, workCheckout: repo };
  const jobs = new JobStore(env.state);
  for (const [ticket, content] of Object.entries(tasks)) {
    await writeTask(workspace, ticket, content, jobs);
  }
  return { env, repo, workspace, jobs };
}

// The job record of a ticket pushed and merged, as its job left it.
function mergedJob(ticket: string): Job {
  const at = now();
  return {
    workspace: 'app', ticket, branch: `sf/${ticket}`, base: 'main', continues: null, builds_on: null, builds_on_commit: null, base_commit: null, state: 'pushed', worktree: null,
    prepared_commit: null, iteration: 1, fixes: 0, gate_fixes: 0, gate_tokens: 0, session_id: null,
    mr: { host: 'github', number: 1, url: 'https://github.com/acme/app/pull/1', state: 'merged' }, target_commit: null, mr_attempts: 1, mr_conflict_turn: false, created_at: at, updated_at: at,
  };
}

test('CB-1: without a chain, or with an empty one, the prompt is as before', () => {
  const task = taskText('T-1');
  const decisions = { docs: [{ path: 'docs/adr/0001-example.md', bytes: 2100 }], left_out: 0 };
  const before = checkPrompt('T-1', task, '<rules>\nr\n</rules>', '<skill name="s">\nx\n</skill>', decisions);
  assert.ok(before.includes(DECISION_CHECK_LINES[0]!));
  assert.equal(checkPrompt('T-1', task, '<rules>\nr\n</rules>', '<skill name="s">\nx\n</skill>', decisions, undefined), before);
  assert.equal(checkPrompt('T-1', task, '<rules>\nr\n</rules>', '<skill name="s">\nx\n</skill>', decisions, []), before);
  assert.ok(!before.includes('builds_on_task') && !before.includes('- Builds on:'));
  // The second line as it was.
  assert.equal(before.split('\n')[1], 'The current directory is a checkout of the repository the Task is about, at the Task\'s base: the code the Implementer starts from. Your tools are Read, Grep and Glob, inside this directory only; nothing else is available. The Task file below is all you get of the plan.');
});

test('CB-2: a chain of two sent and one left out: the second line, the Builds on line, the blocks in order before the Task file', () => {
  const task = taskText('T-4', 'T-3');
  const chain: CheckChain = [
    { ticket: 'T-3', path: '.software-factory/T-3.md', text: `${taskText('T-3', 'T-2')}\n\n` },
    { ticket: 'T-2', path: '.software-factory/T-2.md', text: null },
    { ticket: 'T-1', path: '.software-factory/archive/T-1.md', text: taskText('T-1') },
  ];
  const prompt = checkPrompt('T-4', task, '', '', undefined, chain);
  const lines = prompt.split('\n');
  assert.equal(lines[1], 'The current directory is a checkout of the repository the Task is about, at the Task\'s base. The Implementer does not start from it: this Task builds on T-3, T-2, T-1 (`builds_on` in the front matter), whose change is not merged yet, and the Implementer starts from the code that change leaves. Your tools are Read, Grep and Glob, inside this directory only; nothing else is available. The Task file below and the Task files it builds on (the <builds_on_task> blocks) are all you get of the plan.');
  const codebase = lines.findIndex((line) => line.startsWith('- Codebase:'));
  assert.equal(lines[codebase + 1], '- Builds on: what a <builds_on_task> block says its Task creates, changes or removes counts as code the Implementer starts from, under the names the block gives, though the repository does not hold it yet. Check this Task\'s claims about that code against the block, and its other claims against the repository. A claim a block contradicts is a `contradiction`, with the block\'s ticket and section in where. A name this Task relies on that neither the repository nor a block introduces is `missing`. The blocks are context: report no finding about a block\'s own Task, which has its own check. The Task files of T-2 did not fit here: take what this Task says they introduce as given.');
  assert.ok(lines[codebase + 2]!.startsWith('- Zoom out:'));
  const blocks = [
    '<builds_on_task ticket="T-3" path=".software-factory/T-3.md">', taskText('T-3', 'T-2').trimEnd(), '</builds_on_task>', '',
    '<builds_on_task ticket="T-1" path=".software-factory/archive/T-1.md">', taskText('T-1').trimEnd(), '</builds_on_task>', '',
    '<task_file path=".software-factory/T-4.md">',
  ].join('\n');
  assert.ok(prompt.includes(`\n\n${blocks}\n`), prompt);
  assert.ok(!prompt.includes('ticket="T-2"'));
  assert.equal(prompt.split('<task_file').length, 2);
  // Without a left-out Task the Builds on line ends with its own last sentence.
  const all = checkPrompt('T-4', task, '', '', undefined, [chain[0]!]).split('\n');
  assert.ok(all[all.findIndex((line) => line.startsWith('- Builds on:'))]!.endsWith('which has its own check.'));
});

test('CB-3: buildsOnChain follows the Task files nearest first, reads the archive, and ends at a Task it cannot use or a cycle', async () => {
  const t1 = taskText('T-1');
  const t2 = taskText('T-2', 'T-1');
  const t3 = taskText('T-3', 'T-2');
  const { repo, workspace, jobs } = await checkEnv('chain-walk', { 'T-1': t1, 'T-2': t2, 'T-3': t3 });
  const dir = join(repo, '.software-factory');
  const entry = (ticket: string, text: string, archived = false) => ({ ticket, text, sha256: taskSha256(text), archived, problem: null });
  assert.deepEqual(await buildsOnChain(workspace, 'T-3', t3), { tasks: [entry('T-2', t2), entry('T-1', t1)], problem: null });
  // The archived copy, when the active file is gone.
  await mkdir(join(dir, 'archive'), { recursive: true });
  await rename(join(dir, 'T-1.md'), join(dir, 'archive', 'T-1.md'));
  assert.deepEqual(await buildsOnChain(workspace, 'T-3', t3), { tasks: [entry('T-2', t2), entry('T-1', t1, true)], problem: null });
  assert.deepEqual(chainLines(await buildsOnChain(workspace, 'T-3', t3)), [`builds_on T-2:${taskSha256(t2)}`, `builds_on T-1:${taskSha256(t1)}`]);

  // A ticket with no Task file, a skeleton, a Task that is not valid: the chain ends there.
  const missing = await buildsOnChain(workspace, 'A-1', taskText('A-1', 'NONE-1'));
  assert.deepEqual(missing, { tasks: [{ ticket: 'NONE-1', text: null, sha256: null, archived: false, problem: 'missing' }], problem: null });
  assert.deepEqual(chainLines(missing), ['builds_on NONE-1:missing']);
  const skeleton = draftContent('S-1', 'Skeleton', 'main');
  await writeFile(join(dir, 'S-1.md'), skeleton);
  assert.deepEqual(await buildsOnChain(workspace, 'A-2', taskText('A-2', 'S-1')), {
    tasks: [{ ticket: 'S-1', text: skeleton, sha256: taskSha256(skeleton), archived: false, problem: 'draft' }], problem: null,
  });
  await writeFile(join(dir, 'V-1.md'), 'no front matter here\n');
  const invalid = await buildsOnChain(workspace, 'A-3', taskText('A-3', 'V-1'));
  assert.deepEqual(invalid, { tasks: [{ ticket: 'V-1', text: null, sha256: null, archived: false, problem: 'invalid' }], problem: null });
  assert.deepEqual(chainLines(invalid), ['builds_on V-1:invalid']);
  // A name that is no ticket key is invalid without a read.
  assert.deepEqual((await buildsOnChain(workspace, 'A-4', taskText('A-4', '../x'))).tasks.map((item) => item.problem), ['invalid']);

  // T-2 → T-3 → T-2: a cycle, the repeat not appended.
  const c2 = taskText('C-2', 'C-3');
  const c3 = taskText('C-3', 'C-2');
  await writeTask(workspace, 'C-2', c2, jobs);
  await writeTask(workspace, 'C-3', c3, jobs);
  const cycle = await buildsOnChain(workspace, 'C-2', c2);
  assert.deepEqual([cycle.tasks.map((item) => item.ticket), cycle.problem], [['C-3'], 'cycle']);
  assert.deepEqual(chainLines(cycle), [`builds_on C-3:${taskSha256(c3)}`, 'builds_on:cycle']);

  // No builds_on: an empty chain, nothing read (the checkout does not even exist).
  const nowhere: Workspace = { name: 'app', readCheckout: join(temp, 'nowhere'), workCheckout: join(temp, 'nowhere') };
  assert.deepEqual(await buildsOnChain(nowhere, 'T-1', t1), { tasks: [], problem: null });
  assert.deepEqual(chainLines({ tasks: [], problem: null }), []);
});

test('buildsOnChain stops past MAX_SLICES Tasks with too_long', async () => {
  const tasks: Record<string, string> = {};
  for (let index = 1; index <= MAX_SLICES + 1; index += 1) {
    tasks[`L-${index}`] = taskText(`L-${index}`, index <= MAX_SLICES ? `L-${index + 1}` : undefined);
  }
  const { env, workspace } = await checkEnv('chain-long', tasks);
  const long = await buildsOnChain(workspace, 'L-0', taskText('L-0', 'L-1'));
  assert.deepEqual([long.tasks.length, long.problem], [MAX_SLICES, 'too_long']);
  assert.equal(chainLines(long).at(-1), 'builds_on:too_long');
  // Exactly MAX_SLICES Tasks is a whole chain.
  const whole = await buildsOnChain(workspace, 'L-1', tasks['L-1']!);
  assert.deepEqual([whole.tasks.length, whole.problem], [MAX_SLICES, null]);
  const sent = await checkChain(env.state, workspace, 'L-0', long);
  assert.deepEqual(sent, { error: `The builds_on chain of L-0 is longer than ${MAX_SLICES} Tasks.` });
});

test('CB-4: the check sha256 folds the chain in; a changed Task file in the chain changes it, its archiving does not', async () => {
  const task = taskText('T-1');
  assert.equal(taskCheckSha256(task, [], []), taskSha256(task));
  assert.equal(taskCheckSha256(task, []), taskSha256(task));
  assert.notEqual(taskCheckSha256(task, [], ['builds_on T-0:missing']), taskSha256(task));
  const image = [{ name: '1.png', sha256: 'a'.repeat(64) }];
  assert.equal(taskCheckSha256(task, image, []), taskCheckSha256(task, image));
  assert.notEqual(taskCheckSha256(task, image, ['builds_on T-0:missing']), taskCheckSha256(task, image));

  const t1 = taskText('T-1');
  const t2 = taskText('T-2', 'T-1');
  const { repo, workspace, jobs } = await checkEnv('chain-sha', { 'T-1': t1, 'T-2': t2 });
  const first = await currentCheckSha256(workspace, 'T-2', t2);
  assert.equal(first, taskCheckSha256(t2, [], [`builds_on T-1:${taskSha256(t1)}`]));
  assert.notEqual(first, taskSha256(t2));
  await writeTask(workspace, 'T-1', taskText('T-1', undefined, 'Greet the reader twice.'), jobs);
  const changed = await currentCheckSha256(workspace, 'T-2', t2);
  assert.notEqual(changed, first);
  const dir = join(repo, '.software-factory');
  await mkdir(join(dir, 'archive'), { recursive: true });
  await rename(join(dir, 'T-1.md'), join(dir, 'archive', 'T-1.md'));
  assert.equal(await currentCheckSha256(workspace, 'T-2', t2), changed);
});

test('CB-5: sf check-task on T-3 of T-3 → T-2 → T-1 with T-1 merged sends T-2 only and records the chain', async () => {
  const t1 = taskText('T-1');
  const t2 = taskText('T-2', 'T-1');
  const t3 = taskText('T-3', 'T-2');
  const { env, workspace, jobs } = await checkEnv('chain-cli', { 'T-1': t1, 'T-2': t2, 'T-3': t3 });
  await jobs.write(mergedJob('T-1'));
  await reviewScript(env, [{ output: OUTPUT }]);

  const run = await runCli(env, ['check-task', 'app', 'T-3']);
  assert.equal(run.code, 0, run.stderr);
  const [entry] = await reviewLog(env);
  assert.equal(entry!.prompt, checkPrompt('T-3', t3, '', '', undefined, [{ ticket: 'T-2', path: '.software-factory/T-2.md', text: t2 }]));
  const sha = await currentCheckSha256(workspace, 'T-3', t3);
  const stored = await new CheckStore(env.state).read('app', 'T-3', sha);
  assert.equal(stored?.status, 'checked');
  assert.deepEqual(stored?.builds_on, [{ ticket: 'T-2', sha256: taskSha256(t2), how: 'sent' }, { ticket: 'T-1', sha256: taskSha256(t1), how: 'merged' }]);
  assert.equal(run.stdout.split('\n')[1], 'Builds on: T-2 (sent), T-1 (merged)');

  // The whole chain merged: the prompt is as for a Task without builds_on.
  await jobs.write(mergedJob('T-2'));
  await reviewScript(env, [{ output: OUTPUT }]);
  const again = await runCli(env, ['check-task', 'app', 'T-3']);
  assert.equal(again.code, 0, again.stderr);
  assert.equal((await reviewLog(env)).at(-1)!.prompt, checkPrompt('T-3', t3));
});

test('CB-6: a Task that builds on a ticket with no Task file, a skeleton or a Task that is not valid fails its check; no session runs', async () => {
  const { env, repo, workspace } = await checkEnv('chain-unusable', { 'A-1': taskText('A-1', 'NONE-1'), 'A-2': taskText('A-2', 'S-1'), 'A-3': taskText('A-3', 'V-1') });
  await writeFile(join(repo, '.software-factory', 'S-1.md'), draftContent('S-1', 'Skeleton', 'main'));
  await writeFile(join(repo, '.software-factory', 'V-1.md'), 'no front matter here\n');
  await reviewScript(env, [{ output: OUTPUT }]);
  const cases = [
    ['A-1', 'A-1 builds on NONE-1, which has no Task file.'],
    ['A-2', 'A-2 builds on S-1, whose Task file is still the skeleton.'],
    ['A-3', 'A-3 builds on V-1, whose Task file is not valid.'],
  ] as const;
  for (const [ticket, message] of cases) {
    const run = await runCli(env, ['check-task', 'app', ticket]);
    assert.equal(run.code, 1, ticket);
    const text = await readFile(join(repo, '.software-factory', `${ticket}.md`), 'utf8');
    const stored = await new CheckStore(env.state).read('app', ticket, await currentCheckSha256(workspace, ticket, text));
    assert.deepEqual([stored?.status, stored?.error, stored?.builds_on], ['failed', message, undefined], ticket);
    assert.ok(run.stdout.includes(message), run.stdout);
  }
  // No session ran: the fake Claude never wrote its log.
  assert.equal(existsSync(join(env.home, 'fake-review.log')), false);
});

test('CB-7: a chain that comes back to itself fails its check with the cycle message; no session runs', async () => {
  const t2 = taskText('T-2', 'T-3');
  const { env, workspace } = await checkEnv('chain-cycle', { 'T-2': t2, 'T-3': taskText('T-3', 'T-2') });
  await reviewScript(env, [{ output: OUTPUT }]);
  const run = await runCli(env, ['check-task', 'app', 'T-2']);
  assert.equal(run.code, 1);
  const stored = await new CheckStore(env.state).read('app', 'T-2', await currentCheckSha256(workspace, 'T-2', t2));
  assert.deepEqual([stored?.status, stored?.error], ['failed', 'The builds_on chain of T-2 comes back to a ticket it already holds: T-2 → T-3.']);
  assert.equal(existsSync(join(env.home, 'fake-review.log')), false);
});

test('CB-8: checkChain sends whole Tasks within the cap, leaves out one that does not fit and still tries the next', async () => {
  const t1 = taskText('T-1');
  const t2 = taskText('T-2', 'T-1', 'A long body. '.repeat(50));
  const t3 = taskText('T-3', 'T-2');
  const { env, workspace } = await checkEnv('chain-cap', { 'T-1': t1, 'T-2': t2, 'T-3': t3 });
  const chain = await buildsOnChain(workspace, 'T-4', taskText('T-4', 'T-3'));
  const cap = Buffer.byteLength(t3.trimEnd()) + Buffer.byteLength(t1.trimEnd());
  assert.deepEqual(await checkChain(env.state, workspace, 'T-4', chain, cap), {
    chain: [
      { ticket: 'T-3', path: '.software-factory/T-3.md', text: t3 },
      { ticket: 'T-2', path: '.software-factory/T-2.md', text: null },
      { ticket: 'T-1', path: '.software-factory/T-1.md', text: t1 },
    ],
    record: [
      { ticket: 'T-3', sha256: taskSha256(t3), how: 'sent' },
      { ticket: 'T-2', sha256: taskSha256(t2), how: 'left_out' },
      { ticket: 'T-1', sha256: taskSha256(t1), how: 'sent' },
    ],
  });
  // With the default cap all three are sent.
  const all = await checkChain(env.state, workspace, 'T-4', chain);
  assert.ok(!('error' in all) && all.chain.every((item) => item.text !== null));
});

test('CB-9: the view of a checked T-2 is stale once the Task file of T-1 changes', async () => {
  const t2 = taskText('T-2', 'T-1');
  const { env, workspace, jobs } = await checkEnv('chain-stale', { 'T-1': taskText('T-1'), 'T-2': t2 });
  const checks = new TaskChecks({
    resolve: async () => workspace, claudePath: undefined, sandbox: undefined, model: undefined, maxTurns: 1, rulesMaxBytes: 49152, stateDir: env.state, configDir: env.config, worktreeRoot: join(env.state, 'worktrees'),
  });
  const at = new Date().toISOString();
  await checks.store.write({
    workspace: 'app', ticket: 'T-2', sha256: await currentCheckSha256(workspace, 'T-2', t2), commit: 'c'.repeat(40), status: 'checked', output: OUTPUT, error: null,
    model: 'fake-model', cost_usd: 0.01, started_at: at, ended_at: at,
  });
  assert.equal((await checks.view('app', 'T-2')).stale, false);
  await writeTask(workspace, 'T-1', taskText('T-1', undefined, 'Greet the reader twice.'), jobs);
  assert.equal((await checks.view('app', 'T-2')).stale, true);
});

test('CB-10: checkLines prints the Builds on line second when the record has builds_on, and none without', () => {
  const at = '2026-11-15T10:00:00.000Z';
  const base: CheckRecord = {
    workspace: 'app', ticket: 'T-3', sha256: 'a'.repeat(64), commit: 'c'.repeat(40), status: 'checked', output: OUTPUT, error: null,
    model: 'fake-model', cost_usd: 0.01, started_at: at, ended_at: at,
  };
  const builds = [{ ticket: 'T-2', sha256: 'b'.repeat(64), how: 'sent' as const }, { ticket: 'T-1', sha256: null, how: 'merged' as const }];
  assert.equal(checkLines({ ...base, builds_on: builds })[1], 'Builds on: T-2 (sent), T-1 (merged)');
  const failed: CheckRecord = { ...base, status: 'failed', output: null, error: 'The check ended with error_max_turns: limit', builds_on: builds };
  assert.equal(checkLines(failed)[1], 'Builds on: T-2 (sent), T-1 (merged)');
  assert.equal(checkLines({ ...base, builds_on: [{ ticket: 'T-2', sha256: null, how: 'left_out' }] })[1], 'Builds on: T-2 (left out)');
  assert.ok(!checkLines(base).some((line) => line.startsWith('Builds on:')));
  assert.ok(!checkLines({ ...base, status: 'failed', output: null, error: 'x' }).some((line) => line.startsWith('Builds on:')));
});
