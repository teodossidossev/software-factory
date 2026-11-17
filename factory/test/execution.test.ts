// End-to-end execution tests: the real `sf serve` and `sf` CLI with private config and state
// directories, throwaway Git repositories and the fake Claude Code (test/support/fake-claude.ts)
// as the Implementer executable. Tools are driven through the official MCP client. Since SF-019
// every job works in a worktree of the checkout, Clean prepares the branch, and several jobs of a
// workspace run at once. The Implementer's session is test/execution-sessions.test.ts's; the sandbox
// placeholders, the Task's scope, sensitive paths, images, the Fix round limit and the cloud
// credentials are test/execution-guards.test.ts's (split so that no file runs near run-tests'
// per-file limit).
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { Execution } from '../src/execution.js';
import { type Job, type JobState, JobStore } from '../src/jobs.js';
import { QueueStore } from '../src/queue.js';
import { resolveWorkspace } from '../src/registry.js';
import { FACTORY_PROMPT_RULES } from '../src/prompts.js';
import { taskSha256 } from '../src/task-file.js';
import {
  call, FAKE, fakeLog, git, newEnv, newRepo, putRules, putTask, readyCheck, refused, runCli, script, serve, stop, task, temp, turnsStarted,
  jobPrompt, waitFor,
} from './support/harness.js';

function mrText(header: string): string {
  return [
    header, '',
    '## What', 'Changes the README.', '## Why', 'The ticket asks for it.', '## How', 'One line.', '## Why the change', 'Readers need it.',
    '## Special things to note', '- None.', '## Change outline', '- README.md', '## Testing', 'npm test: passed', '## Screenshots', 'N/A',
    '## Checklist', '- [x] Branch name', '- [x] Target branch', '',
  ].join('\n');
}

// The checkout's working tree and index as one string, to compare before and after a job.
function treeState(repo: string): string {
  return [git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), git(repo, 'rev-parse', 'HEAD'), git(repo, 'status', '--porcelain', '--untracked-files=all').replace(/^\?\? \.software-factory\/.*\n/gm, '')].join('|');
}

