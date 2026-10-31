// SF-009 observation console (`sf009-executor observe`): readable rendering, incremental and
// partial records, session reset following, missing and unverified repositories, bounded and
// truncated content, terminal control sequences, read-only behavior and shutdown. Synthetic
// transcripts in owned temporary directories, and one fixture job run by the fake stream Claude.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectSlug } from '../src/execution/transcript.js';
import { clip, neutralize, observe, OBSERVE_LIMITS, observeTarget, renderRecord, streamWriter, TranscriptTail, type ObserveTarget } from '../src/executor/observe.js';
import { ExecutorState } from '../src/executor/policy.js';
import { readStatus } from '../src/executor/status.js';
import { acceptedJob, destroyFixture, git } from './support/operator-fixture.js';
import { authorize, createExecutorFixture, enableApp, startSupervisor, waitFor, waitForStatus } from './support/executor-fixture.js';

const asRoot = { skip: process.getuid?.() === 0 ? 'read-only files do not stop root' : false };
const CLI = fileURLToPath(new URL('../src/executor/main.js', import.meta.url));

const line = (entry: Record<string, unknown>): string => `${JSON.stringify(entry)}\n`;
const say = (role: 'user' | 'assistant', text: string, uuid: string = randomUUID()): string => line({ type: role, uuid, message: { role, content: [{ type: 'text', text }] } });

async function sandbox(): Promise<{ dir: string; projects: string; repo: string; done: () => Promise<void> }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sf-observe-')));
  return { dir, projects: join(dir, 'projects'), repo: join(dir, 'repo'), done: () => rm(dir, { recursive: true, force: true }) };
}

// Where Claude Code keeps the transcript of a session run in repo.
async function transcript(projects: string, repo: string, sessionId: string, content: string | Buffer = ''): Promise<string> {
  const dir = join(projects, projectSlug(repo));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  await writeFile(path, content);
  return path;
}

function target(overrides: Partial<ObserveTarget> = {}): ObserveTarget {
  return {
    app_id: 'app-one',
    job_id: 'job-one',
    found: true,
    state: 'running',
    repository: null,
    repository_note: 'a separate repository',
    repository_binding: 'verified',
    registered_now: null,
    session_id: null,
    waiting: 'Claude Code, working on iteration-001 (turn in progress)',
    ...overrides,
  };
}

// An observer in follow mode over a changeable target; output collected. stop() aborts it and
// waits for it to end (again: the same result); every test calls it in finally, before removing
// its fixture, so a failed test leaves no polling observer behind.
type Follower = ReturnType<typeof follow>;

function follow(resolveTarget: () => ObserveTarget | Promise<ObserveTarget>, projectsDir: string, limits: Partial<typeof OBSERVE_LIMITS> = {}) {
  const controller = new AbortController();
  let output = '';
  const done = observe({ resolve: async () => resolveTarget(), projectsDir, write: (text) => { output += text; }, signal: controller.signal, pollMs: 15, limits });
  return {
    output: () => output,
    until: (text: string | RegExp) => waitFor(async () => (typeof text === 'string' ? output.includes(text) : text.test(output)), `observer output ${String(text)}`, 5000),
    stop: async () => {
      controller.abort();
      return done;
    },
  };
}

const count = (text: string, part: string): number => text.split(part).length - 1;

// Every entry under root: type, size and modification time (nothing may change while observing).
async function tree(root: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      const stats = await lstat(path);
      entries.set(path, `${stats.isDirectory() ? 'd' : stats.isSymbolicLink() ? 'l' : 'f'}:${stats.isDirectory() ? 0 : stats.size}:${stats.mtimeMs}:${stats.mode}`);
      if (stats.isDirectory()) {
        await walk(path);
      }
    }
  };
  await walk(root);
  return entries;
}

