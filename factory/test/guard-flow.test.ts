// End-to-end tests of the guard (SF-122) with the real sf serve and CLI: the change check at Clean
// and its Guard fixes, the MR text check and its turns, the factory's lines of the MR text cleaned,
// the push and merge request refusals, the secrets of an unguarded workspace, and sf guard.
// Every secret-looking fixture is built at run time.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { JobStore } from '../src/jobs.js';
import { mrMessage, pushBranch } from '../src/mr.js';
import { act, fetchRaw } from './support/dashboard-client.js';
import { startFakeForge } from './support/fake-forge.js';
import { call, type Env, fakeLog, git, newEnv, newRepo, putTask, reviewLog, reviewScript, runCli, script, serve, stop, temp, waitFor } from './support/harness.js';

const TITLE = 'feat(T-1): Change the README';
const NOTE_LINE = 11;

// A valid MR text; note is the line of "## Special things to note" (line NOTE_LINE + 1).
function mrText(header: string, note = '- None.'): string {
  return [
    header, '',
    '## What', 'Changes the README.', '## Why', 'The ticket asks for it.', '## How', 'One line.', '## Why the change', 'Readers need it.',
    '## Special things to note', note, '## Change outline', '- README.md', '## Testing', 'npm test: passed', '## Screenshots', 'N/A',
    '## Checklist', '- [x] Branch name', '- [x] Target branch', '',
  ].join('\n');
}

// Workspace app (guarded or not) with an origin, and a second workspace product-frontend with a
// Task file ABC-1.md, set in workspaces.json by hand.
async function guardEnv(name: string, guard: boolean, extra: Record<string, string> = {}): Promise<{ env: Env; repo: string; origin: string }> {
  const env = await newEnv(name, extra);
  const repo = await newRepo(env, `${name}-repo`, true);
  const pf = join(temp, `${name}-pf`);
  await mkdir(join(pf, '.software-factory'), { recursive: true });
  git(pf, 'init', '-q', '-b', 'main');
  // A public address: the global one of the test's home would be a domain term.
  git(pf, 'config', 'user.email', 'me@users.noreply.github.com');
  await writeFile(join(pf, '.software-factory', 'ABC-1.md'), '# ABC-1\n');
  git(pf, 'add', '.');
  git(pf, 'commit', '-q', '-m', 'task');
  await writeFile(join(env.config, 'workspaces.json'), `${JSON.stringify({ workspaces: { app: { read_checkout: repo, ...(guard ? { guard: true } : {}) }, 'product-frontend': { read_checkout: pf } } }, null, 2)}\n`);
  return { env, repo, origin: join(temp, `${name}-repo-origin.git`) };
}

const taskText = (repo: string, ticket: string): Promise<string> => readFile(join(repo, '.software-factory', `${ticket}.md`), 'utf8');
const jobJson = (env: Env, ticket: string): Promise<string> => readFile(join(env.state, 'jobs', 'app', ticket, 'job.json'), 'utf8');

