// End-to-end execution tests: the real `sf serve` and `sf` CLI with private config and state
// directories, throwaway Git repositories and the fake Claude Code (test/support/fake-claude.ts)
// as the Implementer executable. Tools are driven through the official MCP client. Since SF-019
// every job works in a worktree of the checkout, Clean prepares the branch, and several jobs of a
// workspace run at once.
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { JobStore } from '../src/jobs.js';
import { FACTORY_PROMPT_RULES, factoryPrompt } from '../src/prompts.js';
import { writeTask } from '../src/task-file.js';
import { call, fakeLog, git, newEnv, newRepo, putTask, refused, runCli, script, serve, stop, task, temp, waitFor } from './support/harness.js';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];

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
  const env = await newEnv('cycle', { CLAUDE_CODE_SESSION_ID: 'outer', CLAUDE_CODE_CHILD_SESSION: '1', ANTHROPIC_API_KEY: 'test-key' });
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
  assert.deepEqual([meta.iteration, meta.denials, meta.patch_truncated, meta.submodule_changed, meta.cost_usd, meta.cost_usd_total], [1, ['Bash'], false, [], 0.0123, 0.0123]);
  // The branch tracks nothing, so a later push cannot go to origin/main by accident.
  assert.throws(() => git(repo, 'config', '--get', 'branch.DEMO-1-export-as-csv.remote'));
  assert.deepEqual(meta.changed_files, [{ path: 'README.md', added: 1, removed: 1 }, { path: 'src/new.ts', added: 1, removed: 0 }]);
  // The structured file list (SF-024): status, sensitivity and counts.
  assert.deepEqual(meta.files, [
    { path: 'README.md', status: 'modified', sensitive: 'no', additions: 1, deletions: 1 },
    { path: 'src/new.ts', status: 'added', sensitive: 'no', additions: 1, deletions: 0 },
  ]);

  const fix = await call(served, 'request_fix', { workspace: 'app', ticket: 'DEMO-1', content: '1. src/new.ts: export a value.' });
  assert.deepEqual(fix, { iteration: 2, check_after_minutes: 5 });
  const taskText = await readFile(join(repo, '.software-factory', 'DEMO-1.md'), 'utf8');
  assert.equal(taskText, `${task('DEMO-1', 'Export as CSV!')}\n\n## Fix 1\n\n1. src/new.ts: export a value.\n`);
  const second = await waitFor(served, 'DEMO-1', 'awaiting_review', 2);
  assert.match(second.report, /^# Report: DEMO-1, iteration 2\n/);
  assert.doesNotMatch(second.report, /Denied actions/);
  assert.match(second.patch.text, /\+export const x = 1;/);
  // The Fix section reached the worktree's copy before the turn.
  assert.equal(await readFile(join(worktree, '.software-factory', 'DEMO-1.md'), 'utf8'), taskText);

  let log = await fakeLog(env);
  assert.deepEqual(log.map((entry) => entry.prompt), [
    factoryPrompt('/implement .software-factory/DEMO-1.md', 'DEMO-1', 1),
    factoryPrompt('/implement .software-factory/DEMO-1.md Fix 1', 'DEMO-1', 2),
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
  assert.ok(log[0]!.argv.some((arg) => arg.startsWith('--disallowedTools=') && arg.includes('Bash(git commit:*)') && arg.includes('Read(**/.env)')));
  assert.ok(log[0]!.env.includes('ANTHROPIC_API_KEY'));
  for (const name of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'SF_STATE_DIR', 'SF_CLAUDE']) {
    assert.ok(!log[0]!.env.includes(name), name);
  }
  let job = JSON.parse(await readFile(join(jobDir, 'job.json'), 'utf8'));
  assert.equal(job.session_id, log[0]!.sessionId);
  assert.equal(job.worktree, worktree);

  // approve is not available before Clean: the branch is prepared at Clean.
  assert.equal((await runCli(env, ['approve', 'app', 'DEMO-1'])).code, 1);
  // Clean: the MR preparation turn runs in the worktree, then the worktree goes and the branch
  // holds one commit on top of origin/main in the checkout.
  assert.deepEqual(await call(served, 'mark_clean', { workspace: 'app', ticket: 'DEMO-1' }), { state: 'preparing_mr', iteration: 2, branch: 'DEMO-1-export-as-csv' });
  const clean = await waitFor(served, 'DEMO-1', 'ready_for_human_review', 2);
  assert.deepEqual([clean.report, clean.patch.sha256, clean.mr], [second.report, second.patch.sha256, mrText('feat(DEMO-1): Export as CSV')]);
  await assert.rejects(stat(worktree), { code: 'ENOENT' });
  assert.ok(!git(repo, 'worktree', 'list').includes(worktree));
  assert.equal(git(repo, 'rev-list', '--count', 'origin/main..DEMO-1-export-as-csv').trim(), '1');
  assert.equal(git(repo, 'log', '-1', '--format=%s', 'DEMO-1-export-as-csv').trim(), 'feat(DEMO-1): Export as CSV');
  assert.equal(git(repo, 'show', 'DEMO-1-export-as-csv:src/new.ts'), 'export const x = 1;\n');
  assert.equal(treeState(repo), before);
  job = JSON.parse(await readFile(join(jobDir, 'job.json'), 'utf8'));
  assert.deepEqual([job.worktree, job.prepared_commit, job.base_commit, job.target_commit], [null, git(repo, 'rev-parse', 'DEMO-1-export-as-csv').trim(), git(repo, 'rev-parse', 'origin/main').trim(), git(repo, 'rev-parse', 'origin/main').trim()]);
  log = await fakeLog(env);
  assert.equal(log.length, 3);
  assert.match(log[2]!.prompt, /^MR preparation for DEMO-1 on branch DEMO-1-export-as-csv\./);
  assert.equal(log[2]!.cwd, worktree);
  // The user can check the branch out in the IDE; the checkout itself is still on main.
  git(repo, 'checkout', '-q', 'DEMO-1-export-as-csv');
  assert.equal(await readFile(join(repo, 'src', 'new.ts'), 'utf8'), 'export const x = 1;\n');
  git(repo, 'checkout', '-q', 'main');

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
  assert.match(status.stdout, /^WORKSPACE\s+TICKET\s+STATE\s+ITER\s+BRANCH\s+SINCE\s+EST_USD\s+ELAPSED\s+ERROR\napp\s+DEMO-1\s+ready_for_human_review\s+2\s+DEMO-1-export-as-csv\s+\S+\s+0\.0500\s+\d{2,}:\d\d:\d\d\s*$/m);
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
  assert.equal(treeState(repo), before);
  await stop(served);
  await assert.rejects(stat(join(env.state, 'sf.sock')), { code: 'ENOENT' });
  assert.match((await runCli(env, ['status', 'app', 'DEMO-1'])).stdout, /pushed/);
});