test('full cycle in a worktree: start, awaiting_review with Report, Patch and files, request_fix, Clean prepares the branch, approve pushes; the checkout is untouched', async () => {
  // SF_SMOKE_PROBE_ALLOW (SF-104) set by the user: a real install's state directory ignores it.
  const env = await newEnv('cycle', { CLAUDE_CODE_SESSION_ID: 'outer', CLAUDE_CODE_CHILD_SESSION: '1', ANTHROPIC_API_KEY: 'test-key', SF_SMOKE_PROBE_ALLOW: 'node probe.mjs > probe.json' });
  const repo = await newRepo(env, 'cycle-repo', true);
  await putTask(env, repo, 'DEMO-1', 'Export as CSV!');
  await script(env, [
    {
      tool: true,
      denials: ['Bash'],
      text: '# Report: DEMO-1, iteration 1\n\n## Done\nChanged the README.',
      write: { 'README.md': 'hello world\n', 'src/new.ts': 'export {};\n', 'debug.log': 'ignored\n' },
    },
    { costTotal: 0.05, text: '# Report: DEMO-1, iteration 2\n\n## Fix 1 items\n| 1 | x | fixed | |', write: { 'src/new.ts': 'export const x = 1;\n' } },
    // The MR text turn at Clean: the factory commits and rebases.
    { write: { '.software-factory/DEMO-1.mr.md': mrText('feat(DEMO-1): Export as CSV') }, text: '# Report: DEMO-1, MR preparation 1\n\n## Done\nWrote the MR text.' },
  ]);
  const before = treeState(repo);
  const served = await serve(env);

  const started = await call(served, 'start', { workspace: 'app', ticket: 'DEMO-1' });
  const worktree = join(env.state, 'worktrees', 'app', 'DEMO-1');
  assert.deepEqual(started, { branch: 'DEMO-1-export-as-csv', state: 'working', check_after_minutes: 15, worktree });
  assert.equal((await refused(served, 'write_task', { workspace: 'app', ticket: 'DEMO-1', content: task('DEMO-1', 'Other') })).code, 'job_active');
  // The worktree is on the branch at origin/main, with the Task file copied in; the checkout stays on main.
  assert.equal(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'DEMO-1-export-as-csv');
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'origin/main'));
  assert.equal(await readFile(join(worktree, '.software-factory', 'DEMO-1.md'), 'utf8'), task('DEMO-1', 'Export as CSV!'));
  assert.equal(treeState(repo), before);
  assert.ok(git(repo, 'worktree', 'list').includes(worktree));

  const first = await waitFor(served, 'DEMO-1', 'awaiting_review', 1);
  assert.equal(first.branch, 'DEMO-1-export-as-csv');
  assert.equal(first.check_after_minutes, null);
  assert.match(first.report, /^# Report: DEMO-1, iteration 1\n/);
  assert.match(first.report, /\n## Changed files\n\n\| Path \| Added \| Removed \|\n\|---\|---\|---\|\n\| README\.md \| 1 \| 1 \|\n\| src\/new\.ts \| 1 \| 0 \|\n/);
  assert.match(first.report, /\n## Denied actions\n\n- Bash\n$/);
  assert.doesNotMatch(first.report, /secret-input|### Sensitive|### Deleted/);
  assert.deepEqual(first.files, { sensitive: [], deleted: [] });
  const patch = first.patch;
  assert.equal(patch.offset, 0);
  assert.equal(patch.next_offset, null);
  assert.match(patch.text, /^diff --git a\/README\.md b\/README\.md\n/);
  assert.match(patch.text, /\+\+\+ b\/src\/new\.ts/);
  assert.doesNotMatch(patch.text, /debug\.log|\.software-factory/);
  const page = await call(served, 'check', { workspace: 'app', ticket: 'DEMO-1', max_bytes: 64 });
  assert.deepEqual([page.patch.offset, page.patch.next_offset, page.patch.sha256], [0, 64, patch.sha256]);
  const next = await call(served, 'check', { workspace: 'app', ticket: 'DEMO-1', offset: 64, max_bytes: 64 });
  assert.equal(next.patch.text, patch.text.slice(64, 128));

  // The files were written in the worktree, never in the checkout.
  assert.equal(await readFile(join(worktree, 'README.md'), 'utf8'), 'hello world\n');
  assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'hello\n');
  assert.equal(treeState(repo), before);
  const jobDir = join(env.state, 'jobs', 'app', 'DEMO-1');
  const meta = JSON.parse(await readFile(join(jobDir, 'iterations', '001', 'meta.json'), 'utf8'));
  // SF-059: a repository without rule files gives no block (the prompts below are today's) and an empty list.
  assert.equal(await readFile(join(jobDir, 'rules.md'), 'utf8'), '');
  assert.deepEqual(JSON.parse(await readFile(join(jobDir, 'iterations', '001', 'rules.json'), 'utf8')).files, []);
  assert.deepEqual([meta.iteration, meta.denials, meta.patch_truncated, meta.submodule_changed, meta.cost_usd, meta.cost_usd_total], [1, ['Bash'], false, [], 0.0123, 0.0123]);
  // The branch tracks nothing, so a later push cannot go to origin/main by accident.
  assert.throws(() => git(repo, 'config', '--get', 'branch.DEMO-1-export-as-csv.remote'));
  assert.deepEqual(meta.changed_files, [{ path: 'README.md', added: 1, removed: 1 }, { path: 'src/new.ts', added: 1, removed: 0 }]);
  // The structured file list (SF-024): status, sensitivity and counts.
  assert.deepEqual(meta.files, [
    { path: 'README.md', status: 'modified', sensitive: 'no', scope: 'none', additions: 1, deletions: 1 },
    { path: 'src/new.ts', status: 'added', sensitive: 'no', scope: 'none', additions: 1, deletions: 0 },
  ]);

  const fix = await call(served, 'request_fix', { workspace: 'app', ticket: 'DEMO-1', content: '1. src/new.ts: export a value.' });
  assert.deepEqual(fix, { iteration: 2, check_after_minutes: 5 });
  const taskText = await readFile(join(repo, '.software-factory', 'DEMO-1.md'), 'utf8');
  assert.equal(taskText, `${task('DEMO-1', 'Export as CSV!')}\n\n## Fix 1\n\n1. src/new.ts: export a value.\n`);
  // SF-081: the Fix section is recorded in the ticket's history, by the factory, with its number and
  // the sha256 of the text it left.
  const fixRecord = JSON.parse((await readFile(join(env.state, 'tickets', 'app', 'DEMO-1', 'history.jsonl'), 'utf8')).trimEnd().split('\n').at(-1)!);
  assert.deepEqual([fixRecord.kind, fixRecord.by, fixRecord.fix, fixRecord.sha256], ['fix_added', 'factory', 1, taskSha256(taskText)]);
  const second = await waitFor(served, 'DEMO-1', 'awaiting_review', 2);
  assert.match(second.report, /^# Report: DEMO-1, iteration 2\n/);
  assert.doesNotMatch(second.report, /Denied actions/);
  assert.match(second.patch.text, /\+export const x = 1;/);
  // The Fix section reached the worktree's copy before the turn.
  assert.equal(await readFile(join(worktree, '.software-factory', 'DEMO-1.md'), 'utf8'), taskText);

  let log = await fakeLog(env);
  assert.deepEqual(log.map((entry) => entry.prompt), [
    await jobPrompt(env, '/implement .software-factory/DEMO-1.md', 'DEMO-1', 1),
    await jobPrompt(env, '/implement .software-factory/DEMO-1.md Fix 1', 'DEMO-1', 2),
  ]);
  assert.deepEqual(log.map((entry) => entry.cwd), [worktree, worktree]);
  assert.match(log[0]!.prompt, /^\/implement \.software-factory\/DEMO-1\.md\n\nRules from the Software Factory:\n/);
  assert.match(log[1]!.prompt, /  # Report: DEMO-1, iteration 2\n/);
  const meta2 = JSON.parse(await readFile(join(jobDir, 'iterations', '002', 'meta.json'), 'utf8'));
  assert.deepEqual([meta2.cost_usd, meta2.cost_usd_total], [0.0377, 0.05]);
  assert.equal(log[1]!.sessionId, log[0]!.sessionId);
  assert.ok(log[1]!.argv.includes(`--resume=${log[0]!.sessionId}`));
  for (const flag of ['--permission-mode=auto', '--setting-sources=user,project', '--max-turns=150']) {
    assert.ok(log[1]!.argv.includes(flag), flag);
  }
  // A real job's query() options carry no allowedTools (SF-104), and its mode is auto.
  for (const entry of log) {
    assert.ok(entry.argv.includes('--permission-mode=auto'));
    assert.deepEqual(entry.argv.filter((arg) => arg.startsWith('--allowedTools')), []);
  }
  assert.ok(log[0]!.argv.some((arg) => arg.startsWith('--disallowedTools=') && arg.includes('Bash(git commit:*)') && arg.includes('Read(**/.env)')));
  assert.ok(log[0]!.env.includes('ANTHROPIC_API_KEY'));
  for (const name of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'SF_STATE_DIR', 'SF_CLAUDE']) {
    assert.ok(!log[0]!.env.includes(name), name);
  }
  let job = JSON.parse(await readFile(join(jobDir, 'job.json'), 'utf8'));
  // SF-065: a Task file without an image reference gives no image block, no attachments record and
  // no attachments event.
  assert.ok(log.every((entry) => entry.blocks === undefined));
  assert.equal(job.attachments, undefined);
  assert.doesNotMatch(await readFile(join(jobDir, 'events.jsonl'), 'utf8'), /"attachments"|"images"/);
  assert.equal(job.session_id, log[0]!.sessionId);
  assert.equal(job.worktree, worktree);

  // approve is not available before Clean: the branch is prepared at Clean.
  assert.equal((await runCli(env, ['approve', 'app', 'DEMO-1'])).code, 1);
  // Clean: the MR preparation turn runs in the worktree, then the branch holds one commit on top
  // of origin/main; the worktree stays until the push (SF-073), with the branch checked out.
  assert.deepEqual(await call(served, 'mark_clean', { workspace: 'app', ticket: 'DEMO-1' }), { state: 'preparing_mr', iteration: 2, branch: 'DEMO-1-export-as-csv' });
  const clean = await waitFor(served, 'DEMO-1', 'ready_for_human_review', 2);
  assert.deepEqual([clean.report, clean.patch.sha256, clean.mr], [second.report, second.patch.sha256, mrText('feat(DEMO-1): Export as CSV')]);
  assert.ok((await stat(worktree)).isDirectory());
  assert.ok(git(repo, 'worktree', 'list').includes(worktree));
  assert.equal(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'DEMO-1-export-as-csv');
  assert.equal(git(repo, 'rev-list', '--count', 'origin/main..DEMO-1-export-as-csv').trim(), '1');
  assert.equal(git(repo, 'log', '-1', '--format=%s', 'DEMO-1-export-as-csv').trim(), 'feat(DEMO-1): Export as CSV');
  assert.equal(git(repo, 'show', 'DEMO-1-export-as-csv:src/new.ts'), 'export const x = 1;\n');
  assert.equal(treeState(repo), before);
  job = JSON.parse(await readFile(join(jobDir, 'job.json'), 'utf8'));
  assert.deepEqual([job.worktree, job.prepared_commit, job.base_commit, job.target_commit], [worktree, git(repo, 'rev-parse', 'DEMO-1-export-as-csv').trim(), git(repo, 'rev-parse', 'origin/main').trim(), git(repo, 'rev-parse', 'origin/main').trim()]);
  log = await fakeLog(env);
  assert.equal(log.length, 3);
  assert.match(log[2]!.prompt, /^MR preparation for DEMO-1 on branch DEMO-1-export-as-csv\./);
  assert.equal(log[2]!.cwd, worktree);
  // The branch is in the checkout's repository (the kept worktree holds it); the checkout itself
  // is still on main.
  assert.equal(git(repo, 'show', 'DEMO-1-export-as-csv:src/new.ts'), 'export const x = 1;\n');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');

  const watched = await runCli(env, ['watch', 'app', 'DEMO-1', '--once']);
  assert.equal(watched.code, 0, watched.stderr);
  const lines = watched.stdout;
  assert.match(lines, /^\d\d:\d\d:\d\d \[0\] state - -> starting$/m);
  assert.match(lines, /\[1\] > \/implement \.software-factory\/DEMO-1\.md$/m);
  assert.match(lines, /\[1\] tool_use Bash \{"command":"npm test","description":"Run the tests"\}$/m);
  assert.match(lines, /\[1\] state working -> awaiting_review$/m);
  assert.match(lines, /\[2\] state awaiting_review -> preparing_mr$/m);
  assert.match(lines, /\[2\] state preparing_mr -> ready_for_human_review$/m);

  const status = await runCli(env, ['status']);
  assert.match(status.stdout, /^WORKSPACE\s+TICKET\s+STATE\s+ITER\s+BRANCH\s+SINCE\s+EST_USD\s+ELAPSED\s+ERROR\napp\s+DEMO-1\s+ready_for_human_review\s+2\s+DEMO-1-export-as-csv\s+\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\s+0\.0500\s+\d{2,}:\d\d:\d\d\s*$/m);
  const one = await runCli(env, ['status', 'app', 'DEMO-1']);
  assert.match(one.stdout, /\nsensitive: none\ndeleted: none\n$/);
  assert.equal((await refused(served, 'write_task', { workspace: 'app', ticket: 'DEMO-1', content: task('DEMO-1', 'Other') })).code, 'job_active');

  // approve: the push, nothing else; the branch lands in origin as prepared.
  const approved = await runCli(env, ['approve', 'app', 'DEMO-1']);
  assert.equal(approved.code, 0, approved.stdout + approved.stderr);
  assert.match(approved.stdout, /^state: pushed\nbranch: DEMO-1-export-as-csv\ntitle: feat\(DEMO-1\): Export as CSV$/m);
  assert.equal(git(join(temp, 'cycle-repo-origin.git'), 'rev-parse', 'DEMO-1-export-as-csv').trim(), job.prepared_commit);
  assert.equal((await fakeLog(env)).length, 3);
  assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'DEMO-1' })).state, 'pushed');
  // The push removed the worktree.
  await assert.rejects(stat(worktree), { code: 'ENOENT' });
  assert.ok(!git(repo, 'worktree', 'list').includes(worktree));
  assert.equal((await new JobStore(env.state).read('app', 'DEMO-1'))!.worktree, null);
  assert.equal(treeState(repo), before);
  await stop(served);
  await assert.rejects(stat(join(env.state, 'sf.sock')), { code: 'ENOENT' });
  assert.match((await runCli(env, ['status', 'app', 'DEMO-1'])).stdout, /pushed/);
});

