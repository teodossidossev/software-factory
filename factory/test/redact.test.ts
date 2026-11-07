// Unit tests of the redaction of the reviewers' live events (SF-045): environment values, keys and
// content from outside the worktree (~/.codex above all) never reach events.jsonl. SF-125: a
// reviewer's output, redacted in its free-text fields only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Redactor, WITHHELD } from '../src/redact.js';

const WORKTREE = '/work/tree';
const ENV = {
  HOME: '/home/alice',
  PATH: '/usr/bin:/bin',
  USER: 'alice',
  LANG: 'en_US.UTF-8',
  // A public setting of the factory, a path.
  SF_STATE_DIR: '/usr/bin',
  // A key may start with a slash.
  SLASHED_KEY: '/AbCdEf0123456789xyz',
  // Short secrets count as much as long ones.
  DB_PASSWORD: 'abc123',
  PIN: '42',
  OPENAI_API_KEY: 'opaque-value-1234567890',
  SF_WEBHOOK_SECRET: 'hook$ecret.with+chars',
  npm_package_name: 'software-factory',
  SHORT: 'abc',
};
const redactor = (env: Record<string, string> = ENV): Redactor => new Redactor({ cwd: WORKTREE, env, home: '/home/alice' });
const command = (cmd: string, output: string): Record<string, unknown> => ({
  type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: cmd, aggregated_output: output, exit_code: 0, status: 'completed' },
});
const outputOf = (event: unknown): string => String((event as { item: { aggregated_output: string } }).item.aggregated_output);
const shown = (text: string): string => outputOf(redactor().codexEvent(command('cat notes', text)));

test('environment values become [redacted:NAME] in every string, as whole values, whatever their length; only explicitly public variables stay', () => {
  assert.equal(redactor().text('key opaque-value-1234567890, hook hook$ecret.with+chars, slashed /AbCdEf0123456789xyz, dir /usr/bin/x, user alice, /srv/software-factory/x'),
    'key [redacted:OPENAI_API_KEY], hook [redacted:SF_WEBHOOK_SECRET], slashed [redacted:SLASHED_KEY], dir /usr/bin/x, user alice, /srv/software-factory/x');
  assert.equal(redactor().text('short abc, password abc123, pin 42, "DB_PASSWORD=abc123", pins 421 and 142 stay'),
    'short [redacted:SHORT], password [redacted:DB_PASSWORD], pin [redacted:PIN], "DB_PASSWORD=[redacted]", pins 421 and 142 stay');
  // A path that exists is not public by itself; only the variables named public are.
  assert.equal(new Redactor({ cwd: WORKTREE, env: { JAVA_HOME: '/usr/bin', SF_WORKTREE_ROOT: '/usr/lib', SF_NTFY_TOKEN: 'tk1' }, home: '/home/alice' }).text('/usr/bin/java /usr/lib/x tk1'),
    '[redacted:JAVA_HOME]/java /usr/lib/x [redacted:SF_NTFY_TOKEN]');
  // An empty value redacts nothing.
  assert.equal(new Redactor({ cwd: WORKTREE, env: { EMPTY: '' }, home: '/home/alice' }).text('plain'), 'plain');
  // Not inside a longer word.
  assert.equal(redactor().text('xopaque-value-12345678901'), 'xopaque-value-12345678901');
  assert.deepEqual(redactor().codexEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'The key is opaque-value-1234567890.' } }),
    { type: 'item.completed', item: { type: 'agent_message', text: 'The key is [redacted:OPENAI_API_KEY].' } });
});

test('the gate level settings (SF-092) are public: their values, full and globs, stay in reviewer prose', () => {
  const settings = new Redactor({ cwd: WORKTREE, env: { SF_GATE_LEVEL: 'full', SF_GATE_FULL_PATHS: 'lib/billing/**', SF_NTFY_TOKEN: 'tk1' }, home: '/home/alice' });
  assert.equal(settings.text('The full gate reviewed lib/billing/** and tk1.'), 'The full gate reviewed lib/billing/** and [redacted:SF_NTFY_TOKEN].');
});

