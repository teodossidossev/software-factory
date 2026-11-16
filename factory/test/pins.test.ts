// The dashboard's pins (SF-211): the store of src/pins.ts in a temporary state directory (the file,
// its mode, the ids, the open and resolved bounds, every string bound and control character, an
// unreadable file, the write queue), the routes through a running dashboard (GET, POST, change,
// remove and the transport checks of handlePost), and sf pins, sf pins resolve and sf pins clear
// through sf serve. No test touches the real state directory.
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import {
  addPin, changePin, clearPins, MAX_OPEN_PINS, MAX_RESOLVED_PINS, type PinInput, pinsFile, pinsLines, readPins, removePin,
} from '../src/pins.js';
import { act, fakeActions, fetchRaw } from './support/dashboard-client.js';
import { withDashboard } from './support/dashboard-state.js';
import { newEnv, runCli, serve, stop, temp } from './support/harness.js';

const E2E = { timeout: 120_000 };

const RECT = { x: 10, y: 20, w: 120, h: 32, vw: 1280, vh: 800 };
const input = (overrides: Partial<PinInput> = {}): PinInput => ({ route: '', selector: '#open-new-ticket', text: 'New ticket', rect: RECT, note: '', ...overrides });
const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 14, 9, minute));
let dirs = 0;
async function stateDir(): Promise<string> {
  dirs += 1;
  const dir = join(temp, `pins-${dirs}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
const refused = (code: string) => (error: unknown): boolean => error instanceof FactoryError && error.code === code;

test('the store: a new pins.json of mode 0600, ids 1, 2, 3 never given again after a remove, the shape on disk; a change and a remove', async () => {
  const dir = await stateDir();
  assert.deepEqual(await readPins(dir), { pins: [] }, 'a missing file is no pins');
  const first = await addPin(dir, input(), at(0));
  assert.deepEqual(first.pin, { id: 1, ...input(), at: at(0).toISOString(), resolved: false });
  assert.equal((await stat(pinsFile(dir))).mode & 0o777, 0o600);
  await addPin(dir, input({ route: 'stats', text: 'Stats' }), at(1));
  await addPin(dir, input({ route: 'app/T-1/stream' }), at(2));
  assert.deepEqual((await removePin(dir, 2)).pins.map((pin) => pin.id), [1, 3]);
  const fourth = await addPin(dir, input(), at(3));
  assert.equal(fourth.pin.id, 4);
  assert.deepEqual(fourth.pins.map((pin) => pin.id), [1, 3, 4]);
  const changed = await changePin(dir, 3, { note: 'This one\nhere' });
  assert.equal(changed.pins.find((pin) => pin.id === 3)?.note, 'This one\nhere');
  assert.equal((await changePin(dir, 3, { resolved: true })).pins.find((pin) => pin.id === 3)?.resolved, true);
  const file = JSON.parse(await readFile(pinsFile(dir), 'utf8')) as { version: number; next: number; pins: unknown[] };
  assert.deepEqual([file.version, file.next, file.pins.length], [1, 5, 3]);
  await assert.rejects(changePin(dir, 9, { note: 'x' }), refused('pin_not_found'));
  await assert.rejects(removePin(dir, 2), refused('pin_not_found'));
  await assert.rejects(changePin(dir, 1, {}), refused('invalid_body'), 'a change of nothing');
  // Written atomically: no temp file is left beside it.
  assert.deepEqual(await readdir(dir), ['pins.json']);
});

test('the store: the 51st open pin is refused (too_many_pins); resolving one frees a place; opening a resolved one again counts; only the 50 newest resolved ones are kept', async () => {
  const dir = await stateDir();
  for (let index = 0; index < MAX_OPEN_PINS; index += 1) {
    await addPin(dir, input(), at(index));
  }
  await assert.rejects(addPin(dir, input()), refused('too_many_pins'));
  await changePin(dir, 1, { resolved: true });
  assert.equal((await addPin(dir, input(), at(50))).pin.id, 51);
  await assert.rejects(changePin(dir, 1, { resolved: false }), refused('too_many_pins'), 'opened again: 51 open');
  await changePin(dir, 2, { resolved: true });
  assert.equal((await changePin(dir, 1, { resolved: false })).pins.filter((pin) => !pin.resolved).length, MAX_OPEN_PINS);
  // 60 resolved: the 10 oldest (by creation time) go at the next write.
  await clearPins(dir);
  for (let index = 0; index < 60; index += 1) {
    const { pin } = await addPin(dir, input(), at(index));
    await changePin(dir, pin.id, { resolved: true });
  }
  const { pins } = await readPins(dir);
  assert.equal(pins.length, MAX_RESOLVED_PINS);
  assert.deepEqual([pins[0]!.id, pins.at(-1)!.id], [11, 60]);
});

test('the store: every bound, character counted as JavaScript counts it, and every control character but \\n and \\t in text and note is refused (invalid_body); nothing is stored', async () => {
  const dir = await stateDir();
  const emoji = '😀'.repeat(100);
  const accepted: Array<Partial<PinInput>> = [
    { route: 'r'.repeat(300) }, { selector: 's'.repeat(1000) }, { text: emoji }, { note: 'n'.repeat(500) }, { text: 'a\tb\nc', note: 'a\tb\nc' },
    { rect: { x: -1_000_000, y: 1_000_000, w: 0, h: 1_000_000, vw: 0, vh: 1_000_000 } }, { rect: { ...RECT, x: 1.5 } },
  ];
  for (const overrides of accepted) {
    await addPin(dir, input(overrides));
  }
  const refusedInputs: Array<Partial<PinInput> | Record<string, unknown>> = [
    { route: 'r'.repeat(301) }, { selector: 's'.repeat(1001) }, { text: `${emoji}😀` }, { text: 't'.repeat(201) }, { note: 'n'.repeat(501) },
    { route: 'a\nb' }, { selector: 'a\tb' }, { text: 'bell\u0007' }, { note: 'esc\u001b[31m' }, { note: 'csi\u009b' }, { text: 'del\u007f' }, { note: 'cr\r' },
    { rect: { ...RECT, x: 1_000_001 } }, { rect: { ...RECT, y: -1_000_001 } }, { rect: { ...RECT, w: -1 } }, { rect: { ...RECT, vh: 1_000_001 } },
    { rect: { ...RECT, h: Number.POSITIVE_INFINITY } }, { rect: { ...RECT, x: Number.NaN } }, { rect: { x: 1, y: 1, w: 1, h: 1, vw: 1 } },
    { rect: { ...RECT, z: 1 } }, { extra: true }, { note: null }, { text: 7 },
  ];
  for (const overrides of refusedInputs) {
    await assert.rejects(addPin(dir, { ...input(), ...overrides } as PinInput), refused('invalid_body'), JSON.stringify(overrides));
  }
  await assert.rejects(changePin(dir, 1, { note: 'x\u0000' }), refused('invalid_body'));
  await assert.rejects(changePin(dir, 1, { note: 'n'.repeat(501) }), refused('invalid_body'));
  assert.equal((await readPins(dir)).pins.length, accepted.length);
});

test('the store: a file that is not JSON or not the shape is refused on every read and write (pins_unreadable) and left as it is; sf pins clear replaces it', async () => {
  for (const content of ['not json', '{"version":2,"next":1,"pins":[]}', '{"version":1,"next":1,"pins":[{"id":1}]}', '{"version":1,"next":1,"pins":[]}\n', '[]']) {
    const dir = await stateDir();
    await writeFile(pinsFile(dir), content);
    if (content === '{"version":1,"next":1,"pins":[]}\n') {
      assert.deepEqual(await readPins(dir), { pins: [] }, 'the empty file is readable');
      continue;
    }
    await assert.rejects(readPins(dir), (error: unknown) => refused('pins_unreadable')(error) && /pins\.json.*sf pins clear replaces it/.test((error as Error).message), content);
    await assert.rejects(addPin(dir, input()), refused('pins_unreadable'));
    await assert.rejects(changePin(dir, 1, { resolved: true }), refused('pins_unreadable'));
    await assert.rejects(removePin(dir, 1), refused('pins_unreadable'));
    assert.equal(await readFile(pinsFile(dir), 'utf8'), content, 'nothing written over it');
    assert.deepEqual(await clearPins(dir), { removed: 0, pins: [] });
    assert.equal((await addPin(dir, input())).pin.id, 1);
  }
  // A pin whose id is not below next, or an id given twice, is not the shape either.
  const dir = await stateDir();
  const pin = { id: 1, ...input(), at: at(0).toISOString(), resolved: false };
  for (const file of [{ version: 1, next: 1, pins: [pin] }, { version: 1, next: 3, pins: [pin, pin] }]) {
    await writeFile(pinsFile(dir), JSON.stringify(file));
    await assert.rejects(readPins(dir), refused('pins_unreadable'));
  }
});

// A pin of another page: its address in url, route ''.
const PAGE_URL = 'http://localhost:3000/orders?id=42';
const LONGEST_URL = `http://localhost:3000/${'a'.repeat(2000 - 'http://localhost:3000/'.length)}`;
const PAGE_REFUSALS: Array<Record<string, unknown>> = [
  { url: `${LONGEST_URL}a` }, { url: 'ftp://shop.test/' }, { url: 'javascript:alert(1)' }, { url: 'data:text/html,<b>x</b>' },
  { url: 'http://user:pw@shop.test/' }, { url: 'HTTP://Shop.test/a b' }, { url: 'http://shop.test/\u0007' }, { url: 'http://shop.test/\n' },
  { url: '' }, { url: 7 }, { url: null }, { url: PAGE_URL, route: 'stats' },
];

test('the store: a pin of another page keeps its url as given, route \'\', the length counted to 2,000; any other address, or a url beside a route, is refused (invalid_body), and a stored one is pins_unreadable', async () => {
  const dir = await stateDir();
  const page = input({ url: PAGE_URL, text: 'Place order', note: 'Wrong total' });
  const added = await addPin(dir, page, at(0));
  assert.deepEqual(added.pin, { id: 1, ...page, at: at(0).toISOString(), resolved: false });
  assert.equal((await addPin(dir, input({ url: LONGEST_URL }), at(1))).pin.url, LONGEST_URL);
  assert.equal(LONGEST_URL.length, 2000);
  for (const overrides of PAGE_REFUSALS) {
    await assert.rejects(addPin(dir, { ...input(), ...overrides } as PinInput), (error: unknown) => refused('invalid_body')(error)
      && (error as Error).message === 'A pin expects {"route": string, "selector": string, "text": string, "rect": {"x": number, "y": number, "w": number, "h": number, "vw": number, "vh": number}, "note": string, "url"?: string} ("route" is "" with "url"), within its bounds and without control characters.', JSON.stringify(overrides));
  }
  const { pins } = await readPins(dir);
  assert.deepEqual(pins, [added.pin, { id: 2, ...input({ url: LONGEST_URL }), at: at(1).toISOString(), resolved: false }]);
  // A dashboard pin still has no url, in the file too.
  const board = await addPin(dir, input(), at(2));
  assert.equal('url' in board.pin, false);
  const file = JSON.parse(await readFile(pinsFile(dir), 'utf8')) as { pins: Array<Record<string, unknown>> };
  assert.deepEqual(file.pins.map((pin) => pin.url), [PAGE_URL, LONGEST_URL, undefined]);
  // A stored pin of another page with a route is not the shape.
  const stored = { id: 1, ...input({ url: PAGE_URL, route: 'stats' }), at: at(0).toISOString(), resolved: false };
  await writeFile(pinsFile(dir), JSON.stringify({ version: 1, next: 2, pins: [stored] }));
  await assert.rejects(readPins(dir), refused('pins_unreadable'));
  // Its route '' instead: readable.
  await writeFile(pinsFile(dir), JSON.stringify({ version: 1, next: 2, pins: [{ ...stored, route: '' }] }));
  assert.deepEqual((await readPins(dir)).pins, [{ ...stored, route: '' }]);
});

test('the store: writes started together go one after the other, and every one is kept; sf pins clear counts and starts the ids at 1', async () => {
  const dir = await stateDir();
  const added = await Promise.all(Array.from({ length: 8 }, (_unused, index) => addPin(dir, input({ text: `pin ${index}` }))));
  assert.deepEqual(added.map((result) => result.pin.id).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  await Promise.all([changePin(dir, 1, { note: 'one' }), changePin(dir, 2, { resolved: true }), removePin(dir, 3), addPin(dir, input())]);
  const { pins } = await readPins(dir);
  assert.deepEqual(pins.map((pin) => pin.id), [1, 2, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual([pins[0]!.note, pins[1]!.resolved], ['one', true]);
  assert.deepEqual(await clearPins(dir), { removed: 8, pins: [] });
  assert.equal((await addPin(dir, input())).pin.id, 1);
});

test('sf pins lines: the open pins only, the board as #board, a pin of another page by its address, the note indented, \\n and \\t as spaces; none: No open pins.', () => {
  const pin = (id: number, route: string, text: string, note: string, resolved = false) => ({ id, route, selector: 'body', text, rect: RECT, note, at: at(id).toISOString(), resolved });
  assert.deepEqual(pinsLines([]), ['No open pins.']);
  assert.deepEqual(pinsLines([pin(1, '', 'x', '', true)]), ['No open pins.']);
  assert.deepEqual(pinsLines([
    pin(1, '', 'Approve\tnow', 'Too\nbig'), pin(2, 'app/T-1/stream', 'Iteration 1', ''), pin(3, 'stats', 'gone', 'x', true),
    { ...pin(7, '', 'Place order', 'Wrong\ttotal'), url: PAGE_URL },
  ]), [
    '1  #board  "Approve now"', '  note: Too big', '2  #app/T-1/stream  "Iteration 1"', '7  http://localhost:3000/orders?id=42  "Place order"', '  note: Wrong total',
  ]);
});

test('dashboard: POST api/pins stores a pin of another page with its url and GET api/pins lists it; any other address, or a url beside a route, is 400 invalid_body and stores nothing', async () => {
  await withDashboard('dash-page-pins', fakeActions(), async (dashboard, { state }) => {
    const base = dashboard.url;
    const json = (reply: { body: string }): any => JSON.parse(reply.body);
    const page = input({ url: PAGE_URL, text: 'Place order' });
    const created = await act(base, 'api/pins', page);
    assert.equal(created.status, 200, created.body);
    assert.deepEqual(json(created).result.pin, { id: 1, ...page, at: json(created).result.pin.at, resolved: false });
    const listed = await fetchRaw(new URL('api/pins', base));
    assert.deepEqual([listed.status, json(listed).pins.map((pin: { route: string; url?: string }) => [pin.route, pin.url])], [200, [['', PAGE_URL]]]);
    const before = await readPins(state);
    for (const overrides of PAGE_REFUSALS) {
      const reply = await act(base, 'api/pins', { ...input(), ...overrides });
      assert.deepEqual([reply.status, json(reply).error.code], [400, 'invalid_body'], JSON.stringify(overrides));
      if (overrides.route === 'stats') {
        assert.equal(json(reply).error.message, 'pin-add expects {"route": string, "selector": string, "text": string, "rect": {"x": number, "y": number, "w": number, "h": number, "vw": number, "vh": number}, "note": string, "url"?: string} ("route" is "" with "url"); no other keys, no null.');
      }
    }
    assert.deepEqual(await readPins(state), before);
  });
});

test('dashboard: GET api/pins, POST api/pins, a change and a remove; the transport checks of every POST; unknown and bad ids; the methods', async () => {
  await withDashboard('dash-pins', fakeActions(), async (dashboard, { state }) => {
    const base = dashboard.url;
    const json = (reply: { body: string }): any => JSON.parse(reply.body);
    const empty = await fetchRaw(new URL('api/pins', base));
    assert.deepEqual([empty.status, json(empty)], [200, { pins: [] }]);
    const created = await act(base, 'api/pins', input({ route: 'stats', text: '<img src=x onerror=alert(1)>' }));
    assert.equal(created.status, 200, created.body);
    const { pin, pins } = json(created).result;
    assert.deepEqual([pin.id, pin.route, pin.text, pins.length], [1, 'stats', '<img src=x onerror=alert(1)>', 1]);
    assert.equal((await stat(pinsFile(state))).mode & 0o777, 0o600);
    const noted = await act(base, 'api/pins/1', { note: 'Why is it grey?' });
    assert.deepEqual([noted.status, json(noted).result.pins[0].note], [200, 'Why is it grey?']);
    const resolved = await act(base, 'api/pins/1', { resolved: true });
    assert.deepEqual(Object.keys(json(resolved).result), ['pins']);
    assert.equal(json(resolved).result.pins[0].resolved, true);
    assert.deepEqual(json(await fetchRaw(new URL('api/pins', base))).pins.map((each: { id: number }) => each.id), [1]);
    const removed = await act(base, 'api/pins/1/remove', {});
    assert.deepEqual([removed.status, json(removed).result], [200, { pins: [] }]);

    // The transport checks of handlePost.
    const origin = `http://127.0.0.1:${base.port}`;
    const foreign = await act(base, 'api/pins', input(), { headers: { origin: 'http://evil.example' } });
    assert.equal(foreign.status, 403);
    const missing = await fetchRaw(new URL('api/pins', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input()) });
    assert.equal(missing.status, 403);
    const type = await act(base, 'api/pins', input(), { headers: { 'content-type': 'text/plain' } });
    assert.deepEqual([type.status, json(type).error.code], [415, 'unsupported_media_type']);
    const large = await act(base, 'api/pins', undefined, { body: JSON.stringify({ ...input(), note: 'x'.repeat(130 * 1024) }) });
    assert.deepEqual([large.status, json(large).error.code], [413, 'body_too_large']);
    for (const [path, body] of [['api/pins', { ...input(), extra: 1 }], ['api/pins', { ...input(), text: 'a\u001bb' }], ['api/pins/2', {}], ['api/pins/2', { note: 'x', id: 3 }], ['api/pins/2/remove', { x: 1 }]] as const) {
      const reply = await act(base, path, body);
      assert.deepEqual([reply.status, json(reply).error.code], [400, 'invalid_body'], `${path} ${JSON.stringify(body)}`);
    }
    // Any whole number from 1 is an id: 16 digits (a safe integer) and 20 (beyond them) alike.
    for (const id of ['9', '1234567890123456', '98765432109876543210']) {
      for (const path of [`api/pins/${id}`, `api/pins/${id}/remove`]) {
        const reply = await act(base, path, path.endsWith('remove') ? {} : { note: 'x' });
        assert.deepEqual([reply.status, json(reply).error], [404, { code: 'pin_not_found', message: `There is no pin ${id}.` }], path);
      }
    }
    for (const id of ['0', '01', 'x', '1.5', '-1', '1e3']) {
      for (const path of [`api/pins/${id}`, `api/pins/${id}/remove`]) {
        const reply = await act(base, path, {});
        assert.deepEqual([reply.status, reply.body], [404, ''], path);
      }
    }
    assert.deepEqual([(await fetchRaw(new URL('api/pins?x=1', base))).status, (await fetchRaw(new URL('api/pins/x/y', base))).status], [404, 404]);
    for (const [method, path, allow] of [['PUT', 'api/pins', 'GET, POST'], ['DELETE', 'api/pins', 'GET, POST'], ['GET', 'api/pins/1', 'POST'], ['PATCH', 'api/pins/1', 'POST'], ['GET', 'api/pins/1/remove', 'POST'], ['DELETE', 'api/pins/1/remove', 'POST']] as const) {
      const reply = await fetchRaw(new URL(path, base), { method, headers: { origin, 'content-type': 'application/json' }, body: '{}' });
      assert.deepEqual([reply.status, reply.headers.allow, reply.body], [405, allow, ''], `${method} ${path}`);
    }

    // An unreadable file: refused on the read and the writes, and left as it is.
    await writeFile(pinsFile(state), '{"broken"');
    const read = await fetchRaw(new URL('api/pins', base));
    assert.deepEqual([read.status, json(read).error.code], [409, 'pins_unreadable']);
    const write = await act(base, 'api/pins', input());
    assert.deepEqual([write.status, json(write).error.code], [409, 'pins_unreadable']);
    assert.equal(await readFile(pinsFile(state), 'utf8'), '{"broken"');
  });
});

test('sf pins, sf pins resolve and sf pins clear through sf serve, with the pins the dashboard stored; an unknown id is pin_not_found, a bad one a usage error', E2E, async () => {
  const env = await newEnv('pins-cli');
  const served = await serve(env);
  try {
    const sf = async (...args: string[]) => runCli(env, ['pins', ...args]);
    assert.deepEqual(await sf(), { code: 0, stdout: 'No open pins.\n', stderr: '' });
    const base = served.dashboard!;
    assert.equal((await act(base, 'api/pins', input({ text: 'Approve\tand push' }))).status, 200);
    assert.equal((await act(base, 'api/pins', input({ route: 'app/T-1/stream', selector: '#msg', text: 'Message' }))).status, 200);
    assert.equal((await act(base, 'api/pins/2', { note: 'Should say "Send"\nnot "Say"' })).status, 200);
    assert.equal((await sf()).stdout, '1  #board  "Approve and push"\n2  #app/T-1/stream  "Message"\n  note: Should say "Send" not "Say"\n');
    assert.deepEqual(await sf('resolve', '1'), { code: 0, stdout: 'Resolved pin 1.\n', stderr: '' });
    assert.deepEqual(await sf('resolve', '1'), { code: 0, stdout: 'Resolved pin 1.\n', stderr: '' }, 'already resolved');
    assert.equal((await sf()).stdout, '2  #app/T-1/stream  "Message"\n  note: Should say "Send" not "Say"\n');
    for (const id of ['7', '1234567890123456', '98765432109876543210']) {
      const unknown = await sf('resolve', id);
      assert.deepEqual([unknown.code, unknown.stderr], [1, `sf: There is no pin ${id}.\n`], id);
    }
    for (const id of ['0', '01', 'x', '-1']) {
      const bad = await sf('resolve', id);
      assert.equal(bad.code, 2, id);
      assert.match(bad.stderr, /^sf: id must be a whole number from 1\.\n\nUsage:/, id);
    }
    assert.equal((await sf('resolve')).code, 2);
    assert.equal((await sf('extra')).code, 2);
    assert.deepEqual(await sf('clear'), { code: 0, stdout: 'Removed 2 pins.\n', stderr: '' });
    assert.equal((await act(base, 'api/pins', input())).status, 200);
    assert.deepEqual(await sf('clear'), { code: 0, stdout: 'Removed 1 pin.\n', stderr: '' });
    // Over an unreadable file: sf pins refuses, sf pins clear replaces it.
    await writeFile(pinsFile(env.state), 'not json');
    const unreadable = await sf();
    assert.equal(unreadable.code, 1);
    assert.match(unreadable.stderr, /pins\.json .*sf pins clear replaces it/);
    assert.deepEqual(await sf('clear'), { code: 0, stdout: 'Removed 0 pins.\n', stderr: '' });
    assert.equal(JSON.parse((await act(base, 'api/pins', input())).body).result.pin.id, 1);
  } finally {
    await stop(served);
  }
});