test('coding rules (SF-059): the first prompt gives the <rules> block after /implement, a later turn does not; rules.md and rules.json once at Start, at the base commit, copied into each iteration; without rules.md a job gets none', async () => {
  const env = await newEnv('exec-rules');
  const repo = await newRepo(env, 'exec-rules-repo', true);
  const block = await putRules(env, repo);
  const base = git(repo, 'rev-parse', 'origin/main').trim();
  await putTask(env, repo, 'K-1', 'Follow the rules');
  const jobDir = join(env.state, 'jobs', 'app', 'K-1');
  await script(env, [
    // The job edits a rule in its worktree: the rules it was given stay as at the base commit.
    { write: { 'README.md': 'hello rules\n', 'docs/style.md': '# Style\n\nAnything goes.\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello again\n' }, text: 'Report of iteration 2' },
    { write: { 'README.md': 'hello three\n' }, text: 'Report of iteration 3' },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'K-1' });
    await waitFor(served, 'K-1', 'awaiting_review', 1);
    assert.equal(await readFile(join(jobDir, 'rules.md'), 'utf8'), block);
    const list = JSON.parse(await readFile(join(jobDir, 'rules.json'), 'utf8'));
    assert.deepEqual([list.commit, list.max_bytes, list.left_out, list.skipped], [base, 48 * 1024, [], []]);
    assert.deepEqual(list.files.map((file: { source: string; path: string }) => `${file.source}: ${file.path}`), ['repository: AGENTS.md', 'repository: docs/style.md', 'workspace: rules/app.md']);
    assert.deepEqual(JSON.parse(await readFile(join(jobDir, 'iterations', '001', 'rules.json'), 'utf8')), list);
    await call(served, 'request_fix', { workspace: 'app', ticket: 'K-1', content: '1. README.md: again.' });
    await waitFor(served, 'K-1', 'awaiting_review', 2);
    assert.deepEqual(JSON.parse(await readFile(join(jobDir, 'iterations', '002', 'rules.json'), 'utf8')), list);
    // A job started before SF-059 has no rules.md: no block, no iterations/NNN/rules.json.
    await rm(join(jobDir, 'rules.md'));
    await call(served, 'request_fix', { workspace: 'app', ticket: 'K-1', content: '1. README.md: once more.' });
    await waitFor(served, 'K-1', 'awaiting_review', 3);
    await assert.rejects(stat(join(jobDir, 'iterations', '003', 'rules.json')), { code: 'ENOENT' });
    const log = await fakeLog(env);
    assert.deepEqual(log.map((entry) => entry.prompt), [
      await jobPrompt(env, `/implement .software-factory/K-1.md\n\n${block}`, 'K-1', 1),
      await jobPrompt(env, '/implement .software-factory/K-1.md Fix 1', 'K-1', 2),
      await jobPrompt(env, '/implement .software-factory/K-1.md Fix 2', 'K-1', 3),
    ]);
    assert.ok(log[0]!.prompt.includes('\n\n### repository: docs/style.md\n\n# Style\n\nName things plainly.\n'));
  } finally {
    await stop(served);
  }
});

