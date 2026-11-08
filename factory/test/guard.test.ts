// The guard (SF-122, src/guard.ts): the terms (the names of the user's other workspaces from the
// registry and the job store, the private list, the secrets), the matching, the scans of commits,
// changes and the worktree, the messages and the pre-push hook. Every secret-looking fixture is
// built at run time, so this file matches none of SECRET_PATTERNS.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import {
  buildTerms, commitsToCheck, GUARD_HOOK_MARKER, GUARD_TERMS_FILE, guardMessage, type GuardHit, type GuardTerm, hitPlace, hitReport, hookText, installHook, keyTerm, maskedMrTextProblem,
  parsePrivateTerms, plainTerm, redactAdded, scanBranch, scanChange, scanCommits, scanText, secretTerms, worktreeTree,
} from '../src/guard.js';
import { type Job, JobStore } from '../src/jobs.js';
import { saveRegistry, type Workspace } from '../src/registry.js';
import { CLI, git, temp } from './support/harness.js';

const AT = '2026-11-07T10:00:00.000Z';

function job(workspace: string, ticket: string, extra: Partial<Job> = {}): Job {
  return {
    workspace, ticket, branch: `${ticket}-x`, base: 'main', base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
    mr_attempts: 0, mr_conflict_turn: false, state: 'pushed', iteration: 0, fixes: 0, gate_fixes: 0, gate_tokens: 0, session_id: null,
    created_at: AT, updated_at: AT, mr: null, ...extra,
  } as Job;
}

let counter = 0;
async function dir(name: string): Promise<string> {
  if (counter === 0) {
    // Git's global configuration of this test file: no user.email unless a test sets one.
    const home = join(temp, 'guard-home');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Test User\n');
    process.env.HOME = home;
  }
  counter += 1;
  const path = join(temp, `${name}-${counter}`);
  await mkdir(path, { recursive: true });
  return path;
}

// A repository with one commit on main; files are written and committed in it.
async function repo(name: string, files: Record<string, string> = { 'README.md': 'hello\n' }): Promise<string> {
  const path = await dir(name);
  git(path, 'init', '-q', '-b', 'main');
  await commit(path, files, 'initial');
  return path;
}

async function commit(cwd: string, files: Record<string, string | Buffer>, message: string): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(cwd, path, '..'), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  git(cwd, 'add', '--all');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD').trim();
}

const ws = (name: string, checkout: string, guard = true): Workspace => ({ name, readCheckout: checkout, workCheckout: checkout, ...(guard ? { guard: true } : {}) });
const texts = (terms: GuardTerm[]): string[] => terms.map((term) => `${term.kind}:${term.text}`).sort();
const ACME = plainTerm('private', 'ACME', 'private list line 1');


// The workspaces of the term tests: guarded software-factory, product-frontend, guarded
// friend-app, and old-client known only from its job directory.
async function termsFixture(): Promise<{ config: string; state: string; sf: string; pf: string }> {
  const config = await dir('config');
  const state = await dir('state');
  const sf = await repo('sf', { 'README.md': 'factory\n', '.software-factory/SF-1.md': '# SF-1\n' });
  git(sf, 'remote', 'add', 'origin', 'https://github.com/owner/sf.git');
  git(sf, 'config', 'user.email', 'me@users.noreply.github.com');
  const pf = await repo('pf', {
    'README.md': 'web\n', '.software-factory/ABC-123.md': '# ABC-123\n', '.software-factory/ABC-9.mr.md': 'mr\n', '.software-factory/archive/ABC-7.md': '# ABC-7\n',
  });
  git(pf, 'remote', 'add', 'origin', 'git@gitlab.example.com:team/web.git');
  git(pf, 'config', 'user.email', 'me@acme.example.com');
  const friend = await repo('friend');
  git(friend, 'remote', 'add', 'origin', 'https://github.com/friend/app.git');
  await saveRegistry({
    workspaces: {
      'software-factory': { read_checkout: sf, guard: true },
      'product-frontend': { read_checkout: pf },
      'friend-app': { read_checkout: friend, guard: true },
    },
  }, config);
  const jobs = new JobStore(state);
  await jobs.write(job('product-frontend', 'DEF-4'));
  await jobs.write(job('old-client', 'cleanup'));
  await jobs.write(job('software-factory', 'SF-2'));
  await jobs.write(job('friend-app', 'FA-3'));
  return { config, state, sf, pf };
}

