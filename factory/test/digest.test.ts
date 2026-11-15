// The morning digest's Git data (SF-103, src/digest.ts) on temporary repositories with real Git: a
// bare origin, a colleague's clone and the read checkout. The mirror (clone, fetches, no alternates,
// refs/sf-local kept, the read checkout untouched), what landed (a merge's author from the merged
// side), the live branches (squash landed, earlier_merge, ahead/behind, age, mine, local), overlap
// and hit_by after the merge base, my commits once, the failures, the "why", the diff excerpt, the
// cap and the derived description. Then the digest's period (SF-155, digestPeriod in
// src/digest-run.ts).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { capModelInput, derivedDescription, extractRepo, MAX_DERIVED_DESCRIPTION_CHARS, myEmail, needsAttention, type RepoData, syncMirror, ticketKey, whyOf } from '../src/digest.js';
import { digestPeriod } from '../src/digest-run.js';

const NOW = Date.now();
const DAY = 86_400_000;
const ME = { name: 'Me Myself', email: 'me@example.invalid' };
const COLLEAGUE = { name: 'Colleague', email: 'colleague@example.invalid' };
const MERGER = { name: 'Merger', email: 'merger@example.invalid' };

let temp: string;
let origin: string;
let colleague: string;
let checkout: string;
let mirrors: string;

function at(daysAgo: number): string {
  return new Date(NOW - daysAgo * DAY).toISOString();
}

function g(cwd: string, who: { name: string; email: string }, daysAgo: number, ...args: string[]): string {
  const date = at(daysAgo);
  return execFileSync('git', ['-c', `user.name=${who.name}`, '-c', `user.email=${who.email}`, '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

async function commit(cwd: string, who: { name: string; email: string }, daysAgo: number, files: Record<string, string>, text: string): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(cwd, path), content);
  }
  g(cwd, who, daysAgo, 'add', ...Object.keys(files));
  g(cwd, who, daysAgo, 'commit', '-q', '-m', text);
  return g(cwd, who, daysAgo, 'rev-parse', 'HEAD').trim();
}

// What a digest must never change in the read checkout: its refs, its index and its objects.
async function snapshot(repo: string): Promise<string> {
  const objects: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else {
        objects.push(`${path} ${(await stat(path)).size}`);
      }
    }
  };
  await walk(join(repo, '.git', 'objects'));
  const index = createHash('sha256').update(await readFile(join(repo, '.git', 'index'))).digest('hex');
  return [execFileSync('git', ['for-each-ref'], { cwd: repo, encoding: 'utf8' }), index, objects.sort().join('\n'), execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })].join('\n--\n');
}

const shas: Record<string, string> = {};

