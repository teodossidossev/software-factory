// Unit test of Node's network defaults (SF-231): each connect attempt gets 2.5 s, not 250 ms.
import assert from 'node:assert/strict';
import { getDefaultAutoSelectFamily, getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { test } from 'node:test';
import { applyNetDefaults, CONNECT_ATTEMPT_MS } from '../src/net-defaults.js';

test('applyNetDefaults: a connect attempt gets 2500 ms and happy eyeballs stays on', () => {
  const previous = getDefaultAutoSelectFamilyAttemptTimeout();
  try {
    applyNetDefaults();
    assert.equal(CONNECT_ATTEMPT_MS, 2500);
    assert.equal(getDefaultAutoSelectFamilyAttemptTimeout(), 2500);
    assert.equal(getDefaultAutoSelectFamily(), true);
  } finally {
    setDefaultAutoSelectFamilyAttemptTimeout(previous);
  }
});