test('buildTerms: the names, Git hosts, ticket key prefixes and email domains of the other workspaces, never the guarded ones, public hosts or the own keys', async () => {
  const { config, state, sf, pf } = await termsFixture();
  const built = await buildTerms({ workspace: ws('software-factory', sf), configDir: config, stateDir: state });
  assert.deepEqual(texts(built.terms), [
    'domain:acme.example.com', 'host:gitlab.example.com', 'key:ABC', 'key:DEF', 'name:old-client', 'name:product-frontend',
  ]);
  assert.deepEqual(built.warnings, []);
  assert.equal(built.terms.find((term) => term.kind === 'key')!.label, 'ticket key of another workspace');

  // product-frontend without user.email: its hosts and keys, no domain, no warning.
  git(pf, 'config', '--unset', 'user.email');
  const unset = await buildTerms({ workspace: ws('software-factory', sf), configDir: config, stateDir: state });
  assert.deepEqual(texts(unset.terms), ['host:gitlab.example.com', 'key:ABC', 'key:DEF', 'name:old-client', 'name:product-frontend']);
  assert.deepEqual(unset.warnings, []);

  // The guarded checkout's own identity on that domain: the term stays, with no warning (SF-135).
  git(pf, 'config', 'user.email', 'me@acme.example.com');
  git(sf, 'config', 'user.email', 'me@acme.example.com');
  const own = await buildTerms({ workspace: ws('software-factory', sf), configDir: config, stateDir: state });
  assert.ok(texts(own.terms).includes('domain:acme.example.com'));
  assert.deepEqual(own.warnings, []);
});

test('buildTerms: a registered workspace whose checkout is missing gives its name, its job tickets and a warning', async () => {
  const config = await dir('config');
  const state = await dir('state');
  const sf = await repo('sf');
  await saveRegistry({ workspaces: { 'software-factory': { read_checkout: sf, guard: true }, gone: { read_checkout: join(temp, 'no-such-checkout') } } }, config);
  await new JobStore(state).write(job('gone', 'GO-1'));
  const built = await buildTerms({ workspace: ws('software-factory', sf), configDir: config, stateDir: state });
  assert.deepEqual(texts(built.terms), ['key:GO', 'name:gone']);
  assert.deepEqual(built.warnings, ['workspace "gone": its checkout could not be read; only its name and job tickets are terms.']);
});

test('the private list: plain and re: lines, comments and blank lines skipped, "!" drops an automatic term only; invalid lines refused by number', async () => {
  const parsed = parsePrivateTerms('ACME\n# a comment\n\n  re:jane\\s+doe  \n!ABC\n');
  assert.deepEqual(parsed.terms.map((term) => [term.kind, term.text, term.label]), [['private', 'ACME', 'private list line 1'], ['private', 'jane\\s+doe', 'private list line 4']]);
  assert.deepEqual(parsed.drops, ['abc']);

  const { config, state, sf } = await termsFixture();
  await writeFile(join(config, GUARD_TERMS_FILE), 'ACME\nre:jane\\s+doe\n!product-frontend\n!ABC\n!acme\n');
  const built = await buildTerms({ workspace: ws('software-factory', sf), configDir: config, stateDir: state });
  assert.deepEqual(texts(built.terms), ['domain:acme.example.com', 'host:gitlab.example.com', 'key:DEF', 'name:old-client', 'private:ACME', 'private:jane\\s+doe']);
  assert.deepEqual(scanText('Jane  Doe wrote it', built.terms, (line, column) => `t:${line}:${column}`).map((hit) => hit.label), ['private list line 2']);

  const refusal = (text: string): FactoryError => {
    try {
      parsePrivateTerms(text);
    } catch (error) {
      assert.ok(error instanceof FactoryError);
      return error;
    }
    assert.fail('expected a refusal');
  };
  const invalid = refusal('ACME\n# x\nre:[unclosed\n');
  assert.equal(invalid.code, 'guard_terms_invalid');
  assert.equal(invalid.message, 'guard-terms.txt line 3 is not a valid regular expression.');
  assert.doesNotMatch(invalid.message, /unclosed/);
  assert.equal(refusal('re:x*').message, 'guard-terms.txt line 1 matches the empty text.');
  assert.equal(refusal('a\nre:').message, 'guard-terms.txt line 2 is empty after "re:".');
  assert.equal(refusal('!').message, 'guard-terms.txt line 1 is empty after "!".');

  // No file: no private terms.
  const none = await dir('config');
  await saveRegistry({ workspaces: { 'software-factory': { read_checkout: sf, guard: true } } }, none);
  assert.deepEqual((await buildTerms({ workspace: ws('software-factory', sf), configDir: none, stateDir: await dir('state') })).terms, []);
});