test('parallel jobs: three jobs of a workspace run at once in their own worktrees, a fourth is job_limit, say and check answer while a turn runs, the checkout is never touched', async () => {
  const env = await newEnv('parallel', { SF_MAX_JOBS: '3' });
  const repo = await newRepo(env, 'parallel-repo', true);
  for (const ticket of ['P-1', 'P-2', 'P-3', 'P-4']) {
    await putTask(env, repo, ticket, `Job ${ticket}`);
  }
  // Each job's first turn: P-1 is slow, so the others start while it runs.
  await script(env, [
    { delayMs: 2500, write: { 'one.txt': '1\n' }, text: 'one' },
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
  const limit = await refused(served, 'start', { workspace: 'app', ticket: 'P-4' });
  assert.equal(limit.code, 'job_limit');
  assert.match(limit.message, /Workspace app has 3 live job\(s\) \(P-1 working, P-2 \w+, P-3 \w+\); SF_MAX_JOBS is 3\./);
  // While P-1's turn runs: check and say on it answer, the other jobs finish.
  assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'P-1' })).state, 'working');
  assert.match((await runCli(env, ['say', 'app', 'P-1', 'also', 'this'])).stdout, /^state: working\nqueued: true$/m);
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
  assert.equal((await call(served, 'start', { workspace: 'app', ticket: 'P-4' })).state, 'working');
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
  assert.deepEqual(log.map((entry) => entry.prompt), [factoryPrompt('/implement .software-factory/Q-1.md', 'Q-1', 1), factoryPrompt('also do this', 'Q-1', 1)]);
  assert.ok(log[1]!.prompt.startsWith('also do this\n\nRules from the Software Factory:\n'));
  assert.ok(log[1]!.prompt.includes(FACTORY_PROMPT_RULES.split('\n')[1]!));
  assert.ok(log[1]!.argv.includes(`--resume=${log[0]!.sessionId}`));

  // SF_MAX_ITERATIONS=1 counts Fix sections: the say turn did not use it up, the second Fix is refused.
  await call(served, 'request_fix', { workspace: 'app', ticket: 'Q-1', content: 'first' });
  const fixed = await waitFor(served, 'Q-1', 'awaiting_review', 2);
  const limit = await refused(served, 'request_fix', { workspace: 'app', ticket: 'Q-1', content: 'more' });
  assert.equal(limit.code, 'iteration_limit');
  assert.equal(limit.message, '1 Fix sections were written, the limit of SF_MAX_ITERATIONS; the job needs the user.');
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