test('keys by their form: provider keys, tokens, JWTs, HTTP credentials, URL credentials, assignments, JSON and TOML fields, private keys', () => {
  const cases: Array<[string, string]> = [
    ['sk-proj-AbCdEfGhIjKlMnOpQrStUv12', '[redacted]'],
    ['sk-ant-api03-AbCdEfGhIjKlMnOpQrSt', '[redacted]'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123 here', 'token [redacted] here'],
    ['github_pat_11ABCDEFG0123456789_abcdefghij', '[redacted]'],
    ['AKIAIOSFODNN7EXAMPLE', '[redacted]'],
    ['xoxb-1234567890-abcdefghij', '[redacted]'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl', '[redacted]'],
    ['Authorization: Bearer xyz.def-ghi_jkl9', 'Authorization: Bearer [redacted]'],
    ['Authorization: Basic dXNlcjpwYXNz=', 'Authorization: Basic [redacted]'],
    ['https://bob:hunter2pass@example.com/repo.git', 'https://[redacted]@example.com/repo.git'],
    ['ANTHROPIC_API_KEY=whatever-it-is', 'ANTHROPIC_API_KEY=[redacted]'],
    ['export DB_PASSWORD="p4ss word" next', 'export DB_PASSWORD=[redacted] next'],
    ["SECRET_TOKEN: 'x y'", 'SECRET_TOKEN: [redacted]'],
    ['{"OPENAI_API_KEY": null, "tokens": {"id_token": "a.b.c", "access_token": "xyz", "refresh_token": "rrr", "account_id": "acc"}}',
      '{"OPENAI_API_KEY": null, "tokens": {"id_token": "[redacted]", "access_token": "[redacted]", "refresh_token": "[redacted]", "account_id": "acc"}}'],
    ['{"password": "ab\\"cd", "next": 1}', '{"password": "[redacted]", "next": 1}'],
    ['{"apiKey": "k1", "clientSecret": "s2"}', '{"apiKey": "[redacted]", "clientSecret": "[redacted]"}'],
    ['access_token = "toml-value"\nmodel = "o3"', 'access_token = "[redacted]"\nmodel = "o3"'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\nafter', '[redacted]\nafter'],
    ['-----BEGIN RSA PRIVATE KEY-----\ncut off', '[redacted]'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(shown(text), expected, text);
  }
  // Prose and code that name keys and tokens stay readable.
  for (const text of [
    'const token: string = readToken(); if (apiKey === undefined) { return; } // the key',
    'A basic validation. Bearer of bad news.',
    "const KEY_NAME = 'KEY|TOKEN'; const MAX_TOKENS: number = 5; MIN_SECRET_CHARS = 8",
    '{"monkey": "banana", "keyboard": "qwerty", "tokens": 3}',
  ]) {
    assert.equal(shown(text), text, text);
  }
});

test('Codex: the output of a command that reaches outside the worktree or reads the environment is withheld; others stay', () => {
  for (const cmd of [
    "bash -lc 'cat ~/.codex/auth.json'", "bash -lc 'cat ~/.co*/auth.json'", 'cat /home/alice/.codex/config.toml', 'bash -lc "ls $HOME/.codex"',
    'cat $CODEX_HOME/auth.json', "/bin/bash -lc 'grep -r model ~'", 'cat ../../secrets', 'cat /etc/passwd', 'cat /proc/self/environ',
    'env', 'bash -lc env', '/usr/bin/env', 'command env', 'time env | sort', "bash -lc 'printenv OPENAI_API_KEY'", 'git status; env | sort',
    "bash -lc 'export -p'", 'export', 'set', 'declare -x', 'echo $(env)',
    "python3 -c 'import os; print(os.environ)'", 'node -p process.env', 'bash -lc "echo $OPENAI_API_KEY"', 'echo ${SOME_TOKEN}',
  ]) {
    assert.equal(outputOf(redactor().codexEvent(command(cmd, 'anything at all'))), WITHHELD, cmd);
  }
  for (const cmd of [
    "bash -lc 'git status'", "/bin/bash -lc 'git diff abc -- src/fake-codex.ts'", 'rg -n export src', 'rg environment', 'echo $PATH',
    "bash -lc 'set -euo pipefail; git status'", 'export FOO=bar && make', `cat ${WORKTREE}/src/a.ts`, 'git diff 2>/dev/null', "sed -n '1,20p' README.md",
  ]) {
    assert.equal(outputOf(redactor().codexEvent(command(cmd, 'plain output'))), 'plain output', cmd);
  }
  // An output that shows a file of the home's dotfiles or ~/.codex, or an environment dump.
  for (const output of ['/home/alice/.codex/config.toml:model = "o3"', '/home/alice/.ssh/id_ed25519', 'A=1\nB=2\nC=3', 'declare -x A="1"\ndeclare -x B="2"\ndeclare -x C="3"']) {
    assert.equal(outputOf(redactor().codexEvent(command('rg -n model', output))), WITHHELD, output);
  }
  // The started event of such a command keeps its command line, redacted like any string.
  assert.deepEqual(redactor().codexEvent({ type: 'item.started', item: { type: 'command_execution', command: 'cat ~/.codex/auth.json', aggregated_output: '' } }),
    { type: 'item.started', item: { type: 'command_execution', command: 'cat ~/.codex/auth.json', aggregated_output: WITHHELD } });
  // A CODEX_HOME elsewhere counts too; an empty one does not withhold everything.
  assert.equal(outputOf(redactor({ CODEX_HOME: '/srv/codex-home' }).codexEvent(command('rg x', '/srv/codex-home/auth.json:1'))), WITHHELD);
  assert.equal(outputOf(redactor({ CODEX_HOME: '' }).codexEvent(command('rg x', 'plain'))), 'plain');
  // The result of an MCP tool call is withheld.
  assert.deepEqual(redactor().codexEvent({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 's', tool: 't', result: { content: 'x' }, status: 'completed' } }),
    { type: 'item.completed', item: { type: 'mcp_tool_call', server: 's', tool: 't', result: WITHHELD, status: 'completed' } });
});

test('Claude review: the result of a tool use outside the worktree, or one that reveals itself, is withheld; text and other results are redacted', () => {
  const r = redactor();
  const uses = [
    { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/home/alice/.codex/auth.json' } },
    { type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: '/proc/self/environ' } },
    { type: 'tool_use', id: 'r3', name: 'Grep', input: { pattern: '/api/export', path: 'src' } },
    { type: 'tool_use', id: 'r4', name: 'Grep', input: { pattern: 'model', path: '/home/alice' } },
    { type: 'tool_use', id: 'r5', name: 'Glob', input: { pattern: '~/.co*/*' } },
    { type: 'tool_use', id: 'r6', name: 'Read', input: { file_path: `${WORKTREE}/src/a.ts` } },
  ];
  const read = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The key is opaque-value-1234567890.' }, ...uses] } };
  // The Grep after the reads outside has its pattern withheld: it may repeat what they read.
  // The first read outside marks the run: every input after it is withheld.
  // (r3's Grep input is withheld whole, as a tool input other than a path after the mark; r4 reads outside.)
  const expectedUses = uses.map((use, index) => (index === 0 ? use : { ...use, input: use.id === 'r3' ? WITHHELD : Object.fromEntries(Object.keys(use.input).map((key) => [key, WITHHELD])) }));
  assert.deepEqual(r.reviewMessage(read), { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The key is [redacted:OPENAI_API_KEY].' }, ...expectedUses] } });
  const result = (id: string, content: unknown): Record<string, unknown> => ({ type: 'tool_result', tool_use_id: id, content });
  const results = { type: 'user', message: { role: 'user', content: [
    result('r1', '{"tokens": {"access_token": "secret"}}'), result('r2', [{ type: 'text', text: 'A=1\u0000B=2' }]),
    result('r3', 'src/a.ts:1:export const x = "opaque-value-1234567890";'), result('r4', 'x'), result('r5', 'x'),
    result('r6', 'line 1'), result('r7', '/home/alice/.codex/history.jsonl'),
  ] } };
  assert.deepEqual(r.reviewMessage(results), { type: 'user', message: { role: 'user', content: [
    result('r1', WITHHELD), result('r2', WITHHELD), result('r3', WITHHELD),
    result('r4', WITHHELD), result('r5', WITHHELD), result('r6', WITHHELD), result('r7', WITHHELD),
  ] } });
  // In a run not marked, a tool result inside the worktree is only redacted.
  assert.deepEqual(redactor().reviewMessage({ type: 'user', message: { role: 'user', content: [result('s1', 'src/a.ts:1:export const x = "opaque-value-1234567890";')] } }),
    { type: 'user', message: { role: 'user', content: [result('s1', 'src/a.ts:1:export const x = "[redacted:OPENAI_API_KEY]";')] } });
  // The SDK's own tool_use_result copy of a withheld result is withheld too.
  const copy = r.reviewMessage({ type: 'user', message: { role: 'user', content: [result('r1', 'x')] }, tool_use_result: { file: { content: 'x' } } });
  assert.equal((copy as { tool_use_result: unknown }).tool_use_result, WITHHELD);
  // Non-objects and messages without content are redacted as they are.
  assert.equal(r.reviewMessage('plain'), 'plain');
  assert.deepEqual(redactor().reviewMessage({ type: 'result', result: 'sk-proj-AbCdEfGhIjKlMnOpQrStUv12' }), { type: 'result', result: '[redacted]' });
});

test('a worktree under a dot directory of the home (the default ~/.local/state layout): its own paths stay; other home dotfiles are still withheld', () => {
  const worktree = '/home/alice/.local/state/software-factory/worktrees/app/T-1';
  const r = new Redactor({ cwd: worktree, env: ENV, home: '/home/alice' });
  const own = [`${worktree}/src/a.ts:3:export const a = 1;`, `${worktree}`, `worktree ${worktree} f00ba4 [T-1]`, `    at f (${worktree}/dist/src/x.js:1:2)`].join('\n');
  assert.equal(outputOf(r.codexEvent(command('git worktree list', own))), own);
  assert.equal(outputOf(r.codexEvent(command(`cat ${worktree}/src/a.ts`, 'plain'))), 'plain');
  // A sibling whose name only starts with the worktree's is not the worktree, nor is a path that
  // climbs out of it.
  for (const outside of [`${worktree}-other/a.ts`, `${worktree}~old/a.ts`, `${worktree}/../../../../../.ssh/id_ed25519`, `${worktree}/..`]) {
    assert.equal(outputOf(r.codexEvent(command('rg x', outside))), WITHHELD, outside);
  }
  // (A fresh run: the outputs above marked this one.)
  assert.equal(outputOf(new Redactor({ cwd: worktree, env: ENV, home: '/home/alice' }).codexEvent(command('rg x', `${worktree}/a..b.ts:1:x`))), `${worktree}/a..b.ts:1:x`);
  for (const other of ['/home/alice/.codex/config.toml:model = "o3"', '/home/alice/.ssh/id_ed25519', `${worktree}/a.ts\n/home/alice/.ssh/config`]) {
    assert.equal(outputOf(r.codexEvent(command('rg -n model', other))), WITHHELD, other);
  }
  // The review, in runs not marked before: a Glob of the worktree keeps its result; a read of
  // ~/.ssh, and results that show home files, are withheld.
  const fresh = (): Redactor => new Redactor({ cwd: worktree, env: ENV, home: '/home/alice' });
  const result = (id: string, content: unknown): Record<string, unknown> => ({ type: 'tool_result', tool_use_id: id, content });
  const user = (...content: unknown[]): Record<string, unknown> => ({ type: 'user', message: { role: 'user', content } });
  const glob = fresh();
  glob.reviewMessage({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'g1', name: 'Glob', input: { pattern: '**/*.ts', path: worktree } }] } });
  assert.deepEqual(glob.reviewMessage(user(result('g1', `${worktree}/src/a.ts\n${worktree}/src/b.ts`))), user(result('g1', `${worktree}/src/a.ts\n${worktree}/src/b.ts`)));
  for (const [id, content] of [['g3', '/home/alice/.codex/history.jsonl'], ['g4', `${worktree}/a.ts\n/home/alice/.ssh/config`]] as const) {
    assert.deepEqual(fresh().reviewMessage(user(result(id, content))), user(result(id, WITHHELD)), id);
  }
  const ssh = fresh();
  ssh.reviewMessage({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'g2', name: 'Read', input: { file_path: '/home/alice/.ssh/config' } }] } });
  assert.deepEqual(ssh.reviewMessage(user(result('g2', 'Host x'))), user(result('g2', WITHHELD)));
});