function onOrigin(origin: string, branch: string): boolean {
  try {
    execFileSync('git', ['--git-dir', origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Every file under dir, as text.
async function allText(dir: string): Promise<string> {
  let text = '';
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      text += await readFile(join(entry.parentPath, entry.name), 'utf8').catch(() => '');
    }
  }
  return text;
}

test('Clean: a ticket key of another workspace is a Guard fix naming its place; the next iteration removes it and MR preparation goes on to ready', async () => {
  const { env, repo } = await guardEnv('guard-fix', true);
  await putTask(env, repo, 'T-1', 'Change README');
  await script(env, [
    { write: { 'src/a.txt': 'one\nsee ABC-123 here\n' }, text: 'iteration 1' },
    { write: { 'src/a.txt': 'one\nsee the other ticket here\n' }, text: 'iteration 2' },
    { write: { '.software-factory/T-1.mr.md': mrText(TITLE) }, text: 'prepared' },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    assert.equal((await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' })).state, 'working');
    await waitFor(served, 'T-1', 'awaiting_review', 2);
    const task = await taskText(repo, 'T-1');
    assert.ok(task.includes([
      '## Fix 1: Guard', '',
      "The guard of this workspace found text that must not be published in this repository: a name, Git host, ticket key or email domain of the user's other workspaces, or a term of the user's private list. Remove or reword each place below (its line, column and length mark the text); do not move the text to another file, comment or test fixture.",
      '',
      '- G1: src/a.txt:2:5 (7 characters, ticket key of another workspace)',
    ].join('\n')), task);
    assert.equal(task.includes('ABC-123'), false);
    assert.equal((await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' })).state, 'preparing_mr');
    await waitFor(served, 'T-1', 'ready_for_human_review', 2);
  } finally {
    await stop(served);
  }
});

test('Clean: a term never removed stops the job after two Guard fixes, each reviewed; a "!" line and sf retry go on to the MR text turn and ready', async () => {
  const { env, repo } = await guardEnv('guard-stop', true, { SF_REVIEW: 'on' });
  await putTask(env, repo, 'T-1', 'Change README');
  await script(env, [
    { write: { 'src/a.txt': 'one\nsee ABC-123 here\n' }, text: 'iteration 1' },
    { write: { 'b.txt': 'b\n' }, text: 'iteration 2' },
    { write: { 'c.txt': 'c\n' }, text: 'iteration 3' },
    { write: { '.software-factory/T-1.mr.md': mrText(TITLE) }, text: 'prepared' },
  ]);
  const clean = { output: { verdict: 'clean', summary: 'Right.', items: [], accepted_sensitive: [] } };
  await reviewScript(env, [clean, clean, clean]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    const stopped = await waitFor(served, 'T-1', 'needs_human', 3);
    assert.equal((await reviewLog(env)).length, 3);
    assert.equal(stopped.error.code, 'guard_hit');
    assert.equal(stopped.error.message, 'The guard found text that must not be published in this repository, after 2 Guard fixes: src/a.txt:2:5 (7 characters, ticket key of another workspace). Remove it (sf say, or by hand and sf say), or drop a false positive with a "!" line in guard-terms.txt and sf retry. See the matches with: sf guard app --worktree T-1');
    assert.equal((await taskText(repo, 'T-1')).match(/^## Fix \d+: Guard$/gm)?.length, 2);

    await writeFile(join(env.config, 'guard-terms.txt'), '!ABC\n');
    const retried = await runCli(env, ['retry', 'app', 'T-1']);
    assert.equal(retried.code, 0, retried.stdout + retried.stderr);
    await waitFor(served, 'T-1', 'ready_for_human_review', 3);
  } finally {
    await stop(served);
  }
});

test('the MR text: a name of another workspace gets a second MR text turn told the place; three turns that keep it stop the job', async () => {
  const { env, repo } = await guardEnv('guard-mr', true);
  const named = mrText(TITLE, '- Shared with product-frontend.');
  const named2 = mrText('feat(T-2): Change the README', '- Shared with product-frontend.');
  await putTask(env, repo, 'T-1', 'Change README');
  await putTask(env, repo, 'T-2', 'Change README again');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'iteration 1' },
    { write: { '.software-factory/T-1.mr.md': named }, text: 'prepared' },
    { write: { '.software-factory/T-1.mr.md': mrText(TITLE) }, text: 'prepared again' },
    { write: { 'README.md': 'hello again\n' }, text: 'iteration 1' },
    { write: { '.software-factory/T-2.mr.md': named2 }, text: 'prepared' },
    { write: { '.software-factory/T-2.mr.md': named2 }, text: 'prepared' },
    { write: { '.software-factory/T-2.mr.md': named2 }, text: 'prepared' },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    const ready = await waitFor(served, 'T-1', 'ready_for_human_review', 1);
    assert.equal(ready.mr, mrText(TITLE));
    const place = `MR text:${NOTE_LINE + 1}:15 (16 characters, name of another workspace)`;
    const log = await fakeLog(env);
    assert.equal(log.length, 3);
    assert.ok(log[2]!.prompt.includes(`This is attempt 2. The previous attempt failed: The guard found text that must not be published in this repository in your MR text: ${place}. Write the MR text again without it.`), log[2]!.prompt);
    assert.equal((await new JobStore(env.state).read('app', 'T-1'))!.mr_attempts, 2);

    await call(served, 'start', { workspace: 'app', ticket: 'T-2' });
    await waitFor(served, 'T-2', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-2' });
    const stopped = await waitFor(served, 'T-2', 'needs_human', 1);
    assert.equal(stopped.error.code, 'guard_hit');
    assert.equal(stopped.error.message, `The guard found text that must not be published in this repository in the MR text, after 3 MR text turns: ${place}. Tell the Implementer how to word it (sf say; its iteration is reviewed again), or run sf retry for new MR text turns.`);
    assert.equal((await fakeLog(env)).length, 7);
  } finally {
    await stop(served);
  }
});

test('the MR text: a review nit holding a private term reaches it as [removed by the guard], with no extra MR text turn', async () => {
  const { env, repo } = await guardEnv('guard-nit', true, { SF_REVIEW: 'on' });
  await writeFile(join(env.config, 'guard-terms.txt'), 'ACME\n');
  await putTask(env, repo, 'T-1', 'Change README');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'iteration 1' },
    { write: { '.software-factory/T-1.mr.md': mrText(TITLE) }, text: 'prepared' },
  ]);
  await reviewScript(env, [
    { output: { verdict: 'clean', summary: 'Right.', items: [{ path: 'README.md', problem: 'ACME style is off.', expected: 'Nicer.', severity: 'nit' }], accepted_sensitive: [] } },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    const ready = await waitFor(served, 'T-1', 'ready_for_human_review', 1);
    assert.ok(ready.mr.includes('- [nit] `README.md`: [removed by the guard] style is off. Expected: Nicer.'), ready.mr);
    assert.equal(ready.mr.includes('ACME'), false);
    assert.equal((await fakeLog(env)).length, 2);
  } finally {
    await stop(served);
  }
});

test('a workspace without guard: the same change goes to ready with no Guard fix', async () => {
  const { env, repo } = await guardEnv('guard-off', false);
  await putTask(env, repo, 'T-1', 'Change README');
  await script(env, [
    { write: { 'src/a.txt': 'one\nsee ABC-123 here\n' }, text: 'iteration 1' },
    { write: { '.software-factory/T-1.mr.md': mrText(TITLE, '- Shared with product-frontend.') }, text: 'prepared' },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    assert.equal((await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' })).state, 'preparing_mr');
    await waitFor(served, 'T-1', 'ready_for_human_review', 1);
    assert.equal((await taskText(repo, 'T-1')).includes('## Fix'), false);
  } finally {
    await stop(served);
  }
});

test('the push: a term in the branch name refuses sf approve (--as-is too) and sf mr create before anything is pushed; then the merge request of the pushed job', async () => {
  const fake = await startFakeForge('github', 'owner/app');
  const { env, repo, origin } = await guardEnv('guard-push', true);
  await writeFile(join(env.config, 'auth.env'), `SF_GITHUB_TOKEN=tok${'e'.repeat(20)}\nSF_GITHUB_API=${fake.url}\n`);
  await putTask(env, repo, 'T-1', 'Change zebra docs');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'iteration 1' },
    { write: { '.software-factory/T-1.mr.md': mrText(TITLE) }, text: 'prepared' },
  ]);
  const branch = 'T-1-change-zebra-docs';
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'ready_for_human_review', 1);
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/owner/app.git');
    git(repo, 'remote', 'set-url', '--push', 'origin', origin);
    await writeFile(join(env.config, 'guard-terms.txt'), 'zebra\n');
    const before = await jobJson(env, 'T-1');
    const refusal = /^sf: The guard refused the push of app\/T-1: branch name:12 \(5 characters, private list line 1\)\. See the matches with: sf guard app [0-9a-f]{12} --mr T-1$/m;
    for (const args of [['approve', 'app', 'T-1'], ['approve', 'app', 'T-1', '--as-is'], ['mr', 'create', 'app', 'T-1']]) {
      const refused = await runCli(env, args);
      assert.equal(refused.code, 1, args.join(' '));
      assert.match(refused.stderr, refusal);
      assert.equal(`${refused.stdout}${refused.stderr}`.includes('zebra'), false);
      assert.equal(onOrigin(origin, branch), false);
      assert.equal(await jobJson(env, 'T-1'), before);
    }
    assert.deepEqual(fake.requests, []);

    await writeFile(join(env.config, 'guard-terms.txt'), '');
    const pushed = await runCli(env, ['approve', 'app', 'T-1']);
    assert.equal(pushed.code, 0, pushed.stdout + pushed.stderr);
    assert.equal(onOrigin(origin, branch), true);

    await writeFile(join(env.config, 'guard-terms.txt'), 'zebra\n');
    const mr = await runCli(env, ['mr', 'create', 'app', 'T-1']);
    assert.equal(mr.code, 1);
    assert.match(mr.stderr, /^sf: The guard refused the merge request of app\/T-1: branch name:12 \(5 characters, private list line 1\)\. See the matches with: sf guard app --mr T-1$/m);
    assert.deepEqual(fake.requests, []);
    const job = (await new JobStore(env.state).read('app', 'T-1'))!;
    assert.deepEqual([job.state, job.mr], ['pushed', null]);
  } finally {
    await stop(served);
    await fake.close();
  }
});

test('the push of LFS files: a guarded workspace refuses sf approve before anything is pushed, naming at most 5 paths; without the guard flag git lfs push goes first', async (t) => {
  const { env, repo, origin } = await guardEnv('guard-lfs', true);
  // A fake git-lfs on the PATH of sf serve and the CLI: it logs its arguments.
  const bin = join(temp, 'guard-lfs-bin');
  const log = join(temp, 'guard-lfs.log');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'git-lfs'), `#!/bin/sh\necho "$*" >> '${log}'\nexit 0\n`);
  await chmod(join(bin, 'git-lfs'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path ?? ''}`;
  t.after(() => {
    process.env.PATH = path;
  });
  const lfsCalls = async (): Promise<string[]> => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((line) => line !== '');
  const files = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => [`${name}.bin`, `${name}\n`]));
  // The base tracks *.bin with LFS; the job adds seven of them.
  await writeFile(join(repo, '.gitattributes'), '*.bin filter=lfs\n');
  git(repo, 'add', '.gitattributes');
  git(repo, 'commit', '-q', '-m', 'lfs attributes');
  git(repo, 'push', '-q', 'origin', 'main');
  await putTask(env, repo, 'T-1', 'Change README');
  await script(env, [
    { write: files, text: 'iteration 1' },
    { write: { '.software-factory/T-1.mr.md': mrText(TITLE) }, text: 'prepared' },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'ready_for_human_review', 1);
    const before = await jobJson(env, 'T-1');
    const { branch, prepared_commit: prepared } = JSON.parse(before) as { branch: string; prepared_commit: string };
    for (const args of [['approve', 'app', 'T-1'], ['approve', 'app', 'T-1', '--as-is']]) {
      const refused = await runCli(env, args);
      assert.equal(refused.code, 1, args.join(' '));
      assert.match(refused.stderr, /^sf: The guard cannot read LFS content; this workspace is guarded, so LFS files are not pushed: a\.bin, b\.bin, c\.bin, d\.bin, e\.bin and 2 more$/m);
      assert.equal(onOrigin(origin, branch), false);
      assert.equal(await jobJson(env, 'T-1'), before);
      assert.deepEqual(await lfsCalls(), []);
    }

    // The same push in the workspace without the guard flag.
    const registry = join(env.config, 'workspaces.json');
    const workspaces = JSON.parse(await readFile(registry, 'utf8')) as { workspaces: { app: { guard?: boolean } } };
    delete workspaces.workspaces.app.guard;
    await writeFile(registry, `${JSON.stringify(workspaces, null, 2)}\n`);
    const pushed = await runCli(env, ['approve', 'app', 'T-1']);
    assert.equal(pushed.code, 0, pushed.stdout + pushed.stderr);
    assert.equal(onOrigin(origin, branch), true);
    assert.deepEqual(await lfsCalls(), ['version', `push origin ${prepared}`]);
  } finally {
    await stop(served);
  }
});

test('the push sends the commit the guard checked: a commit added to the branch after the check is not published', async () => {
  const env = await newEnv('guard-exact');
  const repo = await newRepo(env, 'guard-exact-repo', true);
  const origin = join(temp, 'guard-exact-repo-origin.git');
  git(repo, 'checkout', '-q', '-b', 'T-1-x');
  await writeFile(join(repo, 'a.txt'), 'checked\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'checked');
  const checked = git(repo, 'rev-parse', 'HEAD').trim();
  // The branch moves on after the check, as a commit in the user's checkout would.
  await writeFile(join(repo, 'a.txt'), 'never checked\n');
  git(repo, 'commit', '-q', '-am', 'later');
  assert.equal(await pushBranch(repo, 'T-1-x', 'main', checked), undefined);
  assert.equal(execFileSync('git', ['--git-dir', origin, 'rev-parse', 'refs/heads/T-1-x'], { encoding: 'utf8' }).trim(), checked);
  // The remote-tracking ref follows, so the next check starts after it.
  assert.equal(git(repo, 'rev-parse', 'refs/remotes/origin/T-1-x').trim(), checked);
});

test('an invalid MR text never carries a secret into its refusal, also one past the 100 characters it quotes: a saved text at the push, the Implementer\'s at MR preparation (Fix 3, Fix 4)', async () => {
  const { env, repo, origin } = await guardEnv('guard-mrtext', false);
  const secret = `tok${'V'.repeat(20)}`;
  await writeFile(join(env.config, 'auth.env'), `SF_GITHUB_TOKEN=${secret}\n`);
  const masked = '*'.repeat(secret.length);
  // A title whose secret starts at character 98: the problem quotes its first 100 characters.
  const long = (ticket: string): string => `feat(${ticket}): ${'w'.repeat(86)} ${secret}.`;
  await putTask(env, repo, 'T-1', 'Change README');
  await putTask(env, repo, 'T-2', 'Change README again');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'iteration 1' },
    { write: { '.software-factory/T-1.mr.md': mrText(TITLE) }, text: 'prepared' },
    { write: { 'README.md': 'hello again\n' }, text: 'iteration 1' },
    // A title with a trailing period is invalid; it holds the secret.
    { write: { '.software-factory/T-2.mr.md': mrText(long('T-2')) }, text: 'prepared' },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'ready_for_human_review', 1);
    // A saved MR text that fails the rules (as one saved before a rule changed).
    const jobs = new JobStore(env.state);
    await jobs.writeMrFactoryText('app', 'T-1', mrText(TITLE));
    await jobs.writeMrText('app', 'T-1', mrText(`feat(T-1): Use ${secret}.`));
    const refused = await runCli(env, ['approve', 'app', 'T-1']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^sf: The MR text is invalid: its first line "feat\(T-1\): Use \*+\." is not a valid title/m);
    assert.ok(refused.stderr.includes(masked), refused.stderr);
    assert.equal(`${refused.stdout}${refused.stderr}`.includes(secret), false);
    assert.equal(onOrigin(origin, 'T-1-change-readme'), false);
    // The secret past the quoted 100 characters: masked before it is cut, no part of it shown.
    await jobs.writeMrText('app', 'T-1', mrText(long('T-1')));
    const cut = await runCli(env, ['approve', 'app', 'T-1']);
    assert.equal(cut.code, 1);
    assert.match(cut.stderr, /^sf: The MR text is invalid: its first line "feat\(T-1\): w{86} \*\*" is not a valid title/m);
    assert.equal(`${cut.stdout}${cut.stderr}`.includes(`${'w'.repeat(86)} to`), false);
    assert.equal(onOrigin(origin, 'T-1-change-readme'), false);

    await call(served, 'start', { workspace: 'app', ticket: 'T-2' });
    await waitFor(served, 'T-2', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-2' });
    const stopped = await waitFor(served, 'T-2', 'needs_human', 1);
    assert.equal(stopped.error.code, 'mr_text_invalid');
    assert.ok(stopped.error.message.includes(` ${'w'.repeat(86)} **"`), stopped.error.message);
    assert.equal(stopped.error.message.includes(`${'w'.repeat(86)} to`), false, stopped.error.message);
    assert.equal((await jobJson(env, 'T-2')).includes(secret), false);
  } finally {
    await stop(served);
  }
});

test('the Merge request screen never shows a secret: a Save refused for a title whose secret runs past the quoted 100 characters, the listed problems of a saved text', async () => {
  const { env, repo } = await guardEnv('guard-screen', false);
  const secret = `tok${'S'.repeat(20)}`;
  await writeFile(join(env.config, 'auth.env'), `SF_GITHUB_TOKEN=${secret}\n`);
  await putTask(env, repo, 'T-1', 'Change README');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'iteration 1' },
    { write: { '.software-factory/T-1.mr.md': mrText(TITLE) }, text: 'prepared' },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'ready_for_human_review', 1);
    const body = mrMessage(mrText(TITLE)).body;
    // The secret starts at character 98 of the title; the refusal quotes 100.
    const saved = await act(served.dashboard!, 'api/jobs/app/T-1/mr-save', { title: `feat(T-1): ${'w'.repeat(86)} ${secret}`, body });
    assert.notEqual(saved.status, 200, saved.body);
    assert.ok(saved.body.includes(`${'w'.repeat(86)} **`), saved.body);
    assert.equal(saved.body.includes(`${'w'.repeat(86)} to`), false, saved.body);
    assert.equal(saved.body.includes(secret), false);

    // A saved text whose ## Testing claim quotes 90 characters, the secret from character 89 on.
    const claim = `Manually checked ${'w'.repeat(70)} ${secret}`;
    await new JobStore(env.state).writeMrText('app', 'T-1', mrText(TITLE).replace('npm test: passed', claim));
    const view = await fetchRaw(new URL('api/jobs/app/T-1/mr-view', served.dashboard!));
    assert.equal(view.status, 200, view.body);
    const problems = (JSON.parse(view.body) as { problems: Array<{ field: string; message: string }> }).problems;
    const listed = problems.map((problem) => problem.message).join('\n');
    assert.ok(listed.includes(`${'w'.repeat(70)} **"`), listed);
    assert.equal(listed.includes(`${'w'.repeat(70)} to`), false, listed);
  } finally {
    await stop(served);
  }
});

