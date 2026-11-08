// The page renders the server's stop table and decides no rule of its own (SF-129): the page's
// scripts (DASHBOARD_SCRIPTS) have none of the identifiers of its old copies, and its STOPS (the
// words of each stop) has exactly the keys of src/stops.ts's table, usage_limit and other included.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STOP_CODES } from '../src/stops.js';
import { readScripts } from './support/fake-dom.js';

// Every script of the page, in load order, as one text: the files written by hand (SF-146: web/*.ts
// for a script built from TypeScript), whose comments and layout the checks below read.
const pageSource = async (): Promise<string> => (await readScripts('source')).map(({ source }) => source).join('\n');

// What the page decided by hand before SF-129, now the server's.
const DELETED = [
  'ACCEPT_CODES', 'GATE_CODES', 'LEDGER_CODES', 'LIMIT_CODE', 'SETTLE_STOPS', 'RETRY_STOPS', 'STOP_ALIASES', 'PAUSE_STATES', 'RESUME_STATES',
  'RESTART_STATES', 'SAY_STATES', 'HANDOVER_ACTIONS', 'gateAcceptable', 'actedClean', 'retryable', 'usageLimited', 'settleable', 'stopActions', 'actionsFor',
];

test('stops client: the page\'s scripts contain none of the identifiers of the rules it no longer decides, as words (comments included)', async () => {
  const source = await pageSource();
  for (const name of DELETED) {
    assert.doesNotMatch(source, new RegExp(`\\b${name}\\b`), name);
  }
});

test('stops client: the keys of the page\'s STOPS are the table\'s, usage_limit and other included; its entries hold words only, no kind', async () => {
  const source = await pageSource();
  const start = source.indexOf('\nconst STOPS = {\n');
  assert.ok(start >= 0, 'a script has const STOPS');
  const block = source.slice(start, source.indexOf('\n};\n', start));
  const keys = [...block.matchAll(/^ {2}([a-z_]+): \{$/gm)].map((match) => match[1]);
  assert.deepEqual([...keys].sort(), [...STOP_CODES].sort());
  assert.ok(keys.includes('usage_limit') && keys.includes('other'));
  // Only the words: a stop's kind is the payload's stop_kind.
  assert.doesNotMatch(block, /\bkind:/);
});