test('renders user and assistant text, tool calls and tool results readably; other records show nothing', () => {
  const at = '2026-10-29T10:11:12.000Z';
  assert.deepEqual(renderRecord({ type: 'user', timestamp: at, message: { content: 'Please add a line.\nThanks.' } }), ['[10:11:12] user: Please add a line.\n    Thanks.']);
  assert.deepEqual(
    renderRecord({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'private' },
          { type: 'text', text: 'I will run the tests.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'README.md' } },
        ],
      },
    }),
    ['assistant: I will run the tests.', 'tool call Bash: npm test', 'tool call Read: {"file_path":"README.md"}'],
  );
  assert.deepEqual(
    renderRecord({ type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: '1 failing' }, { type: 'image' }] }] } }),
    ['(subagent) tool result (error): 1 failing\n    [image]'],
  );
  assert.deepEqual(renderRecord({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } }), ['tool result: ok']);
  for (const other of [
    { type: 'system', content: 'x' },
    { type: 'summary', summary: 'x' },
    { type: 'user', isMeta: true, message: { content: 'Base directory for this skill: /x' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }] } },
    null,
    'text',
  ]) {
    assert.deepEqual(renderRecord(other), []);
  }
});

test('terminal control sequences from the transcript are shown as inert text', () => {
  const hostile = 'a\x1b[2J\x1b]0;title\x07b\rc\x9b31m‮evil⁦\x7f\td\ne';
  const shown = neutralize(hostile);
  assert.equal(shown, 'a^[[2J^[]0;title^Gb^Mc<U+009B>31m<U+202E>evil<U+2066>^?\td\ne');
  const [command, name] = renderRecord({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo \x1b[1;1H' } }, { type: 'tool_use', name: 'X\x1b[31m', input: {} }] },
  });
  assert.equal(command, 'tool call Bash: echo ^[[1;1H');
  assert.equal(name, 'tool call X^[[31m: {}');
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(renderRecord({ type: 'user', message: { content: hostile } }).join(''), /[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/);
});

test('long text is clipped with an explicit marker, never splitting a character', () => {
  assert.equal(clip('short', 10), 'short');
  assert.equal(clip('abcdefghijkl', 5), 'abcde… [truncated: 7 more characters]');
  assert.equal(clip('ab😀cd', 3), 'ab… [truncated: 4 more characters]');
  const [rendered] = renderRecord({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } }, { ...OBSERVE_LIMITS, textChars: 100 });
  assert.equal(rendered, `assistant: ${'x'.repeat(100)}… [truncated: 4900 more characters]`);
});

test('records are read incrementally; a partial line (split UTF-8 included) waits for its end', async () => {
  const box = await sandbox();
  try {
    const record = Buffer.from(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'héllo € end' }] } }));
    const euro = record.indexOf(Buffer.from('€'));
    const path = await transcript(box.projects, box.repo, 's1', say('user', 'first'));
    const tail = new TranscriptTail(path);
    assert.deepEqual((await tail.read()).map((item) => renderRecord(item.kind === 'record' ? item.record : null)), [['user: first']]);
    assert.deepEqual(await tail.read(), [], 'nothing new, nothing returned');
    await appendFile(path, record.subarray(0, euro + 1));
    assert.deepEqual(await tail.read(), []);
    assert.equal(tail.pendingBytes, euro + 1);
    await appendFile(path, record.subarray(euro + 1));
    const items = await tail.read();
    assert.equal(items.length, 1);
    assert.deepEqual(renderRecord(items[0]!.kind === 'record' ? items[0]!.record : null), ['assistant: héllo € end']);
    assert.equal(tail.pendingBytes, 0);
    await appendFile(path, '{not json\n\n');
    assert.deepEqual(await tail.read(), [{ kind: 'notice', text: 'a transcript line that is not valid JSON was skipped' }]);
  } finally {
    await box.done();
  }
});