test('permission_mode_mismatch ends in needs_human; a restart turns working jobs into needs_human and sf say resumes them', async () => {
  const env = await newEnv('restart');
  const repo = await newRepo(env, 'restart-repo', false);
  await putTask(env, repo, 'M-1', 'Mismatch');
  await script(env, [{ permissionMode: 'default' }, { text: 'resumed report' }]);
  let served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'M-1' });
  const mismatch = await waitFor(served, 'M-1', 'needs_human');
  assert.equal(mismatch.error.code, 'permission_mode_mismatch');
  assert.equal(mismatch.iteration, 0);
  assert.deepEqual([mismatch.report, mismatch.patch], [undefined, undefined]);
  // A crash leaves the socket behind; the next sf serve replaces it.
  await stop(served, 'SIGKILL');
  assert.ok((await stat(join(env.state, 'sf.sock'))).isSocket());

  // A job left "working" by a stopped server, with a session to resume.
  const jobs = new JobStore(env.state);
  const job = (await jobs.read('app', 'M-1'))!;
  await jobs.write({ ...job, state: 'working', session_id: 'kept-session', error: undefined });
  served = await serve(env);
  const restarted = await call(served, 'check', { workspace: 'app', ticket: 'M-1' });
  assert.deepEqual([restarted.state, restarted.error?.code], ['needs_human', 'serve_restarted']);
  assert.equal((await jobs.read('app', 'M-1'))!.session_id, 'kept-session');

  assert.equal((await runCli(env, ['say', 'app', 'M-1', 'please', 'continue'])).code, 0);
  const resumed = await waitFor(served, 'M-1', 'awaiting_review', 1);
  assert.match(resumed.report, /^resumed report\n/);
  const log = await fakeLog(env);
  assert.equal(log[1]!.prompt, factoryPrompt('please continue', 'M-1', 1));
  assert.ok(log[1]!.argv.includes('--resume=kept-session'));
  await stop(served);
});

// The placeholders bubblewrap left in a real job's work checkout on 2026-11-02.
const PLACEHOLDERS = [
  '.bash_profile', '.bashrc', '.gitconfig', '.gitmodules', '.mcp.json',
  '.claude/agents', '.claude/commands', '.claude/hooks', '.claude/launch.json', '.claude/loop.md',
  '.claude/output-styles', '.claude/routines', '.claude/scheduled_tasks.json', '.claude/settings.json',
  '.claude/settings.local.json', '.claude/skills', '.claude/workflows',
];

