// SF-208: back to the planner while a job waits for the user. The conversation about the result
// and the planning chat link (src/conversation.ts), the planner's suggestion and read_job
// (src/planner.ts) served as MCP tools in process (src/server.ts), and the ticket's planning chat
// link in the start screen's data (src/setup.ts). Everything in temp directories; the end-to-end
// Send through sf serve is test/planner-flow.test.ts's.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { conversationUrl, MAX_CONVERSATION_URL, planningChatUrl, resultConversation } from '../src/conversation.js';
import { FactoryError } from '../src/errors.js';
import type { ExclusiveScope } from '../src/execution.js';
import { type Job, type JobState, JobStore } from '../src/jobs.js';
import {
  checkSuggestionSend, MAX_REPORT_BYTES, noteSha256, removeSuggestion, sendShownSuggestion, SENDING_FILE, shownSuggestion, storeSuggestion, SUGGESTION_FILE,
} from '../src/planner.js';
import { ensureMcpToken, mcpUrl, readMcpToken, startServer } from '../src/server.js';
import { Setup } from '../src/setup.js';
import { newEnv, newRepo, putTask } from './support/harness.js';

const T0 = '2026-11-14T10:00:00.000Z';

function jobOf(ticket: string, state: JobState, extra: Partial<Job> = {}): Job {
  return {
    workspace: 'app', ticket, branch: `${ticket}-x`, base: 'main', continues: null, builds_on: null, builds_on_commit: null, base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
    mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state, iteration: 0, session_id: null, mr: null, created_at: T0, updated_at: T0, ...extra,
  };
}

async function refusedWith(work: Promise<unknown>, code: string): Promise<string> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof FactoryError, String(error));
    assert.equal(error.code, code, error.message);
    return error.message;
  }
  assert.fail(`expected ${code}`);
}

test('resultConversation names the workspace, the ticket and the tools, as the user would ask; its link of the longest names fits', () => {
  const message = resultConversation('app', 'T-1');
  assert.ok(message.startsWith('Use the Software Factory connector. Call guide. This conversation is about the result of ticket T-1 in workspace app: its job waits for me. '));
  assert.ok(message.includes('Read the Task file with read_file (workspace "app", path ".software-factory/T-1.md"), then the job\'s latest Report and reviews with read_job (workspace "app", ticket "T-1").'));
  assert.ok(message.includes('propose the change with suggest_changes (workspace "app", ticket "T-1", note): one note to the Implementer, written as I would write it. I read it on the dashboard and send it or dismiss it.'));
  assert.ok(message.endsWith('The Task file cannot be rewritten while the job is live. You do not start, review or approve jobs.'));
  assert.ok(resultConversation('app', 'T-1', 'claude_code').startsWith('Use the software-factory MCP server. Call guide. '));
  const long = resultConversation('w'.repeat(64), `${'T'.repeat(60)}-123`);
  assert.ok(conversationUrl(long).length < MAX_CONVERSATION_URL, String(conversationUrl(long).length));
});

