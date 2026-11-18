// Unit tests for the Task file: the front-matter check and the write into the work checkout.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import { JobStore } from '../src/jobs.js';
import type { Workspace } from '../src/registry.js';
import { appendFix, checkNeed, checkTaskContent, landsAfter, MAX_TASK_BYTES, mayTouch, parseFrontMatter, taskImportant, taskReview, taskScope, taskSha256, taskSize, taskSlice, writeTask } from '../src/task-file.js';

const VALID = '---\nticket: PROJ-1\ntitle: Export as CSV\nbase: master\n---\n\n# PROJ-1: Export as CSV\n';

let temp: string;
let jobs: JobStore;

before(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'sf-task-')));
  jobs = new JobStore(join(temp, 'state'));
});

after(async () => {
  await rm(temp, { recursive: true, force: true });
});

async function newWorkspace(name: string): Promise<Workspace> {
  const repo = join(temp, name);
  execFileSync('git', ['init', '-q', repo]);
  return { name, readCheckout: repo, workCheckout: repo };
}

function refused(content: string, ticket = 'PROJ-1'): void {
  assert.throws(() => checkTaskContent(ticket, content), (error: unknown) => error instanceof FactoryError && error.code === 'invalid_content', content.slice(0, 60));
}

test('checkTaskContent accepts the handbook format, comments, quotes and CRLF', () => {
  assert.equal(checkTaskContent('PROJ-1', VALID).toString('utf8'), VALID);
  checkTaskContent('PROJ-1', '---\nticket: PROJ-1\ntitle: "Quoted: title"\nbase: master          # branch to start from\n---\n');
  checkTaskContent('PROJ-1', '---\r\nticket: PROJ-1\r\ntitle: T\r\nbase: feature/x\r\n---\r\nbody\r\n');
  checkTaskContent('PROJ-1', `---\nticket: PROJ-1\ntitle: Б\nbase: m\n---\n${'я'.repeat((MAX_TASK_BYTES - 64) / 2)}`);
});

test('checkTaskContent refuses content without a matching front matter', () => {
  refused('');
  refused('# PROJ-1\n');
  refused(`\n${VALID}`);
  refused('---\nticket: PROJ-1\ntitle: T\nbase: master\n');
  refused(VALID.replace('ticket: PROJ-1', 'ticket: PROJ-2'));
  refused(VALID.replace('ticket: PROJ-1\n', ''));
  refused(VALID.replace('title: Export as CSV\n', ''));
  refused(VALID.replace('base: master', 'base:'));
  refused(VALID.replace('base: master', 'base:   # comment only'));
  refused(VALID, 'proj-1');
  refused(`${VALID}a\0b`);
  refused(`${VALID}\ud800`);
  refused(`${VALID}${'x'.repeat(MAX_TASK_BYTES)}`);
});

test('checkTaskContent checks continues: not the base, not a protected branch, a valid branch name; without it nothing changes', () => {
  const withContinues = (value: string, base = 'master'): string => VALID.replace('base: master', `base: ${base}\ncontinues: ${value}`);
  const message = (content: string): string => {
    try {
      checkTaskContent('PROJ-1', content);
    } catch (error) {
      assert.ok(error instanceof FactoryError && error.code === 'invalid_content', String(error));
      return error.message;
    }
    return 'accepted';
  };
  assert.equal(message(VALID), 'accepted');
  for (const name of ['feature/csv', 'PROJ-1-export', 'release_2.1', 'a.b/c-d']) {
    assert.equal(message(withContinues(name)), 'accepted', name);
  }
  assert.equal(message(withContinues('feature/csv  # the open MR')), 'accepted');
  assert.equal(message(withContinues('feature/x', 'feature/x')), '"continues" must differ from "base".');
  assert.equal(message(withContinues('main')), '"continues" must not be a protected branch (main).');
  assert.equal(message(withContinues('master', 'develop')), '"continues" must not be a protected branch (master).');
  for (const name of ['', '-x', '/x', 'x/', 'x.', 'x.lock', 'a..b', 'a//b', 'a b', 'a~1', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'ü']) {
    assert.equal(message(withContinues(name)), '"continues" must be a valid branch name.', JSON.stringify(name));
  }
});