before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'sf-digest-'));
  mirrors = join(temp, 'state', 'digest', 'mirrors');
  const seed = join(temp, 'seed');
  await mkdir(seed);
  g(seed, COLLEAGUE, 30, 'init', '-q', '-b', 'main');
  await commit(seed, COLLEAGUE, 30, { 'README.md': '# app\n', 'a.txt': 'a\n', 'd.txt': 'd\n' }, 'Initial commit');
  origin = join(temp, 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, origin]);
  colleague = join(temp, 'colleague');
  checkout = join(temp, 'checkout');
  execFileSync('git', ['clone', '-q', origin, colleague]);
  execFileSync('git', ['clone', '-q', origin, checkout]);
  execFileSync('git', ['config', 'user.email', ME.email], { cwd: checkout });

  // An old branch: its tip is 20 days old.
  g(colleague, COLLEAGUE, 20, 'switch', '-q', '-c', 'old-thing');
  await commit(colleague, COLLEAGUE, 20, { 'e.txt': 'e\n' }, 'An old idea');
  g(colleague, COLLEAGUE, 20, 'push', '-q', 'origin', 'old-thing');
  g(colleague, COLLEAGUE, 20, 'switch', '-q', 'main');
  // M0 on main, in the period, before my branch starts.
  shas.m0 = await commit(colleague, COLLEAGUE, 1.9, { 'd.txt': 'd2\n' }, 'Tweak the d file');
  g(colleague, COLLEAGUE, 1.9, 'push', '-q', 'origin', 'main');

  // My branch, from main after M0, pushed.
  g(checkout, ME, 1.8, 'fetch', '-q', 'origin');
  g(checkout, ME, 1.8, 'switch', '-q', '-c', 'SF-3-mine', 'origin/main');
  shas.mine = await commit(checkout, ME, 1.8, { 'a.txt': 'a mine\n', 'd.txt': 'd mine\n' }, 'SF-3: My change');
  g(checkout, ME, 1.8, 'push', '-q', 'origin', 'SF-3-mine');

  // SF-1: a feature branch merged with a merge commit by someone else.
  g(colleague, COLLEAGUE, 1.5, 'switch', '-q', '-c', 'SF-1-feature');
  await commit(colleague, COLLEAGUE, 1.5, { 'a.txt': 'a feature\n' }, 'SF-1: Add the feature\n\n## Why\n\nThe users need the feature to find their orders faster.\n\n## How\n\nA new file.');
  g(colleague, COLLEAGUE, 1.5, 'push', '-q', 'origin', 'SF-1-feature');
  g(colleague, MERGER, 1.4, 'switch', '-q', 'main');
  g(colleague, MERGER, 1.4, 'merge', '-q', '--no-ff', '-m', "Merge branch 'SF-1-feature'", 'SF-1-feature');
  shas.merge = g(colleague, MERGER, 1.4, 'rev-parse', 'HEAD').trim();
  g(colleague, MERGER, 1.4, 'push', '-q', 'origin', 'main');

  // SF-2: two commits on a branch, squash-merged into one commit on main.
  g(colleague, COLLEAGUE, 1.3, 'switch', '-q', '-c', 'SF-2-squash');
  await commit(colleague, COLLEAGUE, 1.3, { 'b.txt': 'b1\n' }, 'Start b');
  await commit(colleague, COLLEAGUE, 1.3, { 'b.txt': 'b1\nb2\n' }, 'Finish b');
  g(colleague, COLLEAGUE, 1.3, 'push', '-q', 'origin', 'SF-2-squash');
  g(colleague, COLLEAGUE, 1.2, 'switch', '-q', 'main');
  shas.squash = await commit(colleague, COLLEAGUE, 1.2, { 'b.txt': 'b1\nb2\n' }, 'SF-2: Add b (#2)');
  g(colleague, COLLEAGUE, 1.2, 'push', '-q', 'origin', 'main');

  // A follow-up of SF-1 after its merge.
  g(colleague, COLLEAGUE, 1.1, 'switch', '-q', '-c', 'SF-1-followup');
  await commit(colleague, COLLEAGUE, 1.1, { 'f.txt': 'f\n' }, 'SF-1: Follow-up fix');
  g(colleague, COLLEAGUE, 1.1, 'push', '-q', 'origin', 'SF-1-followup');

  // In the read checkout: a local commit on my pushed branch, and a factory job branch, local only.
  shas.local = await commit(checkout, ME, 1.0, { 'c.txt': 'c\n' }, 'SF-3: More local work');
  g(checkout, ME, 0.9, 'switch', '-q', '-c', 'SF-9-a-factory-job', 'origin/main');
  shas.job = await commit(checkout, ME, 0.9, { 'g.txt': 'g\n' }, 'SF-9: The job');
  // A local-only branch with a colleague's commit: in my checkout only, so mine.
  g(checkout, COLLEAGUE, 0.8, 'switch', '-q', '-c', 'spike', 'origin/main');
  await commit(checkout, COLLEAGUE, 0.8, { 'h.txt': 'h\n' }, 'Try something');
  g(checkout, ME, 0.8, 'switch', '-q', 'SF-3-mine');
});

after(async () => {
  await rm(temp, { recursive: true, force: true });
});

const PERIOD = { from: new Date(NOW - 2 * DAY), to: new Date(NOW), since: new Date(NOW - 2 * DAY), me: ME.email, myWork: true };

let data: RepoData;