test('coding rules (SF-059): a Start whose rules cannot be collected fails without an Implementer session; once fixed, sf restart starts it with them', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root reads any file');
    return;
  }
  const env = await newEnv('exec-rules-failed');
  const repo = await newRepo(env, 'exec-rules-failed-repo', false);
  const block = await putRules(env, repo);
  await putTask(env, repo, 'K-2', 'Rules or nothing');
  await script(env, [{ write: { 'README.md': 'hello rules\n' }, text: 'Report of iteration 1' }]);
  const ownRules = join(env.config, 'rules', 'app.md');
  await chmod(ownRules, 0o000);
  const served = await serve(env);
  try {
    const failure = await refused(served, 'start', { workspace: 'app', ticket: 'K-2' });
    assert.deepEqual(failure, { code: 'rules_failed', message: 'The rules file rules/app.md could not be read (EACCES). Fix it, then sf restart the ticket.' });
    const job = (await new JobStore(env.state).read('app', 'K-2'))!;
    assert.deepEqual([job.state, job.error?.code], ['failed', 'rules_failed']);
    await assert.rejects(stat(join(env.state, 'jobs', 'app', 'K-2', 'rules.md')), { code: 'ENOENT' });
    await assert.rejects(stat(join(env.home, 'fake-claude.log')), { code: 'ENOENT' });
    const listed = await runCli(env, ['rules', 'app', 'K-2']);
    assert.equal(listed.stdout, `The job of app/K-2 failed at Start: ${failure.message}\n`);

    await chmod(ownRules, 0o600);
    const restarted = await runCli(env, ['restart', 'app', 'K-2']);
    assert.equal(restarted.code, 0, restarted.stderr);
    await waitFor(served, 'K-2', 'awaiting_review', 1);
    assert.equal((await fakeLog(env))[0]!.prompt, await jobPrompt(env, `/implement .software-factory/K-2.md\n\n${block}`, 'K-2', 1));
  } finally {
    await chmod(ownRules, 0o600);
    await stop(served);
  }
});