test('secrets in a workspace without guard: the value of SF_GITHUB_TOKEN in a commit refuses sf approve and sf guard, printed nowhere; a value of 11 characters is not a secret', async () => {
  const { env, repo, origin } = await guardEnv('guard-secret', false);
  await putTask(env, repo, 'T-1', 'Change README');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'iteration 1' },
    { write: { '.software-factory/T-1.mr.md': mrText(TITLE) }, text: 'prepared' },
  ]);
  const branch = 'T-1-change-readme';
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'ready_for_human_review', 1);
    // The user commits a credential on the prepared branch by hand.
    const secret = `tok${'Z'.repeat(17)}`;
    const worktree = join(env.state, 'worktrees', 'app', 'T-1');
    await writeFile(join(worktree, 'cred.txt'), `key=${secret}\n`);
    git(worktree, 'add', 'cred.txt');
    git(worktree, 'commit', '-q', '-m', 'cred');
    const sha = git(worktree, 'rev-parse', 'HEAD').trim().slice(0, 12);
    await writeFile(join(env.config, 'auth.env'), `SF_GITHUB_TOKEN=${secret}\n`);

    const refused = await runCli(env, ['approve', 'app', 'T-1', '--as-is']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, new RegExp(`^sf: The guard refused the push of app/T-1: cred\\.txt:1:5 in commit ${sha} \\(20 characters, secret\\)\\. See the matches with: sf guard app ${sha} --mr T-1$`, 'm'));
    assert.equal(onOrigin(origin, branch), false);
    const guarded = await runCli(env, ['guard', 'app', branch]);
    assert.equal(guarded.code, 1);
    assert.match(guarded.stdout, new RegExp(`^cred\\.txt:1:5 in commit ${sha}: \\[secret\\] \\(secret\\)$`, 'm'));
    assert.match(guarded.stdout, /^1 hits in 2 commits\.$/m);
    for (const text of [refused.stdout, refused.stderr, guarded.stdout, guarded.stderr, await allText(join(env.state, 'jobs'))]) {
      assert.equal(text.includes(secret), false);
    }

    const short = `tok${'Z'.repeat(8)}`;
    await writeFile(join(worktree, 'cred.txt'), `key=${short}\n`);
    git(worktree, 'commit', '-q', '--amend', '-a', '-m', 'cred');
    await writeFile(join(env.config, 'auth.env'), `SF_GITHUB_TOKEN=${short}\n`);
    const clean = await runCli(env, ['guard', 'app', branch]);
    assert.equal(clean.code, 0, clean.stdout + clean.stderr);
    assert.match(clean.stdout, /^No hits in 2 commits\.$/m);
  } finally {
    await stop(served);
  }
});

