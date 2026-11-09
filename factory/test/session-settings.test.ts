// The settings of every Claude session of a job (SF-159): the Implementer's turns (its first, Fix,
// Tests Fix and MR text turns share one query() site), the Claude review and the simplification
// pass pass disableAllHooks, so no hook of a settings file a job could have written runs, and keep
// their other settings (the review's claudeMdExcludes); the file-tool guard, a hook given to
// query(), still refuses a write outside the worktree. The fake Claude Code puts the tool calls to
// the hooks as the real CLI does; the last test runs the real one, only where the live smoke runs
// (SF_TEST_LIVE_CLAUDE=1: a Claude Code with a login, as sf smoke needs).
import { type SDKMessage, query } from '@anthropic-ai/claude-agent-sdk';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { DENIED_TOOLS } from '../src/rules.js';
import { FILE_GUARD, type PathDenials, pathDenials } from '../src/sandbox-denials.js';
import { runReview } from '../src/review.js';
import { type IdleOutcome, ImplementerSession, JOB_SESSION_SETTINGS } from '../src/session.js';
import { runSimplify } from '../src/simplify.js';
import { FAKE, fakeLog, newEnv, probeLog, reviewLog, reviewScript, script } from './support/harness.js';

const CLEAN = { verdict: 'clean', summary: 'Looks right.', items: [], accepted_sensitive: [] };

// A job's worktree under a fresh state directory, and its path denials (with the file-tool guard).
async function jobOf(name: string): Promise<{ env: Awaited<ReturnType<typeof newEnv>>; worktree: string; denials: PathDenials }> {
  const env = await newEnv(name);
  const worktree = join(env.state, 'worktrees', 'app', 'S-1');
  const checkout = join(dirname(env.state), 'checkout');
  await mkdir(worktree, { recursive: true });
  await mkdir(checkout, { recursive: true });
  await mkdir(env.config, { recursive: true });
  const denials = await pathDenials({
    session: 'job', workspace: 'app', checkout, worktree, stateDir: env.state, worktreeRoot: join(env.state, 'worktrees'), configDir: env.config,
    env: { HOME: env.home, SF_CONFIG_DIR: env.config },
  });
  return { env, worktree, denials };
}

// The JSON of a CLI run's --settings.
const settingsOf = (argv: string[]): Record<string, unknown> => JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '{}') as Record<string, unknown>;

// Runs body with HOME set to home (the fake Claude Code reads its scripts there).
async function withHome<T>(home: string, body: () => Promise<T>): Promise<T> {
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    return await body();
  } finally {
    process.env.HOME = saved;
  }
}

test('the settings every job session passes: disableAllHooks', () => {
  assert.deepEqual(JOB_SESSION_SETTINGS, { disableAllHooks: true });
});

test('the Implementer\'s query() passes disableAllHooks, and the file-tool guard still refuses a Write outside the worktree and one of .claude/settings.json', async () => {
  const { env, worktree, denials } = await jobOf('session-settings-implementer');
  const outside = join(env.home, 'outside.txt');
  await script(env, [{ calls: [{ tool: 'Write', input: { file_path: outside, content: 'x' } }, { tool: 'Write', input: { file_path: '.claude/settings.json', content: '{"hooks":{}}' } }] }]);
  const outcome = await withHome(env.home, () => new Promise<IdleOutcome>((resolve) => {
    const session = new ImplementerSession({ cwd: worktree, maxTurns: 3, claudePath: FAKE, sandbox: undefined, pathDenials: async () => denials }, {
      message: async () => undefined, prompt: async () => undefined, idle: async (idle) => resolve(idle),
    });
    session.send('first', DENIED_TOOLS);
  }));
  assert.equal(outcome.ok, true);
  const [turn] = await fakeLog(env);
  assert.equal(settingsOf(turn!.argv).disableAllHooks, true, turn!.argv.join(' '));
  const probes = await probeLog(env);
  assert.deepEqual(probes.map((entry) => [entry.tool, entry.decision, entry.hooks]), [['Write', 'deny', 1], ['Write', 'deny', 1]]);
  assert.ok(probes[0]!.output.startsWith(FILE_GUARD) && probes[0]!.output.includes(outside), probes[0]!.output);
  assert.match(probes[1]!.output, /is agent configuration; the factory does not let a job change it\.$/u);
  assert.equal(existsSync(outside), false);
});

test('the review\'s and the simplification pass\'s query() pass disableAllHooks with their claudeMdExcludes, and the file-tool guard still refuses a write outside the worktree', async () => {
  const { env, worktree, denials } = await jobOf('session-settings-review');
  const outside = join(env.home, 'outside.txt');
  const probes = [{ tool: 'Write', input: { file_path: outside, content: 'x' } }];
  await reviewScript(env, [{ output: CLEAN, probes }, { output: { summary: 'Nothing to simplify.', suggestions: [] }, probes }]);
  await withHome(env.home, async () => {
    const options = { cwd: worktree, claudePath: FAKE, sandbox: undefined, model: undefined, maxTurns: 3, signal: new AbortController().signal, hooks: denials.hooks };
    assert.equal((await runReview('Review this.', options)).ok, true);
    assert.equal((await runSimplify('Simplify this.', options)).ok, true);
  });
  const runs = await reviewLog(env);
  assert.equal(runs.length, 2);
  for (const run of runs) {
    const settings = settingsOf(run.argv) as { disableAllHooks?: boolean; claudeMdExcludes?: string[] };
    assert.equal(settings.disableAllHooks, true, run.argv.join(' '));
    assert.ok(settings.claudeMdExcludes?.includes(join(dirname(worktree), 'CLAUDE.md')), run.argv.join(' '));
  }
  const writes = (await probeLog(env)).filter((entry) => entry.tool === 'Write');
  assert.deepEqual(writes.map((entry) => entry.decision), ['deny', 'deny']);
  assert.ok(writes.every((entry) => entry.output.startsWith(FILE_GUARD) && entry.output.includes(outside)), JSON.stringify(writes));
});

// The real Claude Code (SF_CLAUDE, else claude on PATH), as sf smoke runs it: does disableAllHooks
// leave the hooks given to query() running? The session may use the Write tool only, without a
// prompt (dontAsk); it is asked for a Write outside its worktree, which the guard must refuse.
test('on the real Claude Code: with disableAllHooks the file-tool guard still refuses a Write outside the worktree', { skip: process.env.SF_TEST_LIVE_CLAUDE === '1' ? false : 'runs only where the live smoke runs (SF_TEST_LIVE_CLAUDE=1)' }, async () => {
  const { env, worktree, denials } = await jobOf('session-settings-live');
  const outside = join(dirname(env.home), 'outside.txt');
  const results: string[] = [];
  const messages = query({
    prompt: `Use the Write tool once to create the file ${outside} with the content "x". Do nothing else, and do not retry.`,
    options: {
      cwd: worktree, permissionMode: 'dontAsk', allowedTools: ['Write'], tools: ['Write'], maxTurns: 3, model: process.env.SF_SMOKE_MODEL || 'haiku',
      settingSources: [], settings: { ...JOB_SESSION_SETTINGS }, hooks: denials.hooks,
      ...(process.env.SF_CLAUDE !== undefined ? { pathToClaudeCodeExecutable: process.env.SF_CLAUDE } : {}),
    },
  });
  for await (const message of messages as AsyncIterable<SDKMessage>) {
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type === 'tool_result') {
          results.push(typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
        }
      }
    }
  }
  assert.equal(existsSync(outside), false);
  assert.ok(results.some((result) => result.includes(FILE_GUARD)), `no refusal of the guard: ${JSON.stringify(results)}`);
});