test('the mirror: a bare clone without alternates, local branches under refs/sf-local, the read checkout unchanged', async () => {
  const before = await snapshot(checkout);
  const result = await syncMirror(mirrors, 'app', checkout);
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.deepEqual([result.message, result.notes], [null, []]);
  assert.ok(result.last_fetch_ok_at !== null);
  const mirror = result.path!;
  assert.equal(execFileSync('git', ['rev-parse', '--is-bare-repository'], { cwd: mirror, encoding: 'utf8' }).trim(), 'true');
  await assert.rejects(stat(join(mirror, 'objects', 'info', 'alternates')));
  const refs = execFileSync('git', ['for-each-ref', '--format=%(refname)'], { cwd: mirror, encoding: 'utf8' }).trim().split('\n');
  for (const ref of ['refs/heads/main', 'refs/heads/SF-3-mine', 'refs/sf-local/heads/SF-3-mine', 'refs/sf-local/heads/SF-9-a-factory-job', 'refs/sf-local/heads/main']) {
    assert.ok(refs.includes(ref), `${ref} in ${refs.join(', ')}`);
  }
  // The hand-over's saved refs are not read.
  assert.ok(!refs.some((ref) => ref.startsWith('refs/factory/')));
  const meta = JSON.parse(await readFile(join(mirrors, 'app.json'), 'utf8'));
  assert.deepEqual([meta.checkout, meta.origin_url, meta.last_error], [checkout, origin, null]);

  // A second run: the fetch from origin prunes, but never refs/sf-local.
  const again = await syncMirror(mirrors, 'app', checkout);
  assert.equal(again.status, 'ok');
  assert.ok(execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/sf-local'], { cwd: mirror, encoding: 'utf8' }).includes('refs/sf-local/heads/SF-9-a-factory-job'));

  data = await extractRepo(mirror, PERIOD);
  assert.equal(await snapshot(checkout), before);
  assert.equal(await myEmail(checkout), ME.email);
});

test('what landed: first-parent commits of the period, newest first; a merge by its merged side\'s author with both subjects; the why and the diff excerpt', () => {
  assert.equal(data.main, 'main');
  assert.deepEqual(data.landed.map((entry) => entry.full_sha), [shas.squash, shas.merge, shas.m0]);
  const [squash, merge, m0] = data.landed;
  assert.equal(merge!.merge, true);
  assert.equal(merge!.author, COLLEAGUE.name);
  assert.equal(merge!.mine, false);
  assert.equal(merge!.subject, "SF-1: Add the feature (Merge branch 'SF-1-feature')");
  assert.equal(merge!.ticket, 'SF-1');
  assert.equal(merge!.why, 'The users need the feature to find their orders faster.');
  assert.deepEqual([merge!.files, merge!.dirs], [['a.txt'], ['.']]);
  assert.match(merge!.stat, /1 file changed/);
  assert.equal(merge!.diff_excerpt, undefined);
  assert.equal(merge!.sha, shas.merge!.slice(0, 10));
  // The committer date.
  assert.equal(Date.parse(merge!.date) / 1000, Math.floor(Date.parse(at(1.4)) / 1000));
  // A short why: the diff excerpt goes to the model.
  assert.equal(squash!.why, '');
  assert.equal(squash!.ticket, 'SF-2');
  assert.match(squash!.diff_excerpt!, /^diff --git a\/b\.txt b\/b\.txt[\s\S]*\+b2/);
  assert.equal(m0!.ticket, null);
});

test('live branches: squash merge landed, a follow-up with earlier_merge, ahead/behind at the local tip, the 14-day age, mine by email, a local-only branch mine, local commits', () => {
  assert.deepEqual(data.branches.map((branch) => branch.name), ['SF-1-followup', 'SF-2-squash', 'SF-3-mine', 'SF-9-a-factory-job', 'spike']);
  const [followup, squash, mine, job, spike] = data.branches;
  assert.deepEqual([spike!.local, spike!.mine, spike!.author], [true, true, COLLEAGUE.name]);
  assert.deepEqual(data.notes, []);
  assert.deepEqual([followup!.landed, followup!.earlier_merge, followup!.mine, followup!.ticket, followup!.ahead, followup!.behind], [false, true, false, 'SF-1', 1, 0]);
  assert.deepEqual([squash!.landed, squash!.earlier_merge, squash!.mine], [true, true, false]);
  assert.deepEqual([mine!.mine, mine!.local, mine!.local_only, mine!.ahead, mine!.behind, mine!.landed, mine!.earlier_merge], [true, false, 1, 2, 3, false, false]);
  assert.deepEqual([job!.mine, job!.local, job!.ticket, job!.ahead], [true, true, 'SF-9', 1]);
  // overlap and hit_by: only what main changed after the merge base (M0 is before it).
  assert.deepEqual(mine!.files, ['a.txt', 'c.txt', 'd.txt']);
  assert.deepEqual(mine!.overlap, ['a.txt']);
  assert.deepEqual(mine!.hit_by, [{ sha: shas.merge!.slice(0, 10), files: ['a.txt'] }]);
  assert.equal(needsAttention(mine!), true);
  assert.equal(needsAttention(job!), false);
  assert.equal(squash!.overlap, undefined);
});

test('my commits: non-merge, on every ref of the mirror, each once, newest first', () => {
  assert.deepEqual(data.my_commits.map((entry) => entry.sha), [shas.job, shas.local, shas.mine].map((sha) => sha!.slice(0, 10)));
  assert.deepEqual(data.my_commits.map((entry) => entry.ref), ['SF-9-a-factory-job (local)', 'SF-3-mine (local)', data.my_commits[2]!.ref]);
  assert.match(data.my_commits[2]!.ref, /^SF-3-mine( \(local\))?$/);
  assert.equal(data.my_commits[0]!.subject, 'SF-9: The job');
  assert.match(data.my_commits[0]!.stat, /1 file changed, 1 insertion/);
});

test('mirror failures: no origin remote and a failed first clone are skipped; a failed fetch keeps the older data; a changed checkout path clones again', async () => {
  const plain = join(temp, 'plain');
  await mkdir(plain);
  execFileSync('git', ['init', '-q', plain]);
  assert.deepEqual(await syncMirror(mirrors, 'plain', plain), { status: 'skipped', message: 'no origin remote', last_fetch_ok_at: null, notes: [] });

  const broken = join(temp, 'broken');
  execFileSync('git', ['clone', '-q', origin, broken]);
  execFileSync('git', ['remote', 'set-url', 'origin', join(temp, 'no-such-origin.git')], { cwd: broken });
  const failed = await syncMirror(mirrors, 'broken', broken);
  assert.equal(failed.status, 'skipped');
  assert.match(failed.message!, /^mirror not created: /);
  await assert.rejects(stat(join(mirrors, 'broken.git')));
  assert.match(JSON.parse(await readFile(join(mirrors, 'broken.json'), 'utf8')).last_error, /^mirror not created: /);
  // Tried again on the next run: it works once origin is back.
  execFileSync('git', ['remote', 'set-url', 'origin', origin], { cwd: broken });
  assert.equal((await syncMirror(mirrors, 'broken', broken)).status, 'ok');

  // Origin gone: the URL is set on the mirror, the fetch fails, the data as of the last good fetch.
  const good = JSON.parse(await readFile(join(mirrors, 'broken.json'), 'utf8')).last_fetch_ok_at;
  execFileSync('git', ['remote', 'set-url', 'origin', join(temp, 'gone.git')], { cwd: broken });
  const stale = await syncMirror(mirrors, 'broken', broken);
  assert.equal(stale.status, 'fetch_failed');
  assert.match(stale.message!, new RegExp(`^fetch failed: .+; data as of ${good.replace(/[.]/g, '\\.')}$`));
  assert.equal(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: stale.path!, encoding: 'utf8' }).trim(), join(temp, 'gone.git'));
  const older = await extractRepo(stale.path!, PERIOD);
  assert.equal(older.landed.length, 3);

  // Another checkout path: the mirror is cloned again from it.
  const moved = join(temp, 'moved');
  execFileSync('git', ['clone', '-q', origin, moved]);
  assert.equal((await syncMirror(mirrors, 'broken', moved)).status, 'ok');
  assert.equal(JSON.parse(await readFile(join(mirrors, 'broken.json'), 'utf8')).checkout, moved);
});