test('matching: case-insensitive, Unicode word boundaries, ticket keys, columns and lines, a duplicate term once', () => {
  const found = (term: GuardTerm, text: string): string[] => scanText(text, [term], (line, column) => `${line}:${column}`).map((hit) => hit.match);
  assert.deepEqual(found(ACME, 'acme'), ['acme']);
  assert.deepEqual(found(ACME, "Acme's"), ['Acme']);
  assert.deepEqual(found(ACME, 'acme-web'), ['acme']);
  assert.deepEqual(found(ACME, 'acmeville my_acme'), []);
  const jurgen = plainTerm('private', 'Jürgen', 'private list line 2');
  assert.deepEqual(found(jurgen, 'jürgen,'), ['jürgen']);
  assert.deepEqual(found(jurgen, 'Jürgens'), []);
  const key = keyTerm('ABC');
  assert.deepEqual(found(key, 'ABC-123 abc-7-fix [ABC-1]'), ['ABC-123', 'abc-7', 'ABC-1']);
  assert.deepEqual(found(key, 'XABC-1 ABCD-1 ABC-'), []);
  const hits = scanText('first\n  x ACME\r\nACME', [ACME, plainTerm('name', 'acme', 'name of another workspace')], (line, column) => `t:${line}:${column}`);
  assert.deepEqual(hits.map((hit) => [hit.where, hit.match, hit.label]), [['t:2:5', 'ACME', 'private list line 1'], ['t:3:1', 'ACME', 'private list line 1']]);
});

