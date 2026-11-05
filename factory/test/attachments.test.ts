// A ticket's images (SF-064, src/attachments.ts) against throwaway repositories: the type by the
// magic bytes only, the size and count limits, the names (the pattern, the extension of the type,
// nothing outside the ticket's folder, the next number with no gap reused), the Task file required,
// the archive and ".md" tickets refused, the write_task guard (a running job refuses, a paused one
// does not), what the listing ignores, reading, removing, the image targets of a Task file, and
// `sf attach` with a name, without one and --remove.
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { addAttachment, imageTargets, listAttachments, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, missingAttachments, readAttachment, removeAttachment, sniffExtension } from '../src/attachments.js';
import { FactoryError } from '../src/errors.js';
import { type Job, JobStore } from '../src/jobs.js';
import type { Workspace } from '../src/registry.js';
import { writeTask } from '../src/task-file.js';
import { newEnv, newRepo, putTask, runCli, task } from './support/harness.js';

// The smallest bytes each type is told by, and some more.
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);
export const GIF = Buffer.from('GIF89a-gif-body');
export const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBPVP8 body')]);

async function refused(work: Promise<unknown>, code: string): Promise<string> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof FactoryError, String(error));
    assert.equal(error.code, code, error.message);
    return error.message;
  }
  assert.fail(`expected ${code}`);
}

function jobOf(ticket: string, state: Job['state']): Job {
  return {
    workspace: 'app', ticket, branch: `${ticket}-x`, base: 'main', base_commit: null, target_commit: null, worktree: null, prepared_commit: null, mr_attempts: 0, fixes: 0, gate_fixes: 0, gate_tokens: 0, state,
    iteration: 0, session_id: null, mr: null, created_at: '2026-11-05T10:00:00.000Z', updated_at: '2026-11-05T10:00:00.000Z',
  };
}

async function workspaceWithTask(name: string, ticket = 'T-1'): Promise<{ workspace: Workspace; repo: string; jobs: JobStore; env: Awaited<ReturnType<typeof newEnv>> }> {
  const env = await newEnv(name);
  const repo = await newRepo(env, `${name}-repo`, false);
  await putTask(env, repo, ticket, 'One');
  return { workspace: { name: 'app', readCheckout: repo, workCheckout: repo }, repo, jobs: new JobStore(env.state), env };
}