test('memory stays bounded: an over-long record is skipped and reported, the history read starts near the end', async () => {
  const box = await sandbox();
  try {
    const limits = { ...OBSERVE_LIMITS, recordBytes: 200, historyBytes: 400, pollBytes: 1000 };
    const path = await transcript(box.projects, box.repo, 's1');
    const tail = new TranscriptTail(path, limits);
    await tail.read();
    await appendFile(path, `{"type":"user","message":{"content":"${'y'.repeat(150)}`);
    assert.deepEqual(await tail.read(), []);
    await appendFile(path, `${'y'.repeat(150)}"}}\n${say('user', 'after')}`);
    const items = await tail.read();
    assert.deepEqual(items[0], { kind: 'notice', text: 'a transcript record longer than 200 bytes was skipped' });
    assert.equal(items.length, 2);
    assert.equal(tail.pendingBytes, 0);

    // A long existing transcript: only its last historyBytes are read, from the first whole line.
    let content = '';
    for (let index = 0; index < 40; index += 1) {
      content += say('user', `entry ${index}`);
    }
    const long = await transcript(box.projects, box.repo, 's2', content);
    const history = await new TranscriptTail(long, limits).read();
    assert.equal(history[0]!.kind, 'notice');
    assert.match((history[0] as { text: string }).text, /^earlier transcript content not shown \(\d+ bytes before the recent history\)$/);
    const texts = history.slice(1).map((item) => renderRecord(item.kind === 'record' ? item.record : null).join(''));
    assert.ok(texts.length > 0 && texts.length < 40);
    assert.equal(texts.at(-1), 'user: entry 39');
    assert.ok(texts.every((text) => /^user: entry \d+$/.test(text)), 'no partial first line');

    // A large backlog is read in bounded portions, the rest on the next read.
    const big = await transcript(box.projects, box.repo, 's3');
    const portion = new TranscriptTail(big, limits);
    await portion.read();
    await appendFile(big, content);
    const portions: number[] = [];
    while (portions.reduce((sum, value) => sum + value, 0) < 40 && portions.length < 40) {
      portions.push((await portion.read()).length);
    }
    assert.ok(portions.length > 1 && portions.every((value) => value > 0 && value < 40), portions.join(' + '));
    assert.equal(portions.reduce((sum, value) => sum + value, 0), 40);
  } finally {
    await box.done();
  }
});

test('a missing, unreadable, truncated or replaced transcript is reported once each', asRoot, async () => {
  const box = await sandbox();
  try {
    const path = join(box.projects, 'missing.jsonl');
    const tail = new TranscriptTail(path);
    assert.deepEqual(await tail.read(), [{ kind: 'notice', text: 'transcript missing: it does not exist (any more); waiting for it' }]);
    assert.deepEqual(await tail.read(), [], 'reported once');
    await transcript(box.projects, box.repo, 'x');
    await writeFile(path, say('user', 'one') + say('user', 'two'));
    assert.equal((await tail.read()).length, 2);
    await chmod(path, 0o000);
    assert.deepEqual(await tail.read(), [{ kind: 'notice', text: 'transcript unreadable (EACCES); retrying' }]);
    assert.deepEqual(await tail.read(), []);
    await chmod(path, 0o600);
    assert.deepEqual(await tail.read(), [{ kind: 'notice', text: 'transcript readable again' }]);
    await truncate(path, 0);
    await appendFile(path, say('user', 'three'));
    const truncated = await tail.read();
    assert.equal(truncated[0]!.kind, 'notice');
    assert.match((truncated[0] as { text: string }).text, /^transcript truncated \(now \d+ bytes, \d+ were read\); reading it again \(records already shown are not repeated\)$/);
    assert.deepEqual(renderRecord(truncated[1]!.kind === 'record' ? truncated[1]!.record : null), ['user: three']);
    const replacement = `${path}.new`;
    await writeFile(replacement, say('user', 'four'));
    await rename(replacement, path);
    const replaced = await tail.read();
    assert.match((replaced[0] as { text: string }).text, /^transcript replaced by another file; reading the new one again \(records already shown are not repeated\)$/);
    assert.deepEqual(renderRecord(replaced[1]!.kind === 'record' ? replaced[1]!.record : null), ['user: four']);
    await rm(path);
    assert.deepEqual(await tail.read(), [{ kind: 'notice', text: 'transcript missing: it does not exist (any more); waiting for it' }]);
  } finally {
    await box.done();
  }
});