test('planningChatUrl takes a https://chatgpt.com/ link (no other scheme, host, subdomain, port or credentials, at most 2048 characters) or exactly a https://claude.ai/code/<session> link', () => {
  assert.equal(planningChatUrl('https://chatgpt.com/c/6735-abcd'), 'https://chatgpt.com/c/6735-abcd');
  assert.equal(planningChatUrl('  https://chatgpt.com/g/g-p-x/c/6735-abcd \n'), 'https://chatgpt.com/g/g-p-x/c/6735-abcd');
  assert.equal(planningChatUrl('https://claude.ai/code/session_01Ab'), 'https://claude.ai/code/session_01Ab');
  assert.equal(planningChatUrl(' https://claude.ai/code/x-Y_9 '), 'https://claude.ai/code/x-Y_9');
  assert.equal(planningChatUrl(`https://claude.ai/code/${'a'.repeat(128)}`), `https://claude.ai/code/${'a'.repeat(128)}`);
  const refused = ['http://chatgpt.com/', 'https://chat.openai.com/', 'https://evil.chatgpt.com/', 'https://chatgpt.com.evil.com/', 'https://u:p@chatgpt.com/', 'https://chatgpt.com:444/',
    'javascript:alert(1)', `https://chatgpt.com/c/${'a'.repeat(2049 - 'https://chatgpt.com/c/'.length)}`, 'not a link', '',
    'http://claude.ai/code/x', 'https://claude.ai/chat/x', 'https://claude.ai/code/', 'https://claude.ai/code/a/b', 'https://claude.ai/code/x?y=1', 'https://claude.ai/code/x#y',
    'https://claude.ai/code/x?', 'https://claude.ai/code/x#', 'https://CLAUDE.ai/code/x', 'https://evil.claude.ai/code/x', 'https://claude.ai.evil.com/code/x',
    'https://u:p@claude.ai/code/x', 'https://claude.ai:444/code/x', `https://claude.ai/code/${'a'.repeat(129)}`, 'https://claude.ai/'];
  for (const text of refused) {
    assert.throws(() => planningChatUrl(text), (error: unknown) => error instanceof FactoryError && error.code === 'invalid_chat_link'
      && error.message === 'Only a https://chatgpt.com/ conversation link or a https://claude.ai/code/<session> link can be saved.', text);
  }
});

test('the suggestion store: only for a waiting job, a valid note, replaced by the next; shown only while waiting at its iteration; removed only when it is still the one sent', async () => {
  const env = await newEnv('planner-store');
  const jobs = new JobStore(env.state);
  assert.equal(await refusedWith(storeSuggestion(jobs, 'app', 'S-1', 'x'), 'job_not_found'), 'There is no job for app/S-1.');
  for (const state of ['working', 'paused', 'pushed'] as const) {
    await jobs.write(jobOf('S-1', state, { iteration: 1 }));
    assert.equal(await refusedWith(storeSuggestion(jobs, 'app', 'S-1', 'x'), 'invalid_state'),
      `The job is ${state}; suggest_changes needs a job that waits for the user: needs_human, ready_for_human_review or handed_over.`);
  }
  await jobs.write(jobOf('S-1', 'needs_human', { iteration: 1 }));
  for (const note of ['', '  \n ', 'a\u0000b', 'x'.repeat(4001)]) {
    await refusedWith(storeSuggestion(jobs, 'app', 'S-1', note), 'invalid_content');
  }
  const file = join(jobs.dir('app', 'S-1'), SUGGESTION_FILE);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  const first = await storeSuggestion(jobs, 'app', 'S-1', 'x'.repeat(4000));
  assert.deepEqual(first, { stored: true, sha256: noteSha256('x'.repeat(4000)) });
  const note = 'Keep the button, ünïcödé 🚀\nrename it';
  const second = await storeSuggestion(jobs, 'app', 'S-1', note);
  assert.equal(second.sha256, noteSha256(note));
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual({ ...stored, at: 'at' }, { note, sha256: second.sha256, at: 'at', iteration: 1 });
  let job = (await jobs.read('app', 'S-1'))!;
  assert.deepEqual(await shownSuggestion(jobs, job), { note, sha256: second.sha256, at: stored.at });
  for (const state of ['ready_for_human_review', 'handed_over'] as const) {
    assert.notEqual(await shownSuggestion(jobs, { ...job, state }), null, state);
  }
  // Stale: the job no longer waits, or it moved on to another iteration.
  assert.equal(await shownSuggestion(jobs, { ...job, state: 'working' }), null);
  assert.equal(await shownSuggestion(jobs, { ...job, iteration: 2 }), null);
  // A file that is not a suggestion (a sha256 of another note) is none.
  await writeFile(file, JSON.stringify({ ...stored, note: 'other' }));
  assert.equal(await shownSuggestion(jobs, job), null);
  await storeSuggestion(jobs, 'app', 'S-1', note);
  // Send: refused unsent for another sha256 (the file stays), sent and removed for the shown one.
  const sent: string[] = [];
  const read = async (): Promise<Job> => (await jobs.read('app', 'S-1'))!;
  const send = async (text: string): Promise<string> => {
    sent.push(text);
    return 'said';
  };
  await refusedWith(sendShownSuggestion(jobs, 'app', 'S-1', first.sha256, read, send), 'suggestion_changed');
  assert.deepEqual(sent, []);
  assert.notEqual(await shownSuggestion(jobs, job), null);
  assert.equal(await sendShownSuggestion(jobs, 'app', 'S-1', second.sha256, read, send), 'said');
  assert.deepEqual(sent, [note]);
  assert.equal(await shownSuggestion(jobs, job), null);
  await refusedWith(sendShownSuggestion(jobs, 'app', 'S-1', second.sha256, read, send), 'no_suggestion');
  assert.equal(await removeSuggestion(jobs, 'app', 'S-1'), false);
  await storeSuggestion(jobs, 'app', 'S-1', note);
  assert.equal(await removeSuggestion(jobs, 'app', 'S-1'), true);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  // A stale note (the job no longer waits, or another iteration) is not sent.
  await storeSuggestion(jobs, 'app', 'S-1', note);
  await refusedWith(sendShownSuggestion(jobs, 'app', 'S-1', second.sha256, async () => ({ ...(await read()), state: 'working' }), send), 'no_suggestion');
  await refusedWith(sendShownSuggestion(jobs, 'app', 'S-1', second.sha256, async () => ({ ...(await read()), iteration: 2 }), send), 'no_suggestion');
  assert.deepEqual(sent, [note]);
  job = (await jobs.read('app', 'S-1'))!;
  assert.equal(job.state, 'needs_human');
});