test('parallel jobs: three jobs of a workspace run at once in their own worktrees, a fourth queued waits for the run limit and starts by itself when one ends, say and check answer while a turn runs, the checkout is never touched', async () => {
  const env = await newEnv('parallel', { SF_MAX_JOBS: '3' });
  const repo = await newRepo(env, 'parallel-repo', true);
  for (const ticket of ['P-1', 'P-2', 'P-3', 'P-4']) {
    await putTask(env, repo, ticket, `Job ${ticket}`);
  }
  // Each job's first turn: P-1 is slow, so the others start while it runs.
  await script(env, [
    // Long enough for P-2 and P-3 to start and publish, and the check, say and queue calls, while it runs.
    { delayMs: 9000, write: { 'one.txt': '1\n' }, text: 'one' },
    { write: { 'two.txt': '2\n' }, text: 'two' },
    { write: { 'three.txt': '3\n' }, text: 'three' },
    { text: 'one after say' },
  ]);
  const before = treeState(repo);
  const served = await serve(env);
  const worktree = (ticket: string): string => join(env.state, 'worktrees', 'app', ticket);
  await call(served, 'start', { workspace: 'app', ticket: 'P-1' });
  await call(served, 'start', { workspace: 'app', ticket: 'P-2' });
  await call(served, 'start', { workspace: 'app', ticket: 'P-3' });
  // The three first turns have their scripted turn before P-1's say takes the fourth.
  await turnsStarted(env, 3);
  // While P-1's turn runs: check and say on it answer, the other jobs finish.
  assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'P-1' })).state, 'working');
  assert.match((await runCli(env, ['say', 'app', 'P-1', 'also', 'this'])).stdout, /^state: working\nqueued: true$/m);
  // The run queue's limit (SF-071; SF_MAX_JOBS=3 its default) holds P-4 in the queue.
  await readyCheck(env, repo, 'P-4');
  assert.equal((await runCli(env, ['queue', 'add', 'app', 'P-4'])).stdout, 'position: 1\n');
  assert.match((await runCli(env, ['queue', 'list'])).stdout, /^limit: 3 jobs at once\nrunning: 3\n[\s\S]*\n {2}1\. app\/P-4\n$/);
  await waitFor(served, 'P-2', 'awaiting_review', 1);
  await waitFor(served, 'P-3', 'awaiting_review', 1);
  assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'P-1' })).state, 'working');
  const one = await waitFor(served, 'P-1', 'awaiting_review', 1);
  assert.match(one.report, /^one after say\n/);
  for (const [ticket, file] of [['P-1', 'one.txt'], ['P-2', 'two.txt'], ['P-3', 'three.txt']] as const) {
    assert.ok((await stat(join(worktree(ticket), file))).isFile(), ticket);
    assert.equal(git(worktree(ticket), 'rev-parse', '--abbrev-ref', 'HEAD').trim(), `${ticket}-job-${ticket.toLowerCase()}`);
  }
  assert.equal(treeState(repo), before);
  const log = await fakeLog(env);
  assert.deepEqual(new Set(log.map((entry) => entry.cwd)), new Set([worktree('P-1'), worktree('P-2'), worktree('P-3')]));
  // Each job has its own session.
  assert.equal(new Set(log.map((entry) => entry.sessionId)).size, 3);
  // A job ending frees a slot; an abort without discard leaves its worktree and prints its path.
  const aborted = await runCli(env, ['abort', 'app', 'P-3']);
  assert.equal(aborted.code, 0, aborted.stderr);
  assert.match(aborted.stdout, new RegExp(`^state: aborted\\nbranch: P-3-job-p-3\\ndiscarded: false\\nworktree: ${worktree('P-3')}\\nThe branch and its worktree are left as they are: ${worktree('P-3')}$`, 'm'));
  assert.ok((await stat(join(worktree('P-3'), 'three.txt'))).isFile());
  assert.equal(git(repo, 'branch', '--list', 'P-3-job-p-3').replace(/^[+* ]+/, '').trim(), 'P-3-job-p-3');
  // The slot P-3 freed: the queue starts P-4 by itself.
  const jobs = new JobStore(env.state);
  for (const deadline = Date.now() + 20_000; (await jobs.read('app', 'P-4')) === undefined;) {
    assert.ok(Date.now() < deadline, 'P-4 did not start');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.notEqual((await jobs.read('app', 'P-4'))!.state, 'failed');
  assert.match((await runCli(env, ['queue', 'list'])).stdout, /\nqueue: empty\n$/);
  // A stale worktree directory of a ticket makes the next start worktree_exists; reset removes it.
  assert.equal((await runCli(env, ['reset', 'app', 'P-3'])).code, 0);
  assert.equal((await runCli(env, ['abort', 'app', 'P-2'])).code, 0);
  await assert.rejects(stat(worktree('P-3')), { code: 'ENOENT' });
  await mkdir(worktree('P-3'), { recursive: true });
  git(repo, 'branch', '-q', '-D', 'P-3-job-p-3');
  const stale = await refused(served, 'start', { workspace: 'app', ticket: 'P-3' });
  assert.equal(stale.code, 'worktree_exists');
  assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'P-3' })).state, 'failed');
  await rm(worktree('P-3'), { recursive: true });
  await stop(served);
});