test('attachments: the type is told by the first bytes only', () => {
  assert.equal(sniffExtension(PNG), 'png');
  assert.equal(sniffExtension(JPEG), 'jpg');
  assert.equal(sniffExtension(GIF), 'gif');
  assert.equal(sniffExtension(Buffer.from('GIF87a....')), 'gif');
  assert.equal(sniffExtension(WEBP), 'webp');
  for (const other of [Buffer.alloc(0), Buffer.from('not an image'), Buffer.from('%PDF-1.7'), Buffer.from('RIFF\0\0\0\0WAVEfmt '), PNG.subarray(0, 7), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')]) {
    assert.equal(sniffExtension(other), undefined, other.toString('latin1'));
  }
});

test('attachments: add numbers the images, names keep to the pattern and the type, the limits hold, list and read', async () => {
  const { workspace, repo, jobs } = await workspaceWithTask('att-add');
  const dir = join(repo, '.software-factory', 'T-1');
  assert.deepEqual(await listAttachments(workspace, 'T-1'), []);

  // Without a name: the next number with the real type's extension; with one: as given.
  assert.deepEqual(await addAttachment(workspace, 'T-1', PNG, jobs), { name: '1.png', bytes: PNG.length, type: 'image/png' });
  assert.deepEqual(await addAttachment(workspace, 'T-1', JPEG, jobs), { name: '2.jpg', bytes: JPEG.length, type: 'image/jpeg' });
  assert.deepEqual(await addAttachment(workspace, 'T-1', WEBP, jobs, 'login-screen.webp'), { name: 'login-screen.webp', bytes: WEBP.length, type: 'image/webp' });
  assert.deepEqual(await readFile(join(dir, '1.png')), PNG);
  // A gap after a removal is not reused: the highest number + 1.
  await removeAttachment(workspace, 'T-1', '1.png', jobs);
  assert.equal((await addAttachment(workspace, 'T-1', GIF, jobs)).name, '3.gif');
  assert.deepEqual((await listAttachments(workspace, 'T-1')).map((image) => [image.name, image.type]), [['2.jpg', 'image/jpeg'], ['3.gif', 'image/gif'], ['login-screen.webp', 'image/webp']]);

  // A non-image renamed .png, and an empty body, are refused by their bytes.
  assert.match(await refused(addAttachment(workspace, 'T-1', Buffer.from('just text'), jobs, 'fake.png'), 'attachment_type'), /PNG, JPEG, WebP and GIF/);
  await refused(addAttachment(workspace, 'T-1', Buffer.alloc(0), jobs), 'attachment_type');
  // Names: the extension of the detected type; nothing that leaves the folder or breaks the pattern.
  assert.match(await refused(addAttachment(workspace, 'T-1', PNG, jobs, 'shot.jpg'), 'invalid_name'), /must end in \.png/);
  // 64 characters before the extension are the most a name may have.
  assert.equal((await addAttachment(workspace, 'T-1', PNG, jobs, `${'x'.repeat(64)}.png`)).name.length, 68);
  await removeAttachment(workspace, 'T-1', `${'x'.repeat(64)}.png`, jobs);
  for (const name of ['../escape.png', 'a/b.png', '/abs.png', '..png', '.hidden.png', 'shot.PNG', 'shot.jpeg', 'shot', 'shot.png/', `${'x'.repeat(65)}.png`, 'sp ace.png', 'a\\b.png']) {
    await refused(addAttachment(workspace, 'T-1', PNG, jobs, name), 'invalid_name');
  }
  // A name taken is refused, not replaced.
  assert.match(await refused(addAttachment(workspace, 'T-1', JPEG, jobs, '2.jpg'), 'invalid_name'), /already exists/);
  assert.deepEqual(await readFile(join(dir, '2.jpg')), JPEG);

  // At most 5 MB each: exactly the limit is taken, one byte more is not.
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES - PNG.length)]);
  assert.equal((await addAttachment(workspace, 'T-1', big, jobs, 'big.png')).bytes, MAX_ATTACHMENT_BYTES);
  await refused(addAttachment(workspace, 'T-1', Buffer.concat([big, Buffer.alloc(1)]), jobs), 'attachment_too_large');
  // At most 10 per ticket.
  while ((await listAttachments(workspace, 'T-1')).length < MAX_ATTACHMENTS) {
    await addAttachment(workspace, 'T-1', PNG, jobs);
  }
  assert.match(await refused(addAttachment(workspace, 'T-1', PNG, jobs), 'attachment_limit'), /at most 10/);

  // Read: the bytes and the type; a missing one, a bad name.
  const image = await readAttachment(workspace, 'T-1', 'login-screen.webp');
  assert.deepEqual([image.name, image.type, image.bytes, image.data], ['login-screen.webp', 'image/webp', WEBP.length, WEBP]);
  await refused(readAttachment(workspace, 'T-1', '99.png'), 'attachment_missing');
  await refused(readAttachment(workspace, 'T-1', '../T-1.md'), 'invalid_name');
  // Nothing was written outside the ticket's folder (the atomic write's temp files are gone too).
  assert.deepEqual((await readdir(join(repo, '.software-factory'))).sort(), ['T-1', 'T-1.md']);
  assert.ok((await readdir(dir)).every((name) => !name.startsWith('.')));
});

