// End-to-end tests of the MR preparation at Clean (mark_clean: the MR text turn, the factory's
// commit and rebase, the conflict turn), the push at approve, abort, reset, the sandbox arguments
// and the notifications, with the fake Claude writing files in the job's worktree.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { JobStore } from '../src/jobs.js';
import { loadHandbook } from '../src/server.js';
import { mrMessage, pushBranch } from '../src/mr.js';
import { conflictPrompt, mrPrompt } from '../src/prompts.js';
import { call, fakeLog, git, newEnv, newRepo, putTask, refused, runCli, script, serve, stop, temp, turnsStarted, waitFor } from './support/harness.js';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];

function mrText(header: string): string {
  return [
    header, '',
    '## What', 'Changes the README.', '## Why', 'The ticket asks for it.', '', 'Readers need the new line.', '## How', 'One line.', '## Why the change', 'Readers need it.',
    '## Special things to note', '- None.', '## Change outline', '- README.md', '## Testing', 'npm test: passed', '## Screenshots', 'N/A',
    '## Checklist', '- [x] Branch name', '- [x] Target branch', '',
  ].join('\n');
}

// Pushes a commit adding path to origin/main from a separate clone.
function moveOrigin(origin: string, path: string): string {
  return pushToOrigin(origin, { [path]: 'upstream\n' }, `upstream ${path}`);
}

// Pushes a commit writing files on origin/main from a separate clone; returns the commit.
function pushToOrigin(origin: string, files: Record<string, string>, message: string): string {
  const other = join(temp, `push-${message.replace(/\W/g, '')}-${Date.now()}`);
  execFileSync('git', ['clone', '-q', origin, other]);
  for (const [path, content] of Object.entries(files)) {
    execFileSync('sh', ['-c', 'printf "%s" "$2" > "$1"', 'sh', path, content], { cwd: other });
  }
  git(other, 'add', '.');
  git(other, 'commit', '-q', '-m', message);
  git(other, 'push', '-q', 'origin', 'main');
  return git(other, 'rev-parse', 'HEAD').trim();
}

const NINE = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const lines = (edit: Record<number, string>): string => `${NINE.map((line, index) => edit[index + 1] ?? line).join('\n')}\n`;

async function approve(env: Parameters<typeof runCli>[0], ticket: string, ...flags: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runCli(env, ['approve', 'app', ticket, ...flags]);
}

const worktreeOf = (env: { state: string }, ticket: string): string => join(env.state, 'worktrees', 'app', ticket);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// True while a rebase is in progress in the worktree.
async function rebasing(worktree: string): Promise<boolean> {
  const dir = resolve(worktree, git(worktree, 'rev-parse', '--git-dir').trim());
  return (await exists(join(dir, 'rebase-merge'))) || (await exists(join(dir, 'rebase-apply')));
}

const denied = (entry: { argv: string[] }): string => entry.argv.find((arg) => arg.startsWith('--disallowedTools='))!;

