// SF-009 with supervisors in their own processes: racing supervisors start one session, a killed
// supervisor is never followed by a second launch, and a crash during a capture publishes nothing.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acceptedJob, destroyFixture, invocations, jobDir, type Fixture } from './support/operator-fixture.js';
import { authorize, createExecutorFixture, enableApp, gateway, waitFor } from './support/executor-fixture.js';

const ENTRY = fileURLToPath(new URL('./support/supervisor-fixture.js', import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

async function fixture(): Promise<{ fx: Fixture; file: string }> {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  await enableApp(fx);
  const file = join(fx.sandbox, 'fixture.json');
  await writeFile(file, JSON.stringify(fx));
  return { fx, file };
}

interface Proc {
  child: ChildProcess;
  first: Promise<string>;
  exited: Promise<number | null>;
}

function supervisor(file: string, fault?: string): Proc {
  const child = spawn(process.execPath, [ENTRY, file, ...(fault ? [fault] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8000))]);
      child.kill('SIGKILL');
    }
  });
  const first = new Promise<string>((resolve) => {
    let output = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes('\n')) resolve(output.split('\n')[0]!);
    });
    child.once('exit', () => resolve(output.split('\n')[0] || 'exited'));
  });
  return { child, first, exited };
}

const status = (fx: Fixture, job: string, wanted: string, diagnostic?: RegExp) =>
  waitFor(async () => {
    const value = await gateway(fx).status(fx.app, job);
    return value.status === wanted && (diagnostic === undefined || diagnostic.test(`${value.job?.diagnostic?.code}`)) ? value : undefined;
  }, `${job} ${wanted}`);

test('racing supervisors: exactly one runs, and one authorization starts one session', async () => {
  const { fx, file } = await fixture();
  const accepted = await acceptedJob(fx, 'job-race');
  const procs = [supervisor(file), supervisor(file), supervisor(file)];
  const firsts = (await Promise.all(procs.map((proc) => proc.first))).sort();
  assert.deepEqual(firsts, ['error locked', 'error locked', 'ready']);
  await authorize(fx, 'job-race', accepted, randomUUID());
  await status(fx, 'job-race', 'awaiting_review');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await invocations(fx)).length, 1);
});

test('a killed supervisor is never followed by a second launch; its session is collected for inspection', async () => {
  const { fx, file } = await fixture();
  const accepted = await acceptedJob(fx, 'job-kill');
  const first = supervisor(file);
  assert.equal(await first.first, 'ready');
  await authorize(fx, 'job-kill', accepted, randomUUID());
  await status(fx, 'job-kill', 'awaiting_review');
  first.child.kill('SIGKILL');
  await first.exited;
  // The session's input closed with its supervisor, so the fake Claude ends; a new supervisor collects it.
  const second = supervisor(file);
  assert.equal(await second.first, 'ready');
  const ended = await status(fx, 'job-kill', 'needs_inspection', /supervisor_restarted/);
  assert.equal(ended.job?.execution_state, 'interrupted');
  assert.equal(ended.job?.session_process, 'ended');
  const execution = JSON.parse(await readFile(join(jobDir(fx, 'job-kill'), 'execution.json'), 'utf8')) as { state: string; error: { code: string } };
  assert.equal(execution.state, 'interrupted');
  assert.equal(execution.error.code, 'adapter_interrupted');
  // A further restart changes nothing and launches nothing.
  second.child.kill('SIGTERM');
  await second.exited;
  const third = supervisor(file);
  assert.equal(await third.first, 'ready');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal((await gateway(fx).status(fx.app, 'job-kill')).status, 'needs_inspection');
  assert.equal((await invocations(fx)).length, 1);
});

test('a crash during a capture publishes no snapshot and never leads to a second launch', async () => {
  const { fx, file } = await fixture();
  const accepted = await acceptedJob(fx, 'job-crash');
  const crashing = supervisor(file, 'crash-before-commit');
  assert.equal(await crashing.first, 'ready');
  await authorize(fx, 'job-crash', accepted, randomUUID());
  await crashing.exited;
  // The crash left unreferenced capture files: they are not evidence.
  const files = await readdir(jobDir(fx, 'job-crash'));
  assert.ok(files.includes('iteration-001.diff'));
  assert.ok(!files.includes('iteration-001.snapshot.json'));
  const gw = gateway(fx);
  assert.equal((await gw.status(fx.app, 'job-crash')).job?.iterations[0]?.snapshot_sha256, null);
  await assert.rejects(gw.snapshot(fx.app, 'job-crash', 'iteration-001'), { code: 'not_found' });
  assert.equal((await gw.listReviewReady(fx.app)).ready.length, 0);
  const next = supervisor(file);
  assert.equal(await next.first, 'ready');
  const ended = await status(fx, 'job-crash', 'needs_inspection', /supervisor_restarted/);
  assert.equal(ended.job?.iterations[0]?.state, 'abandoned');
  assert.equal((await invocations(fx)).length, 1);
});