test('writeTask creates and replaces the Task file atomically and excludes the folder once', async () => {
  const workspace = await newWorkspace('write');
  const created = await writeTask(workspace, 'PROJ-1', VALID, jobs);
  assert.equal(created.path, '.software-factory/PROJ-1.md');
  assert.equal(created.status, 'created');
  assert.equal(created.bytes, Buffer.byteLength(VALID));
  assert.match(created.sha256, /^[0-9a-f]{64}$/);
  const target = join(workspace.workCheckout, created.path);
  assert.equal(await readFile(target, 'utf8'), VALID);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.equal((await stat(join(workspace.workCheckout, '.software-factory'))).mode & 0o777, 0o700);

  const second = `${VALID}\n## Fix 1\n`;
  const replaced = await writeTask(workspace, 'PROJ-1', second, jobs);
  assert.equal(replaced.status, 'replaced');
  assert.equal(await readFile(target, 'utf8'), second);
  assert.deepEqual(await readdir(join(workspace.workCheckout, '.software-factory')), ['PROJ-1.md']);

  const exclude = await readFile(join(workspace.workCheckout, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((line) => line === '.software-factory/').length, 1);
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: workspace.workCheckout, encoding: 'utf8' });
  assert.equal(status, '');
  await assert.rejects(stat(join(workspace.workCheckout, '.gitignore')), { code: 'ENOENT' });
});

test('writeTask appends to an existing exclude without a trailing newline and keeps an existing entry', async () => {
  const workspace = await newWorkspace('exclude');
  const excludePath = join(workspace.workCheckout, '.git', 'info', 'exclude');
  await writeFile(excludePath, '*.log');
  await writeTask(workspace, 'PROJ-1', VALID, jobs);
  assert.equal(await readFile(excludePath, 'utf8'), '*.log\n.software-factory/\n');

  const other = await newWorkspace('exclude-present');
  const otherPath = join(other.workCheckout, '.git', 'info', 'exclude');
  await writeFile(otherPath, '/.software-factory/\n');
  await writeTask(other, 'PROJ-1', VALID, jobs);
  assert.equal(await readFile(otherPath, 'utf8'), '/.software-factory/\n');
});

test('writeTask refuses bad tickets and symlinks on the way', async () => {
  const workspace = await newWorkspace('symlink');
  for (const ticket of ['', '../x', '.hidden', 'a/b', 'x'.repeat(65)]) {
    await assert.rejects(writeTask(workspace, ticket, VALID.replace('PROJ-1', ticket), jobs), { code: 'invalid_ticket' }, ticket);
  }
  const elsewhere = join(temp, 'elsewhere');
  await mkdir(elsewhere);
  await symlink(elsewhere, join(workspace.workCheckout, '.software-factory'));
  await assert.rejects(writeTask(workspace, 'PROJ-1', VALID, jobs), { code: 'forbidden_path' });
  assert.deepEqual(await readdir(elsewhere), []);

  const linked = await newWorkspace('file-symlink');
  await mkdir(join(linked.workCheckout, '.software-factory'));
  await writeFile(join(elsewhere, 'target.md'), 'keep');
  await symlink(join(elsewhere, 'target.md'), join(linked.workCheckout, '.software-factory', 'PROJ-1.md'));
  await assert.rejects(writeTask(linked, 'PROJ-1', VALID, jobs), { code: 'forbidden_path' });
  assert.equal(await readFile(join(elsewhere, 'target.md'), 'utf8'), 'keep');
});

