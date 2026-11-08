// The page renders the server's stop table and decides no rule of its own (SF-129): static/app.js
// has none of the identifiers of its old copies, and its STOPS (the words of each stop) has
// exactly the keys of src/stops.ts's table, usage_limit and other included.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { STOP_CODES } from '../src/stops.js';

const APP = new URL('../../static/app.js', import.meta.url);

// What the page decided by hand before SF-129, now the server's.
const DELETED = [
  'ACCEPT_CODES', 'GATE_CODES', 'LEDGER_CODES', 'LIMIT_CODE', 'SETTLE_STOPS', 'RETRY_STOPS', 'STOP_ALIASES', 'PAUSE_STATES', 'RESUME_STATES',
  'RESTART_STATES', 'SAY_STATES', 'HANDOVER_ACTIONS', 'gateAcceptable', 'actedClean', 'retryable', 'usageLimited', 'settleable', 'stopActions', 'actionsFor',
];

test('stops client: app.js contains none of the identifiers of the rules it no longer decides, as words (comments included)', async () => {
  const source = await readFile(APP, 'utf8');
  for (const name of DELETED) {
    assert.doesNotMatch(source, new RegExp(`\\b${name}\\b`), name);
  }
});

test('stops client: the keys of app.js\'s STOPS are the table\'s, usage_limit and other included; its entries hold words only, no kind', async () => {
  const source = await readFile(APP, 'utf8');
  const start = source.indexOf('\nconst STOPS = {\n');
  assert.ok(start >= 0, 'app.js has const STOPS');
  const block = source.slice(start, source.indexOf('\n};\n', start));
  const keys = [...block.matchAll(/^ {2}([a-z_]+): \{$/gm)].map((match) => match[1]);
  assert.deepEqual([...keys].sort(), [...STOP_CODES].sort());
  assert.ok(keys.includes('usage_limit') && keys.includes('other'));
  // Only the words: a stop's kind is the payload's stop_kind.
  assert.doesNotMatch(block, /\bkind:/);
});