test('what a Send is sending: planner-send.json while its say runs, gone after it (a failed one too); the runner\'s check refuses that note unless the job still waits at the iteration checked; store and Dismiss clear a leftover', async () => {
  const env = await newEnv('planner-sending');
  const jobs = new JobStore(env.state);
  await jobs.write(jobOf('S-3', 'needs_human', { iteration: 2 }));
  const read = async (): Promise<Job> => (await jobs.read('app', 'S-3'))!;
  const sending = join(jobs.dir('app', 'S-3'), SENDING_FILE);
  const note = 'Rename the button';
  const other = 'Something of my own';
  // No Send under way: every message passes.
  await checkSuggestionSend(jobs, { ...(await read()), state: 'working' }, note);
  const { sha256 } = await storeSuggestion(jobs, 'app', 'S-3', note);
  const seen: Array<[string, unknown]> = [];
  await sendShownSuggestion(jobs, 'app', 'S-3', sha256, read, async (text) => {
    seen.push([text, JSON.parse(await readFile(sending, 'utf8'))]);
    // The runner's check, as sayInRunner makes it: the note passes while the job waits at iteration 2 ...
    await checkSuggestionSend(jobs, await read(), text);
    // ... and not once another message moved the job on, nor at another iteration; another message passes.
    for (const job of [{ ...(await read()), state: 'working' as const }, { ...(await read()), iteration: 3 }]) {
      const message = await refusedWith(checkSuggestionSend(jobs, job, text), 'no_suggestion');
      assert.match(message, /no longer waits for you at the iteration the planner's suggestion was for; the suggestion was not sent\.$/);
      await checkSuggestionSend(jobs, job, other);
    }
    return 'said';
  });
  assert.deepEqual(seen, [[note, { sha256, iteration: 2 }]]);
  await assert.rejects(readFile(sending), { code: 'ENOENT' });
  // A say that is refused: the record goes, the suggestion stays.
  await storeSuggestion(jobs, 'app', 'S-3', note);
  await refusedWith(sendShownSuggestion(jobs, 'app', 'S-3', sha256, read, async () => {
    throw new FactoryError('no_suggestion', 'refused in the runner');
  }), 'no_suggestion');
  await assert.rejects(readFile(sending), { code: 'ENOENT' });
  assert.notEqual(await shownSuggestion(jobs, await read()), null);
  // A record an interrupted Send left: a store and a Dismiss remove it.
  for (const clear of [() => storeSuggestion(jobs, 'app', 'S-3', 'next'), () => removeSuggestion(jobs, 'app', 'S-3')]) {
    await writeFile(sending, JSON.stringify({ sha256, iteration: 2 }));
    await clear();
    await assert.rejects(readFile(sending), { code: 'ENOENT' });
  }
});

test('a Send is one step: a store or a Dismiss that comes while the note is being said waits for it, so the note said is the one checked; a replacement stored first is never sent', async () => {
  const env = await newEnv('planner-race');
  const jobs = new JobStore(env.state);
  await jobs.write(jobOf('S-2', 'needs_human', { iteration: 1 }));
  const read = async (): Promise<Job> => (await jobs.read('app', 'S-2'))!;
  const first = await storeSuggestion(jobs, 'app', 'S-2', 'first note');
  // say answers only when the test lets it: meanwhile the planner replaces the note and the user dismisses it.
  const said: string[] = [];
  let answer!: () => void;
  const sending = sendShownSuggestion(jobs, 'app', 'S-2', first.sha256, read, async (note) => {
    said.push(note);
    await new Promise<void>((resolve) => (answer = resolve));
    // The job takes the message: it no longer waits for the user.
    await jobs.write({ ...(await read()), state: 'working' });
    return 'said';
  });
  const order: string[] = [];
  const replacing = storeSuggestion(jobs, 'app', 'S-2', 'second note').then(() => order.push('stored'), (error: unknown) => order.push((error as FactoryError).code));
  const dismissing = removeSuggestion(jobs, 'app', 'S-2').then((removed) => order.push(`dismissed ${removed}`));
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Neither went while the note was being said: the file is still the first note's.
  assert.deepEqual([said, order], [['first note'], []]);
  assert.equal(JSON.parse(await readFile(join(jobs.dir('app', 'S-2'), SUGGESTION_FILE), 'utf8')).note, 'first note');
  answer();
  assert.equal(await sending, 'said');
  await Promise.all([replacing, dismissing]);
  // After the Send the job works: the planner's store is refused, and there is nothing to dismiss.
  assert.deepEqual(order, ['invalid_state', 'dismissed false']);
  assert.deepEqual(said, ['first note']);

  // A replacement that comes before the Send (its store ahead in the lock): the page's sha256 is the
  // old note's, nothing is said, and the new note stays.
  await jobs.write({ ...(await read()), state: 'needs_human' });
  const old = await storeSuggestion(jobs, 'app', 'S-2', 'old note');
  const replaced = storeSuggestion(jobs, 'app', 'S-2', 'new note');
  const refused = sendShownSuggestion(jobs, 'app', 'S-2', old.sha256, read, async (note) => {
    said.push(note);
    return 'said';
  });
  await replaced;
  await refusedWith(refused, 'suggestion_changed');
  assert.deepEqual(said, ['first note']);
  assert.equal((await shownSuggestion(jobs, await read()))?.note, 'new note');
});

// The MCP endpoint in process, on a temp state and config directory: the client and what
// onSuggested heard.
async function mcpWorld(name: string) {
  const env = await newEnv(name);
  const repo = await newRepo(env, `${name}-repo`, false);
  process.env.SF_CONFIG_DIR = env.config;
  process.env.SF_STATE_DIR = env.state;
  delete process.env.SF_WORKTREE_ROOT;
  await ensureMcpToken(env.state);
  const jobs = new JobStore(env.state);
  const suggested: string[] = [];
  const server = await startServer(0, env.state, { text: '# H\n', quickStart: '## Quick start\n', planSkill: undefined }, '0.0.0', { jobs }, undefined, undefined, undefined, undefined,
    (workspace, ticket) => suggested.push(`${workspace}/${ticket}`));
  const client = new Client({ name: 'sf-208', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl(server.port, (await readMcpToken(env.state))!))));
  const callTool = async (tool: string, args: Record<string, unknown>) => client.callTool({ name: tool, arguments: args });
  const ok = async (tool: string, args: Record<string, unknown>): Promise<Record<string, any>> => {
    const result = await callTool(tool, args);
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    return result.structuredContent as Record<string, any>;
  };
  const refused = async (tool: string, args: Record<string, unknown>): Promise<{ code: string; message: string }> => {
    const result = await callTool(tool, args);
    assert.equal(result.isError, true, `expected ${tool} to be refused`);
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  };
  const close = async (): Promise<void> => {
    await client.close();
    await server.close();
  };
  return { env, repo, jobs, suggested, ok, refused, callTool, listTools: () => client.listTools(), close };
}