test('the queue\'s own start counts the running jobs of every workspace against max_running (job_limit); a paused job and the jobs that wait for the user do not count', async () => {
  const env = await newEnv('queued-limit');
  const repo = await newRepo(env, 'queued-limit-repo', false);
  await putTask(env, repo, 'L-1', 'Limited');
  const jobs = new JobStore(env.state);
  const at = new Date().toISOString();
  const record = (workspace: string, ticket: string, state: JobState): Job => ({
    workspace, ticket, branch: `${ticket}-b`, base: 'main', continues: null, builds_on: null, builds_on_commit: null,base_commit: null, state, worktree: null, prepared_commit: null,
    iteration: 1, fixes: 0, gate_fixes: 0, gate_tokens: 0, session_id: null, mr: null, target_commit: null, mr_attempts: 0, mr_conflict_turn: false, created_at: at, updated_at: at,
  });
  for (const [workspace, ticket, state] of [['app', 'X-1', 'working'], ['web', 'X-2', 'awaiting_review'], ['app', 'X-3', 'paused'], ['app', 'X-4', 'needs_human'], ['app', 'X-5', 'ready_for_human_review'], ['app', 'X-6', 'pushed']] as const) {
    await jobs.write(record(workspace, ticket, state));
  }
  const store = new QueueStore(env.state, 3);
  await store.write({ ...(await store.read()), max_running: 2 });
  const config = loadConfig({ SF_STATE_DIR: env.state, SF_CLAUDE: FAKE });
  const execution = new Execution(config, (name) => resolveWorkspace(name, env.config), undefined, undefined, { maxRunning: async () => (await store.read()).max_running });
  await assert.rejects(execution.start('app', 'L-1', { queued: true }), { code: 'job_limit', message: '2 jobs run (X-1 working, X-2 awaiting_review); the limit is 2.' });
  assert.equal(await jobs.read('app', 'L-1'), undefined);
  await jobs.write(record('web', 'X-2', 'starting'));
  await store.write({ ...(await store.read()), max_running: 1 });
  await assert.rejects(execution.start('app', 'L-1', { queued: true }), { code: 'job_limit', message: '2 jobs run (X-1 working, X-2 starting); the limit is 1.' });
});