test('the why: ## Why, ## WHAT, else the first paragraph of the body; ticket keys', () => {
  assert.equal(whyOf('Subject\n\n## Why\nBecause of X.\nAnd Y.\n\n## How\nZ'), 'Because of X.\nAnd Y.');
  assert.equal(whyOf('Subject\n\n## WHAT\n\nThe what.\n## Other'), 'The what.');
  assert.equal(whyOf('Subject\n\n## What\nThe what.\n\n## Why\nThe why.'), 'The why.');
  assert.equal(whyOf('Subject\n\nFirst paragraph\nstill first.\n\nSecond.'), 'First paragraph\nstill first.');
  assert.equal(whyOf('Only a subject'), '');
  assert.equal(ticketKey('no key', 'body with PROJ-12 and AB-3', 'XY-1'), 'PROJ-12');
  assert.equal(ticketKey('nothing', undefined, 'feature/AB-77-x'), 'AB-77');
  assert.equal(ticketKey('lower-1'), null);
  // A key of several dashed parts is taken whole, never its tail.
  assert.equal(ticketKey('DOCS-AUDIT-1-report-x'), 'DOCS-AUDIT-1');
  assert.equal(ticketKey('ABC-123-fix'), 'ABC-123');
  assert.equal(ticketKey('feat(ABC-12): x'), 'ABC-12');
});

