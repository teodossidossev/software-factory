// End-to-end tests of abort and reset (with and without --discard, sandbox_unavailable), the
// Implementer's arguments with SF_SANDBOX=off, and the notifications (desktop and ntfy), with the
// fake Claude writing files in the job's worktree. Split from approve.test.ts, which keeps the MR
// preparation at Clean and the push, so that neither file runs near the test runner's time limit.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DENIED_TOOLS } from '../src/rules.js';
import { assertPathDenials, call, fakeBwrapBin, fakeLog, git, newEnv, newRepo, putTask, refused, runCli, script, serve, stop, temp, turnsStarted, waitFor } from './support/harness.js';

function mrText(header: string): string {
  return [
    header, '',
    '## What', 'Changes the README.', '## Why', 'The ticket asks for it.', '', 'Readers need the new line.', '## How', 'One line.', '## Why the change', 'Readers need it.',
    '## Special things to note', '- None.', '## Change outline', '- README.md', '## Testing', 'npm test: passed', '## Screenshots', 'N/A',
    '## Checklist', '- [x] Branch name', '- [x] Target branch', '',
  ].join('\n');
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
  // The path denials for the tools still apply without the sandbox (SF-100).
  assertPathDenials(entry!.argv, env, worktreeOf(env, 'S-1'), DENIED_TOOLS, false);
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
    // The fake bwrap too: the Implementer's turns run inside it (SF-181).
    PATH: `${bin}:${fakeBwrapBin}:${process.env.PATH}`, SF_DESKTOP_NOTIFY: 'on', SF_NTFY_URL: url, SF_NTFY_TOKEN: 'tk_test', SF_MAX_ITERATIONS: '1',
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
  // The message of the Fix round limit (SF-131): no open finding, since request_fix writes no ledger.
  const body = 'branch: N-1-notify-me\niteration_limit: 1 Fix sections were written, the limit of SF_MAX_ITERATIONS; 0 open blocker or major findings; the user decides how to go on: sf accept takes iteration 2 as it is (the open findings go unapplied and are listed in the MR text), sf say gives a direction.';
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