test('read_job (MCP): the job\'s state, stop, Report and reviews with the worktree and checkout paths replaced; a long Report cut and flagged; no job and a bad iteration refused', async () => {
  const w = await mcpWorld('planner-read');
  try {
    const worktree = join(w.env.state, 'worktrees', 'app', 'R-1');
    assert.deepEqual(await w.refused('read_job', { workspace: 'app', ticket: 'R-1' }), { code: 'job_not_found', message: 'There is no job for app/R-1.' });
    assert.equal((await w.refused('read_job', { workspace: 'nope', ticket: 'R-1' })).code, 'workspace_not_found');
    // No iteration yet: shown_iteration 0, nothing to read; any iteration refused.
    await w.jobs.write(jobOf('R-1', 'working', { worktree }));
    assert.deepEqual(await w.ok('read_job', { workspace: 'app', ticket: 'R-1' }), {
      state: 'working', iteration: 0, shown_iteration: 0, stop: null, report: null, report_truncated: false, review: null, gate: null,
    });
    assert.equal((await w.refused('read_job', { workspace: 'app', ticket: 'R-1', iteration: 1 })).code, 'invalid_iteration');

    await w.jobs.write(jobOf('R-1', 'needs_human', { worktree, iteration: 2, error: { code: 'gate_rounds', message: `Stopped in ${worktree}/src.` } }));
    for (const number of [1, 2]) {
      await mkdir(w.jobs.iterationDir('app', 'R-1', number), { recursive: true });
    }
    await writeFile(join(w.jobs.iterationDir('app', 'R-1', 1), 'report.md'), `# Report 1\nin ${worktree}/a.ts and ${w.repo}/b.ts\n`);
    const long = `${worktree}/x\n${'é'.repeat(36 * 1024)}`;
    await writeFile(join(w.jobs.iterationDir('app', 'R-1', 2), 'report.md'), long);
    const item = { path: `${worktree}/a.ts`, problem: `Spec: ${w.repo} is read`, expected: 'e', severity: 'major' as const, reopens: '', caused_by: '' };
    await w.jobs.writeReview('app', 'R-1', 1, { reviewer: 'claude', verdict: 'fix', summary: `See ${worktree}.`, items: [item], accepted_sensitive: [], cost_usd: 1, started_at: T0, ended_at: T0 });
    await w.jobs.writeGate('app', 'R-1', 1, { reviewer: 'codex', error: `failed in ${worktree}`, tokens: { input: 0, cached_input: 0, output: 0 }, started_at: T0, ended_at: T0 });

    const last = await w.ok('read_job', { workspace: 'app', ticket: 'R-1' });
    assert.deepEqual([last.state, last.iteration, last.shown_iteration, last.stop, last.review, last.gate, last.report_truncated],
      ['needs_human', 2, 2, { code: 'gate_rounds', message: 'Stopped in <worktree>/src.' }, null, null, true]);
    assert.ok(last.report.startsWith('<worktree>/x\n'));
    assert.ok(Buffer.byteLength(last.report) <= MAX_REPORT_BYTES && Buffer.byteLength(last.report) > MAX_REPORT_BYTES - 2);
    assert.ok(!last.report.includes('�'));

    const first = await w.ok('read_job', { workspace: 'app', ticket: 'R-1', iteration: 1 });
    assert.deepEqual(first, {
      state: 'needs_human', iteration: 2, shown_iteration: 1, stop: { code: 'gate_rounds', message: 'Stopped in <worktree>/src.' },
      report: '# Report 1\nin <worktree>/a.ts and <checkout>/b.ts\n', report_truncated: false,
      review: { verdict: 'fix', summary: 'See <worktree>.', items: [{ path: '<worktree>/a.ts', problem: 'Spec: <checkout> is read', expected: 'e', severity: 'major' }] },
      gate: { error: 'failed in <worktree>' },
    });
    for (const iteration of [0, 3, -1]) {
      assert.equal((await w.refused('read_job', { workspace: 'app', ticket: 'R-1', iteration })).code, 'invalid_iteration', String(iteration));
    }
    // After Clean the record has no worktree: the path the factory gives it is still replaced; no stop outside needs_human.
    await w.jobs.write(jobOf('R-1', 'ready_for_human_review', { iteration: 2 }));
    const ready = await w.ok('read_job', { workspace: 'app', ticket: 'R-1', iteration: 1 });
    assert.deepEqual([ready.stop, ready.report], [null, '# Report 1\nin <worktree>/a.ts and <checkout>/b.ts\n']);
    // No answer of any call carries a real path.
    for (const answer of [last, first, ready]) {
      assert.ok(!JSON.stringify(answer).includes(w.env.state) && !JSON.stringify(answer).includes(w.repo));
    }
    assert.deepEqual(w.suggested, []);
  } finally {
    await w.close();
  }
});