test('taskScope reads scope: in the forms of may_touch; no field or an empty list declares none (SF-053)', () => {
  const fields = (text: string) => parseFrontMatter(`---\nticket: T-1\ntitle: t\nbase: main\n${text}\n---\n`)!;
  assert.deepEqual(taskScope(fields('scope: [src/a.ts, test/**]')), ['src/a.ts', 'test/**']);
  assert.deepEqual(taskScope(fields('scope: src/a.ts, "docs/*.md"  # the files of the ticket')), ['src/a.ts', 'docs/*.md']);
  assert.deepEqual(taskScope(fields('scope: src/a.ts README.md')), ['src/a.ts', 'README.md']);
  assert.equal(taskScope(fields('may_touch: [package.json]')), undefined);
  assert.equal(taskScope(fields('scope:')), undefined);
  assert.equal(taskScope(fields('scope: []')), undefined);
  // Parsed next to may_touch, independently.
  const both = fields('may_touch: [package.json]\nscope: [src/**]');
  assert.deepEqual([mayTouch(both), taskScope(both)], [['package.json'], ['src/**']]);
});

test('taskReview (SF-131) reads review: claude or codex, quoted or with a comment too; any other value or no key is undefined', () => {
  const fields = (text: string) => parseFrontMatter(`---\nticket: T-1\ntitle: t\nbase: main\n${text}\n---\n`)!;
  assert.equal(taskReview(fields('review: claude')), 'claude');
  assert.equal(taskReview(fields('review: "codex"  # the gate alone')), 'codex');
  for (const other of ['review: Claude', 'review: both', 'review:', 'scope: [a]']) {
    assert.equal(taskReview(fields(other)), undefined, other);
  }
});

test('taskImportant (SF-297) is true for important: true, quoted or with a comment too; any other value or no key is not important', () => {
  const fields = (text: string) => parseFrontMatter(`---\nticket: T-1\ntitle: t\nbase: main\n${text}\n---\n`)!;
  assert.equal(taskImportant(fields('important: true')), true);
  assert.equal(taskImportant(fields('important: "true"  # the user said so')), true);
  for (const other of ['important: True', 'important: yes', 'important:', 'scope: [a]']) {
    assert.equal(taskImportant(fields(other)), false, other);
  }
});

test('taskSize (SF-219) reads size: small, medium or complex, quoted or with a comment too; absent or any other value is medium', () => {
  const fields = (text: string) => parseFrontMatter(`---\nticket: T-1\ntitle: t\nbase: main\n${text}\n---\n`)!;
  assert.equal(taskSize(fields('size: small')), 'small');
  assert.equal(taskSize(fields('size: medium')), 'medium');
  assert.equal(taskSize(fields('size: "complex"  # the planner\'s estimate')), 'complex');
  for (const other of ['size: Complex', 'size: large', 'size:', 'scope: [a]']) {
    assert.equal(taskSize(fields(other)), 'medium', other);
  }
});

test('taskSlice (SF-220) reads part_of, slice N/M and kind; absent keys leave kind change and no problems', () => {
  const fields = (text: string) => parseFrontMatter(`---\nticket: T-1\ntitle: t\nbase: main\nsize: small\n${text}\n---\n`)!;
  assert.deepEqual(taskSlice(fields('part_of: SF-210\nslice: 3/5\nkind: "switch"  # the flag')), { part_of: 'SF-210', slice: { n: 3, of: 5 }, kind: 'switch', problems: [] });
  for (const kind of ['mechanical', 'preparation', 'change', 'switch', 'cleanup'] as const) {
    assert.equal(taskSlice(fields(`kind: ${kind}`)).kind, kind);
  }
  assert.deepEqual(taskSlice(fields('scope: [a]')), { kind: 'change', problems: [] });
  // An empty value counts as absent.
  assert.deepEqual(taskSlice(fields('part_of:\nslice: ""\nkind:')), { kind: 'change', problems: [] });
  assert.deepEqual(taskSlice(fields('slice: 1/1')).slice, { n: 1, of: 1 });
  assert.deepEqual(taskSlice(fields('slice: 20/20')).slice, { n: 20, of: 20 });
  // Any run of digits, the bounds checked on the numbers.
  assert.deepEqual(taskSlice(fields('slice: 001/001')), { slice: { n: 1, of: 1 }, kind: 'change', problems: [] });
  assert.deepEqual(taskSlice(fields('slice: 01/003')).slice, { n: 1, of: 3 });
  assert.deepEqual(taskSlice(fields('slice: 2/0020')).slice, { n: 2, of: 20 });
});