test('attachments: the listing ignores what is not an image of the pattern; reads refuse links and a mismatched type', async () => {
  const { workspace, repo, jobs } = await workspaceWithTask('att-list');
  const dir = join(repo, '.software-factory', 'T-1');
  await addAttachment(workspace, 'T-1', PNG, jobs);
  await writeFile(join(dir, 'notes.txt'), 'x');
  await writeFile(join(dir, 'renamed.png'), 'not an image');
  await writeFile(join(dir, 'wrong.jpg'), PNG);
  await mkdir(join(dir, 'sub.png'));
  await writeFile(join(repo, 'outside.png'), PNG);
  await symlink(join(repo, 'outside.png'), join(dir, 'link.png'));
  assert.deepEqual((await listAttachments(workspace, 'T-1')).map((image) => image.name), ['1.png']);
  // Numbering looks at every numbered name in the folder, so a file that is not listed is never overwritten.
  await writeFile(join(dir, '7.png'), 'junk');
  assert.equal((await addAttachment(workspace, 'T-1', PNG, jobs)).name, '8.png');
  // Fix 1 (R1): a number of any length a valid name allows, without precision loss.
  await writeFile(join(dir, '1000000000.png'), PNG);
  assert.equal((await addAttachment(workspace, 'T-1', PNG, jobs)).name, '1000000001.png');
  await writeFile(join(dir, '0012345678901234567890.gif'), 'junk');
  assert.equal((await addAttachment(workspace, 'T-1', PNG, jobs)).name, '12345678901234567891.png');
  // The successor of the longest number a name may have does not fit a name: refused, nothing written.
  const longest = `${'9'.repeat(64)}.png`;
  await writeFile(join(dir, longest), 'junk');
  assert.match(await refused(addAttachment(workspace, 'T-1', PNG, jobs), 'invalid_name'), /give the image a name/);
  assert.equal((await addAttachment(workspace, 'T-1', PNG, jobs, 'named.png')).name, 'named.png');
  for (const name of [longest, '0012345678901234567890.gif', '12345678901234567891.png', '1000000001.png', '1000000000.png', 'named.png']) {
    await rm(join(dir, name));
  }
  await refused(readAttachment(workspace, 'T-1', 'link.png'), 'forbidden_path');
  await refused(readAttachment(workspace, 'T-1', 'wrong.jpg'), 'attachment_type');
  await refused(readAttachment(workspace, 'T-1', 'renamed.png'), 'attachment_type');
  // Remove takes a file of an attachment's name that is none, never a link's target or a directory.
  await removeAttachment(workspace, 'T-1', 'renamed.png', jobs);
  await refused(removeAttachment(workspace, 'T-1', 'sub.png', jobs), 'forbidden_path');
  await refused(removeAttachment(workspace, 'T-1', 'gone.png', jobs), 'attachment_missing');
  await refused(removeAttachment(workspace, 'T-1', '../T-1.md', jobs), 'invalid_name');

  // The ticket's folder as a link to elsewhere is refused.
  const other = await workspaceWithTask('att-link', 'T-2');
  await mkdir(join(other.repo, 'elsewhere'));
  await symlink(join(other.repo, 'elsewhere'), join(other.repo, '.software-factory', 'T-2'));
  await refused(addAttachment(other.workspace, 'T-2', PNG, other.jobs), 'forbidden_path');
  await refused(listAttachments(other.workspace, 'T-2'), 'forbidden_path');
  assert.deepEqual(await readdir(join(other.repo, 'elsewhere')), []);
});

test('attachments: the Task file is required, archive and ".md" tickets are refused, a running job refuses changes and a paused one does not', async () => {
  const { workspace, repo, jobs, env } = await workspaceWithTask('att-guard');
  await refused(addAttachment(workspace, 'T-9', PNG, jobs), 'task_not_found');
  await refused(listAttachments(workspace, 'T-9'), 'task_not_found');
  await refused(readAttachment(workspace, 'T-9', '1.png'), 'task_not_found');
  await refused(removeAttachment(workspace, 'T-9', '1.png', jobs), 'task_not_found');
  // "archive" is a valid ticket key but the archive folder's name; a key ending in .md looks like a Task file.
  await writeTask(workspace, 'archive', task('archive', 'A'), jobs);
  await refused(addAttachment(workspace, 'archive', PNG, jobs), 'invalid_ticket');
  await refused(addAttachment(workspace, 'x.md', PNG, jobs), 'invalid_ticket');
  await refused(addAttachment(workspace, '../T-1', PNG, jobs), 'invalid_ticket');

  await addAttachment(workspace, 'T-1', PNG, jobs);
  await jobs.write(jobOf('T-1', 'working'));
  assert.match(await refused(addAttachment(workspace, 'T-1', PNG, jobs), 'job_active'), /working; its images cannot be changed now/);
  await refused(removeAttachment(workspace, 'T-1', '1.png', jobs), 'job_active');
  // Reading goes on during the job.
  assert.equal((await readAttachment(workspace, 'T-1', '1.png')).type, 'image/png');
  await jobs.write(jobOf('T-1', 'paused'));
  assert.equal((await addAttachment(workspace, 'T-1', PNG, jobs)).name, '2.png');
  await removeAttachment(workspace, 'T-1', '2.png', jobs);
  await jobs.write(jobOf('T-1', 'aborted'));
  // The highest number is 1 again after 2.png went: the next is 2.png (only a gap below the highest stays).
  assert.equal((await addAttachment(workspace, 'T-1', PNG, jobs)).name, '2.png');
  assert.deepEqual((await readdir(join(repo, '.software-factory', 'T-1'))).sort(), ['1.png', '2.png']);
  assert.ok(env.state.length > 0);
});