test('sf guard: unpushed commits, --branch, --mr, --worktree, --history and a range; an unguarded workspace, an unknown one, an invalid list, usage errors and install-hook', async () => {
  const { env, repo } = await guardEnv('guard-cli', true);
  const guard = (...args: string[]): ReturnType<typeof runCli> => runCli(env, ['guard', ...args]);
  const nothing = await guard('app');
  assert.deepEqual([nothing.code, nothing.stdout], [0, 'No hits in 0 commits.\n']);

  const initial = git(repo, 'rev-parse', 'HEAD').trim();
  await writeFile(join(repo, 'notes.txt'), 'see ABC-123\n');
  git(repo, 'add', 'notes.txt');
  git(repo, 'commit', '-q', '-m', 'notes');
  const sha = git(repo, 'rev-parse', 'HEAD').trim().slice(0, 12);
  const unpushed = await guard('app');
  assert.equal(unpushed.code, 1);
  assert.equal(unpushed.stdout, `notes.txt:1:5 in commit ${sha}: "ABC-123" (ticket key of another workspace)\n1 hits in 1 commits.\n`);
  git(repo, 'push', '-q', 'origin', 'main');
  assert.equal((await guard('app')).code, 0);
  const history = await guard('app', '--history');
  assert.equal(history.code, 1);
  assert.match(history.stdout, /"ABC-123"[^]*^1 hits in 2 commits\.$/m);
  const range = await guard('app', `${initial}..main`);
  assert.equal(range.code, 1);
  assert.match(range.stdout, /^1 hits in 1 commits\.$/m);
  assert.equal((await guard('app', `${initial}..main`, '--history')).code, 2);

  const branch = await guard('app', '--branch', 'fix-abc-9-now');
  assert.equal(branch.code, 1);
  assert.equal(branch.stdout, 'branch name:5: "abc-9" (ticket key of another workspace)\n1 hits in 0 commits.\n');

  const jobs = new JobStore(env.state);
  const at = '2026-11-07T10:00:00.000Z';
  const record = { workspace: 'app', branch: 'T-5-x', base: 'main', base_commit: null, target_commit: null, worktree: null, prepared_commit: null, mr_attempts: 0, mr_conflict_turn: false, state: 'ready_for_human_review' as const, iteration: 1, fixes: 0, gate_fixes: 0, gate_tokens: 0, session_id: null, created_at: at, updated_at: at, mr: null };
  await jobs.write({ ...record, ticket: 'T-5', branch: 'T-5-after-abc-2' });
  await jobs.writeMrText('app', 'T-5', 'feat(T-5): x\n\nproduct-frontend shares it\n');
  const mr = await guard('app', '--mr', 'T-5');
  assert.equal(mr.code, 1);
  assert.equal(mr.stdout, 'MR text:3:1: "product-frontend" (name of another workspace)\nbranch name:11: "abc-2" (ticket key of another workspace)\n2 hits in 0 commits.\n');
  const noText = await guard('app', '--mr', 'T-9');
  assert.deepEqual([noText.code, noText.stderr], [1, 'sf: No job app/T-9.\n']);

  const worktree = join(temp, 'guard-cli-worktree');
  execFileSync('git', ['clone', '-q', repo, worktree]);
  await writeFile(join(worktree, 'w.txt'), 'ABC-77\n');
  await jobs.write({ ...record, ticket: 'T-6', worktree, base_commit: git(worktree, 'rev-parse', 'HEAD').trim() });
  const changed = await guard('app', '--worktree', 'T-6');
  assert.equal(changed.code, 1);
  assert.equal(changed.stdout, 'w.txt:1:1: "ABC-77" (ticket key of another workspace)\n1 hits in 0 commits.\n');
  await jobs.write({ ...record, ticket: 'T-7', worktree: join(temp, 'no-such-worktree'), base_commit: initial });
  assert.equal((await guard('app', '--worktree', 'T-7')).stderr, 'sf: The job app/T-7 has no worktree to check.\n');

  await writeFile(join(env.config, 'guard-terms.txt'), 'fine\nre:(unclosed\n');
  const invalid = await guard('app');
  assert.deepEqual([invalid.code, invalid.stderr], [1, 'sf: guard-terms.txt line 2 is not a valid regular expression.\n']);
  await rm(join(env.config, 'guard-terms.txt'));

  // A malformed environment file: the guard's fail-closed message, never its line (Fix 1).
  const leaked = `tok${'L'.repeat(20)}`;
  await writeFile(join(env.config, 'auth.env'), `SF_GITHUB_TOKEN ${leaked}\n`);
  const badEnv = await guard('app');
  assert.deepEqual([badEnv.code, badEnv.stdout, badEnv.stderr], [1, '', 'sf: auth.env could not be read for the secret check.\n']);
  await rm(join(env.config, 'auth.env'));

  const unknown = await guard('nope');
  assert.deepEqual([unknown.code, unknown.stderr], [1, 'sf: Workspace "nope" is not registered.\n']);

  // A workspace without guard: secrets only, a clean commit passes; its hook is written all the same.
  const other = await newRepo({ ...env, config: join(temp, 'guard-cli-scratch') }, 'guard-cli-other', true);
  const registry = JSON.parse(await readFile(join(env.config, 'workspaces.json'), 'utf8')) as { workspaces: Record<string, unknown> };
  registry.workspaces['other-site'] = { read_checkout: other };
  await writeFile(join(env.config, 'workspaces.json'), JSON.stringify(registry));
  await writeFile(join(other, 'fine.txt'), 'fine\n');
  git(other, 'add', 'fine.txt');
  git(other, 'commit', '-q', '-m', 'fine');
  const plain = await guard('other-site');
  assert.equal(plain.code, 0, plain.stdout + plain.stderr);
  assert.equal(plain.stdout, 'No hits in 1 commits.\n');
  assert.equal(plain.stderr, 'sf guard: workspace "other-site" is not guarded ("guard": true in workspaces.json); only secrets are checked.\n');
  const hook = await guard('install-hook', 'other-site');
  assert.equal(hook.code, 0, hook.stderr);
  assert.equal(hook.stdout, `Wrote ${join(other, '.git', 'hooks', 'pre-push')}.\n`);
  assert.equal((await stat(join(other, '.git', 'hooks', 'pre-push'))).mode & 0o777, 0o755);
});