test('scans: added lines and new paths of each commit against its first parent; removed lines, binary files and pure renames give none', async () => {
  const cwd = await repo('scan', { 'README.md': 'hello\n', 'old.txt': 'ACME was here\nkeep\n', 'notes/acme.txt': 'ACME inside\n' });
  const removed = await commit(cwd, { 'old.txt': 'keep\n' }, 'drop a line');
  assert.deepEqual(await scanCommits(cwd, [removed], [ACME]), []);

  const added = await commit(cwd, { 'src/a.ts': 'one\ntwo\nlet ABC-123 = 1;\n' }, 'add a\nsee ABC-9');
  const sha = added.slice(0, 12);
  const terms = [ACME, keyTerm('ABC'), plainTerm('domain', 'acme.example.com', 'email domain of another workspace')];
  assert.deepEqual((await scanCommits(cwd, [added], terms)).map((hit) => hit.where), [`commit ${sha} message:2:5`, `src/a.ts:3:5 in commit ${sha}`]);

  const binary = await commit(cwd, { 'bin.dat': Buffer.from('ACME\0ACME\n') }, 'binary');
  assert.deepEqual(await scanCommits(cwd, [binary], terms), []);

  const path = await commit(cwd, { 'docs/acme-notes.md': 'clean\n' }, 'notes');
  const pathHits = await scanCommits(cwd, [path], terms);
  assert.deepEqual(pathHits.map((hit) => hit.where), [`docs/acme-notes.md (file path, column 6) in commit ${path.slice(0, 12)}`]);
  assert.equal(hitPlace(pathHits[0]!, terms), `docs/****-notes.md (file path, column 6) in commit ${path.slice(0, 12)} (4 characters, private list line 1)`);

  git(cwd, 'mv', 'notes/acme.txt', 'moved.txt');
  git(cwd, 'commit', '-q', '-m', 'rename');
  const renamed = git(cwd, 'rev-parse', 'HEAD').trim();
  assert.deepEqual(await scanCommits(cwd, [renamed], terms), []);

  const plusPlus = await commit(cwd, { 'list.txt': '++ ACME\n' }, 'plus');
  assert.deepEqual((await scanCommits(cwd, [plusPlus], terms)).map((hit) => hit.where), [`list.txt:1:4 in commit ${plusPlus.slice(0, 12)}`]);

  // The author and committer are the user's own identity (SF-135): never scanned, for names or secrets.
  const identity = ['-c', 'user.name=ACME Me', '-c', 'user.email=me@acme.example.com'];
  const secret: GuardTerm = { kind: 'secret', text: 'me@acme.example.com', label: 'secret', pattern: /me@acme\.example\.com/g };
  execFileSync('git', [...identity, 'commit', '-q', '--allow-empty', '-m', 'empty'], { cwd });
  const authored = git(cwd, 'rev-parse', 'HEAD').trim();
  assert.deepEqual(await scanCommits(cwd, [authored], [...terms, secret]), []);
  execFileSync('git', [...identity, 'commit', '-q', '--allow-empty', '-m', 'empty for ACME'], { cwd });
  const told = git(cwd, 'rev-parse', 'HEAD').trim();
  assert.deepEqual((await scanCommits(cwd, [told], terms)).map((hit) => hit.where), [`commit ${told.slice(0, 12)} message:1:11`]);

  // A merge commit: its change against the first parent.
  git(cwd, 'checkout', '-q', '-b', 'side');
  await commit(cwd, { 'side.txt': 'ACME on the side\n' }, 'side');
  git(cwd, 'checkout', '-q', 'main');
  await commit(cwd, { 'main.txt': 'main\n' }, 'main moves');
  git(cwd, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  const merge = git(cwd, 'rev-parse', 'HEAD').trim();
  assert.deepEqual((await scanCommits(cwd, [merge], terms)).map((hit) => hit.where), [`side.txt:1:1 in commit ${merge.slice(0, 12)}`]);

  // A root commit: against the empty tree.
  const root = await repo('root', { 'a.txt': 'x\nACME\n' });
  const first = git(root, 'rev-parse', 'HEAD').trim();
  assert.deepEqual((await scanCommits(root, [first], terms)).map((hit) => hit.where), [`a.txt:2:1 in commit ${first.slice(0, 12)}`]);
});

test('a change over 16 MiB of diff is guard_failed with its size message, for a commit and for the worktree', async () => {
  const big = 'a line of text\n'.repeat(Math.ceil((17 * 1024 * 1024) / 15));
  const cwd = await repo('big');
  const base = git(cwd, 'rev-parse', 'HEAD').trim();
  const added = await commit(cwd, { 'big.txt': big }, 'big');
  await assert.rejects(scanCommits(cwd, [added], [ACME]), { code: 'guard_failed', message: `The change of commit ${added.slice(0, 12)} is too large for the guard (over 16 MiB of diff).` });
  git(cwd, 'reset', '-q', '--mixed', base);
  await assert.rejects(scanChange(cwd, base, await worktreeTree(cwd, base), [ACME]), { code: 'guard_failed', message: 'The change of the worktree is too large for the guard (over 16 MiB of diff).' });
});

test('commitsToCheck: the unpushed commits of a push, the whole history, a range; a revision that does not exist is refused', async () => {
  const seed = await repo('seed');
  const origin = join(await dir('origin'), 'o.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, origin]);
  const cwd = join(await dir('clone'), 'c');
  execFileSync('git', ['clone', '-q', origin, cwd]);
  const pushed = git(cwd, 'rev-parse', 'HEAD').trim();
  const one = await commit(cwd, { 'a.txt': '1\n' }, 'one');
  const two = await commit(cwd, { 'a.txt': '2\n' }, 'two');
  assert.deepEqual(await commitsToCheck(cwd, { rev: 'HEAD', remote: 'origin', history: false }), [one, two]);
  assert.deepEqual(await commitsToCheck(cwd, { rev: 'HEAD', history: true }), [pushed, one, two]);
  assert.deepEqual(await commitsToCheck(cwd, { range: `${one}..${two}` }), [two]);
  // A remote without remote-tracking refs: the whole history.
  git(cwd, 'remote', 'add', 'other', origin);
  assert.deepEqual(await commitsToCheck(cwd, { rev: 'HEAD', remote: 'other', history: false }), [pushed, one, two]);
  await assert.rejects(commitsToCheck(cwd, { rev: 'nope', remote: 'origin', history: false }), { code: 'guard_failed', message: 'The revision nope does not exist in the checkout.' });
});

test('worktreeTree: the untracked and the edited files the factory would commit, without .software-factory/', async () => {
  const cwd = await repo('wt', { 'README.md': 'hello\n', 'src/b.ts': 'b\n' });
  const base = git(cwd, 'rev-parse', 'HEAD').trim();
  await writeFile(join(cwd, 'new.txt'), 'ACME\n');
  await writeFile(join(cwd, 'src/b.ts'), 'b\nABC-1\n');
  await mkdir(join(cwd, '.software-factory'), { recursive: true });
  await writeFile(join(cwd, '.software-factory', 'X-1.md'), 'ACME\n');
  const tree = await worktreeTree(cwd, base);
  const hits = await scanChange(cwd, base, tree, [ACME, keyTerm('ABC')]);
  assert.deepEqual(hits.map((hit) => hit.where), ['new.txt:1:1', 'src/b.ts:2:1']);
  // The worktree's own index is untouched.
  assert.equal(git(cwd, 'status', '--porcelain').includes('?? new.txt'), true);
});

test('redactAdded: a term on a line the factory added is removed, the same term on the Implementer\'s line stays', () => {
  const written = 'feat(X-1): title\n\nACME asked for it.';
  const factory = `${written}\n\n### Nits not applied\n- a.ts: ACME and acme-web (ACME).`;
  assert.equal(redactAdded(factory, written, [ACME]), `${written}\n\n### Nits not applied\n- a.ts: [removed by the guard] and [removed by the guard]-web ([removed by the guard]).`);
});

test('maskedMrTextProblem: a key cut off by the 100 characters the problem quotes is masked before the cut; a valid text has no problem', async () => {
  const terms = await secretTerms({ stateDir: await dir('state'), envFile: undefined });
  const key = `ghp_${'a'.repeat(36)}`;
  const title = `feat(X-1): ${'w'.repeat(81)} ${key}`;
  const problem = maskedMrTextProblem('X-1', `${title}\n\nbody\n`, terms)!;
  assert.ok(problem.startsWith(`its first line "feat(X-1): ${'w'.repeat(81)} *******" is not a valid title`), problem);
  assert.equal(problem.includes('ghp_'), false);
  assert.equal(maskedMrTextProblem('X-1', ['feat(X-1): Fine', '', '## What', 'x', '## Why', 'x', '## How', 'x', '## Why the change', 'x', '## Special things to note', 'x', '## Change outline', 'x', '## Testing', 'x', '## Checklist', 'x', ''].join('\n'), terms), undefined);
});

test('messages: hitPlace never carries the matched text; guardMessage lists 20 places and the count of the rest', () => {
  const hit: GuardHit = { where: 'src/acme.ts:3:5', match: 'ACME', label: 'private list line 1', secret: false };
  assert.equal(hitPlace(hit, [ACME]), 'src/****.ts:3:5 (4 characters, private list line 1)');
  assert.equal(hitReport(hit), 'src/acme.ts:3:5: "ACME" (private list line 1)');
  const hits = Array.from({ length: 25 }, (_, index): GuardHit => ({ where: `a.ts:${index + 1}:1`, match: 'ACME', label: 'private list line 1', secret: false }));
  const message = guardMessage(hits, [ACME]);
  assert.equal(message.split('; ').length, 21);
  assert.match(message, /^a\.ts:1:1 \(4 characters, private list line 1\); .*a\.ts:20:1 \(4 characters, private list line 1\); and 5 more$/);
  assert.doesNotMatch(message, /ACME/);
});

test('a private regular expression that overlaps a secret never prints it: the secret part of its match is masked, in sf guard\'s report too (Fix 6)', async () => {
  const state = await dir('state');
  const env = join(await dir('env'), 'auth.env');
  const token = `tok${'R'.repeat(20)}`;
  await writeFile(env, `SF_GITHUB_TOKEN=${token}\n`);
  const secrets = await secretTerms({ stateDir: state, envFile: env });
  const key = `AKIA${'Q'.repeat(16)}`;
  const terms = [...secrets, ...parsePrivateTerms('re:.+\nre:tok\\w{4}\n').terms];
  const cwd = await repo('overlap');
  const added = await commit(cwd, { 'conf.ts': `key=${token} and ${key}\n` }, 'keys');
  const hits = await scanCommits(cwd, [added], terms);
  const lines = hits.map((hit) => hitReport(hit, terms));
  assert.ok(lines.some((line) => line.includes(`"key=${'*'.repeat(token.length)} and ${'*'.repeat(key.length)}" (private list line 1)`)), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('"*******" (private list line 2)')), lines.join('\n'));
  for (const line of lines) {
    assert.equal(line.includes(token) || line.includes(key) || line.includes('tokR'), false, line);
  }
  // A branch name and an MR text alike.
  for (const hit of [...scanBranch(`x-${token}`, terms), ...scanText(`t ${key}`, terms, (line, column) => `t:${line}:${column}`)]) {
    assert.equal(hitReport(hit, terms).includes(token) || hitReport(hit, terms).includes(key), false);
  }
});

test('the sk- and xox patterns have a left boundary: a branch slug holding them is no hit, a standalone key is', async () => {
  const terms = await secretTerms({ stateDir: await dir('state'), envFile: undefined });
  assert.deepEqual(scanBranch('SF-70-the-task-check-s-guard-keeps-other-workspaces', terms), []);
  assert.deepEqual(scanBranch('feat-xoxb-1234567890-abc', terms), []);
  const keys = [`sk-${'A'.repeat(24)}`, `xoxb-${'1'.repeat(12)}`];
  for (const key of keys) {
    assert.deepEqual(scanText(`key: ${key}`, terms, (line, column) => `t:${line}:${column}`).map((hit) => [hit.where, hit.secret]), [['t:1:6', true]], key);
  }
});

test('secretTerms: the secret keys of the environment file and the token files, never other settings, short values or flags; a secret hit is never printed', async () => {
  const state = await dir('state');
  const env = join(await dir('env'), 'auth.env');
  const token = `tok${'x'.repeat(20)}`;
  const ntfy = `https://ntfy.example/topic-${'q'.repeat(8)}`;
  await writeFile(env, [
    `SF_GITHUB_TOKEN=${token}`, `SF_NTFY_URL="${ntfy}"`, 'SF_MODEL=claude-opus-5-5', 'SF_GITLAB_TOKEN=elevenchars', 'SF_NTFY_TOKEN=true',
    'SF_PORT_SECRET=8080', 'SF_GATE_MAX_TOKENS=123456789012345', 'OTHER_PASSWORD=123456789012', '',
  ].join('\n'));
  const dashboard = 'd'.repeat(64);
  await writeFile(join(state, 'dashboard-token'), `${dashboard}\n`);
  const exact = (terms: GuardTerm[]): string[] => terms.filter((term) => term.pattern.flags === 'g' && !/[[\\]/.test(term.text)).map((term) => term.text);
  assert.deepEqual(exact(await secretTerms({ stateDir: state, envFile: env })), [token, ntfy, dashboard]);
  const mcp = 'm'.repeat(64);
  await writeFile(join(state, 'mcp-token'), mcp);
  const terms = await secretTerms({ stateDir: state, envFile: env });
  assert.deepEqual(exact(terms), [token, ntfy, dashboard, mcp]);
  assert.ok(terms.every((term) => term.kind === 'secret' && term.label === 'secret'));
  assert.deepEqual(exact(await secretTerms({ stateDir: await dir('state'), envFile: undefined })), []);

  // A generic pattern in an added line: a secret hit, printed as [secret].
  const cwd = await repo('secret');
  const key = `AKIA${'Q'.repeat(16)}`;
  const added = await commit(cwd, { 'conf.ts': `const k = '${key}';\nconst t = '${token}';\n` }, 'keys');
  const hits = await scanCommits(cwd, [added], terms);
  assert.deepEqual(hits.map((hit) => [hit.where, hit.secret]), [[`conf.ts:1:12 in commit ${added.slice(0, 12)}`, true], [`conf.ts:2:12 in commit ${added.slice(0, 12)}`, true]]);
  for (const hit of hits) {
    assert.equal(hitReport(hit), `${hit.where}: [secret] (secret)`);
    assert.equal(hitPlace(hit, terms).includes(hit.match), false);
  }
  // A secret inside a path: masked in sf guard's report too.
  const inPath = await commit(cwd, { [`keys/${token}.txt`]: 'fine\n' }, 'path');
  const pathHit = (await scanCommits(cwd, [inPath], terms))[0]!;
  assert.equal(hitReport(pathHit, terms), `keys/${'*'.repeat(token.length)}.txt (file path, column 6) in commit ${inPath.slice(0, 12)}: [secret] (secret)`);

  // An environment file parseEnvFile refuses: guard_failed, without the line.
  await writeFile(env, 'not a setting line\n');
  await assert.rejects(secretTerms({ stateDir: state, envFile: env }), (error: unknown) => {
    assert.ok(error instanceof FactoryError);
    assert.equal(error.code, 'guard_failed');
    assert.equal(error.message, 'auth.env could not be read for the secret check.');
    return true;
  });
});

test('the hook: its text, mode 0755, its own hook rewritten, a foreign one refused unchanged, core.hooksPath followed; a push of a term is refused', async () => {
  const text = hookText("/opt/it's/sf", 'software-factory');
  const lines = text.split('\n');
  assert.equal(lines[0], '#!/bin/sh');
  assert.equal(lines[1], GUARD_HOOK_MARKER);
  assert.equal(lines[2], "sf='/opt/it'\\''s/sf'");
  assert.match(text, /"\$sf" guard 'software-factory' "\$local_sha" --remote "\$remote" --branch "\$\{remote_ref#refs\/heads\/\}" <\/dev\/null \|\| exit 1 ;;/);

  const cwd = await repo('hook');
  const first = await installHook(cwd, 'software-factory', '/bin/sf');
  assert.equal(first.path, join(cwd, '.git', 'hooks', 'pre-push'));
  assert.equal(first.replaced, false);
  assert.equal((await stat(first.path)).mode & 0o777, 0o755);
  assert.equal((await installHook(cwd, 'software-factory', '/bin/sf')).replaced, true);
  const foreign = '#!/bin/sh\necho mine\n';
  await writeFile(first.path, foreign);
  await assert.rejects(installHook(cwd, 'software-factory'), {
    code: 'guard_hook_exists',
    message: `A pre-push hook that is not the factory's exists at ${first.path}; call sf guard software-factory "$local_sha" --remote "$1" from it yourself.`,
  });
  assert.equal(await readFile(first.path, 'utf8'), foreign);
  git(cwd, 'config', 'core.hooksPath', 'my-hooks');
  assert.equal((await installHook(cwd, 'software-factory', '/bin/sf')).path, join(cwd, 'my-hooks', 'pre-push'));

  // The hook at work: sf guard through a wrapper of the CLI.
  const config = await dir('config');
  const state = await dir('state');
  const seed = await repo('hook-seed');
  const origin = join(await dir('hook-origin'), 'o.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, origin]);
  const clone = join(await dir('hook-clone'), 'c');
  execFileSync('git', ['clone', '-q', origin, clone]);
  await saveRegistry({ workspaces: { 'software-factory': { read_checkout: clone, guard: true } } }, config);
  await writeFile(join(config, GUARD_TERMS_FILE), 'ACME\n');
  const sf = join(await dir('bin'), 'sf');
  await writeFile(sf, `#!/bin/sh\nexec '${process.execPath}' '${CLI}' "$@"\n`);
  await chmod(sf, 0o755);
  await installHook(clone, 'software-factory', sf);
  const env = { ...process.env, SF_CONFIG_DIR: config, SF_STATE_DIR: state, SF_ENV_FILE: '' };
  const push = (...args: string[]): { ok: boolean; output: string } => {
    try {
      return { ok: true, output: execFileSync('git', ['push', '-q', 'origin', ...args], { cwd: clone, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (error) {
      return { ok: false, output: `${(error as { stdout?: string }).stdout ?? ''}${(error as { stderr?: string }).stderr ?? ''}` };
    }
  };
  const remoteRef = (ref: string): string => {
    try {
      return execFileSync('git', ['--git-dir', origin, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };
  git(clone, 'checkout', '-q', '-b', 'bad');
  await commit(clone, { 'a.txt': 'ACME\n' }, 'bad');
  const refused = push('bad');
  assert.equal(refused.ok, false);
  assert.match(refused.output, /a\.txt:1:1 in commit [0-9a-f]{12}: "ACME" \(private list line 1\)/);
  assert.equal(remoteRef('refs/heads/bad'), '');
  git(clone, 'checkout', '-q', 'main');
  const clean = await commit(clone, { 'b.txt': 'fine\n' }, 'clean');
  assert.equal(push('main').ok, true);
  assert.equal(remoteRef('refs/heads/main'), clean);
  assert.equal(push('main:refs/heads/tmp').ok, true);
  assert.equal(push('--delete', 'tmp').ok, true);
  assert.equal(remoteRef('refs/heads/tmp'), '');
});