test('the history window keeps a record that starts exactly at its edge; a re-read after replacement is bounded too', async () => {
  const box = await sandbox();
  try {
    const first = say('user', 'aligned');
    const rest = say('user', 'second');
    const limits = { ...OBSERVE_LIMITS, historyBytes: Buffer.byteLength(first + rest) };
    const path = await transcript(box.projects, box.repo, 's1', say('user', 'before the window') + first + rest);
    const read = await new TranscriptTail(path, limits).read();
    assert.equal(read[0]!.kind, 'notice');
    assert.deepEqual(read.slice(1).map((item) => renderRecord(item.kind === 'record' ? item.record : null).join('')), ['user: aligned', 'user: second']);

    const tail = new TranscriptTail(path, limits);
    await tail.read();
    await writeFile(`${path}.new`, say('user', 'old 1') + say('user', 'old 2') + first + rest);
    await rename(`${path}.new`, path);
    const again = await tail.read();
    assert.deepEqual(
      again.map((item) => (item.kind === 'notice' ? item.text.replace(/\(\d+ bytes/, '(N bytes') : renderRecord(item.record).join(''))),
      [
        'transcript replaced by another file; reading the new one again (records already shown are not repeated)',
        'earlier transcript content not shown (N bytes before the recent history)',
        'user: aligned',
        'user: second',
      ],
    );
  } finally {
    await box.done();
  }
});

test('a transcript too large for the status lookup is still followed, from its end', async () => {
  const box = await sandbox();
  try {
    const path = await transcript(box.projects, box.repo, 'session-big');
    // Sparse: larger than the 256 MiB findTranscript accepts, without using the disk space.
    await truncate(path, 300 * 1024 * 1024);
    await appendFile(path, `\n${say('assistant', 'at the end of a large transcript')}`);
    let output = '';
    const code = await observe({
      resolve: async () => target({ repository: box.repo, session_id: 'session-big' }),
      projectsDir: box.projects,
      write: (text) => {
        output += text;
      },
      once: true,
    });
    assert.equal(code, 0);
    assert.match(output, /-- earlier transcript content not shown \(\d+ bytes before the recent history\)\n/);
    assert.match(output, /\nassistant: at the end of a large transcript\n/);
  } finally {
    await box.done();
  }
});

test('notices of the history read are never cut by the entry limit', async () => {
  const box = await sandbox();
  try {
    let content = `{not json\n`;
    for (let index = 0; index < 6; index += 1) {
      content += say('user', `entry ${index}`);
    }
    await transcript(box.projects, box.repo, 'session-a', content);
    let output = '';
    await observe({ resolve: async () => target({ repository: box.repo, session_id: 'session-a' }), projectsDir: box.projects, write: (text) => { output += text; }, once: true, limits: { historyEntries: 2 } });
    assert.match(output, /-- 4 earlier entries not shown\n-- a transcript line that is not valid JSON was skipped\nuser: entry 4\nuser: entry 5\n/);
  } finally {
    await box.done();
  }
});

test('--once prints the header and a bounded recent history', async () => {
  const box = await sandbox();
  try {
    let content = line({ type: 'system', subtype: 'init' });
    for (let index = 0; index < 12; index += 1) {
      content += say(index % 2 === 0 ? 'user' : 'assistant', `message ${index}`);
    }
    await transcript(box.projects, box.repo, 'session-a', `${content}{"type":"user","message":{"content":"part`);
    let output = '';
    const code = await observe({
      resolve: async () => target({ repository: box.repo, session_id: 'session-a' }),
      projectsDir: box.projects,
      write: (text) => {
        output += text;
      },
      once: true,
      limits: { historyEntries: 5 },
    });
    assert.equal(code, 0);
    assert.match(output, /^Observing app app-one \/ job job-one \(read-only: starts, sends, locks, signals and writes nothing; Ctrl\+C stops only this observer\)\n/);
    assert.match(output, new RegExp(`\n  repository +${box.repo} \\(a separate repository\\)\n  session +session-a\n  state +running\n  waiting for +Claude Code, working on iteration-001`));
    assert.match(output, /\n-- transcript .*\n-- 7 earlier entries not shown\nassistant: message 7\nuser: message 8\nassistant: message 9\nuser: message 10\nassistant: message 11\n/);
    assert.match(output, /-- an incomplete last record \(\d+ bytes so far\) is not shown yet\n$/);
    assert.doesNotMatch(output, /following new records/);
  } finally {
    await box.done();
  }
});

test('following prints new records once, follows a reset session after a separator, and stops on Ctrl+C', async () => {
  const box = await sandbox();
  let observer: Follower | undefined;
  try {
    const a = await transcript(box.projects, box.repo, 'session-a', say('user', 'start A', 'u-a1'));
    let current = target({ repository: box.repo, session_id: 'session-a' });
    observer = follow(() => current, box.projects);
    await observer.until('-- following new records');
    await appendFile(a, say('assistant', 'working in A', 'u-a2'));
    await observer.until('assistant: working in A');
    // The transcript is replaced by a copy that repeats an earlier record: shown once only.
    await writeFile(`${a}.new`, say('user', 'start A', 'u-a1') + say('assistant', 'working in A', 'u-a2') + say('assistant', 'more in A', 'u-a3'));
    await rename(`${a}.new`, a);
    await observer.until('assistant: more in A');
    // Written just before the reset: shown before the separator.
    await appendFile(a, say('assistant', 'last words in A', 'u-a5'));
    current = target({ repository: box.repo, session_id: 'session-b', state: 'awaiting_review', waiting: 'your review' });
    await observer.until('-- state awaiting_review; waiting for: your review');
    await observer.until(/no transcript yet for session session-b under .*; waiting for it/);
    await transcript(box.projects, box.repo, 'session-b', say('user', 'Software Factory context reset', 'u-b1'));
    await observer.until('user: Software Factory context reset');
    await appendFile(a, say('assistant', 'late in A', 'u-a4'));
    const code = await observer.stop();
    assert.equal(code, 0);
    const output = observer.output();
    assert.match(output, /\n==== the managed session changed \(reset\): now following session session-b, was session-a ====\n/);
    assert.match(output, /-- transcript replaced by another file/);
    assert.equal(count(output, 'user: start A'), 1);
    assert.equal(count(output, 'assistant: working in A'), 1);
    assert.doesNotMatch(output, /late in A/, 'the old session is no longer followed');
    assert.ok(output.endsWith('-- observer stopped; the session and the job are not affected\n'));
    assert.ok(output.indexOf('==== the managed session changed') < output.indexOf('context reset'));
    assert.equal(count(output, 'assistant: last words in A'), 1);
    assert.ok(output.indexOf('assistant: last words in A') < output.indexOf('==== the managed session changed'));
  } finally {
    await observer?.stop().catch(() => undefined);
    await box.done();
  }
});

test('a replacement larger than the remembered identities repeats none of the records shown before', async () => {
  const box = await sandbox();
  let observer: Follower | undefined;
  try {
    const records = say('user', 'record A', 'u-1') + say('user', 'record B', 'u-2') + say('user', 'record C', 'u-3');
    const path = await transcript(box.projects, box.repo, 'session-a', records);
    observer = follow(() => target({ repository: box.repo, session_id: 'session-a' }), box.projects, { seenRecords: 2 });
    await observer.until('-- following new records');
    // Identical content, then one new record: three identities against a capacity of two.
    await writeFile(`${path}.new`, records);
    await rename(`${path}.new`, path);
    await observer.until('-- transcript replaced by another file');
    await appendFile(path, say('user', 'record D', 'u-4'));
    await observer.until('user: record D');
    // Again, now with the new record in the replacement too.
    await writeFile(`${path}.new`, `${records}${say('user', 'record D', 'u-4')}${say('user', 'record E', 'u-5')}`);
    await rename(`${path}.new`, path);
    await observer.until('user: record E');
    const output = observer.output();
    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      assert.equal(count(output, `user: record ${name}\n`), 1, `record ${name} is shown once`);
    }
    assert.equal(count(output, '-- transcript replaced by another file'), 2, 'each replacement stays visible');
  } finally {
    await observer?.stop().catch(() => undefined);
    await box.done();
  }
});