test('sf guard: the author and committer are never checked, the own user.email on another workspace\'s domain warns nothing; a term in the message still hits (SF-135)', async () => {
  const { env, repo } = await guardEnv('guard-identity', true);
  const pf = join(temp, 'guard-identity-pf');
  git(pf, 'config', 'user.email', 'me@acme.example.com');
  git(repo, 'config', 'user.email', 'jane@acme.example.com');
  await writeFile(join(env.config, 'guard-terms.txt'), 'Jane Doe\n');
  const guard = (...args: string[]): ReturnType<typeof runCli> => runCli(env, ['guard', ...args]);
  const identity = ['-c', 'user.name=Jane Doe', '-c', 'user.email=jane@acme.example.com'];

  await writeFile(join(repo, 'notes.txt'), 'clean\n');
  git(repo, 'add', 'notes.txt');
  execFileSync('git', [...identity, 'commit', '-q', '-m', 'notes'], { cwd: repo });
  const clean = await guard('app');
  assert.deepEqual([clean.code, clean.stdout, clean.stderr], [0, 'No hits in 1 commits.\n', '']);
  const history = await guard('app', '--history');
  assert.equal(history.code, 0, history.stdout);
  assert.doesNotMatch(history.stdout, /author|committer/);

  execFileSync('git', [...identity, 'commit', '-q', '--allow-empty', '-m', 'thanks to Jane Doe'], { cwd: repo });
  const sha = git(repo, 'rev-parse', 'HEAD').trim().slice(0, 12);
  const told = await guard('app');
  assert.equal(told.code, 1);
  assert.equal(told.stdout, `commit ${sha} message:1:11: "Jane Doe" (private list line 1)\n1 hits in 2 commits.\n`);
});