test('attachments: the image targets of a Task file outside fenced code, and the ones the ticket does not have', async () => {
  const text = [
    '---', 'ticket: T-1', '---', 'See ![the login](T-1/1.png) and ![x](T-1/2.png "title") and ![y](./T-1/3.png).',
    '![other](https://example.com/a.png) ![nested [no]](T-1/4.png)', '```md', '![in code](T-1/9.png)', '```', '~~~', '![tilde](T-1/8.png)', '~~~',
    '````', '```', '![still code](T-1/7.png)', '````', 'After ![last](T-1/1.png)',
  ].join('\n');
  assert.deepEqual(imageTargets(text), ['T-1/1.png', 'T-1/2.png', './T-1/3.png', 'https://example.com/a.png', 'T-1/1.png']);

  const { workspace, jobs } = await workspaceWithTask('att-refs');
  await addAttachment(workspace, 'T-1', PNG, jobs);
  assert.deepEqual(await missingAttachments(workspace, 'T-1', text), ['2.png']);
  assert.deepEqual(await missingAttachments(workspace, 'T-1', 'No image.'), []);
  assert.deepEqual(await missingAttachments(workspace, 'T-2', '![a](T-2/1.png)'), ['1.png']);
});

test('sf attach: a file with a name and without one, the rules, --remove, the usage', async () => {
  const env = await newEnv('att-cli');
  const repo = await newRepo(env, 'att-cli-repo', false);
  await putTask(env, repo, 'T-1', 'One');
  const files = join(repo, '..', 'att-cli-files');
  await mkdir(files, { recursive: true });
  await writeFile(join(files, 'shot.jpg'), JPEG);
  await writeFile(join(files, 'fake.png'), 'plain text');
  await writeFile(join(files, 'big.png'), Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES)]));
  const dir = join(repo, '.software-factory', 'T-1');

  const named = await runCli(env, ['attach', 'app', 'T-1', join(files, 'shot.jpg'), 'login.jpg']);
  assert.equal(named.code, 0, named.stderr);
  assert.equal(named.stdout.trim(), `Attached .software-factory/T-1/login.jpg (image/jpeg, ${JPEG.length} bytes).`);
  const numbered = await runCli(env, ['attach', 'app', 'T-1', join(files, 'shot.jpg')]);
  assert.equal(numbered.stdout.trim(), `Attached .software-factory/T-1/1.jpg (image/jpeg, ${JPEG.length} bytes).`);
  assert.deepEqual(await readFile(join(dir, '1.jpg')), JPEG);

  const fake = await runCli(env, ['attach', 'app', 'T-1', join(files, 'fake.png')]);
  assert.equal(fake.code, 1);
  assert.match(fake.stderr, /Only PNG, JPEG, WebP and GIF images/);
  assert.match((await runCli(env, ['attach', 'app', 'T-1', join(files, 'big.png')])).stderr, /at most 5242880 bytes/);
  assert.match((await runCli(env, ['attach', 'app', 'T-1', join(files, 'shot.jpg'), 'shot.png'])).stderr, /must end in \.jpg/);
  assert.match((await runCli(env, ['attach', 'app', 'T-1', join(files, 'missing.png')])).stderr, /cannot be read/);
  assert.match((await runCli(env, ['attach', 'app', 'T-9', join(files, 'shot.jpg')])).stderr, /T-9\.md does not exist/);

  const removed = await runCli(env, ['attach', 'app', 'T-1', '--remove', 'login.jpg']);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(removed.stdout.trim(), 'Removed .software-factory/T-1/login.jpg.');
  assert.deepEqual(await readdir(dir), ['1.jpg']);
  assert.match((await runCli(env, ['attach', 'app', 'T-1', '--remove', 'login.jpg'])).stderr, /does not exist/);

  // The same guard as the page: a running job refuses.
  await new JobStore(env.state).write(jobOf('T-1', 'working'));
  assert.match((await runCli(env, ['attach', 'app', 'T-1', join(files, 'shot.jpg')])).stderr, /its images cannot be changed now/);
  await rm(join(env.state, 'jobs'), { recursive: true, force: true });

  for (const args of [['attach', 'app', 'T-1'], ['attach', 'app', 'T-1', '--remove', 'x.png', 'extra'], ['attach', 'app', 'T-1', 'a', 'b', 'c']]) {
    const usage = await runCli(env, args);
    assert.equal(usage.code, 2, args.join(' '));
    assert.match(usage.stderr, /attach needs <workspace> <ticket> <file> \[name\]/);
  }
  assert.match((await runCli(env, ['--help'])).stdout, /sf attach <workspace> <ticket> <file> \[name\]/);
});