test('without a worktree (a review that could not start) no absolute path counts as inside', () => {
  const r = new Redactor({ cwd: '', env: ENV, home: '/home/alice' });
  assert.equal(outputOf(r.codexEvent(command('cat /work/tree/a.ts', 'x'))), WITHHELD);
  assert.equal(outputOf(r.codexEvent(command('rg x', '/home/alice/.ssh/config'))), WITHHELD);
});

test('a short value does not rewrite the fields that structure an event or a message; npm\'s config variables stay secret', () => {
  const r = new Redactor({ cwd: WORKTREE, env: { LOG_LEVEL: 'error', CLAUDECODE: '1', ROLE: 'user', npm_config__authToken: 'npm_tok', npm_package_name: 'software-factory' }, home: '/home/alice' });
  assert.deepEqual(r.codexEvent({ type: 'error', message: 'an error, then 1 more' }), { type: 'error', message: 'an [redacted:LOG_LEVEL], then [redacted:CLAUDECODE] more' });
  assert.deepEqual(r.codexEvent({ type: 'item.completed', item: { id: 'item_1', type: 'error', message: 'error' } }),
    { type: 'item.completed', item: { id: 'item_1', type: 'error', message: '[redacted:LOG_LEVEL]' } });
  assert.deepEqual(r.reviewMessage({ type: 'user', uuid: 'u-1', session_id: 's-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't_1', content: 'user 1' }] } }),
    { type: 'user', uuid: 'u-1', session_id: 's-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't_1', content: '[redacted:ROLE] [redacted:CLAUDECODE]' }] } });
  assert.equal(r.text('token npm_tok in software-factory'), 'token [redacted:npm_config__authToken] in software-factory');
});

test('reviewer prose: text that shows ~/.codex or another home dotfile is withheld, and so is all prose after the run read such a file', () => {
  const codex = redactor();
  const message = (text: string): Record<string, unknown> => ({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text } });
  const reasoning = (text: string): Record<string, unknown> => ({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text } });
  const textOf = (event: unknown): unknown => (event as { item: { text: unknown } }).item.text;
  assert.equal(textOf(codex.codexEvent(message('Looks right; key opaque-value-1234567890.'))), 'Looks right; key [redacted:OPENAI_API_KEY].');
  assert.equal(textOf(codex.codexEvent(message('/home/alice/.codex/config.toml: model = "o3"'))), WITHHELD);
  assert.equal(textOf(codex.codexEvent(reasoning('Reading /home/alice/.ssh/config'))), WITHHELD);
  assert.deepEqual(codex.codexEvent({ type: 'error', message: 'cannot read /home/alice/.codex/auth.json' }), { type: 'error', message: WITHHELD });
  // Prose that names no path is kept until the run reads a file it withholds; then it is withheld.
  assert.equal(textOf(codex.codexEvent(message('Still fine.'))), 'Still fine.');
  codex.codexEvent({ type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'cat ~/.codex/config.toml', aggregated_output: '' } });
  assert.equal(textOf(codex.codexEvent(message('The model is o3.'))), WITHHELD);
  assert.equal(textOf(codex.codexEvent(reasoning('**Thinking**'))), WITHHELD);
  // An output that withholds itself (an environment dump) does the same.
  const dumped = redactor();
  dumped.codexEvent(command('rg -n x', 'A=1\nB=2\nC=3'));
  assert.equal(textOf(dumped.codexEvent(message('B is 2.'))), WITHHELD);
  // Another run starts clean.
  assert.equal(textOf(redactor().codexEvent(message('Fine.'))), 'Fine.');

  const review = redactor();
  const assistant = (...content: unknown[]): Record<string, unknown> => ({ type: 'assistant', message: { role: 'assistant', content } });
  const blocksOf = (message: unknown): unknown[] => (message as { message: { content: unknown[] } }).message.content;
  assert.deepEqual(blocksOf(review.reviewMessage(assistant({ type: 'text', text: 'Before: opaque-value-1234567890' }, { type: 'text', text: 'See /home/alice/.codex/config.toml: model = "o3"' }))),
    [{ type: 'text', text: 'Before: [redacted:OPENAI_API_KEY]' }, { type: 'text', text: WITHHELD }]);
  // In one message, text before the read stays; text after it is withheld.
  assert.deepEqual(blocksOf(review.reviewMessage(assistant(
    { type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'x1', name: 'Read', input: { file_path: '/home/alice/.codex/auth.json' } }, { type: 'text', text: 'Reading.' },
  ))), [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'x1', name: 'Read', input: { file_path: '/home/alice/.codex/auth.json' } }, { type: 'text', text: WITHHELD }]);
  assert.deepEqual(blocksOf(review.reviewMessage(assistant({ type: 'thinking', thinking: 'The token is in there.' }, { type: 'text', text: 'It says model o3.' }))),
    [{ type: 'thinking', thinking: WITHHELD }, { type: 'text', text: WITHHELD }]);
  assert.deepEqual(review.reviewMessage({ type: 'result', subtype: 'success', result: 'Done: model o3.' }), { type: 'result', subtype: 'success', result: WITHHELD });
  // A tool result withheld by what it shows marks the run as well.
  const shown = redactor();
  shown.reviewMessage({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'g', content: '/home/alice/.ssh/config' }] } });
  assert.deepEqual(blocksOf(shown.reviewMessage(assistant({ type: 'text', text: 'Host x.' }))), [{ type: 'text', text: WITHHELD }]);
});