test('taskSlice (SF-220) ignores a malformed slice, an unknown kind or a part_of that is no ticket name, with one problem line each', () => {
  const fields = (text: string) => parseFrontMatter(`---\nticket: T-1\ntitle: t\nbase: main\n${text}\n---\n`)!;
  for (const slice of ['0/3', '4/3', '1/21', '21/21', '1 / 3', '1/', '3', 'a/b', '-1/3', '1.5/3', '00/3', '1/021', `1/${'9'.repeat(400)}`]) {
    assert.deepEqual(taskSlice(fields(`slice: ${slice}`)), { kind: 'change', problems: [`slice: "${slice}" is not valid; it is ignored.`] }, slice);
  }
  assert.deepEqual(taskSlice(fields('kind: refactor')), { kind: 'change', problems: ['kind: "refactor" is not valid; it is ignored.'] });
  assert.deepEqual(taskSlice(fields('kind: Change')).problems, ['kind: "Change" is not valid; it is ignored.']);
  assert.deepEqual(taskSlice(fields('part_of: ../x\nslice: 9/2\nkind: mechanical')), {
    kind: 'mechanical', problems: ['part_of: "../x" is not valid; it is ignored.', 'slice: "9/2" is not valid; it is ignored.'],
  });
});

test('landsAfter (SF-084) reads lands_after: in the list forms of may_touch; a ticket of another workspace is <workspace>/<ticket>', () => {
  const fields = (text: string) => parseFrontMatter(`---\nticket: T-1\ntitle: t\nbase: main\n${text}\n---\n`)!;
  assert.deepEqual(landsAfter(fields('lands_after: [SF-078, web/W-2]'), 'app'), [{ workspace: 'app', ticket: 'SF-078' }, { workspace: 'web', ticket: 'W-2' }]);
  assert.deepEqual(landsAfter(fields('lands_after: SF-078 "SF-079"  # both first'), 'app'), [{ workspace: 'app', ticket: 'SF-078' }, { workspace: 'app', ticket: 'SF-079' }]);
  assert.deepEqual(landsAfter(fields('scope: [src/**]'), 'app'), []);
  assert.deepEqual(landsAfter(fields('lands_after: []'), 'app'), []);
  // Duplicates once; names that are no ticket or workspace (paths, empty parts) are dropped.
  assert.deepEqual(landsAfter(fields('lands_after: [A-1, app/A-1, A-1, ../x, Web/W-1, a/b/c, /A-2, web/, .hidden]'), 'app'), [{ workspace: 'app', ticket: 'A-1' }]);
});

const isCode = (code: string) => (error: unknown): boolean => error instanceof FactoryError && error.code === code;

test('writeTask with expectedSha256 (SF-081): the version read is replaced; a stale one is refused with task_changed and nothing is written', async () => {
  const workspace = await newWorkspace('expected');
  const path = join(workspace.workCheckout, '.software-factory', 'PROJ-1.md');
  await assert.rejects(writeTask(workspace, 'PROJ-1', VALID, jobs, { expectedSha256: taskSha256(VALID) }), isCode('task_not_found'));
  await writeTask(workspace, 'PROJ-1', VALID, jobs);
  const edited = `${VALID}\nEdited.\n`;
  const recorded: string[] = [];
  const result = await writeTask(workspace, 'PROJ-1', edited, jobs, { expectedSha256: taskSha256(VALID), record: async (sha) => void recorded.push(sha) });
  assert.equal(await readFile(path, 'utf8'), edited);
  assert.deepEqual(recorded, [taskSha256(edited)]);
  assert.equal(result.sha256, taskSha256(edited));

  // The page still holds VALID's sha256: the file is another version now.
  await assert.rejects(writeTask(workspace, 'PROJ-1', `${VALID}\nMine.\n`, jobs, { expectedSha256: taskSha256(VALID), record: async (sha) => void recorded.push(sha) }), isCode('task_changed'));
  assert.equal(await readFile(path, 'utf8'), edited);
  assert.equal(recorded.length, 1);
});