test('the model input cap: diff excerpts first, then the why texts of the oldest entries', () => {
  const entries = [
    { date: at(3), why: 'w'.repeat(500), diff_excerpt: 'x'.repeat(2500) },
    { date: at(1), why: 'v'.repeat(500), diff_excerpt: 'y'.repeat(2500) },
    { date: at(2), why: 'u'.repeat(500) },
  ];
  const input = { repos: [{ landed: entries }] };
  assert.equal(capModelInput(input, entries, 100_000), null);
  // Room for one excerpt: the oldest goes.
  const size = JSON.stringify(input).length;
  const note = capModelInput(input, entries, size - 1000);
  assert.match(note!, /1 diff excerpt\(s\) and 0 "why" text\(s\)/);
  assert.deepEqual(entries.map((entry) => 'diff_excerpt' in entry), [false, true, false]);
  // Less room: every excerpt, then the oldest whys.
  const tight = capModelInput(input, entries, JSON.stringify(input).length - 3300);
  assert.match(tight!, /1 diff excerpt\(s\) and 2 "why" text\(s\)/);
  assert.deepEqual(entries.map((entry) => entry.why.length), [0, 500, 0]);
  assert.ok(JSON.stringify(input).length <= size - 5000);
});

test('the 150,000-character cap applies by default', () => {
  const entries = Array.from({ length: 80 }, (_, index) => ({ date: at(index / 10), why: 'w'.repeat(200), diff_excerpt: 'x'.repeat(2500) }));
  const input = { entries };
  const note = capModelInput(input, entries);
  assert.ok(note !== null);
  assert.ok(JSON.stringify(input).length <= 150_000);
  assert.ok(entries.filter((entry) => 'diff_excerpt' in entry).length > 0);
  // The newest keep their excerpts.
  assert.ok('diff_excerpt' in entries[0]!);
});

test('the derived description: the first paragraph of README.md, else package.json\'s description, at most 300 characters', async () => {
  const repo = join(temp, 'described');
  await mkdir(repo);
  assert.equal(await derivedDescription(repo), null);
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'x', description: 'The  shop\'s backend.' }));
  assert.equal(await derivedDescription(repo), 'The shop\'s backend.');
  await writeFile(join(repo, 'README.md'), '# Shop\n\n[![build](https://x/b.svg)](https://x)\n<!-- a comment -->\n\nThe shop backend:\norders and payments.\n\nMore.\n');
  assert.equal(await derivedDescription(repo), 'The shop backend: orders and payments.');
  await writeFile(join(repo, 'README.md'), `Title\n=====\n\n${'word '.repeat(100)}\n`);
  const long = (await derivedDescription(repo))!;
  assert.equal(long.length, MAX_DERIVED_DESCRIPTION_CHARS);
  assert.ok(long.endsWith('…'));
});