test('suggest_changes (MCP): refused without a job, for working, paused and pushed, and for an empty or too long note; stored in each waiting state, the next replacing it; onSuggested once per store', async () => {
  const w = await mcpWorld('planner-suggest');
  try {
    assert.equal((await w.refused('suggest_changes', { workspace: 'app', ticket: 'G-1', note: 'n' })).code, 'job_not_found');
    for (const state of ['working', 'paused', 'pushed'] as const) {
      await w.jobs.write(jobOf('G-1', state, { iteration: 1 }));
      assert.deepEqual(await w.refused('suggest_changes', { workspace: 'app', ticket: 'G-1', note: 'n' }), {
        code: 'invalid_state', message: `The job is ${state}; suggest_changes needs a job that waits for the user: needs_human, ready_for_human_review or handed_over.`,
      });
    }
    const file = join(w.jobs.dir('app', 'G-1'), SUGGESTION_FILE);
    for (const state of ['needs_human', 'ready_for_human_review', 'handed_over'] as const) {
      await w.jobs.write(jobOf('G-1', state, { iteration: 1 }));
      const note = `Rename it (${state})`;
      assert.deepEqual(await w.ok('suggest_changes', { workspace: 'app', ticket: 'G-1', note }), { stored: true, sha256: noteSha256(note) });
      assert.equal(JSON.parse(await readFile(file, 'utf8')).note, note);
    }
    assert.deepEqual(w.suggested, ['app/G-1', 'app/G-1', 'app/G-1']);
    // Over 4000 characters, empty, blank or with NUL: refused with invalid_content, nothing stored, nobody told.
    for (const note of ['x'.repeat(4001), '', '   ', 'a\u0000b']) {
      assert.deepEqual(await w.refused('suggest_changes', { workspace: 'app', ticket: 'G-1', note }), {
        code: 'invalid_content', message: 'The note must be non-empty text of at most 4000 characters.',
      }, `${note.length} characters`);
    }
    assert.deepEqual([JSON.parse(await readFile(file, 'utf8')).note, w.suggested.length], ['Rename it (handed_over)', 3]);
    // The bound is in the published schema all the same.
    const listed = (await w.listTools()).tools.find((tool) => tool.name === 'suggest_changes')!;
    assert.deepEqual((listed.inputSchema.properties as Record<string, unknown>).note, { type: 'string', description: 'The note to the Implementer, 1-4000 characters.', maxLength: 4000 });
    // Exactly 4000 is taken.
    assert.deepEqual(await w.ok('suggest_changes', { workspace: 'app', ticket: 'G-1', note: 'y'.repeat(4000) }), { stored: true, sha256: noteSha256('y'.repeat(4000)) });
    assert.equal(JSON.parse(await readFile(file, 'utf8')).note, 'y'.repeat(4000));
    // One onSuggested per store: the three above and this one; none for a refusal.
    assert.equal(w.suggested.length, 4);
    // The job record is untouched: suggest_changes starts nothing.
    assert.equal((await w.jobs.read('app', 'G-1'))!.state, 'handed_over');
  } finally {
    await w.close();
  }
});