test('reviewer prose and payloads: the short form of a home file, failed turns, MCP calls, todo lists, the verdict and tool inputs; a search does not mark the run', () => {
  const textOf = (event: unknown): unknown => (event as { item: { text: unknown } }).item.text;
  const message = (text: string): Record<string, unknown> => ({ type: 'item.completed', item: { type: 'agent_message', text } });
  const r = redactor();
  // ~/.codex/config.toml named the short way is withheld, without marking the run; a bare ~/.codex stays.
  assert.equal(textOf(r.codexEvent(message('~/.codex/config.toml: model = "o3"'))), WITHHELD);
  assert.equal(textOf(r.codexEvent(message('Nothing from ~/.codex is logged; $HOME/.ssh/id_rsa neither.'))), WITHHELD);
  assert.equal(textOf(r.codexEvent(message('Nothing from ~/.codex is logged.'))), 'Nothing from ~/.codex is logged.');
  assert.deepEqual(r.codexEvent({ type: 'turn.failed', error: { message: '/home/alice/.codex/auth.json: denied' } }), { type: 'turn.failed', error: { message: WITHHELD } });
  // Searches in the worktree for these words do not mark the run, and their output stays.
  for (const cmd of ['rg -n "process.env" src', 'rg "\\.codex" README.md', 'cat .codex/notes.md']) {
    assert.equal(outputOf(r.codexEvent(command(cmd, 'src/a.ts:1:x'))), 'src/a.ts:1:x', cmd);
  }
  assert.equal(textOf(r.codexEvent(message('Still shown.'))), 'Still shown.');
  // A worktree file that names ~/.codex/auth.json is withheld but does not mark the run either.
  assert.equal(outputOf(r.codexEvent(command('cat README.md', 'reads ~/.codex/auth.json'))), WITHHELD);
  assert.equal(textOf(r.codexEvent(message('Still shown.'))), 'Still shown.');
  // An interpreter that prints the environment, and a cd to the home, are withheld and mark the run.
  for (const cmd of ['node -p process.env', 'cd; cat .codex/auth.json', 'cd && ls']) {
    const fresh = redactor();
    assert.equal(outputOf(fresh.codexEvent(command(cmd, 'x'))), WITHHELD, cmd);
    assert.equal(textOf(fresh.codexEvent(message('After.'))), WITHHELD, cmd);
  }
  // An MCP call: its result is withheld and marks the run; arguments and errors that reveal a home file are withheld.
  const mcp = redactor();
  assert.deepEqual(mcp.codexEvent({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 's', tool: 't', arguments: { path: '~/.ssh/config' }, result: { content: 'x' }, error: { message: '/home/alice/.codex/x' } } }),
    { type: 'item.completed', item: { type: 'mcp_tool_call', server: 's', tool: 't', arguments: WITHHELD, result: WITHHELD, error: WITHHELD } });
  assert.equal(textOf(mcp.codexEvent(message('The result says y.'))), WITHHELD);
  // A todo list is prose.
  const todo = (text: string): Record<string, unknown> => ({ type: 'item.updated', item: { type: 'todo_list', items: [{ text, completed: false }] } });
  assert.deepEqual(redactor().codexEvent(todo('Read src')), todo('Read src'));
  assert.deepEqual(mcp.codexEvent(todo('Quote the result')), todo(WITHHELD));

  // Claude: after a read outside, the verdict, its errors and tool inputs other than paths are withheld.
  const review = redactor();
  review.reviewMessage({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/home/alice/.codex/auth.json' } }] } });
  const uses = (review.reviewMessage({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'b', name: 'Grep', input: { pattern: 'token-from-the-file', path: 'src' } },
    { type: 'tool_use', id: 'c', name: 'Read', input: { file_path: 'src/a.ts' } },
    { type: 'tool_use', id: 'd', name: 'StructuredOutput', input: { verdict: 'clean', summary: 'It quotes the file.' } },
  ] } }) as { message: { content: Array<{ input: unknown }> } }).message.content.map((block) => block.input);
  assert.deepEqual(uses, [WITHHELD, { file_path: WITHHELD }, WITHHELD]);
  assert.deepEqual(review.reviewMessage({ type: 'result', subtype: 'error_max_turns', errors: ['it said x'], structured_output: { verdict: 'clean' } }),
    { type: 'result', subtype: 'error_max_turns', errors: [WITHHELD], structured_output: WITHHELD });
  // Without a read outside, the verdict and a Grep pattern stay.
  const clean = redactor();
  assert.deepEqual(clean.reviewMessage({ type: 'result', subtype: 'success', result: '', structured_output: { verdict: 'clean' } }), { type: 'result', subtype: 'success', result: '', structured_output: { verdict: 'clean' } });
  assert.deepEqual((clean.reviewMessage({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'e', name: 'Grep', input: { pattern: 'x', path: 'src' } }] } }) as { message: { content: Array<{ input: unknown }> } }).message.content[0]!.input,
    { pattern: 'x', path: 'src' });
});