test('mark_clean: the MR turn writes the MR text only; the factory commits once on top of the moved target with the whole MR text as its message; approve refuses a hand-edited tip and pushes with --as-is', async () => {
  const env = await newEnv('approve', { SF_SANDBOX_DOMAINS: 'pypi.org' });
  const repo = await newRepo(env, 'approve-repo', true);
  const origin = join(temp, 'approve-repo-origin.git');
  await putTask(env, repo, 'T-1', 'Change README');
  await script(env, [
    { write: { 'README.md': 'hello world\n', 'debug.log': 'ignored\n' }, text: 'iteration 1' },
    { write: { '.software-factory/T-1.mr.md': mrText('feat(T-1): Change the README') }, text: '# Report: T-1, MR preparation 1\n\n## Done\nfeat(T-1): Change the README' },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
  await waitFor(served, 'T-1', 'awaiting_review', 1);
  const branch = 'T-1-change-readme';
  const worktree = worktreeOf(env, 'T-1');
  const jobs = new JobStore(env.state);
  const original = (await jobs.read('app', 'T-1'))!.base_commit!;
  assert.equal((await jobs.readMeta('app', 'T-1', 1)).base_commit, original);
  const upstream = moveOrigin(origin, 'other.txt');

  assert.equal((await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' })).state, 'preparing_mr');
  const ready = await waitFor(served, 'T-1', 'ready_for_human_review', 1);
  assert.equal(ready.mr, mrText('feat(T-1): Change the README'));
  // The worktree stays until the push (SF-073); the branch has one commit on top of the moved
  // main, with the whole MR text as its message (every # heading kept) and the user's identity.
  assert.equal(await exists(worktree), true);
  assert.equal(git(repo, 'rev-list', '--count', `${upstream}..${branch}`).trim(), '1');
  assert.equal(git(repo, 'rev-parse', `${branch}~1`).trim(), upstream);
  const message = mrMessage(mrText('feat(T-1): Change the README'));
  assert.equal(git(repo, 'log', '-1', '--format=%B', branch).replace(/\n+$/, ''), `${message.title}\n\n${message.body}`);
  assert.match(message.body, /^## What\n[^]*\n## Why\nThe ticket asks for it\.\n\nReaders need the new line\.\n## How\n[^]*\n## Checklist\n- \[x\] Branch name\n- \[x\] Target branch$/);
  assert.equal(git(repo, 'log', '-1', '--format=%an <%ae>', branch).trim(), 'Test User <test@example.invalid>');
  // Only the reviewed change: no ignored file, no .software-factory/.
  assert.equal(git(repo, 'show', '--name-only', '--format=', branch).trim(), 'README.md');
  const jobDir = join(env.state, 'jobs', 'app', 'T-1');
  assert.equal(await readFile(join(jobDir, 'mr.md'), 'utf8'), ready.mr);
  let job = (await jobs.read('app', 'T-1'))!;
  const prepared = git(repo, 'rev-parse', branch).trim();
  assert.deepEqual([job.target_commit, job.base_commit, job.prepared_commit, job.worktree, job.mr_attempts, job.iteration], [upstream, upstream, prepared, worktree, 1, 1]);
  assert.equal(await exists(join(jobDir, 'mr-snapshot.json')), false);
  assert.equal(git(repo, 'for-each-ref', 'refs/sf/'), '');

  // The user edits the branch by hand: approve refuses, --as-is pushes the edited tip.
  const tree = git(repo, 'rev-parse', `${branch}^{tree}`).trim();
  const edited = execFileSync('git', [...ID, 'commit-tree', tree, '-p', prepared, '-m', 'feat(T-1): Change the README'], { cwd: repo, encoding: 'utf8' }).trim();
  git(repo, 'update-ref', `refs/heads/${branch}`, edited);
  const changed = await approve(env, 'T-1');
  assert.equal(changed.code, 1);
  assert.match(changed.stderr, new RegExp(`^sf: The tip of ${branch} is ${edited.slice(0, 12)}, not the prepared ${prepared.slice(0, 12)}: it was edited by hand\\. Approve with --as-is to push it as it is\\.$`, 'm'));
  assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'T-1' })).state, 'ready_for_human_review');
  const pushed = await approve(env, 'T-1', '--as-is');
  assert.equal(pushed.code, 0, pushed.stdout + pushed.stderr);
  assert.match(pushed.stdout, new RegExp(`^state: pushed\\nbranch: ${branch}\\ntitle: feat\\(T-1\\): Change the README$`, 'm'));
  assert.match(pushed.stdout, /No merge request link: the origin URL could not be parsed\./);
  const remote = execFileSync('git', ['--git-dir', origin, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
  assert.equal(remote, edited);
  const done = await call(served, 'check', { workspace: 'app', ticket: 'T-1' });
  assert.deepEqual([done.state, done.error, done.mr], ['pushed', undefined, ready.mr]);
  job = (await jobs.read('app', 'T-1'))!;
  assert.deepEqual([job.prepared_commit, job.mr_attempts, job.worktree], [edited, 1, null]);
  // The push removed the worktree.
  assert.equal(await exists(worktree), false);

  // The MR turn: the MR prompt with the target of this Clean, and the full deny list (git commit
  // included); sandbox on; every turn in the worktree and the same session.
  const log = await fakeLog(env);
  const handbook = (await loadHandbook()).text;
  assert.equal(log.length, 2);
  assert.notEqual(upstream, original);
  assert.equal(log[1]!.prompt, mrPrompt({ ticket: 'T-1', branch, targetRef: 'origin/main', targetCommit: upstream, attempt: 1, handbook }));
  assert.doesNotMatch(log[1]!.prompt, /Rules from the Software Factory/);
  assert.ok(log.every((entry) => entry.cwd === worktree));
  for (const entry of log) {
    assert.match(denied(entry), /Bash\(git commit:\*\)/);
    assert.match(denied(entry), /Bash\(git (add|rebase|push):\*\)/);
  }
  assert.equal(denied(log[1]!), denied(log[0]!));
  assert.ok(log[1]!.argv.includes(`--resume=${log[0]!.sessionId}`));
  const settings = JSON.parse(log[0]!.argv[log[0]!.argv.indexOf('--settings') + 1]!);
  assert.deepEqual(settings.sandbox, {
    enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true,
    network: { allowedDomains: ['registry.npmjs.org', 'pypi.org'], allowLocalBinding: true, allowAllUnixSockets: true },
  });
  assert.ok(log.every((entry) => !entry.argv.some((arg) => arg === '--model' || arg.startsWith('--model='))));
  // pushed is terminal: approve again is refused; the checkout stayed on main throughout.
  assert.equal((await approve(env, 'T-1')).code, 1);
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  await stop(served);
});

test('mark_clean: a missing, then an invalid MR text is needs_human with its code and commits nothing; the retry prepares the branch', async () => {
  const env = await newEnv('mrtext');
  const repo = await newRepo(env, 'mrtext-repo', true);
  await putTask(env, repo, 'T-2', 'Add a');
  const mrPath = '.software-factory/T-2.mr.md';
  await script(env, [
    { write: { 'a.txt': 'a\n' }, text: 'iteration 1' },
    { text: 'attempt 1: no MR text' },
    { write: { [mrPath]: mrText('feat(T-2): Add a.') }, text: 'attempt 2: a title with a period' },
    { write: { [mrPath]: mrText('feat(T-2): Add a') }, text: 'attempt 3' },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'T-2' });
  await waitFor(served, 'T-2', 'awaiting_review', 1);
  const jobs = new JobStore(env.state);
  const base = (await jobs.read('app', 'T-2'))!.base_commit!;
  const branch = 'T-2-add-a';
  const worktree = worktreeOf(env, 'T-2');

  const expectations: Array<[string, RegExp]> = [
    ['mr_text_missing', /^\.software-factory\/T-2\.mr\.md does not exist\.$/],
    ['mr_text_invalid', /^\.software-factory\/T-2\.mr\.md is invalid: its first line "feat\(T-2\): Add a\." is not a valid title: it ends with a period\.$/],
  ];
  for (const [index, [code, message]] of expectations.entries()) {
    // The first Clean from awaiting_review; the second the retry from needs_human.
    assert.equal((await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-2' })).state, 'preparing_mr');
    const checked = await waitFor(served, 'T-2', 'needs_human');
    assert.equal(checked.error.code, code);
    assert.match(checked.error.message, message);
    const job = (await jobs.read('app', 'T-2'))!;
    assert.deepEqual([job.mr_attempts, job.worktree, job.prepared_commit], [index + 1, worktree, null]);
    // Nothing committed: the branch is still at its base, the change uncommitted in the worktree.
    assert.equal(git(repo, 'rev-parse', branch).trim(), base);
    assert.equal(git(worktree, 'status', '--porcelain', '--', 'a.txt'), '?? a.txt\n');
    assert.equal((await approve(env, 'T-2')).code, 1);
    if (index === 0) {
      assert.equal((await refused(served, 'request_fix', { workspace: 'app', ticket: 'T-2', content: 'x' })).code, 'invalid_state');
    }
  }
  await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-2' });
  await waitFor(served, 'T-2', 'ready_for_human_review', 1);
  assert.equal(git(repo, 'rev-list', '--count', `${base}..${branch}`).trim(), '1');
  assert.equal(git(repo, 'log', '-1', '--format=%s', branch).trim(), 'feat(T-2): Add a');
  assert.equal((await jobs.read('app', 'T-2'))!.mr_attempts, 3);
  const log = await fakeLog(env);
  assert.match(log[2]!.prompt, /^This is attempt 2\. The previous attempt failed: \.software-factory\/T-2\.mr\.md does not exist\.$/m);
  assert.match(log[3]!.prompt, /^This is attempt 3\. The previous attempt failed: .*it ends with a period\.$/m);
  await stop(served);
});

test('mark_clean after a fix asked in ready_for_human_review: still one commit, with the new file, without a file reverted by the fix', async () => {
  const env = await newEnv('fixafter');
  const repo = await newRepo(env, 'fixafter-repo', true);
  const origin = join(temp, 'fixafter-repo-origin.git');
  await putTask(env, repo, 'D-1', 'Add files');
  const mrPath = '.software-factory/D-1.mr.md';
  await script(env, [
    { write: { 'a.txt': 'a\n', 'README.md': 'changed\n' }, text: 'iteration 1' },
    { write: { [mrPath]: mrText('feat(D-1): Add a') }, text: 'MR text 1' },
    // The fix after Clean, in the reopened worktree: adds c.txt and puts the README back.
    { write: { 'c.txt': 'c\n', 'README.md': 'hello\n' }, text: 'iteration 2: added c, README as before' },
    { write: { [mrPath]: mrText('feat(D-1): Add a and c') }, text: 'MR text 2' },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'D-1' });
  await waitFor(served, 'D-1', 'awaiting_review', 1);
  const jobs = new JobStore(env.state);
  const base = (await jobs.read('app', 'D-1'))!.base_commit!;
  const branch = 'D-1-add-files';
  const worktree = worktreeOf(env, 'D-1');

  await call(served, 'mark_clean', { workspace: 'app', ticket: 'D-1' });
  await waitFor(served, 'D-1', 'ready_for_human_review', 1);
  const prepared = git(repo, 'rev-parse', branch).trim();
  assert.equal(git(repo, 'show', '--name-only', '--format=', branch).trim(), 'README.md\na.txt');

  // request_fix from ready_for_human_review: the worktree is recreated from the branch and the
  // next iteration's Patch is the whole change against the target.
  assert.deepEqual(await call(served, 'request_fix', { workspace: 'app', ticket: 'D-1', content: 'Add c.txt, keep the README.' }), { iteration: 2, check_after_minutes: 5 });
  const second = await waitFor(served, 'D-1', 'awaiting_review', 2);
  assert.match(second.patch.text, /\+\+\+ b\/a\.txt/);
  assert.match(second.patch.text, /\+\+\+ b\/c\.txt/);
  assert.doesNotMatch(second.patch.text, /README/);
  assert.equal(git(worktree, 'rev-parse', 'HEAD').trim(), prepared);
  await call(served, 'mark_clean', { workspace: 'app', ticket: 'D-1' });
  await waitFor(served, 'D-1', 'ready_for_human_review', 2);
  assert.equal(git(repo, 'rev-list', '--count', `${base}..${branch}`).trim(), '1');
  assert.equal(git(repo, 'log', '-1', '--format=%s', branch).trim(), 'feat(D-1): Add a and c');
  assert.equal(git(repo, 'show', '--name-only', '--format=', branch).trim(), 'a.txt\nc.txt');
  const job = (await jobs.read('app', 'D-1'))!;
  assert.notEqual(job.prepared_commit, prepared);
  assert.deepEqual([job.worktree, job.mr_attempts], [worktree, 2]);

  const pushed = await approve(env, 'D-1');
  assert.equal(pushed.code, 0, pushed.stdout + pushed.stderr);
  assert.match(pushed.stdout, /^state: pushed\nbranch: D-1-add-files\ntitle: feat\(D-1\): Add a and c$/m);
  assert.equal(execFileSync('git', ['--git-dir', origin, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim(), job.prepared_commit);
  await stop(served);
});

// A repository whose main (and origin/main) holds lines.txt with the lines 1 to 9.
async function linesRepo(env: Parameters<typeof runCli>[0], name: string): Promise<{ repo: string; origin: string }> {
  const repo = await newRepo(env, name, true);
  await writeFile(join(repo, 'lines.txt'), lines({}));
  git(repo, 'add', 'lines.txt');
  git(repo, 'commit', '-q', '-m', 'lines');
  git(repo, 'push', '-q', 'origin', 'main');
  return { repo, origin: join(temp, `${name}-origin.git`) };
}

test('mark_clean: the target moved in another hunk of a reviewed file; the rebase merges it and the branch is ready without a new iteration', async () => {
  const env = await newEnv('mergeclean');
  const { repo, origin } = await linesRepo(env, 'mergeclean-repo');
  await putTask(env, repo, 'M-1', 'Edit line nine');
  await script(env, [
    { write: { 'lines.txt': lines({ 9: '9 change' }) }, text: 'iteration 1' },
    { write: { '.software-factory/M-1.mr.md': mrText('feat(M-1): Edit line nine') }, text: 'MR text' },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'M-1' });
  await waitFor(served, 'M-1', 'awaiting_review', 1);
  // The same file changes on the target, in line 1: a clean rebase.
  const upstream = pushToOrigin(origin, { 'lines.txt': lines({ 1: '1 upstream' }) }, 'upstream line one');
  await call(served, 'mark_clean', { workspace: 'app', ticket: 'M-1' });
  await waitFor(served, 'M-1', 'ready_for_human_review', 1);
  const job = (await new JobStore(env.state).read('app', 'M-1'))!;
  assert.deepEqual([job.iteration, job.target_commit, job.base_commit], [1, upstream, upstream]);
  assert.equal(git(repo, 'rev-parse', 'M-1-edit-line-nine~1').trim(), upstream);
  assert.equal(git(repo, 'show', 'M-1-edit-line-nine:lines.txt'), lines({ 1: '1 upstream', 9: '9 change' }));
  assert.equal((await fakeLog(env)).length, 2);
  const pushed = await approve(env, 'M-1');
  assert.equal(pushed.code, 0, pushed.stdout + pushed.stderr);
  assert.match(pushed.stdout, /^state: pushed\nbranch: M-1-edit-line-nine\ntitle: feat\(M-1\): Edit line nine$/m);
  assert.equal(execFileSync('git', ['--git-dir', origin, 'show', 'M-1-edit-line-nine:lines.txt'], { encoding: 'utf8' }), lines({ 1: '1 upstream', 9: '9 change' }));
  await stop(served);
});

test('mark_clean: the target moved in the same hunk; a conflict turn that leaves markers is mr_conflict with the rebase aborted, one that resolves it goes back to review naming the file, the next Clean is ready', async () => {
  const env = await newEnv('mergeconflict');
  const { repo, origin } = await linesRepo(env, 'mergeconflict-repo');
  await putTask(env, repo, 'M-2', 'Edit line nine');
  const resolved = lines({ 9: '9 change and upstream' });
  await script(env, [
    { write: { 'lines.txt': lines({ 9: '9 change' }) }, text: 'iteration 1' },
    { write: { '.software-factory/M-2.mr.md': mrText('feat(M-2): Edit line nine') }, text: 'MR text' },
    // Conflict turn 1 changes nothing: the markers stay.
    { text: 'Could not resolve.' },
    // The retry: the MR text is still in the worktree; conflict turn 2 resolves the file.
    { text: 'MR text kept' },
    // It also edits a file that did not conflict, to make the merge build.
    { write: { 'lines.txt': resolved, 'notes.txt': 'adapted\n' }, text: '# Report: M-2, conflict resolution\n\n## Done\nlines.txt: kept both changes.' },
    // The next Clean.
    { text: 'MR text kept' },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'M-2' });
  await waitFor(served, 'M-2', 'awaiting_review', 1);
  const worktree = worktreeOf(env, 'M-2');
  const jobs = new JobStore(env.state);
  const original = (await jobs.read('app', 'M-2'))!.base_commit!;
  const upstream = pushToOrigin(origin, { 'lines.txt': lines({ 9: '9 upstream' }) }, 'upstream line nine');

  await call(served, 'mark_clean', { workspace: 'app', ticket: 'M-2' });
  const failed = await waitFor(served, 'M-2', 'needs_human');
  assert.deepEqual(failed.error, { code: 'mr_conflict', message: 'The rebase had conflicts in lines.txt; conflict markers are left in lines.txt. The rebase was aborted.' });
  assert.equal(await rebasing(worktree), false);
  assert.equal(await readFile(join(worktree, 'lines.txt'), 'utf8'), lines({ 9: '9 change' }));
  let log = await fakeLog(env);
  assert.equal(log[2]!.prompt, conflictPrompt({ ticket: 'M-2', targetRef: 'origin/main', targetCommit: upstream, files: ['lines.txt'] }));
  assert.match(denied(log[2]!), /Bash\(git add:\*\)/);

  // The retry: the conflict is resolved, and the change goes back to review against the target.
  await call(served, 'mark_clean', { workspace: 'app', ticket: 'M-2' });
  const second = await waitFor(served, 'M-2', 'awaiting_review', 2);
  assert.match(second.report, new RegExp(`^# Report: M-2, conflict resolution\\n\\n## Done\\nlines\\.txt: kept both changes\\.\\n\\n## MR preparation\\n\\nThe rebase onto origin/main \\(${upstream}\\) had conflicts in lines\\.txt, resolved by the Implementer\\. The Patch is now against the target\\.\\n\\n## Changed files\\n`));
  assert.match(second.patch.text, /^-9 upstream\n\+9 change and upstream$/m);
  let job = (await jobs.read('app', 'M-2'))!;
  assert.deepEqual([job.base_commit, job.target_commit, job.worktree, job.mr_attempts], [upstream, upstream, worktree, 2]);
  // Each iteration's meta.json records the base its Patch is against (SF-079): the conflict
  // iteration's is the target.
  assert.deepEqual([(await jobs.readMeta('app', 'M-2', 1)).base_commit, (await jobs.readMeta('app', 'M-2', 2)).base_commit], [original, upstream]);
  assert.equal(git(worktree, 'rev-parse', 'HEAD~1').trim(), upstream);
  assert.equal(git(worktree, 'show', '--name-only', '--format=', 'HEAD').trim(), 'lines.txt\nnotes.txt');
  assert.equal(await rebasing(worktree), false);

  // The next Clean commits again (one commit); the rebase has nothing to do.
  await call(served, 'mark_clean', { workspace: 'app', ticket: 'M-2' });
  await waitFor(served, 'M-2', 'ready_for_human_review', 2);
  assert.equal(git(repo, 'rev-list', '--count', `${upstream}..M-2-edit-line-nine`).trim(), '1');
  job = (await jobs.read('app', 'M-2'))!;
  assert.deepEqual([job.iteration, job.mr_attempts, job.worktree], [2, 3, worktree]);
  log = await fakeLog(env);
  assert.equal(log.length, 6);
  const pushed = await approve(env, 'M-2');
  assert.equal(pushed.code, 0, pushed.stdout + pushed.stderr);
  assert.equal(execFileSync('git', ['--git-dir', origin, 'show', 'M-2-edit-line-nine:lines.txt'], { encoding: 'utf8' }), resolved);
  await stop(served);
});

test('mark_clean: a resolved conflict whose rebase --continue fails keeps the resolution as conflict-resolution.diff and names it in mr_conflict', async () => {
  const env = await newEnv('continuefails');
  const { repo, origin } = await linesRepo(env, 'continuefails-repo');
  await putTask(env, repo, 'M-3', 'Edit line nine');
  const resolved = lines({ 9: '9 change and upstream' });
  // Commits are signed by a fake gpg that signs until the refuse file exists. The rebase keeps the
  // signing option it started with, so the commit and the rebase sign and the continue fails.
  const refuse = join(env.home, 'refuse-signing');
  const signer = join(env.home, 'fake-gpg');
  await writeFile(signer, `#!/bin/sh\ncat >/dev/null\n[ -e '${refuse}' ] && { echo 'signing refused' >&2; exit 1; }\nprintf '\\n[GNUPG:] SIG_CREATED D 1 8 00 0 0\\n' >&2\nprintf -- '-----BEGIN PGP SIGNATURE-----\\nfake\\n-----END PGP SIGNATURE-----\\n'\n`, { mode: 0o755 });
  git(repo, 'config', 'commit.gpgsign', 'true');
  git(repo, 'config', 'gpg.program', signer);
  await script(env, [
    { write: { 'lines.txt': lines({ 9: '9 change' }) }, text: 'iteration 1' },
    { write: { '.software-factory/M-3.mr.md': mrText('feat(M-3): Edit line nine') }, text: 'MR text' },
    // The turn resolves the conflict and edits another file, then the signing program starts
    // refusing: the continue's commit fails.
    {
      write: { 'lines.txt': resolved, 'notes.txt': 'adapted\n' },
      run: [['touch', refuse]],
      text: '# Report: M-3, conflict resolution',
    },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'M-3' });
  await waitFor(served, 'M-3', 'awaiting_review', 1);
  const worktree = worktreeOf(env, 'M-3');
  const upstream = pushToOrigin(origin, { 'lines.txt': lines({ 9: '9 upstream' }) }, 'upstream line nine');

  await call(served, 'mark_clean', { workspace: 'app', ticket: 'M-3' });
  const failed = await waitFor(served, 'M-3', 'needs_human');
  const saved = join(new JobStore(env.state).iterationDir('app', 'M-3', 1), 'conflict-resolution.diff');
  assert.equal(failed.error?.code, 'mr_conflict');
  assert.ok(failed.error!.message.startsWith(`The rebase had conflicts in lines.txt; the resolved files are saved in ${saved}, a patch against ${upstream}. git rebase failed: `), failed.error!.message);
  assert.match(failed.error!.message, /gpg failed to sign.*The rebase was aborted\.$/s);
  assert.equal(await rebasing(worktree), false);
  assert.equal(await readFile(join(worktree, 'lines.txt'), 'utf8'), lines({ 9: '9 change' }));
  // The patch takes the target to the resolved state.
  const patch = await readFile(saved, 'utf8');
  assert.match(patch, /^-9 upstream\n\+9 change and upstream$/m);
  assert.match(patch, /^\+adapted$/m);
  await stop(served);
});

test('mark_clean retries directly after a failed MR turn (sandbox_unavailable); approve pushes', async () => {
  const env = await newEnv('retry');
  const repo = await newRepo(env, 'retry-repo', true);
  const origin = join(temp, 'retry-repo-origin.git');
  await putTask(env, repo, 'R-1', 'Retry');
  await script(env, [
    { write: { 'README.md': 'retry\n' } },
    { startupFailure: 'sandbox: bubblewrap is not installed' },
    { write: { '.software-factory/R-1.mr.md': mrText('fix(R-1): Retry the README') } },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'R-1' });
  await waitFor(served, 'R-1', 'awaiting_review', 1);
  await call(served, 'mark_clean', { workspace: 'app', ticket: 'R-1' });
  const failed = await waitFor(served, 'R-1', 'needs_human');
  assert.deepEqual(failed.error, { code: 'sandbox_unavailable', message: 'sandbox: bubblewrap is not installed' });
  await call(served, 'mark_clean', { workspace: 'app', ticket: 'R-1' });
  await waitFor(served, 'R-1', 'ready_for_human_review', 1);
  const pushed = await approve(env, 'R-1');
  assert.equal(pushed.code, 0, pushed.stdout + pushed.stderr);
  assert.match(pushed.stdout, /^state: pushed\nbranch: R-1-retry\ntitle: fix\(R-1\): Retry the README$/m);
  assert.equal(execFileSync('git', ['--git-dir', origin, 'log', '-1', '--format=%s', 'R-1-retry'], { encoding: 'utf8' }).trim(), 'fix(R-1): Retry the README');
  const job = (await new JobStore(env.state).read('app', 'R-1'))!;
  assert.deepEqual([job.state, job.mr_attempts], ['pushed', 2]);
  await stop(served);
});

test('mark_clean: sandbox placeholders and untracked ignored files never reach the commit', async () => {
  const env = await newEnv('mrplaceholders');
  const repo = await newRepo(env, 'mrplaceholders-repo', true);
  await putTask(env, repo, 'P-2', 'Placeholders on approve');
  const placeholders = ['.bashrc', '.gitconfig', '.gitmodules', '.mcp.json', '.claude/settings.json', '.claude/skills', '.claude/.cc-writes/'];
  await script(env, [
    { write: { 'README.md': 'prepared\n', 'build.log': 'ignored\n' }, placeholders },
    // The MR turn leaves the placeholders behind again.
    { write: { '.software-factory/P-2.mr.md': mrText('feat(P-2): Prepare the README') }, placeholders },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'P-2' });
  await waitFor(served, 'P-2', 'awaiting_review', 1);
  await call(served, 'mark_clean', { workspace: 'app', ticket: 'P-2' });
  await waitFor(served, 'P-2', 'ready_for_human_review', 1);
  const files = git(repo, 'show', '--name-only', '--format=', 'P-2-placeholders-on-approve').trim();
  assert.equal(files, 'README.md');
  const logged = (await readFile(join(env.state, 'jobs', 'app', 'P-2', 'events.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.type === 'placeholders_removed');
  const expected = ['.bashrc', '.claude', '.claude/.cc-writes', '.claude/settings.json', '.claude/skills', '.gitconfig', '.gitmodules', '.mcp.json'];
  assert.deepEqual(logged.map((record) => [record.iteration, record.paths]), [[1, expected], [2, expected]]);
  assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all').replace(/^\?\? \.software-factory\/.*\n/gm, ''), '');
  await stop(served);
});

test('mark_clean is refused in needs_human before any MR preparation; approve is refused without a prepared branch', async () => {
  const env = await newEnv('noretry', { SF_MAX_ITERATIONS: '1' });
  const repo = await newRepo(env, 'noretry-repo', false);
  await putTask(env, repo, 'R-2', 'No retry');
  await script(env, [{}, {}]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'R-2' });
  await waitFor(served, 'R-2', 'awaiting_review', 1);
  await call(served, 'request_fix', { workspace: 'app', ticket: 'R-2', content: 'first' });
  await waitFor(served, 'R-2', 'awaiting_review', 2);
  const early = await approve(env, 'R-2');
  assert.equal(early.code, 1);
  assert.match(early.stderr, /^sf: approve needs ready_for_human_review \(the branch prepared at Clean\); the job is awaiting_review\.$/m);
  assert.equal((await refused(served, 'request_fix', { workspace: 'app', ticket: 'R-2', content: 'x' })).code, 'iteration_limit');
  const result = await refused(served, 'mark_clean', { workspace: 'app', ticket: 'R-2' });
  assert.equal(result.code, 'invalid_state');
  assert.match(result.message, /^mark_clean needs awaiting_review \(or needs_human after an MR preparation\); the job is needs_human\.$/);
  await stop(served);
});

test('the push refuses main, master and the base branch with mr_push_protected and leaves origin as it was', async () => {
  const env = await newEnv('protected');
  const repo = await newRepo(env, 'protected-repo', true);
  const origin = join(temp, 'protected-repo-origin.git');
  const before = git(origin, 'rev-parse', 'main').trim();
  await writeFile(join(repo, 'README.md'), 'direct\n');
  git(repo, ...ID, 'commit', '-q', '-am', 'feat(T-9): Direct');
  git(repo, 'branch', 'master');
  git(repo, 'branch', 'release-1');
  for (const [branch, base] of [['main', 'main'], ['main', 'develop'], ['master', 'main'], ['release-1', 'release-1']] as const) {
    const failure = await pushBranch(repo, branch, base);
    assert.equal(failure?.code, 'mr_push_protected', `${branch} onto ${base}`);
    assert.match(failure.message, /every change goes through a merge request/);
  }
  assert.equal(git(origin, 'rev-parse', 'main').trim(), before);
  assert.equal(execFileSync('git', ['branch', '--list', 'master', 'release-1'], { cwd: origin }).toString().trim(), '');
});

test('abort with and without --discard, reset, and sandbox_unavailable, with worktrees', async () => {
  const env = await newEnv('abort', { SF_SANDBOX_DOMAINS: 'example.org' });
  const repo = await newRepo(env, 'abort-repo', false);
  for (const ticket of ['A-1', 'A-2', 'A-3', 'A-4']) {
    await putTask(env, repo, ticket, `Job ${ticket}`);
  }
  await script(env, [
    // The SDK closes stdin on abort and sends SIGTERM 2 s later; 5 s leaves 3 s for sf abort to arrive.
    { delayMs: 5000, write: { 'late.txt': 'never\n' } },
    { write: { 'y.txt': 'y\n', 'README.md': 'changed\n', 'debug.log': 'ignored\n' } },
    { write: { 'z.txt': 'z\n' } },
    { startupFailure: 'sandbox: bubblewrap is not installed' },
  ]);
  const served = await serve(env);
  const worktree = (ticket: string): string => worktreeOf(env, ticket);

  // abort while a turn runs: the session ends, the worktree and the branch stay.
  await call(served, 'start', { workspace: 'app', ticket: 'A-1' });
  await turnsStarted(env, 1);
  const aborted = await runCli(env, ['abort', 'app', 'A-1']);
  assert.equal(aborted.code, 0, aborted.stderr);
  assert.match(aborted.stdout, new RegExp(`^state: aborted\\nbranch: A-1-job-a-1\\ndiscarded: false\\nworktree: ${worktree('A-1')}\\nThe branch and its worktree are left as they are: ${worktree('A-1')}$`, 'm'));
  await new Promise((resolve) => setTimeout(resolve, 5500));
  await assert.rejects(stat(join(worktree('A-1'), 'late.txt')), { code: 'ENOENT' });
  const a1 = await call(served, 'check', { workspace: 'app', ticket: 'A-1' });
  assert.deepEqual([a1.state, a1.error], ['aborted', undefined]);
  assert.equal(git(worktree('A-1'), 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'A-1-job-a-1');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  assert.equal((await runCli(env, ['abort', 'app', 'A-1'])).code, 1);

  // abort --discard: refused during a rebase in the worktree, then the worktree and the branch are gone.
  await call(served, 'start', { workspace: 'app', ticket: 'A-2' });
  await waitFor(served, 'A-2', 'awaiting_review', 1);
  const gitDir = resolve(worktree('A-2'), execFileSync('git', ['rev-parse', '--git-dir'], { cwd: worktree('A-2'), encoding: 'utf8' }).trim());
  await mkdir(join(gitDir, 'rebase-merge'), { recursive: true });
  const busy = await runCli(env, ['abort', 'app', 'A-2', '--discard']);
  assert.equal(busy.code, 1);
  assert.match(busy.stderr, /^sf: A rebase or a Git lock is in progress/);
  assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'A-2' })).state, 'awaiting_review');
  await rm(join(gitDir, 'rebase-merge'), { recursive: true });
  const discarded = await runCli(env, ['abort', 'app', 'A-2', '--discard']);
  assert.equal(discarded.code, 0, discarded.stderr);
  assert.match(discarded.stdout, /^state: aborted\nbranch: A-2-job-a-2\ndiscarded: true\nworktree: null$/m);
  assert.equal(await exists(worktree('A-2')), false);
  assert.equal(git(repo, 'branch', '--list', 'A-2-job-a-2'), '');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'hello\n');
  assert.ok((await stat(join(repo, '.software-factory', 'A-2.md'))).isFile());

  // reset: the job directory is archived, the worktree removed, the branch untouched.
  await call(served, 'start', { workspace: 'app', ticket: 'A-3' });
  await waitFor(served, 'A-3', 'awaiting_review', 1);
  const reset = await runCli(env, ['reset', 'app', 'A-3']);
  assert.equal(reset.code, 0, reset.stderr);
  assert.match(reset.stdout, /^archived: jobs\/app\/A-3\.\d{8}T\d{6}Z\nbranch: A-3-job-a-3\nThe worktree is removed; the branch is untouched\.$/m);
  assert.equal((await refused(served, 'check', { workspace: 'app', ticket: 'A-3' })).code, 'job_not_found');
  assert.equal((await readdir(join(env.state, 'jobs', 'app'))).filter((name) => name.startsWith('A-3.')).length, 1);
  assert.equal(await exists(worktree('A-3')), false);
  assert.equal(git(repo, 'branch', '--list', 'A-3-job-a-3').trim(), 'A-3-job-a-3');
  assert.equal((await runCli(env, ['reset', 'app', 'A-3'])).code, 1);

  // A query that ends because the sandbox is unavailable.
  await call(served, 'start', { workspace: 'app', ticket: 'A-4' });
  const sandbox = await waitFor(served, 'A-4', 'needs_human');
  assert.deepEqual(sandbox.error, { code: 'sandbox_unavailable', message: 'sandbox: bubblewrap is not installed' });
  // reset works in any state, a live session included.
  assert.equal((await runCli(env, ['reset', 'app', 'A-4'])).code, 0);

  // reset of a finished job whose workspace was unregistered meanwhile: the record is archived,
  // Git is not touched (the aborted A-1 keeps its worktree).
  const registry = await readFile(join(env.config, 'workspaces.json'), 'utf8');
  await writeFile(join(env.config, 'workspaces.json'), '{"workspaces":{}}\n');
  const orphan = await runCli(env, ['reset', 'app', 'A-1']);
  assert.equal(orphan.code, 0, orphan.stderr);
  assert.match(orphan.stdout, /^checkout: unavailable$/m);
  assert.match(orphan.stdout, /only the job record was archived; nothing in Git was touched\.$/m);
  assert.equal((await refused(served, 'check', { workspace: 'app', ticket: 'A-1' })).code, 'job_not_found');
  assert.ok((await stat(worktree('A-1'))).isDirectory());
  await writeFile(join(env.config, 'workspaces.json'), registry);

  const log = await fakeLog(env);
  const settings = JSON.parse(log[0]!.argv[log[0]!.argv.indexOf('--settings') + 1]!);
  assert.deepEqual(settings.sandbox.network.allowedDomains, ['registry.npmjs.org', 'example.org']);
  assert.ok(log[0]!.env.includes('CLAUDE_CODE_STARTUP_FAILURE_RESULTS'));
  await stop(served);
});

test('SF_SANDBOX=off passes no sandbox to the Implementer; SF_MODEL arrives as --model', async () => {
  const env = await newEnv('nosandbox', { SF_SANDBOX: 'off', SF_MODEL: 'claude-test-model-1' });
  const repo = await newRepo(env, 'nosandbox-repo', false);
  await putTask(env, repo, 'S-1', 'No sandbox');
  await script(env, [{}]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'S-1' });
  await waitFor(served, 'S-1', 'awaiting_review', 1);
  const [entry] = await fakeLog(env);
  const index = entry!.argv.indexOf('--settings');
  assert.ok(index < 0 || JSON.parse(entry!.argv[index + 1]!).sandbox === undefined);
  // The SDK passes it inline (--model=<value>) or as two arguments.
  const separate = entry!.argv.indexOf('--model');
  const model = entry!.argv.find((arg) => arg.startsWith('--model='))?.slice('--model='.length) ?? (separate >= 0 ? entry!.argv[separate + 1] : undefined);
  assert.equal(model, 'claude-test-model-1', JSON.stringify(entry!.argv));
  // Not in the Implementer's environment: SF_* is filtered.
  assert.ok(!entry!.env.includes('SF_MODEL'));
  await stop(served);
});

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

test('notifications: desktop and ntfy for the user\'s states, silent iterations, the file lines at ready, notify_failed, notify-test', async () => {
  const received: Received[] = [];
  const ntfy = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((resolve) => ntfy.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(ntfy.address() as AddressInfo).port}/sf-test-topic`;
  const bin = join(temp, 'notify-bin');
  await mkdir(bin);
  const desktopLog = join(temp, 'notify-send.log');
  await writeFile(join(bin, 'notify-send'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a"; done >> '${desktopLog}'\nprintf '\\036' >> '${desktopLog}'\n`);
  await chmod(join(bin, 'notify-send'), 0o755);
  const env = await newEnv('notify', {
    PATH: `${bin}:${process.env.PATH}`, SF_DESKTOP_NOTIFY: 'on', SF_NTFY_URL: url, SF_NTFY_TOKEN: 'tk_test', SF_MAX_ITERATIONS: '1',
  });
  const desktop = async (): Promise<string[][]> => {
    const text = await readFile(desktopLog, 'utf8').catch(() => '');
    return text.split('\x1e').filter((entry) => entry !== '').map((entry) => entry.split('\x1f').slice(0, -1));
  };
  const until = async (condition: () => Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!(await condition())) {
      assert.ok(Date.now() < deadline, 'timed out');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const tested = await runCli(env, ['notify-test']);
  assert.equal(tested.code, 0, tested.stdout + tested.stderr);
  assert.equal(tested.stdout, 'desktop: sent (notify-send succeeded)\nntfy: sent (HTTP 200)\n');
  assert.equal(received.length, 1);
  assert.equal(received[0]!.headers.title, 'SF-TEST: pushed');
  assert.equal((await desktop()).length, 1);
  received.length = 0;
  await rm(desktopLog);

  const repo = await newRepo(env, 'notify-repo', false);
  await putTask(env, repo, 'N-1', 'Notify me');
  await script(env, [
    { text: 'iteration 1', write: { 'a.txt': 'a\n' } },
    { text: 'fixed' },
    { text: 'iteration 3', write: { 'package.json': '{}\n' }, run: [['rm', 'a.txt']] },
    { write: { '.software-factory/N-1.mr.md': mrText('feat(N-1): Notify me') }, text: 'prepared' },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'N-1' });
  await waitFor(served, 'N-1', 'awaiting_review', 1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await call(served, 'request_fix', { workspace: 'app', ticket: 'N-1', content: 'first' });
  await waitFor(served, 'N-1', 'awaiting_review', 2);
  // Iterations are silent.
  assert.deepEqual([received.length, (await desktop()).length], [0, 0]);

  assert.equal((await refused(served, 'request_fix', { workspace: 'app', ticket: 'N-1', content: 'more' })).code, 'iteration_limit');
  await until(async () => received.length === 1 && (await desktop()).length === 1);
  const body = 'branch: N-1-notify-me\niteration_limit: 1 Fix sections were written, the limit of SF_MAX_ITERATIONS; the user decides how to go on.';
  assert.equal(received[0]!.body, body);
  assert.deepEqual(
    [received[0]!.headers.title, received[0]!.headers.priority, received[0]!.headers.tags, received[0]!.headers.authorization],
    ['N-1: needs_human', 'high', 'warning', 'Bearer tk_test'],
  );
  assert.deepEqual((await desktop())[0], ['--app-name=Software Factory', 'N-1: needs_human', body]);

  // ntfy down: the failure is recorded, the job is unaffected, the desktop still notifies; the
  // ready notification names the MR title and the sensitive paths (the deleted line is the fourth, cut).
  await new Promise<void>((resolve) => ntfy.close(() => resolve()));
  await runCli(env, ['say', 'app', 'N-1', 'go', 'on']);
  await waitFor(served, 'N-1', 'awaiting_review', 3);
  await call(served, 'mark_clean', { workspace: 'app', ticket: 'N-1', sensitive: ['package.json'] });
  await waitFor(served, 'N-1', 'ready_for_human_review', 3);
  const events = join(env.state, 'jobs', 'app', 'N-1', 'events.jsonl');
  const failures = async (): Promise<Array<Record<string, unknown>>> =>
    (await readFile(events, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.type === 'notify_failed');
  await until(async () => (await failures()).length === 1 && (await desktop()).length === 2);
  const [failure] = await failures();
  assert.equal(failure!.channel, 'ntfy');
  assert.match(String(failure!.message), /fetch failed|ECONNREFUSED/);
  assert.deepEqual((await desktop())[1]!.slice(1), ['N-1: ready_for_human_review', 'branch: N-1-notify-me\nfeat(N-1): Notify me\nsensitive: package.json (undeclared); deleted: none']);
  assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'N-1' })).state, 'ready_for_human_review');
  assert.match((await runCli(env, ['watch', 'app', 'N-1', '--once'])).stdout, /\[3\] notification via ntfy failed: /);
  const down = await runCli(env, ['notify-test']);
  assert.equal(down.code, 1);
  assert.match(down.stdout, /^desktop: sent \(notify-send succeeded\)\nntfy: failed \(/);
  await stop(served);
});

test('SF_NOTIFY_ITERATIONS=on notifies awaiting_review on ntfy with the iteration and the file lines; off it stays silent', async () => {
  const received: Received[] = [];
  const ntfy = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((resolve) => ntfy.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(ntfy.address() as AddressInfo).port}/sf-iterations`;
  for (const [setting, expected] of [['on', 1], ['off', 0]] as const) {
    received.length = 0;
    const env = await newEnv(`notify-iterations-${setting}`, { SF_NTFY_URL: url, SF_NOTIFY_ITERATIONS: setting });
    const repo = await newRepo(env, `notify-iterations-${setting}-repo`, false);
    await putTask(env, repo, 'N-2', 'Notify iterations');
    await script(env, [{ text: 'iteration 1', write: { 'b.txt': 'b\n' }, run: [['rm', 'README.md']] }]);
    const served = await serve(env);
    await call(served, 'start', { workspace: 'app', ticket: 'N-2' });
    await waitFor(served, 'N-2', 'awaiting_review', 1);
    const deadline = Date.now() + 1000;
    while (received.length < expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(received.length, expected, setting);
    if (expected === 1) {
      assert.deepEqual(
        [received[0]!.headers.title, received[0]!.headers.priority, received[0]!.headers.tags, received[0]!.body],
        ['N-2: awaiting_review', 'default', 'eyes', 'Report and Patch of iteration 1 are ready for the reviewers\nsensitive: none; deleted: README.md'],
      );
    }
    await stop(served);
  }
  await new Promise<void>((resolve) => ntfy.close(() => resolve()));
});