// These tests retire no job: a call would be a bug.
const NO_RETIREMENT: ExclusiveScope = { retireFinished: async () => assert.fail('no job is retired here') };

test('Setup: the planning chat link saved, replaced and removed in <ticket>.chat, with a live job too; a bad link and a missing Task file refused; tickets() and planningOf read it; deleteTicket removes it', async () => {
  const env = await newEnv('planner-chat');
  const repo = await newRepo(env, 'planner-chat-repo', false);
  const jobs = new JobStore(env.state);
  const setup = new Setup({ configDir: env.config, jobs, exclusive: (work) => work(NO_RETIREMENT), handoffDefault: 'off' });
  await putTask(env, repo, 'C-1', 'Chat');
  const file = join(env.state, 'requests', 'app', 'C-1.chat');
  assert.deepEqual(await setup.planningOf('app', 'C-1'), { owner: 'chatgpt', planning_chat: null });
  assert.equal((await setup.tickets())[0]!.planning_chat, null);

  assert.deepEqual(await setup.setPlanningChat('app', 'C-1', ' https://chatgpt.com/c/one '), { workspace: 'app', ticket: 'C-1', planning_chat: 'https://chatgpt.com/c/one' });
  assert.equal(await readFile(file, 'utf8'), 'https://chatgpt.com/c/one');
  assert.equal((await setup.tickets())[0]!.planning_chat, 'https://chatgpt.com/c/one');
  // A live job of the ticket: still allowed (the job's card shows the link).
  await jobs.write(jobOf('C-1', 'working'));
  assert.equal((await setup.setPlanningChat('app', 'C-1', 'https://chatgpt.com/g/g-p-x/c/two')).planning_chat, 'https://chatgpt.com/g/g-p-x/c/two');
  assert.deepEqual(await setup.planningOf('app', 'C-1'), { owner: 'chatgpt', planning_chat: 'https://chatgpt.com/g/g-p-x/c/two' });
  await refusedWith(setup.setPlanningChat('app', 'C-1', 'https://evil.chatgpt.com/c/x'), 'invalid_chat_link');
  await refusedWith(setup.setPlanningChat('app', 'C-9', 'https://chatgpt.com/c/x'), 'task_not_found');
  await refusedWith(setup.setPlanningChat('app', 'bad ticket', null), 'invalid_ticket');
  await refusedWith(setup.setPlanningChat('nope', 'C-1', null), 'workspace_not_found');
  assert.equal(await readFile(file, 'utf8'), 'https://chatgpt.com/g/g-p-x/c/two');
  // A stored value that is no longer a link reads as none.
  await writeFile(file, 'http://chatgpt.com/c/x');
  assert.equal((await setup.planningOf('app', 'C-1')).planning_chat, null);
  assert.deepEqual(await setup.setPlanningChat('app', 'C-1', null), { workspace: 'app', ticket: 'C-1', planning_chat: null });
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  // Removing what is not there is fine.
  assert.equal((await setup.setPlanningChat('app', 'C-1', null)).planning_chat, null);

  await rm(jobs.dir('app', 'C-1'), { recursive: true });
  // A Claude planner session link: saved trimmed, read back by tickets() and planningOf.
  assert.equal((await setup.setPlanningChat('app', 'C-1', ' https://claude.ai/code/session_01Ab ')).planning_chat, 'https://claude.ai/code/session_01Ab');
  assert.equal(await readFile(file, 'utf8'), 'https://claude.ai/code/session_01Ab');
  assert.equal((await setup.tickets())[0]!.planning_chat, 'https://claude.ai/code/session_01Ab');
  assert.deepEqual(await setup.planningOf('app', 'C-1'), { owner: 'chatgpt', planning_chat: 'https://claude.ai/code/session_01Ab' });
  await refusedWith(setup.setPlanningChat('app', 'C-1', 'https://claude.ai/code/x?y=1'), 'invalid_chat_link');
  assert.equal(await readFile(file, 'utf8'), 'https://claude.ai/code/session_01Ab');
  await setup.setPlanningChat('app', 'C-1', 'https://chatgpt.com/c/three');
  await setup.deleteTicket('app', 'C-1');
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});
