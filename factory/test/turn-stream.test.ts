// SF-196: a factory turn always ends. The session driver alone, on the fake Claude Code: a session
// whose stream stays open after its result (the CLI kept alive by a background task) is ended
// after the grace time, the turn finishing with that result and the stuck hook told; a turn whose
// result comes late is never cut; a close() during the grace time ends the turn as closed. And the
// event's line in sf watch.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { type IdleOutcome, ImplementerSession, type SessionHooks, STREAM_GRACE_MS } from '../src/session.js';
import { formatEvent } from '../src/watch.js';
import { FAKE, temp } from './support/harness.js';

// Runs fn with HOME set to a fresh folder holding the fake's turn scripts.
async function withFake<T>(name: string, turns: unknown[], fn: (home: string) => Promise<T>): Promise<T> {
  const home = join(temp, name);
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'fake-claude.json'), JSON.stringify({ turns }));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    process.env.HOME = saved;
  }
}

// A session on the fake with the given grace time, recording the stuck hook's calls.
function session(home: string, streamGraceMs: number, stuck: number[], hooks: Partial<SessionHooks> = {}): { session: ImplementerSession; idle: Promise<IdleOutcome> } {
  let idle: (outcome: IdleOutcome) => void = () => undefined;
  const outcome = new Promise<IdleOutcome>((done) => (idle = done));
  const created = new ImplementerSession({ cwd: home, maxTurns: 5, claudePath: FAKE, streamGraceMs }, {
    message: async () => undefined,
    prompt: async () => undefined,
    streamStuck: async (waitedS) => void stuck.push(waitedS),
    idle: async (result) => idle(result),
    ...hooks,
  });
  return { session: created, idle: outcome };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('the grace time after a result is 2 minutes', () => {
  assert.equal(STREAM_GRACE_MS, 120_000);
});

test('a stream left open after its result: the session ends Claude Code after the grace time, tells the stuck hook, and the turn finishes with that result', async () => {
  await withFake('stream-stuck', [{ text: 'the report', holdOpen: true }], async (home) => {
    const stuck: number[] = [];
    const { session: held, idle } = session(home, 300, stuck);
    const started = Date.now();
    held.send('go', []);
    const outcome = await idle;
    assert.ok(Date.now() - started >= 300);
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.ok && outcome.text, 'the report');
    assert.equal(outcome.ok && outcome.result.subtype, 'success');
    assert.deepEqual(stuck, [1]);
    // The fake's process, held open, is ended.
    const pid = Number(await readFile(join(home, 'fake-claude.held'), 'utf8'));
    const deadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(alive(pid), false);
    await held.close();
  });
});

test('a result that comes after the grace time is never cut: the timer starts at the result, and a stream that ends by itself tells no one', async () => {
  // The fake holds its turn until the test creates the file, past the grace time.
  await withFake('stream-late', [{ text: 'late report', waitFile: 'go' }], async (home) => {
    const stuck: number[] = [];
    const { session: late, idle } = session(home, 200, stuck);
    late.send('go', []);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await writeFile(join(home, 'go'), '');
    const outcome = await idle;
    assert.equal(outcome.ok && outcome.text, 'late report');
    // Past the grace time after the stream ended: no stuck call came.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(stuck, []);
    await late.close();
  });
});

test('a close() during the grace time ends the turn as closed: no idle outcome, no stuck call', async () => {
  await withFake('stream-closed', [{ text: 'the report', holdOpen: true }], async (home) => {
    const stuck: number[] = [];
    let idled = false;
    let closing: Promise<void> | undefined;
    const { session: held } = session(home, 60_000, stuck, {
      idle: async () => void (idled = true),
      message: async (message) => {
        if (message.type === 'result') {
          closing = held.close();
        }
      },
    });
    held.send('go', []);
    const deadline = Date.now() + 10_000;
    while (closing === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await closing;
    assert.equal(held.busy, false);
    assert.deepEqual([idled, stuck], [false, []]);
  });
});

test('sf watch: the stuck stream\'s event in one line', () => {
  const [line] = formatEvent(JSON.stringify({ ts: '2026-11-12T10:00:00.000Z', iteration: 2, type: 'turn_stream_stuck', waited_s: 120 }));
  assert.equal(line!.replace(/^\S+ /, ''), '[2] the turn\'s result came but Claude Code did not end within 120 s (a background task kept it); the factory ended it and kept the result');
});
