// Contract tests for deploy/openclaw/sf-dispatch-receiver.mjs, the fixed command
// that the OpenClaw command automation runs inside the gateway container. Runs it
// with plain Node against a throwaway dispatch directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const RECEIVER = fileURLToPath(new URL('../../../deploy/openclaw/sf-dispatch-receiver.mjs', import.meta.url));
const REQUEST = {
  request_id: '0b7a1c55-3f0e-4c1e-9f55-8d1e2a6f0c11',
  app_id: 'sf-pilot',
  job_id: 'job-001',
  instruction_sha256: 'b3496d0aaf2cac18460200ab1a7c4363033688afb2f972f3b6a55cecff7e3bbc',
};

let dir: string;

function receiver(mode: string, input = ''): Promise<{ code: number | null; lines: Array<Record<string, unknown>>; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RECEIVER, mode], { env: { SF_DISPATCH_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) => {
      const lines = stdout
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      resolve({ code, lines, stderr });
    });
    child.stdin.end(input);
  });
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sf-dispatch-receiver-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('accepts an enqueued request exactly once and records it', async () => {
  assert.deepEqual(await receiver('accept'), { code: 0, lines: [{ sf_dispatch: 'idle' }], stderr: '' });

  const enqueued = await receiver('enqueue', JSON.stringify(REQUEST));
  assert.deepEqual([enqueued.code, enqueued.lines], [0, [{ enqueued: true, request_id: REQUEST.request_id }]]);
  assert.deepEqual(await readdir(join(dir, 'inbox')), [`${REQUEST.request_id}.json`]);

  const accepted = await receiver('accept');
  assert.equal(accepted.code, 0);
  assert.equal(accepted.lines.length, 1);
  const [line] = accepted.lines;
  assert.deepEqual({ ...line, accepted_at: undefined }, { sf_dispatch: 'accepted', ...REQUEST, accepted_at: undefined });
  assert.match(String(line!.accepted_at), /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(await readdir(join(dir, 'inbox')), []);
  const record = JSON.parse(await readFile(join(dir, 'accepted', `${REQUEST.request_id}.json`), 'utf8'));
  assert.deepEqual(record, { ...REQUEST, accepted_at: line!.accepted_at });

  // A retried request is enqueued again; the accept run reports the first acceptance instead of a second one.
  const again = await receiver('enqueue', JSON.stringify(REQUEST));
  assert.deepEqual(again.lines, [{ enqueued: true, request_id: REQUEST.request_id }]);
  const replay = await receiver('accept');
  assert.deepEqual(replay.lines, [{ sf_dispatch: 'already_accepted', ...REQUEST, accepted_at: line!.accepted_at }]);
  assert.deepEqual(await readdir(join(dir, 'inbox')), []);
  assert.equal(JSON.parse(await readFile(join(dir, 'accepted', `${REQUEST.request_id}.json`), 'utf8')).accepted_at, line!.accepted_at);
});

test('enqueue refuses anything but the four validated fields', async () => {
  const bad = [
    '',
    'not json',
    JSON.stringify({ ...REQUEST, extra: 1 }),
    JSON.stringify({ ...REQUEST, app_id: '../x' }),
    JSON.stringify({ ...REQUEST, job_id: 'Job' }),
    JSON.stringify({ ...REQUEST, request_id: '../../etc/passwd' }),
    JSON.stringify({ ...REQUEST, instruction_sha256: 'abc' }),
    JSON.stringify({ request_id: REQUEST.request_id }),
    'x'.repeat(5000),
  ];
  for (const input of bad) {
    const result = await receiver('enqueue', input);
    assert.equal(result.code, 2, input.slice(0, 60));
  }
  assert.equal((await receiver('bogus-mode')).code, 2);
  assert.deepEqual(await readdir(join(dir, 'inbox')), []);
});

test('accept rejects a tampered inbox entry and fails the run', async () => {
  await writeFile(join(dir, 'inbox', 'not-a-request.json'), '{"request_id":"x"}');
  const result = await receiver('accept');
  assert.equal(result.code, 2);
  assert.deepEqual(result.lines, [{ sf_dispatch: 'rejected', entry: 'not-a-request.json', reason: 'invalid request' }]);
  assert.deepEqual(await readdir(join(dir, 'inbox')), []);
  assert.deepEqual(await readdir(join(dir, 'rejected')), ['not-a-request.json']);
});

test('a request id already accepted for a different payload is refused and the first acceptance stays', async () => {
  const original = await readFile(join(dir, 'accepted', `${REQUEST.request_id}.json`), 'utf8');
  const variants = [
    { ...REQUEST, job_id: 'job-other' },
    { ...REQUEST, app_id: 'other-app' },
    { ...REQUEST, instruction_sha256: '0'.repeat(64) },
  ];
  for (const variant of variants) {
    assert.equal((await receiver('enqueue', JSON.stringify(variant))).code, 0);
    const result = await receiver('accept');
    assert.equal(result.code, 2, JSON.stringify(variant));
    assert.deepEqual(result.lines, [
      {
        sf_dispatch: 'conflict',
        entry: `${REQUEST.request_id}.json`,
        request_id: REQUEST.request_id,
        reason: 'request_id was already accepted with a different payload',
      },
    ]);
    assert.ok(!result.lines.some((line) => line.sf_dispatch === 'accepted' || line.sf_dispatch === 'already_accepted'));
    assert.equal(await readFile(join(dir, 'accepted', `${REQUEST.request_id}.json`), 'utf8'), original);
    assert.deepEqual(await readdir(join(dir, 'inbox')), []);
  }
  // Every refused entry is kept; none overwrites an earlier one.
  const rejected = (await readdir(join(dir, 'rejected'))).filter((name) => name.startsWith(REQUEST.request_id));
  assert.equal(rejected.length, variants.length);

  // The original payload is still acknowledged as already accepted.
  await receiver('enqueue', JSON.stringify(REQUEST));
  const same = await receiver('accept');
  assert.deepEqual([same.code, same.lines[0]?.sf_dispatch], [0, 'already_accepted']);
});

test('an unreadable accepted record is a conflict, not an acknowledgement', async () => {
  const request = { ...REQUEST, request_id: '22222222-3333-4444-8555-666666666666' };
  await writeFile(join(dir, 'accepted', `${request.request_id}.json`), '{"request_id":');
  await receiver('enqueue', JSON.stringify(request));
  const result = await receiver('accept');
  assert.equal(result.code, 2);
  assert.equal(result.lines[0]?.sf_dispatch, 'conflict');
  assert.equal(await readFile(join(dir, 'accepted', `${request.request_id}.json`), 'utf8'), '{"request_id":');
});