test('output backpressure (the CLI writer): a blocked reader stops the reading, and Ctrl+C still ends the observer', async () => {
  const box = await sandbox();
  const controller = new AbortController();
  let done: Promise<number> | undefined;
  try {
    const path = await transcript(box.projects, box.repo, 'session-a', say('user', 'before'));
    const delivered: string[] = [];
    // A reader that never takes the first chunk: everything after it stays in the stream's buffer.
    const blocked = new Writable({
      highWaterMark: 16,
      write(chunk, _encoding, _callback) {
        delivered.push(String(chunk));
      },
    });
    let resolves = 0;
    done = observe({
      resolve: async () => {
        resolves += 1;
        return target({ repository: box.repo, session_id: 'session-a' });
      },
      projectsDir: box.projects,
      write: streamWriter(blocked, controller.signal),
      signal: controller.signal,
      pollMs: 10,
    });
    await waitFor(async () => delivered.length > 0, 'the header written');
    for (let index = 0; index < 20; index += 1) {
      await appendFile(path, say('assistant', `while blocked ${index}`));
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    assert.equal(resolves, 1, 'no further polling while the output is blocked');
    assert.equal(delivered.length, 1);
    assert.equal(blocked.writableLength, Buffer.byteLength(delivered[0]!), 'only the first, untaken write is buffered: nothing more was queued');
    const started = Date.now();
    controller.abort();
    assert.equal(await done, 0);
    assert.ok(Date.now() - started < 1000, 'Ctrl+C ends the observer while the output is blocked');
  } finally {
    controller.abort();
    await done?.catch(() => undefined);
    await box.done();
  }
});

test('output backpressure (the CLI writer): a slow reader gets everything once, in order, with a bounded buffer', async () => {
  const box = await sandbox();
  const controller = new AbortController();
  let done: Promise<number> | undefined;
  try {
    const path = await transcript(box.projects, box.repo, 'session-a');
    let received = '';
    let peak = 0;
    let largest = 0;
    const slow = new Writable({
      highWaterMark: 64,
      write(chunk, _encoding, callback) {
        const text = String(chunk);
        received += text;
        largest = Math.max(largest, text.length);
        peak = Math.max(peak, this.writableLength);
        setTimeout(callback, 20);
      },
    });
    done = observe({
      resolve: async () => target({ repository: box.repo, session_id: 'session-a' }),
      projectsDir: box.projects,
      write: streamWriter(slow, controller.signal),
      signal: controller.signal,
      pollMs: 5,
    });
    for (let batch = 0; batch < 10; batch += 1) {
      let lines = '';
      for (let index = 0; index < 5; index += 1) {
        lines += say('assistant', `slow ${batch * 5 + index}`);
      }
      await appendFile(path, lines);
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    await waitFor(async () => received.includes('assistant: slow 49\n'), 'every record delivered', 10_000);
    const order = [...received.matchAll(/assistant: slow (\d+)\n/g)].map((match) => Number(match[1]));
    assert.deepEqual(order, Array.from({ length: 50 }, (_, index) => index));
    assert.ok(peak <= 64 + largest, `at most one write beyond the high-water mark is buffered (peak ${peak}, largest ${largest})`);
  } finally {
    controller.abort();
    await done?.catch(() => undefined);
    await box.done();
  }
});

// A child process running the production observer process (runObserverProcess) over a synthetic
// target; it reports its pending stdout bytes on stderr.
const OBSERVER_CHILD = `
const [, , module, projects, repo] = process.argv;
const { runObserverProcess } = await import(module);
setInterval(() => process.stderr.write('pending ' + process.stdout.writableLength + '\\n'), 50).unref();
process.exitCode = await runObserverProcess({
  resolve: async () => ({ app_id: 'app-one', job_id: 'job-one', found: true, state: 'running', repository: repo, repository_note: 'a separate repository', repository_binding: 'verified', registered_now: null, session_id: 'session-a', waiting: 'Claude Code' }),
  projectsDir: projects,
  once: false,
});
`;

test('Ctrl+C ends the observer process within a bound while its own stdout pipe is full and unread', async () => {
  const box = await sandbox();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    let content = '';
    for (let index = 0; index < 600; index += 1) {
      content += say('assistant', `${index} ${'x'.repeat(900)}`);
    }
    const path = await transcript(box.projects, box.repo, 'session-a', say('user', 'start'));
    const script = join(box.dir, 'observer-child.mjs');
    await writeFile(script, OBSERVER_CHILD);
    child = spawn(process.execPath, [script, new URL('../src/executor/observe.js', import.meta.url).href, box.projects, box.repo], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
    let stderr = '';
    child.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString('utf8');
    });
    // The parent keeps the pipe open and does not read it: the child's output backs up.
    child.stdout!.pause();
    await waitFor(async () => stderr.includes('pending '), 'the child started', 10_000);
    // More than the pipe and the parent's buffer hold.
    await appendFile(path, content);
    await waitFor(async () => [...stderr.matchAll(/pending (\d+)/g)].some((match) => Number(match[1]) > 0), 'the child blocked on its stdout', 10_000);
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    assert.equal(child.exitCode, null, 'the child is alive and blocked');
    const started = Date.now();
    assert.ok(child.kill('SIGINT'));
    const result = await Promise.race([exited, new Promise<'timeout'>((resolveWait) => setTimeout(() => resolveWait('timeout'), 5000))]);
    const elapsed = Date.now() - started;
    assert.notEqual(result, 'timeout', 'the observer process ended within 5 s although its stdout could not drain');
    assert.deepEqual(result, [0, null]);
    assert.ok(elapsed < 3000, `ended after ${elapsed} ms`);
    assert.match(stderr, /sf009-executor observe: stopped; the session and the job are not affected\n/);
    // Only now is the pipe drained: nothing was written to stdout after the abort.
    let stdout = '';
    const closed = once(child.stdout!, 'close');
    child.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString('utf8');
    });
    child.stdout!.resume();
    await closed;
    assert.match(stdout, /\nassistant: \d+ x+\n/);
    assert.doesNotMatch(stdout, /observer stopped/);
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit').catch(() => undefined);
    }
    await box.done();
  }
});