test('a failure message: redacted; its detail withheld when it shows or names a home file or the run read one; the factory\'s lead-in stays', () => {
  const r = redactor();
  assert.equal(r.failure('Codex exited with code 1.'), 'Codex exited with code 1.');
  assert.equal(r.failure('Codex reported an error: quota for opaque-value-1234567890'), 'Codex reported an error: quota for [redacted:OPENAI_API_KEY]');
  assert.equal(r.failure('Codex reported an error: /home/alice/.codex/auth.json: literal-file-content'), `Codex reported an error: ${WITHHELD}`);
  assert.equal(r.failure('The review ended with error_during_execution: ~/.codex/config.toml says literal-file-content'), `The review ended with error_during_execution: ${WITHHELD}`);
  // Without a lead-in, the whole message.
  assert.equal(r.failure('/home/alice/.ssh/config: Host x'), WITHHELD);
  // Once the run read something outside, any detail is withheld; a message without one stays.
  r.codexEvent(command('cat ~/.codex/auth.json', 'x'));
  assert.equal(r.failure('Codex reported an error: it says literal-file-content'), `Codex reported an error: ${WITHHELD}`);
  assert.equal(r.failure('Codex timed out after 900000 ms and was stopped (SIGTERM).'), 'Codex timed out after 900000 ms and was stopped (SIGTERM).');
});