test('the model input cap is a hard bound: the oldest entries go whole, then the ends of the longest lists, then half of the longest texts', () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({ date: at(10 - index), why: '', subject: `s${index}`.padEnd(400, 'x') }));
  const branches = Array.from({ length: 50 }, (_, index) => ({ name: `b${index}`.padEnd(100, 'y') }));
  const input = { workspaces: [{ name: 'app', landed: entries, branches, description: 'd'.repeat(3000) }] };
  const max = JSON.stringify(input).length - 2000;
  const note = capModelInput(input, entries, max);
  assert.ok(JSON.stringify(input).length <= max);
  assert.match(note!, /0 diff excerpt\(s\) and 0 "why" text\(s\) of the oldest entries, then \d+ of the oldest entries were left out\.$/);
  // The oldest went first; the newest stays.
  assert.equal(input.workspaces[0]!.landed.at(-1)!.subject, entries.at(-1)!.subject);
  assert.ok(input.workspaces[0]!.landed.length < 10);

  // Without entries to drop: the longest list loses its last items.
  const lists = { workspaces: [{ name: 'app', landed: [] as unknown[], branches: branches.map((branch) => ({ ...branch })), files: ['a', 'b'] }] };
  const listsMax = JSON.stringify(lists).length - 1000;
  assert.match(capModelInput(lists, [], listsMax)!, /then \d+ item\(s\) at the end of the longest lists were left out\.$/);
  assert.ok(JSON.stringify(lists).length <= listsMax);
  assert.deepEqual(lists.workspaces[0]!.files, ['a', 'b']);
  assert.equal(lists.workspaces[0]!.branches[0]!.name, branches[0]!.name);

  // Nothing but long texts: halved until it fits.
  const texts = { description: 'd'.repeat(5000), name: 'app' };
  assert.match(capModelInput(texts, [], 1000)!, /half of the \d+ longest text\(s\) were left out\.$/);
  assert.ok(JSON.stringify(texts).length <= 1000);
  assert.equal(texts.name, 'app');
});

test('my commits: all of them, more than 300, from a log of over 1 MB read as a stream with every message whole, with none of a colleague\'s', async () => {
  const repo = join(temp, 'busy');
  execFileSync('git', ['clone', '-q', origin, repo]);
  execFileSync('git', ['config', 'user.email', ME.email], { cwd: repo });
  // 320 of my commits and one of a colleague's on a local branch, made at once by fast-import.
  const when = Math.floor((NOW - 0.5 * DAY) / 1000);
  const head = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: repo, encoding: 'utf8' }).trim();
  const commands = [`commit refs/heads/busy\ncommitter ${COLLEAGUE.name} <${COLLEAGUE.email}> ${when} +0000\ndata 9\nNot mine\nfrom ${head}\nM 644 inline other.txt\ndata 2\nx\n`];
  // Each message about 4 KB with multi-byte characters: the log (over 1 MB) comes in many chunks.
  const why = (index: number): string => `Grüße ${index} `.repeat(400).trim();
  for (let index = 0; index < 320; index += 1) {
    const text = `Commit ${index}\n\n${why(index)}`;
    commands.push(`commit refs/heads/busy\ncommitter ${ME.name} <${ME.email.toUpperCase()}> ${when + index + 1} +0000\ndata ${Buffer.byteLength(text)}\n${text}\nM 644 inline n.txt\ndata ${String(index).length + 1}\n${index}\n`);
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, input: commands.join('') });
  const result = await syncMirror(mirrors, 'busy', repo);
  assert.equal(result.status, 'ok');
  const busy = await extractRepo(result.path!, { ...PERIOD, me: ME.email });
  assert.equal(busy.my_commits.length, 320 + 1);
  assert.equal(new Set(busy.my_commits.map((commit) => commit.sha)).size, 321);
  assert.ok(!busy.my_commits.some((commit) => commit.subject === 'Not mine'));
  assert.equal(busy.my_commits[0]!.subject, 'Commit 319');
  // Every message whole, however the stream was cut (its "why" kept to 1,500 characters).
  const busyCommits = busy.my_commits.filter((commit) => commit.subject.startsWith('Commit '));
  assert.equal(busyCommits.length, 320);
  assert.ok(busyCommits.every((commit) => commit.why === why(Number(commit.subject.slice(7))).slice(0, 1500)));
});