test('writeTask (SF-081): two concurrent saves from the same version: one wins, the other gets task_changed', async () => {
  const workspace = await newWorkspace('concurrent');
  await writeTask(workspace, 'PROJ-1', VALID, jobs);
  const expectedSha256 = taskSha256(VALID);
  const results = await Promise.allSettled([
    writeTask(workspace, 'PROJ-1', `${VALID}\nA\n`, jobs, { expectedSha256 }),
    writeTask(workspace, 'PROJ-1', `${VALID}\nB\n`, jobs, { expectedSha256 }),
  ]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected']);
  assert.ok(isCode('task_changed')((results[1] as PromiseRejectedResult).reason));
  assert.equal(await readFile(join(workspace.workCheckout, '.software-factory', 'PROJ-1.md'), 'utf8'), `${VALID}\nA\n`);
});

test('writeTask and appendFix (SF-081) record the sha256 of the text written; a failing record does not fail the write', async () => {
  const workspace = await newWorkspace('record');
  const recorded: string[] = [];
  await writeTask(workspace, 'PROJ-1', VALID, jobs, { record: async () => { throw new Error('disk full'); } });
  const text = await appendFix(workspace, 'PROJ-1', 1, '1. [R1, major] Fix it.', undefined, { record: async (sha) => void recorded.push(sha) });
  assert.deepEqual(recorded, [taskSha256(text)]);
  assert.equal(await readFile(join(workspace.workCheckout, '.software-factory', 'PROJ-1.md'), 'utf8'), text);
  // A refused write records nothing.
  await assert.rejects(writeTask(workspace, 'PROJ-1', 'no front matter', jobs, { record: async (sha) => void recorded.push(sha) }), isCode('invalid_content'));
  assert.equal(recorded.length, 1);
});

test('writeTask (SF-064): every image reference into the ticket\'s folder must name an attachment; code blocks, other targets and appendFix are not checked', async () => {
  const workspace = await newWorkspace('refs');
  const head = '---\nticket: PROJ-1\ntitle: T\nbase: master\n---\n\n';
  await writeTask(workspace, 'PROJ-1', `${head}No image yet.\n`, jobs);
  const missing = `${head}![the login](PROJ-1/1.png) and ![b](PROJ-1/2.png) and ![a](PROJ-1/1.png)\n`;
  await assert.rejects(writeTask(workspace, 'PROJ-1', missing, jobs), (error: unknown) => {
    assert.ok(error instanceof FactoryError && error.code === 'attachment_missing', String(error));
    assert.match(error.message, /images PROJ-1 does not have: 1\.png, 2\.png\./);
    return true;
  });
  assert.equal(await readFile(join(workspace.workCheckout, '.software-factory', 'PROJ-1.md'), 'utf8'), `${head}No image yet.\n`);

  // With the image in the folder the reference passes; one inside a fenced code block, another
  // ticket's, an URL and "./" are not attachments of this ticket.
  await mkdir(join(workspace.workCheckout, '.software-factory', 'PROJ-1'));
  await writeFile(join(workspace.workCheckout, '.software-factory', 'PROJ-1', '1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const ok = `${head}![the login](PROJ-1/1.png)\n\n\`\`\`md\n![example](PROJ-1/9.png)\n\`\`\`\n\n![x](PROJ-2/1.png) ![y](https://example.com/a.png) ![z](./PROJ-1/9.png)\n`;
  assert.equal((await writeTask(workspace, 'PROJ-1', ok, jobs)).status, 'replaced');
  // A file of the right name that is not the image its name says is no attachment.
  await writeFile(join(workspace.workCheckout, '.software-factory', 'PROJ-1', '3.png'), 'text');
  await assert.rejects(writeTask(workspace, 'PROJ-1', `${ok}![t](PROJ-1/3.png)\n`, jobs), (error: unknown) => error instanceof FactoryError && error.code === 'attachment_missing');
  // appendFix is not checked.
  assert.match(await appendFix(workspace, 'PROJ-1', 1, '![gone](PROJ-1/7.png)'), /## Fix 1\n\n!\[gone\]\(PROJ-1\/7\.png\)/);
});

// SF-130: whether a Task needs a plan check, and why.
const taskWith = (front: string, body = 'Small change.'): string => `---\nticket: PROJ-1\ntitle: T\nbase: main\n${front}---\n\n# PROJ-1: T\n\n${body}\n`;
const SCOPE = 'scope: [src/a.ts, test/a.test.ts]\n';

test('checkNeed (SF-130): a small scoped Task is not needed, with its scope entries and words', () => {
  // ---, ticket:, PROJ-1, title:, T, base:, main, scope:, [src/a.ts,, test/a.test.ts], ---, #, PROJ-1:, T, Small, change.
  assert.deepEqual(checkNeed(taskWith(SCOPE), 'web'), { needed: false, reason: 'small: 2 scope entries, 16 words' });
  // Own-workspace lands_after, given bare or with its own workspace, does not count.
  assert.equal(checkNeed(taskWith(`${SCOPE}lands_after: [PROJ-0, web/PROJ-2]\n`), 'web').needed, false);
});

test('checkNeed (SF-130): each condition with its reason, the first match giving it', () => {
  assert.deepEqual(checkNeed(taskWith('check: required\n'), 'web'), { needed: true, reason: 'check: required' });
  // An unknown value counts as required.
  assert.deepEqual(checkNeed(taskWith(`check: maybe\n${SCOPE}`), 'web'), { needed: true, reason: 'check: required' });
  assert.deepEqual(checkNeed(taskWith(''), 'web'), { needed: true, reason: 'no scope' });
  assert.deepEqual(checkNeed(taskWith('scope: []\n'), 'web'), { needed: true, reason: 'no scope' });
  assert.deepEqual(checkNeed('no front matter at all', 'web'), { needed: true, reason: 'no scope' });
  const eleven = Array.from({ length: 11 }, (_, index) => `src/f${index}.ts`).join(', ');
  assert.deepEqual(checkNeed(taskWith(`scope: [${eleven}]\n`), 'web'), { needed: true, reason: 'scope has 11 entries' });
  const ten = Array.from({ length: 10 }, (_, index) => `src/f${index}.ts`).join(', ');
  assert.equal(checkNeed(taskWith(`scope: [${ten}]\n`), 'web').needed, false);
  assert.deepEqual(checkNeed(taskWith('scope: [src/**, README.md]\n'), 'web'), { needed: true, reason: 'scope has a glob' });
  assert.deepEqual(checkNeed(taskWith(`${SCOPE}lands_after: [PROJ-0, api/API-7]\n`), 'web'), { needed: true, reason: 'lands after api/API-7' });
  // The first match: more than 10 entries before a glob.
  assert.equal(checkNeed(taskWith(`scope: [${ten}, src/**]\n`), 'web').reason, 'scope has 11 entries');
});

test('checkNeed (SF-130): words are the whitespace-separated tokens of the whole file, front matter included', () => {
  const head = taskWith(SCOPE, '');
  const headWords = head.split(/\s+/).filter((word) => word !== '').length;
  const at = taskWith(SCOPE, Array.from({ length: 1200 - headWords }, () => 'word').join(' \n\t '));
  assert.equal(checkNeed(at, 'web').reason, 'small: 2 scope entries, 1200 words');
  const over = taskWith(SCOPE, Array.from({ length: 1201 - headWords }, () => 'word').join(' '));
  assert.deepEqual(checkNeed(over, 'web'), { needed: true, reason: '1201 words' });
});

test('checkNeed (SF-130): check: skip wins over every condition', () => {
  const big = Array.from({ length: 1300 }, () => 'word').join(' ');
  const eleven = Array.from({ length: 11 }, (_, index) => `src/f${index}/**`).join(', ');
  assert.deepEqual(checkNeed(taskWith(`check: skip\nscope: [${eleven}]\nlands_after: [api/API-7]\n`, big), 'web'), { needed: false, reason: 'check: skip' });
  assert.deepEqual(checkNeed(taskWith('check: skip\n'), 'web'), { needed: false, reason: 'check: skip' });
});