test('output (SF-125): a reviewer\'s free text loses keys, long environment values and the given tokens; short values, quoted code and every other field stay', () => {
  const token = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';
  const env = { HOME: '/home/alice', PATH: '/usr/bin', FLAG: '1', BRANCH: 'main', DEPLOY_KEY_VALUE: 'deploy-value-0123456789', SAME: 'src/app.ts' };
  const output = {
    verdict: 'fix',
    summary: `Leaks ghp_${'A'.repeat(36)} and deploy-value-0123456789.`,
    items: [
      {
        path: 'src/app.ts', severity: 'major', reopens: 'R1', caused_by: '',
        problem: `It logs the dashboard token ${token}; it quotes \`if (process.env.FLAG === "1") { checkout("main"); }\`.`,
        expected: 'Remove deploy-value-0123456789 from the log.',
      },
    ],
    accepted_sensitive: ['src/app.ts'],
  };
  const redacted = new Redactor({ cwd: WORKTREE, env, home: '/home/alice', secrets: [token] }).output(output);
  assert.deepEqual(redacted, {
    verdict: 'fix',
    summary: 'Leaks [redacted] and [redacted].',
    items: [
      {
        path: 'src/app.ts', severity: 'major', reopens: 'R1', caused_by: '',
        problem: 'It logs the dashboard token [redacted]; it quotes `if (process.env.FLAG === "1") { checkout("main"); }`.',
        expected: 'Remove [redacted] from the log.',
      },
    ],
    accepted_sensitive: ['src/app.ts'],
  });
  // A copy: the reviewer's output itself is unchanged.
  assert.ok(output.summary.includes('ghp_'));
  // The structural fields stay even when they equal an environment value of 8 characters or more.
  const structural = new Redactor({ cwd: WORKTREE, env: { VERDICT: 'clean-and-fix', SEVERITY_VALUE: 'major-value', PATH_VALUE: 'src/app.ts', IDS: 'R1-R2-R3-R4' }, home: '/home/alice' }).output({
    summary: 'ok', suggestions: [{ path: 'src/app.ts', what: 'Drop src/app.ts', why: 'R1-R2-R3-R4 added it.', saves_lines: 3, ledger_ids: ['R1-R2-R3-R4'] }],
    verdict: 'clean-and-fix', severity: 'major-value',
  });
  assert.deepEqual(structural, {
    summary: 'ok', suggestions: [{ path: 'src/app.ts', what: 'Drop [redacted]', why: '[redacted] added it.', saves_lines: 3, ledger_ids: ['R1-R2-R3-R4'] }],
    verdict: 'clean-and-fix', severity: 'major-value',
  });
  // Never withheld whole, whatever it names.
  assert.equal(new Redactor({ cwd: WORKTREE, env, home: '/home/alice' }).output({ summary: 'It reads ~/.codex/auth.json.' }).summary, 'It reads ~/.codex/auth.json.');
});