// The period (SF-155, digestPeriod in src/digest-run.ts): from the earliest of the times on the
// previous digest day before today, local time, to the run's start. Past digests play no part (the
// Digests run in test/digest-run.test.ts shows that with stored scheduled digests).
test('the period: from the earliest time on the previous digest day (Friday on a Monday and a Sunday with weekdays_only), to the run\'s start', () => {
  const at = (day: number, hours: number, minutes = 0): Date => new Date(2026, 10, day, hours, minutes);
  const weekdays = { times: ['07:00'], weekdays_only: true };
  const everyDay = { times: ['07:00'], weekdays_only: false };
  // 2026-11-09 is a Monday.
  assert.deepEqual(digestPeriod(at(9, 7, 1), weekdays), { from: at(6, 7).toISOString(), to: at(9, 7, 1).toISOString() });
  // A manual run later on Monday: still from Friday, though Monday's scheduled digest ran at 07:00.
  assert.equal(digestPeriod(at(9, 15, 30), weekdays).from, at(6, 7).toISOString());
  // Before `at` on Monday: the previous digest day is still Friday.
  assert.equal(digestPeriod(at(9, 6, 0), weekdays).from, at(6, 7).toISOString());
  assert.equal(digestPeriod(at(10, 7, 1), weekdays).from, at(9, 7).toISOString());
  // Saturday and Sunday (manual runs): Friday.
  assert.equal(digestPeriod(at(8, 10), weekdays).from, at(6, 7).toISOString());
  assert.equal(digestPeriod(at(7, 10), weekdays).from, at(6, 7).toISOString());
  // Every day a digest day: Sunday on a Monday.
  assert.equal(digestPeriod(at(9, 7, 1), everyDay).from, at(8, 7).toISOString());
  assert.equal(digestPeriod(at(9, 7, 1), { times: ['23:59'], weekdays_only: false }).from, at(8, 23, 59).toISOString());
  // Across a month's start.
  assert.equal(digestPeriod(new Date(2026, 5, 1, 9), weekdays).from, new Date(2026, 4, 29, 7).toISOString());
});

test('the period with several times: from the earliest of them, so every run of a day covers the same start', () => {
  const at = (day: number, hours: number, minutes = 0): Date => new Date(2026, 10, day, hours, minutes);
  const several = { times: ['08:30', '10:45', '16:00'], weekdays_only: true };
  // Tuesday's runs at 08:30, 10:45 and 16:00 all start at Monday 08:30.
  for (const now of [at(10, 8, 30), at(10, 10, 46), at(10, 16, 1)]) {
    assert.deepEqual(digestPeriod(now, several), { from: at(9, 8, 30).toISOString(), to: now.toISOString() });
  }
  // An unsorted list: still the earliest.
  assert.equal(digestPeriod(at(10, 12), { times: ['16:00', '08:30'], weekdays_only: true }).from, at(9, 8, 30).toISOString());
});

test('the period across a DST change keeps the time in local time', () => {
  const zone = process.env.TZ;
  process.env.TZ = 'Europe/Berlin';
  try {
    const weekdays = { times: ['07:00'], weekdays_only: true };
    // Summer time ends on Sunday 2026-10-25: Friday 07:00 CEST is 05:00 UTC, Monday 07:01 CET 06:01 UTC.
    assert.deepEqual(digestPeriod(new Date('2026-10-26T06:01:00Z'), weekdays), { from: '2026-10-23T05:00:00.000Z', to: '2026-10-26T06:01:00.000Z' });
    // Summer time starts on Sunday 2026-03-29: Friday 07:00 CET is 06:00 UTC; without weekdays_only
    // Sunday 07:00 CEST, 05:00 UTC.
    assert.equal(digestPeriod(new Date('2026-03-30T05:01:00Z'), weekdays).from, '2026-03-27T06:00:00.000Z');
    assert.equal(digestPeriod(new Date('2026-03-30T05:01:00Z'), { ...weekdays, weekdays_only: false }).from, '2026-03-29T05:00:00.000Z');
    assert.equal(digestPeriod(new Date('2026-10-26T06:01:00Z'), { ...weekdays, weekdays_only: false }).from, '2026-10-25T06:00:00.000Z');
  } finally {
    if (zone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = zone;
    }
  }
});
