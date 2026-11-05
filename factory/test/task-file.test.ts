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
import { checkTaskContent, landsAfter, MAX_TASK_BYTES, mayTouch, parseFrontMatter, taskScope, writeTask } from '../src/task-file.js';

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

test('landsAfter (SF-084) reads lands_after: in the list forms of may_touch; a ticket of another workspace is <workspace>/<ticket>', () => {
  const fields = (text: string) => parseFrontMatter(`---\nticket: T-1\ntitle: t\nbase: main\n${text}\n---\n`)!;
  assert.deepEqual(landsAfter(fields('lands_after: [SF-078, web/W-2]'), 'app'), [{ workspace: 'app', ticket: 'SF-078' }, { workspace: 'web', ticket: 'W-2' }]);
  assert.deepEqual(landsAfter(fields('lands_after: SF-078 "SF-079"  # both first'), 'app'), [{ workspace: 'app', ticket: 'SF-078' }, { workspace: 'app', ticket: 'SF-079' }]);
  assert.deepEqual(landsAfter(fields('scope: [src/**]'), 'app'), []);
  assert.deepEqual(landsAfter(fields('lands_after: []'), 'app'), []);
  // Duplicates once; names that are no ticket or workspace (paths, empty parts) are dropped.
  assert.deepEqual(landsAfter(fields('lands_after: [A-1, app/A-1, A-1, ../x, Web/W-1, a/b/c, /A-2, web/, .hidden]'), 'app'), [{ workspace: 'app', ticket: 'A-1' }]);
});