async function events(env: { state: string }, ticket: string): Promise<Array<Record<string, any>>> {
  const text = await readFile(join(env.state, 'jobs', 'app', ticket, 'events.jsonl'), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.type === 'placeholders_removed');
}

test('sandbox placeholders: the Patch leaves them out, they are removed from the worktree after every turn and before abort --discard', async () => {
  const env = await newEnv('placeholders');
  const repo = await newRepo(env, 'placeholders-repo', false);
  await putTask(env, repo, 'P-1', 'Placeholders');
  // A real dotfile with content is a change of its own and stays.
  await script(env, [
    { tool: true, write: { 'README.md': 'hello placeholders\n', '.editorconfig': 'root = true\n' }, placeholders: [...PLACEHOLDERS, '.claude/.cc-writes/'] },
  ]);
  const served = await serve(env);
  assert.equal((await call(served, 'start', { workspace: 'app', ticket: 'P-1' })).state, 'working');
  const worktree = join(env.state, 'worktrees', 'app', 'P-1');
  const first = await waitFor(served, 'P-1', 'awaiting_review', 1);

  assert.match(first.patch.text, /\+\+\+ b\/README\.md/);
  assert.match(first.patch.text, /\+\+\+ b\/\.editorconfig/);
  assert.doesNotMatch(first.patch.text, /bash|gitconfig|gitmodules|mcp\.json|\.claude/);
  assert.match(first.report, /\| README\.md \| 1 \| 1 \|\n\| \.editorconfig \| 1 \| 0 \|\n/);
  assert.doesNotMatch(first.report, /\.bashrc|\.claude/);
  // .editorconfig is a sensitive path (tool configuration), undeclared by the Task file.
  assert.match(first.report, /\n## Changed files\n\n### Sensitive\n\n- \.editorconfig \(undeclared\)\n\n\| Path/);
  assert.deepEqual(first.files, { sensitive: [{ path: '.editorconfig', declared: false }], deleted: [] });
  const logged = await events(env, 'P-1');
  assert.deepEqual(logged.map((record) => [record.iteration, record.paths]), [[1, [...PLACEHOLDERS, '.claude', '.claude/.cc-writes'].sort()]]);
  for (const path of ['.bashrc', '.claude', '.mcp.json']) {
    await assert.rejects(stat(join(worktree, path)), { code: 'ENOENT' }, path);
  }
  const watched = await runCli(env, ['watch', 'app', 'P-1', '--once']);
  assert.match(watched.stdout, /^\d\d:\d\d:\d\d \[1\] placeholders removed: \.bash_profile, \.bashrc, \.claude, /m);

  // Placeholders recreated before abort --discard are removed and logged as well; the worktree goes.
  await writeFile(join(worktree, '.gitconfig'), '');
  await chmod(join(worktree, '.gitconfig'), 0o444);
  const aborted = await runCli(env, ['abort', 'app', 'P-1', '--discard']);
  assert.equal(aborted.code, 0, aborted.stdout + aborted.stderr);
  assert.match(aborted.stdout, /^discarded: true$/m);
  assert.deepEqual((await events(env, 'P-1')).at(-1)!.paths, ['.gitconfig']);
  await assert.rejects(stat(worktree), { code: 'ENOENT' });
  assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all').replace(/^\?\? \.software-factory\/.*\n/gm, ''), '');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  await stop(served);
});

test('sensitive paths (SF-024): declared by may_touch or not, deleted files, mark_clean needs the undeclared ones acknowledged, the Report and notifications name them', async () => {
  const env = await newEnv('sensitive', { SF_SENSITIVE_PATHS: 'docs/*.lock' });
  const repo = await newRepo(env, 'sensitive-repo', true);
  await writeFile(join(repo, 'package.json'), '{}\n');
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'old.ts'), 'old\n');
  await writeFile(join(repo, 'package-lock.json'), '{}\n');
  git(repo, 'add', '.');
  git(repo, ...ID, 'commit', '-q', '-m', 'files');
  git(repo, 'push', '-q', 'origin', 'main');
  const content = `---\nticket: S-1\ntitle: Touch files\nbase: main\nmay_touch: [package.json, docs/**]\n---\n\n# S-1: Touch files\n\nChange things.\n`;
  await writeTask({ name: 'app', readCheckout: repo, workCheckout: repo }, 'S-1', content, new JobStore(env.state));
  await script(env, [
    {
      write: { 'package.json': '{"name":"x"}\n', '.github/workflows/ci.yml': 'on: push\n', 'src/a.ts': 'a\n', 'docs/dep.lock': 'x\n' },
      run: [['rm', 'src/old.ts', 'package-lock.json']],
      text: 'iteration 1',
    },
    { write: { '.software-factory/S-1.mr.md': mrText('feat(S-1): Touch files') }, text: 'prepared' },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'S-1' });
  const first = await waitFor(served, 'S-1', 'awaiting_review', 1);
  assert.deepEqual(first.files, {
    sensitive: [{ path: 'package-lock.json', declared: false }, { path: 'package.json', declared: true }, { path: '.github/workflows/ci.yml', declared: false }, { path: 'docs/dep.lock', declared: true }],
    deleted: ['package-lock.json', 'src/old.ts'],
  });
  assert.match(first.report, /\n## Changed files\n\n### Sensitive\n\n- package-lock\.json \(undeclared, deleted\)\n- package\.json \(declared\)\n- \.github\/workflows\/ci\.yml \(undeclared\)\n- docs\/dep\.lock \(declared\)\n\n### Deleted\n\n- package-lock\.json\n- src\/old\.ts\n\n\| Path/);
  const meta = JSON.parse(await readFile(join(env.state, 'jobs', 'app', 'S-1', 'iterations', '001', 'meta.json'), 'utf8'));
  assert.deepEqual(meta.files.map((file: Record<string, unknown>) => [file.path, file.status, file.sensitive]), [
    ['package-lock.json', 'deleted', 'undeclared'], ['package.json', 'modified', 'declared'], ['src/old.ts', 'deleted', 'no'],
    ['.github/workflows/ci.yml', 'added', 'undeclared'], ['docs/dep.lock', 'added', 'declared'], ['src/a.ts', 'added', 'no'],
  ]);
  const one = await runCli(env, ['status', 'app', 'S-1']);
  assert.match(one.stdout, /\nsensitive: package-lock\.json \(undeclared\), package\.json, \.github\/workflows\/ci\.yml \(undeclared\), docs\/dep\.lock\ndeleted: package-lock\.json, src\/old\.ts\n$/);

  // Clean without the undeclared paths is refused and starts nothing; with them it prepares the branch.
  const unacknowledged = await refused(served, 'mark_clean', { workspace: 'app', ticket: 'S-1' });
  assert.equal(unacknowledged.code, 'sensitive_unacknowledged');
  assert.match(unacknowledged.message, /^Undeclared sensitive path\(s\) in the reviewed iteration: package-lock\.json, \.github\/workflows\/ci\.yml\. Name each in sensitive/);
  assert.equal((await refused(served, 'mark_clean', { workspace: 'app', ticket: 'S-1', sensitive: ['package-lock.json'] })).code, 'sensitive_unacknowledged');
  assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'S-1' })).state, 'awaiting_review');
  assert.equal((await fakeLog(env)).length, 1);
  assert.equal((await call(served, 'mark_clean', { workspace: 'app', ticket: 'S-1', sensitive: ['package-lock.json', '.github/workflows/ci.yml'] })).state, 'preparing_mr');
  await waitFor(served, 'S-1', 'ready_for_human_review', 1);
  assert.equal(git(repo, 'show', '--name-status', '--format=', 'S-1-touch-files').trim().split('\n').sort().join(','), 'A\t.github/workflows/ci.yml,A\tdocs/dep.lock,A\tsrc/a.ts,D\tpackage-lock.json,D\tsrc/old.ts,M\tpackage.json');
  await stop(served);
});