test('Ctrl+C stops the observer promptly while it waits', async () => {
  const box = await sandbox();
  const controller = new AbortController();
  let done: Promise<number> | undefined;
  try {
    let output = '';
    let resolves = 0;
    done = observe({
      resolve: async () => {
        resolves += 1;
        return target({ repository: box.repo });
      },
      projectsDir: box.projects,
      write: (text) => {
        output += text;
      },
      signal: controller.signal,
      pollMs: 60_000,
    });
    await waitFor(async () => output.includes('no managed session yet; waiting for it'), 'waiting');
    const started = Date.now();
    controller.abort();
    assert.equal(await done, 0);
    assert.ok(Date.now() - started < 1000);
    assert.equal(resolves, 1);
    assert.match(output, /-- observer stopped; the session and the job are not affected\n$/);
  } finally {
    controller.abort();
    await done?.catch(() => undefined);
    await box.done();
  }
});

test('an unverified repository is reported and never replaced by the current registration; a missing job is reported', async () => {
  const box = await sandbox();
  try {
    const registered = join(box.dir, 'other');
    await transcript(box.projects, registered, 'session-a', say('assistant', 'DECOY from the registered repository'));
    let output = '';
    const write = (text: string) => {
      output += text;
    };
    const unverified = target({
      session_id: 'session-a',
      repository_binding: 'mismatch',
      repository_note: 'unknown: APP_REPO now names another repository than the one this job was authorized for (recorded only by its sha256)',
      registered_now: registered,
    });
    assert.equal(await observe({ resolve: async () => unverified, projectsDir: box.projects, write, once: true }), 1);
    assert.match(output, new RegExp(`registered now +${registered} \\(NOT verified as this job's repository: mismatch; never read\\)`));
    assert.match(output, /-- the job's repository is not verified \(unknown: APP_REPO now names another repository .*\); its transcript is not read, and the current registration is never used instead\n/);
    assert.doesNotMatch(output, /DECOY/);

    output = '';
    const missing = observeTarget('app-one', 'job-x', { jobs: [], discovery: { complete: true, issues: [], more_issues: false } } as never);
    assert.equal(missing.found, false);
    assert.equal(await observe({ resolve: async () => missing, projectsDir: box.projects, write }), 1);
    assert.match(output, /state +not found\n  waiting for +nothing: no such authorized or managed job\nNo such authorized or managed job; nothing to observe\.\n$/);
  } finally {
    await box.done();
  }
});

test('a managed job: the verified repository and managed session; read-only; a moved registration is not read', async () => {
  const fx = await createExecutorFixture();
  try {
    await enableApp(fx);
    const state = await ExecutorState.openExisting(fx.stateHome, fx.mediator);
    const job = 'job-observe';
    const accepted = await acceptedJob(fx, job);
    const resolve = async () => observeTarget(fx.app, job, await readStatus({ mediatorRoot: fx.mediator, state, projectsDir: fx.projects, app: fx.app, job }));
    const authorized = await resolve();
    assert.equal(authorized.found, false, 'not yet authorized');
    const running = await startSupervisor(fx);
    let sessionId: string;
    try {
      await authorize(fx, job, accepted, randomUUID());
      const ready = await waitForStatus(fx, job, (value) => value.status === 'awaiting_review', 'iteration-001 ready');
      const observed = await resolve();
      sessionId = observed.session_id!;
      assert.equal(observed.repository, fx.appRepo);
      assert.equal(observed.repository_binding, 'verified');
      assert.equal(observed.session_id, ready.job?.current_session_id);
      let output = '';
      const observer = observe({ resolve, projectsDir: fx.projects, write: (text) => { output += text; }, once: true });
      assert.equal(await observer, 0);
      assert.match(output, new RegExp(`repository +${fx.appRepo} \\(a separate repository\\)\n  session +${sessionId}\n  state +awaiting_review\n`));
      assert.match(output, /user: <command-message>implement<\/command-message>/);
      assert.match(output, /tool call Bash: npm test\ntool result: ok\n/);
      assert.match(output, /assistant: (Done with this round\.|Scope confirmed)/);
      assert.doesNotMatch(output, /Base directory for this skill/, 'meta records are not shown');
    } finally {
      await running.stop();
    }

    // Read-only: nothing in the fixture changes, no Claude is invoked, no message is sent.
    const before = await tree(fx.sandbox);
    const invocations = await readFile(join(fx.fakeDir, 'invocations.jsonl'), 'utf8');
    const messages = await readFile(join(fx.fakeDir, 'messages.jsonl'), 'utf8');
    const observer = follow(resolve, fx.projects);
    try {
      await observer.until('-- following new records');
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      assert.equal(await observer.stop(), 0);
    } finally {
      await observer.stop().catch(() => undefined);
    }
    let output = '';
    assert.equal(await observe({ resolve, projectsDir: fx.projects, write: (text) => { output += text; }, once: true }), 0);
    assert.deepEqual(await tree(fx.sandbox), before);
    assert.equal(await readFile(join(fx.fakeDir, 'invocations.jsonl'), 'utf8'), invocations);
    assert.equal(await readFile(join(fx.fakeDir, 'messages.jsonl'), 'utf8'), messages);

    // APP_REPO moves; a transcript of the same session id in the new repository is never read.
    const other = join(fx.sandbox, 'app-b');
    await mkdir(other);
    git(other, 'init', '-q');
    await writeFile(join(fx.mediator, 'factory-data', 'apps', fx.app, '.env'), `APP_REPO=${other}\n`, { mode: 0o600 });
    await transcript(fx.projects, other, sessionId, say('assistant', 'DECOY in the new registration'));
    output = '';
    assert.equal(await observe({ resolve, projectsDir: fx.projects, write: (text) => { output += text; }, once: true }), 1);
    assert.match(output, new RegExp(`registered now +${other} \\(NOT verified as this job's repository: mismatch; never read\\)`));
    assert.match(output, /its transcript is not read, and the current registration is never used instead/);
    assert.doesNotMatch(output, /DECOY|tool call/);
  } finally {
    await destroyFixture(fx);
  }
});

test('the read-only state opening creates nothing and still refuses a non-private state directory', async () => {
  const box = await sandbox();
  try {
    const mediator = join(box.dir, 'mediator');
    await mkdir(mediator);
    const home = join(box.dir, 'state');
    const state = await ExecutorState.openExisting(home, mediator);
    assert.equal(await state.policy(), undefined);
    await assert.rejects(lstat(home), { code: 'ENOENT' });
    await mkdir(join(home, 'software-factory', 'executor'), { recursive: true });
    await chmod(join(home, 'software-factory'), 0o755);
    await assert.rejects(ExecutorState.openExisting(home, mediator), { code: 'unsafe_state' });
  } finally {
    await box.done();
  }
});

test('the CLI: observe needs --app and --job, --once belongs to observe, and an unknown job creates no state', async () => {
  const box = await sandbox();
  try {
    const run = (args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        execFile(process.execPath, [CLI, ...args], { env: { ...process.env, XDG_STATE_HOME: join(box.dir, 'state'), CLAUDE_CONFIG_DIR: join(box.dir, 'claude') } }, (error, stdout, stderr) => {
          resolve({ code: error === null ? 0 : Number((error as { code?: number }).code), stdout, stderr });
        });
      });
    const usage = await run(['observe', '--app', 'sf-observe-test-app']);
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /observe --app <id> --job <id> \[--once\]/);
    assert.equal((await run(['status', '--once'])).code, 2);
    const missing = await run(['observe', '--app', 'sf-observe-no-such-app', '--job', 'no-such-job', '--once']);
    assert.equal(missing.code, 1, missing.stderr);
    assert.match(missing.stdout, /^Observing app sf-observe-no-such-app \/ job no-such-job/);
    assert.match(missing.stdout, /No such authorized or managed job; nothing to observe\.\n$/);
    await assert.rejects(lstat(join(box.dir, 'state')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(box.dir, 'claude')), { code: 'ENOENT' });
  } finally {
    await box.done();
  }
});
