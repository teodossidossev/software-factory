// End-to-end tests of the MR preparation at Clean (mark_clean), the push at approve, abort, reset,
// the sandbox arguments and the notifications, with the fake Claude staging, committing and
// rebasing in the job's worktree like the Implementer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { JobStore } from '../src/jobs.js';
import { loadHandbook } from '../src/server.js';
import { pushBranch } from '../src/mr.js';
import { mrPrompt } from '../src/prompts.js';
import { call, fakeLog, git, newEnv, newRepo, putTask, refused, runCli, script, serve, stop, temp, waitFor } from './support/harness.js';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
const commit = (message: string): string[] => ['git', ...ID, 'commit', '-q', '-m', message];
const ADD = ['git', 'add', '-A'];
const REBASE = ['git', ...ID, 'rebase', '-q', 'origin/main'];

function mrText(header: string): string {
  return [
    header, '',
    '## What', 'Changes the README.', '## Why', 'The ticket asks for it.', '## How', 'One line.', '## Why the change', 'Readers need it.',
    '## Special things to note', '- None.', '## Change outline', '- README.md', '## Testing', 'npm test: passed', '## Screenshots', 'N/A',
    '## Checklist', '- [x] Branch name', '- [x] Target branch', '',
  ].join('\n');
}

// Pushes a commit adding path to origin/main from a separate clone.
function moveOrigin(origin: string, path: string): string {
  const other = join(temp, `move-${path.replace(/\W/g, '')}-${Date.now()}`);
  execFileSync('git', ['clone', '-q', origin, other]);
  execFileSync('sh', ['-c', 'echo upstream > "$1"', 'sh', path], { cwd: other });
  git(other, 'add', '.');
  git(other, 'commit', '-q', '-m', `upstream ${path}`);
  git(other, 'push', '-q', 'origin', 'main');
  return git(other, 'rev-parse', 'HEAD').trim();
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

// The commit of the job's snapshot ref in the checkout, or undefined when there is none.
function snapshotRefCommit(repo: string, ticket: string): string | undefined {
  try {
    return git(repo, 'rev-parse', '--verify', '--quiet', `refs/sf/snapshot/${ticket}`).trim();
  } catch {
    return undefined;
  }
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

test('mark_clean: each mr_* check fails in turn, retries keep the snapshot and the worktree, the last attempt rebases; approve refuses a hand-edited tip and pushes with --as-is', async () => {
  const env = await newEnv('approve', { SF_SANDBOX_DOMAINS: 'pypi.org' });
  const repo = await newRepo(env, 'approve-repo', true);
  const origin = join(temp, 'approve-repo-origin.git');
  await putTask(env, repo, 'T-1', 'Change README');
  const mrPath = '.software-factory/T-1.mr.md';
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'iteration 1' },
    // 1: nothing committed.
    { write: { [mrPath]: mrText('feat(T-1): Change the README') }, text: 'attempt 1' },
    // 2: a header that breaks the rules.
    { run: [ADD, commit('feat(T-1): Change the README.')], text: 'attempt 2' },
    // 3: two commits.
    { run: [['git', ...ID, 'commit', '-q', '--allow-empty', '-m', 'feat(T-1): Second']], text: 'attempt 3' },
    // 4: one good commit, but no MR text.
    { run: [['git', 'reset', '-q', '--soft', 'HEAD~2'], commit('feat(T-1): Change the README'), ['rm', mrPath]], text: 'attempt 4' },
    // 5: MR text back, but its title differs from the commit subject.
    { write: { [mrPath]: mrText('feat(T-1): Change the README file') }, text: 'attempt 5' },
    // 6: the right title, but origin/main moved and the branch is not rebased.
    { write: { [mrPath]: mrText('feat(T-1): Change the README') }, text: 'attempt 6' },
    // 7: rebased.
    { run: [REBASE], text: '# Report: T-1, MR preparation 7\n\n## Done\nRebased.' },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
  await waitFor(served, 'T-1', 'awaiting_review', 1);
  const branch = 'T-1-change-readme';
  const worktree = worktreeOf(env, 'T-1');

  const expectations: Array<[string, RegExp]> = [
    ['mr_dirty', /The work checkout has 1 uncommitted change\(s\): README\.md\./],
    ['mr_commit_header', /The commit header "feat\(T-1\): Change the README\." breaks the rules: it ends with a period\./],
    ['mr_commit_count', /T-1-change-readme has 2 commit\(s\) on top of the target; the rules want exactly 1\./],
    ['mr_text_missing', /\.software-factory\/T-1\.mr\.md does not exist\./],
    ['mr_text_invalid', /is invalid: its title "feat\(T-1\): Change the README file" differs from the commit subject "feat\(T-1\): Change the README"\./],
    ['mr_not_rebased', /T-1-change-readme does not contain the target commit [0-9a-f]{12}; it is not rebased\./],
  ];
  let upstream = '';
  for (const [index, [code, message]] of expectations.entries()) {
    if (code === 'mr_not_rebased') {
      upstream = moveOrigin(origin, 'other.txt');
    }
    // The first Clean from awaiting_review; every later one the retry from needs_human.
    assert.equal((await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' })).state, 'preparing_mr');
    const checked = await waitFor(served, 'T-1', 'needs_human');
    assert.equal(checked.error.code, code);
    assert.match(checked.error.message, message);
    const job = (await new JobStore(env.state).read('app', 'T-1'))!;
    assert.equal(job.mr_attempts, index + 1);
    // The worktree stays for the retry; approve has nothing to push yet.
    assert.equal(job.worktree, worktree);
    assert.equal((await approve(env, 'T-1')).code, 1);
    if (index === 0) {
      assert.equal((await refused(served, 'request_fix', { workspace: 'app', ticket: 'T-1', content: 'x' })).code, 'invalid_state');
    }
  }

  assert.equal((await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' })).state, 'preparing_mr');
  const ready = await waitFor(served, 'T-1', 'ready_for_human_review', 1);
  assert.equal(ready.mr, mrText('feat(T-1): Change the README'));
  // The worktree is gone, the branch has one commit on top of the moved main in the checkout.
  assert.equal(await exists(worktree), false);
  assert.equal(git(repo, 'rev-parse', `${branch}~1`).trim(), upstream);
  assert.equal(git(repo, 'log', '-1', '--format=%s', branch).trim(), 'feat(T-1): Change the README');
  const jobDir = join(env.state, 'jobs', 'app', 'T-1');
  assert.equal(await readFile(join(jobDir, 'mr.md'), 'utf8'), ready.mr);
  let job = (await new JobStore(env.state).read('app', 'T-1'))!;
  const prepared = git(repo, 'rev-parse', branch).trim();
  assert.deepEqual([job.target_commit, job.base_commit, job.prepared_commit, job.worktree, job.mr_attempts, job.iteration], [upstream, upstream, prepared, null, 7, 1]);
  // The snapshot of attempt 1 was kept through the retries; the target is the last one. Its commit
  // holds the reviewed tree on top of the base, and its ref stays until the job ends.
  const snapshot = JSON.parse(await readFile(join(jobDir, 'mr-snapshot.json'), 'utf8'));
  const original = git(repo, 'rev-parse', `${upstream}~1`).trim();
  assert.deepEqual(snapshot.paths, ['README.md']);
  assert.deepEqual([snapshot.target_ref, snapshot.target_commit, snapshot.base_commit], ['origin/main', upstream, original]);
  assert.equal(git(repo, 'rev-parse', `${snapshot.snapshot_commit}:README.md`).trim(), git(repo, 'rev-parse', `${branch}:README.md`).trim());
  assert.equal(snapshotRefCommit(repo, 'T-1'), snapshot.snapshot_commit);
  await assert.rejects(stat(join(jobDir, 'snapshot.index')), { code: 'ENOENT' });

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
  job = (await new JobStore(env.state).read('app', 'T-1'))!;
  assert.deepEqual([job.prepared_commit, job.mr_attempts], [edited, 7]);
  assert.equal(snapshotRefCommit(repo, 'T-1'), undefined);

  // The MR turns: the MR prompt and deny list; iterations keep the full deny list; sandbox on; every turn in the worktree.
  const log = await fakeLog(env);
  const handbook = (await loadHandbook()).text;
  assert.equal(log.length, 8);
  assert.equal(log[1]!.prompt, mrPrompt({ ticket: 'T-1', branch, targetRef: 'origin/main', targetCommit: original, attempt: 1, handbook }));
  assert.match(log[7]!.prompt, new RegExp(`^Target: origin/main at ${upstream}\\.$`, 'm'));
  assert.match(log[2]!.prompt, /This is attempt 2\. The previous attempt failed the factory's checks: The work checkout has 1 uncommitted change\(s\): README\.md\./);
  assert.doesNotMatch(log[1]!.prompt, /Rules from the Software Factory/);
  assert.ok(log.every((entry) => entry.cwd === worktree));
  const denied = (entry: { argv: string[] }): string => entry.argv.find((arg) => arg.startsWith('--disallowedTools='))!;
  assert.match(denied(log[0]!), /Bash\(git commit:\*\)/);
  for (const entry of log.slice(1)) {
    assert.doesNotMatch(denied(entry), /Bash\(git (commit|add|rebase):\*\)/);
    assert.match(denied(entry), /Bash\(git push:\*\)/);
    assert.ok(entry.argv.includes(`--resume=${log[0]!.sessionId}`));
  }
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

test('mark_clean: a prepared commit that differs from the reviewed change goes back to review against the target in the same worktree; a fix after Clean reopens the worktree and the next Clean amends', async () => {
  const env = await newEnv('diffcheck');
  const repo = await newRepo(env, 'diffcheck-repo', true);
  const origin = join(temp, 'diffcheck-repo-origin.git');
  await putTask(env, repo, 'D-1', 'Add files');
  const mrPath = '.software-factory/D-1.mr.md';
  await script(env, [
    { write: { 'a.txt': 'a\n' }, text: 'iteration 1' },
    // The Implementer touches one more file during preparation.
    { write: { 'b.txt': 'b\n', [mrPath]: mrText('feat(D-1): Add a and b') }, run: [ADD, commit('feat(D-1): Add a and b'), REBASE], text: 'Prepared; also added b.txt.' },
    // Second Clean: nothing to commit, nothing to rebase.
    { text: 'Nothing left to do.' },
    // A fix after Clean, in the reopened worktree.
    { write: { 'c.txt': 'c\n' }, text: 'iteration 3: added c' },
    // Its Clean amends the prepared commit.
    { write: { [mrPath]: mrText('feat(D-1): Add a, b and c') }, run: [['git', 'add', 'c.txt'], ['git', ...ID, 'commit', '-q', '--amend', '-m', 'feat(D-1): Add a, b and c']], text: 'Amended.' },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'D-1' });
  const first = await waitFor(served, 'D-1', 'awaiting_review', 1);
  const jobs = new JobStore(env.state);
  const oldBase = (await jobs.read('app', 'D-1'))!.base_commit;
  const upstream = moveOrigin(origin, 'up.txt');
  const worktree = worktreeOf(env, 'D-1');

  await call(served, 'mark_clean', { workspace: 'app', ticket: 'D-1' });
  const second = await waitFor(served, 'D-1', 'awaiting_review', 2);
  assert.match(second.report, /^Prepared; also added b\.txt\.\n\n## MR preparation\n\nThe prepared commit differs from the reviewed change in: b\.txt\. The Patch is now against the target origin\/main \([0-9a-f]{40}\)\.\n\n## Changed files\n/);
  // The Patch is against the target: both files, not the upstream change.
  assert.match(second.patch.text, /\+\+\+ b\/a\.txt/);
  assert.match(second.patch.text, /\+\+\+ b\/b\.txt/);
  assert.doesNotMatch(second.patch.text, /up\.txt/);
  assert.notEqual(second.patch.sha256, first.patch.sha256);
  assert.equal(second.mr, mrText('feat(D-1): Add a and b'));
  let job = (await jobs.read('app', 'D-1'))!;
  assert.deepEqual([job.base_commit, job.target_commit, job.worktree], [upstream, upstream, worktree]);
  assert.notEqual(oldBase, upstream);
  assert.throws(() => execFileSync('git', ['--git-dir', origin, 'rev-parse', '--verify', 'refs/heads/D-1-add-files'], { stdio: 'ignore' }));

  await call(served, 'mark_clean', { workspace: 'app', ticket: 'D-1' });
  await waitFor(served, 'D-1', 'ready_for_human_review', 2);
  assert.equal(await exists(worktree), false);
  const prepared = git(repo, 'rev-parse', 'D-1-add-files').trim();
  job = (await jobs.read('app', 'D-1'))!;
  assert.equal(job.prepared_commit, prepared);

  // request_fix from ready_for_human_review: the worktree is recreated from the branch, the next
  // iteration's Patch is the whole change against the target, and Clean amends the one commit.
  assert.deepEqual(await call(served, 'request_fix', { workspace: 'app', ticket: 'D-1', content: 'Add c.txt too.' }), { iteration: 3, check_after_minutes: 5 });
  const third = await waitFor(served, 'D-1', 'awaiting_review', 3);
  assert.match(third.patch.text, /\+\+\+ b\/a\.txt/);
  assert.match(third.patch.text, /\+\+\+ b\/c\.txt/);
  assert.equal(git(worktree, 'rev-parse', 'HEAD').trim(), prepared);
  await call(served, 'mark_clean', { workspace: 'app', ticket: 'D-1' });
  await waitFor(served, 'D-1', 'ready_for_human_review', 3);
  assert.equal(git(repo, 'rev-list', '--count', `${upstream}..D-1-add-files`).trim(), '1');
  assert.equal(git(repo, 'log', '-1', '--format=%s', 'D-1-add-files').trim(), 'feat(D-1): Add a, b and c');
  assert.equal(git(repo, 'show', 'D-1-add-files:c.txt'), 'c\n');
  job = (await jobs.read('app', 'D-1'))!;
  assert.notEqual(job.prepared_commit, prepared);
  assert.equal(job.worktree, null);

  const pushed = await approve(env, 'D-1');
  assert.equal(pushed.code, 0, pushed.stdout + pushed.stderr);
  assert.match(pushed.stdout, /^state: pushed\nbranch: D-1-add-files\ntitle: feat\(D-1\): Add a, b and c$/m);
  assert.equal(execFileSync('git', ['--git-dir', origin, 'rev-parse', 'refs/heads/D-1-add-files'], { encoding: 'utf8' }).trim(), job.prepared_commit);
  assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'D-1' })).state, 'pushed');
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
    {
      write: { '.software-factory/M-1.mr.md': mrText('feat(M-1): Edit line nine') },
      run: [['git', 'add', 'lines.txt'], commit('feat(M-1): Edit line nine'), REBASE],
      text: 'Prepared.',
    },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'M-1' });
  await waitFor(served, 'M-1', 'awaiting_review', 1);
  // The same file changes on the target, in line 1: a clean three-way merge.
  const upstream = pushToOrigin(origin, { 'lines.txt': lines({ 1: '1 upstream' }) }, 'upstream line one');
  await call(served, 'mark_clean', { workspace: 'app', ticket: 'M-1' });
  await waitFor(served, 'M-1', 'ready_for_human_review', 1);
  const job = (await new JobStore(env.state).read('app', 'M-1'))!;
  assert.deepEqual([job.iteration, job.target_commit], [1, upstream]);
  assert.equal(git(repo, 'show', 'M-1-edit-line-nine:lines.txt'), lines({ 1: '1 upstream', 9: '9 change' }));
  const pushed = await approve(env, 'M-1');
  assert.equal(pushed.code, 0, pushed.stdout + pushed.stderr);
  assert.match(pushed.stdout, /^state: pushed\nbranch: M-1-edit-line-nine\ntitle: feat\(M-1\): Edit line nine$/m);
  assert.equal(execFileSync('git', ['--git-dir', origin, 'show', 'M-1-edit-line-nine:lines.txt'], { encoding: 'utf8' }), lines({ 1: '1 upstream', 9: '9 change' }));
  assert.equal(snapshotRefCommit(repo, 'M-1'), undefined);
  await stop(served);
});

test('mark_clean: the target moved in the same hunk; the resolved conflict goes back to review naming the file, the next Clean is ready', async () => {
  const env = await newEnv('mergeconflict');
  const { repo, origin } = await linesRepo(env, 'mergeconflict-repo');
  await putTask(env, repo, 'M-2', 'Edit line nine');
  const resolved = lines({ 9: '9 change and upstream' });
  const rebaseResolving = [
    'sh', '-c',
    'git -c user.name=t -c user.email=t@example.invalid rebase -q origin/main >/dev/null 2>&1 || '
      + '{ printf "%s" "$1" > lines.txt && git add lines.txt && GIT_EDITOR=true git -c user.name=t -c user.email=t@example.invalid rebase --continue >/dev/null; }',
    'sh', resolved,
  ];
  await script(env, [
    { write: { 'lines.txt': lines({ 9: '9 change' }) }, text: 'iteration 1' },
    {
      write: { '.software-factory/M-2.mr.md': mrText('feat(M-2): Edit line nine') },
      run: [['git', 'add', 'lines.txt'], commit('feat(M-2): Edit line nine'), rebaseResolving],
      text: 'Prepared; resolved a conflict in lines.txt.',
    },
    { text: 'Nothing left to do.' },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'M-2' });
  await waitFor(served, 'M-2', 'awaiting_review', 1);
  const upstream = pushToOrigin(origin, { 'lines.txt': lines({ 9: '9 upstream' }) }, 'upstream line nine');

  await call(served, 'mark_clean', { workspace: 'app', ticket: 'M-2' });
  const second = await waitFor(served, 'M-2', 'awaiting_review', 2);
  assert.match(second.report, /\n## MR preparation\n\nThe prepared commit differs from the reviewed change in: lines\.txt\. /);
  assert.match(second.patch.text, /^-9 upstream\n\+9 change and upstream$/m);
  // The snapshot ref stays until the job ends; the snapshot holds the reviewed content.
  const jobDir = join(env.state, 'jobs', 'app', 'M-2');
  const first = JSON.parse(await readFile(join(jobDir, 'mr-snapshot.json'), 'utf8'));
  assert.equal(snapshotRefCommit(repo, 'M-2'), first.snapshot_commit);
  assert.equal(git(repo, 'show', `${first.snapshot_commit}:lines.txt`), lines({ 9: '9 change' }));

  // The next Clean replaces the snapshot (now against the target) and readies the branch.
  await call(served, 'mark_clean', { workspace: 'app', ticket: 'M-2' });
  await waitFor(served, 'M-2', 'ready_for_human_review', 2);
  const next = JSON.parse(await readFile(join(jobDir, 'mr-snapshot.json'), 'utf8'));
  assert.deepEqual([next.base_commit, next.target_commit, next.paths], [upstream, upstream, ['lines.txt']]);
  assert.notEqual(next.snapshot_commit, first.snapshot_commit);
  const pushed = await approve(env, 'M-2');
  assert.equal(pushed.code, 0, pushed.stdout + pushed.stderr);
  assert.equal(snapshotRefCommit(repo, 'M-2'), undefined);
  assert.equal(execFileSync('git', ['--git-dir', origin, 'show', 'M-2-edit-line-nine:lines.txt'], { encoding: 'utf8' }), resolved);
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
    { write: { '.software-factory/R-1.mr.md': mrText('fix(R-1): Retry the README') }, run: [['git', 'add', 'README.md'], commit('fix(R-1): Retry the README')] },
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

test('mark_clean: placeholders the sandbox creates during the MR turn do not fail mr_dirty; the branch holds the change only', async () => {
  const env = await newEnv('mrplaceholders');
  const repo = await newRepo(env, 'mrplaceholders-repo', true);
  await putTask(env, repo, 'P-2', 'Placeholders on approve');
  const placeholders = ['.bashrc', '.gitconfig', '.mcp.json', '.claude/settings.json', '.claude/skills', '.claude/.cc-writes/'];
  await script(env, [
    { write: { 'README.md': 'prepared\n' }, placeholders },
    // The MR turn stages by path; running the checks recreates the placeholders.
    {
      write: { '.software-factory/P-2.mr.md': mrText('feat(P-2): Prepare the README') },
      run: [['git', 'add', 'README.md'], commit('feat(P-2): Prepare the README')],
      placeholders,
    },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'P-2' });
  await waitFor(served, 'P-2', 'awaiting_review', 1);
  await call(served, 'mark_clean', { workspace: 'app', ticket: 'P-2' });
  await waitFor(served, 'P-2', 'ready_for_human_review', 1);
  const files = git(repo, 'show', '--name-only', '--format=', 'P-2-placeholders-on-approve').trim();
  assert.equal(files, 'README.md');
  const snapshot = JSON.parse(await readFile(join(env.state, 'jobs', 'app', 'P-2', 'mr-snapshot.json'), 'utf8'));
  assert.deepEqual(snapshot.paths, ['README.md']);
  assert.equal(git(repo, 'diff', '--name-only', snapshot.base_commit, snapshot.snapshot_commit).trim(), 'README.md');
  const logged = (await readFile(join(env.state, 'jobs', 'app', 'P-2', 'events.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.type === 'placeholders_removed');
  const expected = ['.bashrc', '.claude', '.claude/.cc-writes', '.claude/settings.json', '.claude/skills', '.gitconfig', '.mcp.json'];
  assert.deepEqual(logged.map((record) => [record.iteration, record.paths]), [[1, expected], [2, expected]]);
  assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all').replace(/^\?\? \.software-factory\/.*\n/gm, ''), '');
  await stop(served);
});

test('mark_clean is refused in needs_human before any MR preparation; approve is refused without a prepared branch', async () => {
  const env = await newEnv('noretry', { SF_MAX_ITERATIONS: '1' });
  const repo = await newRepo(env, 'noretry-repo', false);
  await putTask(env, repo, 'R-2', 'No retry');
  await script(env, [{}]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'R-2' });
  await waitFor(served, 'R-2', 'awaiting_review', 1);
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

  // A snapshot ref as Clean leaves it; abort (with or without --discard) and reset delete it.
  const fakeSnapshotRef = (ticket: string): void => {
    git(repo, 'update-ref', `refs/sf/snapshot/${ticket}`, git(repo, 'rev-parse', 'main').trim());
  };
  for (const ticket of ['A-1', 'A-2', 'A-3']) {
    fakeSnapshotRef(ticket);
  }

  // abort while a turn runs: the session ends, the worktree and the branch stay.
  await call(served, 'start', { workspace: 'app', ticket: 'A-1' });
  const aborted = await runCli(env, ['abort', 'app', 'A-1']);
  assert.equal(aborted.code, 0, aborted.stderr);
  assert.match(aborted.stdout, new RegExp(`^state: aborted\\nbranch: A-1-job-a-1\\ndiscarded: false\\nworktree: ${worktree('A-1')}\\nThe branch and its worktree are left as they are: ${worktree('A-1')}$`, 'm'));
  await new Promise((resolve) => setTimeout(resolve, 5500));
  await assert.rejects(stat(join(worktree('A-1'), 'late.txt')), { code: 'ENOENT' });
  const a1 = await call(served, 'check', { workspace: 'app', ticket: 'A-1' });
  assert.deepEqual([a1.state, a1.error], ['aborted', undefined]);
  assert.equal(git(worktree('A-1'), 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'A-1-job-a-1');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  assert.equal(snapshotRefCommit(repo, 'A-1'), undefined);
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
  assert.equal(snapshotRefCommit(repo, 'A-2'), undefined);
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
  assert.equal(snapshotRefCommit(repo, 'A-3'), undefined);
  assert.equal((await runCli(env, ['reset', 'app', 'A-3'])).code, 1);

  // A query that ends because the sandbox is unavailable.
  await call(served, 'start', { workspace: 'app', ticket: 'A-4' });
  const sandbox = await waitFor(served, 'A-4', 'needs_human');
  assert.deepEqual(sandbox.error, { code: 'sandbox_unavailable', message: 'sandbox: bubblewrap is not installed' });
  // reset works in any state, a live session included.
  assert.equal((await runCli(env, ['reset', 'app', 'A-4'])).code, 0);

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
    { text: 'iteration 2', write: { 'package.json': '{}\n' }, run: [['rm', 'a.txt']] },
    { write: { '.software-factory/N-1.mr.md': mrText('feat(N-1): Notify me') }, run: [['git', 'add', 'package.json'], commit('feat(N-1): Notify me')], text: 'prepared' },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'N-1' });
  await waitFor(served, 'N-1', 'awaiting_review', 1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Iterations are silent.
  assert.deepEqual([received.length, (await desktop()).length], [0, 0]);

  assert.equal((await refused(served, 'request_fix', { workspace: 'app', ticket: 'N-1', content: 'more' })).code, 'iteration_limit');
  await until(async () => received.length === 1 && (await desktop()).length === 1);
  const body = 'branch: N-1-notify-me\niteration_limit: 1 iterations were published without Clean; the user decides how to go on.';
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
  await waitFor(served, 'N-1', 'awaiting_review', 2);
  await call(served, 'mark_clean', { workspace: 'app', ticket: 'N-1', sensitive: ['package.json'] });
  await waitFor(served, 'N-1', 'ready_for_human_review', 2);
  const events = join(env.state, 'jobs', 'app', 'N-1', 'events.jsonl');
  const failures = async (): Promise<Array<Record<string, unknown>>> =>
    (await readFile(events, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.type === 'notify_failed');
  await until(async () => (await failures()).length === 1 && (await desktop()).length === 2);
  const [failure] = await failures();
  assert.equal(failure!.channel, 'ntfy');
  assert.match(String(failure!.message), /fetch failed|ECONNREFUSED/);
  assert.deepEqual((await desktop())[1]!.slice(1), ['N-1: ready_for_human_review', 'branch: N-1-notify-me\nfeat(N-1): Notify me\nsensitive: package.json (undeclared)']);
  assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'N-1' })).state, 'ready_for_human_review');
  assert.match((await runCli(env, ['watch', 'app', 'N-1', '--once'])).stdout, /\[2\] notification via ntfy failed: /);
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
        ['N-2: awaiting_review', 'default', 'eyes', 'Report and Patch of iteration 1 are ready for the Context owner\nsensitive: none\ndeleted: README.md'],
      );
    }
    await stop(served);
  }
  await new Promise<void>((resolve) => ntfy.close(() => resolve()));
});