test('usage limit (SF-072): a parked job counts against max_running for the queue\'s own start; limitReset re-reads the job under the lock: one no longer parked, parked again or already marked is skipped; under wait it is marked reset_seen', async () => {
  const env = await newEnv('limit-reset');
  const repo = await newRepo(env, 'limit-reset-repo', false);
  await putTask(env, repo, 'L-9', 'Limited');
  const jobs = new JobStore(env.state);
  const at = new Date(Date.now() - 60_000).toISOString();
  const record = (ticket: string, state: JobState, parkedAt = at): Job => ({
    workspace: 'app', ticket, branch: `${ticket}-b`, base: 'main', continues: null, builds_on: null, builds_on_commit: null,base_commit: null, state, worktree: null, prepared_commit: null,
    iteration: 1, fixes: 0, gate_fixes: 0, gate_tokens: 0, session_id: null, mr: null, target_commit: null, mr_attempts: 0, mr_conflict_turn: false, created_at: at, updated_at: at,
    ...(state === 'waiting_limit' ? { paused: { from: 'working' as const, step: 'turn' as const, at: parkedAt }, limit: { provider: 'claude' as const, resets_at: at } } : {}),
  });
  await jobs.write(record('L-1', 'waiting_limit'));
  await jobs.write(record('L-2', 'aborted'));
  await jobs.write(record('L-3', 'waiting_limit', new Date().toISOString()));
  const store = new QueueStore(env.state, 3);
  await store.write({ ...(await store.read()), max_running: 2 });
  const config = loadConfig({ SF_STATE_DIR: env.state, SF_CLAUDE: FAKE });
  const execution = new Execution(config, (name) => resolveWorkspace(name, env.config), undefined, undefined, { maxRunning: async () => (await store.read()).max_running });
  await assert.rejects(execution.start('app', 'L-9', { queued: true }), { code: 'job_limit', message: '2 jobs run (L-1 waiting_limit, L-3 waiting_limit); the limit is 2.' });
  assert.equal(await execution.limitReset('app', 'L-2', at, true), 'skipped');
  assert.equal(await execution.limitReset('app', 'L-3', at, true), 'skipped', 'parked again since the queue saw it');
  assert.equal(await execution.limitReset('app', 'L-1', at, false), 'waiting');
  const marked = (await jobs.read('app', 'L-1'))!;
  assert.deepEqual([marked.state, marked.limit?.reset_seen, typeof marked.limit?.notified_at, marked.paused?.at], ['waiting_limit', true, 'string', at]);
  assert.equal(await execution.limitReset('app', 'L-1', at, true), 'skipped', 'already handled under wait');
  // Restartable and resumable: the refusals name waiting_limit.
  await assert.rejects(execution.resumePaused('app', 'L-2'), { code: 'invalid_state', message: 'sf resume needs paused or waiting_limit; the job is aborted.' });
  await assert.rejects(execution.say('app', 'L-1', 'hello'), { code: 'invalid_state', message: 'The job waits for the usage limit to reset. Resume the job with a message: sf resume app L-1 [message]' });
  await assert.rejects(execution.pause('app', 'L-1'), { code: 'invalid_state', message: 'sf pause needs working or awaiting_review; the job is waiting_limit.' });
});

test('queue and limits: say during a turn, iteration_limit, base_not_found, branch_exists, abort --discard removes the worktree and the branch', async () => {
  const env = await newEnv('limits', { SF_MAX_ITERATIONS: '1' });
  const repo = await newRepo(env, 'limits-repo', false);
  for (const [ticket, title, base] of [['Q-1', 'First'], ['Q-2', 'Second'], ['Q-3', 'Third', 'nope'], ['Q-4', 'Fourth']] as const) {
    await putTask(env, repo, ticket, title, base);
  }
  await script(env, [{ delayMs: 1500, write: { 'a.txt': '1\n' }, text: 'first turn' }, { text: 'after say' }, { text: 'fixed' }, { text: 'continued' }, { write: { 'q4.txt': 'q\n' } }]);
  const served = await serve(env);
  const worktree = join(env.state, 'worktrees', 'app', 'Q-1');

  await call(served, 'start', { workspace: 'app', ticket: 'Q-1' });
  const said = await runCli(env, ['say', 'app', 'Q-1', 'also', 'do', 'this']);
  assert.equal(said.code, 0, said.stderr);
  assert.match(said.stdout, /^state: working\nqueued: true$/m);

  // Both turns form one iteration; the second resumed the session.
  const first = await waitFor(served, 'Q-1', 'awaiting_review', 1);
  assert.match(first.report, /^after say\n/);
  const log = await fakeLog(env);
  assert.deepEqual(log.map((entry) => entry.prompt), [await jobPrompt(env, '/implement .software-factory/Q-1.md', 'Q-1', 1), await jobPrompt(env, 'also do this', 'Q-1', 1)]);
  assert.ok(log[1]!.prompt.startsWith('also do this\n\nRules from the Software Factory:\n'));
  assert.ok(log[1]!.prompt.includes(FACTORY_PROMPT_RULES.split('\n')[1]!));
  assert.ok(log[1]!.argv.includes(`--resume=${log[0]!.sessionId}`));

  // SF_MAX_ITERATIONS=1: the say turn did not count; the second sf fix is a round without progress and is refused.
  await call(served, 'request_fix', { workspace: 'app', ticket: 'Q-1', content: 'first' });
  const fixed = await waitFor(served, 'Q-1', 'awaiting_review', 2);
  const limit = await refused(served, 'request_fix', { workspace: 'app', ticket: 'Q-1', content: 'more' });
  assert.equal(limit.code, 'iteration_limit');
  assert.equal(limit.message, "1 of the job's review rounds made no progress (SF_MAX_ITERATIONS is 1); the job needs the user.");
  const human = await call(served, 'check', { workspace: 'app', ticket: 'Q-1' });
  assert.deepEqual([human.state, human.error?.code], ['needs_human', 'iteration_limit']);
  // needs_human still returns the last Report and Patch.
  assert.deepEqual([human.report, human.patch.sha256], [fixed.report, fixed.patch.sha256]);
  assert.equal((await readFile(join(repo, '.software-factory', 'Q-1.md'), 'utf8')).match(/^## Fix /gm)?.length, 1);

  // sf say continues a needs_human job; its turn end publishes a new iteration.
  assert.match((await runCli(env, ['say', 'app', 'Q-1', 'go', 'on'])).stdout, /^state: working\nqueued: false$/m);
  const continued = await waitFor(served, 'Q-1', 'awaiting_review', 3);
  assert.equal(continued.error, undefined);
  assert.match(continued.report, /^continued\n/);
  assert.equal((await refused(served, 'start', { workspace: 'app', ticket: 'Q-1' })).code, 'job_exists');

  // abort --discard: the worktree and the branch go; the checkout and its files stay.
  const discarded = await runCli(env, ['abort', 'app', 'Q-1', '--discard']);
  assert.equal(discarded.code, 0, discarded.stderr);
  assert.match(discarded.stdout, /^state: aborted\nbranch: Q-1-first\ndiscarded: true\nworktree: null$/m);
  await assert.rejects(stat(worktree), { code: 'ENOENT' });
  assert.equal(git(repo, 'branch', '--list', 'Q-1-first'), '');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all').replace(/^\?\? \.software-factory\/.*\n/gm, ''), '');

  assert.equal((await refused(served, 'start', { workspace: 'app', ticket: 'Q-3' })).code, 'base_not_found');
  assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'Q-3' })).state, 'failed');
  git(repo, 'branch', 'Q-4-fourth');
  assert.equal((await refused(served, 'start', { workspace: 'app', ticket: 'Q-4' })).code, 'branch_exists');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  // A failed job is archived by the next start of the same ticket.
  git(repo, 'branch', '-q', '-D', 'Q-4-fourth');
  assert.equal((await call(served, 'start', { workspace: 'app', ticket: 'Q-4' })).state, 'working');
  await waitFor(served, 'Q-4', 'awaiting_review', 1);
  const archived = (await readdir(join(env.state, 'jobs', 'app'))).filter((name) => name.startsWith('Q-4.'));
  assert.equal(archived.length, 1);
  assert.equal(JSON.parse(await readFile(join(env.state, 'jobs', 'app', archived[0]!, 'job.json'), 'utf8')).state, 'failed');
  assert.match((await runCli(env, ['status'])).stdout, /\napp\s+Q-4\s+awaiting_review/);
  await stop(served);
  assert.equal((await runCli(env, ['say', 'app', 'Q-4', 'hello'])).stderr, 'sf: sf serve is not running.\n');
});
