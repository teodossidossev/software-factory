// Tests of the findings checklist (src/findings-checklist.ts) on fixture state directories: which
// ledger entries feed it (current and archived jobs; contested, dropped, nit, old, closed by a
// clean verdict, the factory's own scope and sensitive entries left out), the distil with a fake
// model (invented ids, the counts the factory makes itself, at most 12 checks, generic texts
// only, the file's format), the cases that write nothing and keep the old file, the daily
// refresh's conditions and failures, the setting, and the commands' lines.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { COMMANDS, answerLines, usageLines } from '../src/commands.js';
import { type Config, findingsChecklistSetting, loadConfig } from '../src/config.js';
import { FactoryError } from '../src/errors.js';
import {
  checklistPath, type DistillOptions, type FindingsModel, type FindingsOutput, FindingsRefresh, distill, distillPrompt, isGeneric, isRealFinding, keptChecks, MAX_CHECKS,
  refreshDue, showChecklist, type SourceFinding, sourceFindings, startFindingsRefresh,
} from '../src/findings-checklist.js';
import { type Job, JobStore } from '../src/jobs.js';
import { type LedgerEntry, SCOPE_PROBLEM, SENSITIVE_PROBLEM } from '../src/ledger.js';

const DAY = 24 * 60 * 60_000;
const NOW = new Date();
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

async function stateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sf-findings-'));
}

function job(workspace: string, ticket: string, updated: string): Job {
  return {
    workspace, ticket, branch: `${ticket}-x`, base: 'main', base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
    mr_attempts: 0, mr_conflict_turn: false, state: 'pushed', iteration: 2, fixes: 0, gate_fixes: 0, gate_tokens: 0, session_id: null,
    created_at: updated, updated_at: updated, mr: null,
  } as Job;
}

function entry(id: string, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id, iteration: 1, reviewer: 'codex', severity: 'major', path: 'src/secret-place.ts', problem: `Problem ${id}.`, expected: `Expected ${id}.`, status: 'fixed',
    response: '', evidence: '', reopened: 0, asked: 1, caused_by: '', dispute: null, settled: null, ...extra,
  };
}

// A job directory (dir: its name, <ticket>.<stamp> when archived) with its ledger and, when
// ended is given, the meta.json of iteration 1 ending then.
async function jobDir(state: string, workspace: string, dir: string, ticket: string, ledger: LedgerEntry[], options: { ended?: string; updated?: string } = {}): Promise<void> {
  const path = join(state, 'jobs', workspace, dir);
  await mkdir(join(path, 'iterations', '001'), { recursive: true });
  await writeFile(join(path, 'job.json'), JSON.stringify(job(workspace, ticket, options.updated ?? ago(1))));
  await writeFile(join(path, 'ledger.json'), JSON.stringify(ledger));
  if (options.ended !== undefined) {
    await writeFile(join(path, 'iterations', '001', 'meta.json'), JSON.stringify({ iteration: 1, started_at: options.ended, ended_at: options.ended }));
  }
}

// count real findings of one time over the jobs J-1..J-<jobs> of workspace app, in blocks of
// ceil(count / jobs): the model reads them in job order, so E1.. are J-1's, then J-2's (12 over 3:
// E1-E4 J-1, E5-E8 J-2, E9-E12 J-3).
async function realFindings(state: string, count: number, jobs: number, ended = ago(2)): Promise<void> {
  const per = Math.ceil(count / jobs);
  for (let n = 1; n <= jobs; n += 1) {
    const ledger: LedgerEntry[] = [];
    for (let i = (n - 1) * per + 1; i <= Math.min(count, n * per); i += 1) {
      ledger.push(entry(`R${i}`, { problem: `Finding ${i} problem.`, expected: `Finding ${i} expected.` }));
    }
    await jobDir(state, 'app', `J-${n}`, `J-${n}`, ledger, { ended });
  }
}

const fakeModel = (output: FindingsOutput, calls: Array<{ prompt: string; model: string | undefined; cwd: string }> = []): FindingsModel => async (prompt, options) => {
  calls.push({ prompt, model: options.model, cwd: options.cwd });
  return { ok: true, output, costUsd: 0, model: 'fake', startedAt: NOW.toISOString(), endedAt: NOW.toISOString() };
};
const failingModel: FindingsModel = async () => ({ ok: false, message: 'The findings checklist ended with error_max_turns.', model: null, startedAt: '', endedAt: '' });

const options = (state: string, call: FindingsModel): DistillOptions => ({ stateDir: state, model: 'review-model', claudePath: undefined, call, now: () => NOW });

test('only real findings feed the checklist: fixed blocker and major entries of the Claude review and the Codex gate, of current and archived jobs, of the last 30 days', async () => {
  const state = await stateDir();
  await jobDir(state, 'app', 'A-1', 'A-1', [
    entry('R1', { problem: 'Real gate finding.' }),
    entry('R2', { reviewer: 'claude', severity: 'blocker', problem: 'Real review finding.' }),
    entry('R3', { status: 'contested' }),
    entry('R4', { status: 'left' }),
    entry('R5', { status: 'accepted_risk' }),
    entry('R6', { status: 'open' }),
    entry('R7', { severity: 'nit' }),
    entry('R8', { fixed_by_clean: 2 }),
    entry('R9', { problem: SCOPE_PROBLEM }),
    entry('R10', { problem: SENSITIVE_PROBLEM }),
    entry('R11', { reviewer: 'simplify' }),
    entry('R12', { reviewer: 'user', status: 'user_fix' }),
  ], { ended: ago(3) });
  // Archived: its directory is <ticket>.<stamp>; the entry's time is the job's last change (no meta.json).
  await jobDir(state, 'app', 'A-0.20261101T080000Z', 'A-0', [entry('R1', { problem: 'Archived finding.' })], { updated: ago(10) });
  // A-1's earlier job, archived at a restart: a job of its own.
  await jobDir(state, 'app', 'A-1.20261102T080000Z', 'A-1', [entry('R1', { problem: 'Earlier run finding.' })], { updated: ago(5) });
  // Old: its iteration ended 40 days ago.
  await jobDir(state, 'app', 'A-OLD', 'A-OLD', [entry('R1', { problem: 'Old finding.' })], { ended: ago(40) });
  // Another workspace's.
  await jobDir(state, 'other', 'O-1', 'O-1', [entry('R1', { problem: 'Other workspace finding.' })], { ended: ago(1) });
  // An unreadable ledger gives nothing.
  await mkdir(join(state, 'jobs', 'app', 'BAD'), { recursive: true });
  await writeFile(join(state, 'jobs', 'app', 'BAD', 'job.json'), JSON.stringify(job('app', 'BAD', ago(1))));
  await writeFile(join(state, 'jobs', 'app', 'BAD', 'ledger.json'), '{');

  const found = await sourceFindings(new JobStore(state), 'app', NOW);
  assert.deepEqual(found.map((finding) => [finding.job, finding.problem]), [
    // A finding's job is its job directory: a restarted ticket's archived and current jobs are two.
    ['A-0.20261101T080000Z', 'Archived finding.'],
    ['A-1.20261102T080000Z', 'Earlier run finding.'],
    ['A-1', 'Real gate finding.'],
    ['A-1', 'Real review finding.'],
  ]);
  const { checks } = keptChecks({ checks: [{ text: 'Test the new path.', entries: ['E2', 'E3', 'E4'] }] }, found);
  assert.deepEqual(checks, [{ text: 'Test the new path.', findings: 3, jobs: 2 }]);
  assert.deepEqual(Object.keys(found[0]!).sort(), ['at', 'expected', 'job', 'problem']);
  assert.equal(isRealFinding(entry('R1', { fixed_by_clean: 0 })), false);
});

test('the prompt gives the findings as E<n> with job keys J<m> and their two texts only, never their paths', () => {
  const findings: SourceFinding[] = [
    { job: 'X-1', problem: 'P one.', expected: 'E one.', at: ago(1) },
    { job: 'X-2', problem: 'P two.', expected: 'E two.', at: ago(1) },
    { job: 'X-1', problem: 'P   three\nlines.', expected: 'E three.', at: ago(1) },
  ];
  const prompt = distillPrompt(findings);
  assert.ok(prompt.includes('{"id":"E1","job":"J1","problem":"P one.","expected":"E one."}'));
  assert.ok(prompt.includes('{"id":"E2","job":"J2","problem":"P two.","expected":"E two."}'));
  assert.ok(prompt.includes('{"id":"E3","job":"J1","problem":"P three lines.","expected":"E three."}'));
  assert.ok(!prompt.includes('X-1'));
  assert.match(prompt, /no ticket ids, no file or directory paths/);
});

test('the factory keeps a check only with a generic text and 3 real cited findings from 2 jobs, counts them itself, the most first, at most 12', () => {
  const findings: SourceFinding[] = ['A', 'A', 'B', 'B', 'C', 'A'].map((job, index) => ({ job, problem: `p${index}`, expected: `e${index}`, at: ago(1) }));
  const output: FindingsOutput = {
    checks: [
      { text: 'Test every new error path.', entries: ['E1', 'E3', 'E4', 'E99', 'X'] },
      { text: '  Name   the  failure\n in the message. ', entries: ['E1', 'E2', 'E3', 'E4', 'E5'] },
      { text: 'Invented ids do not count.', entries: ['E1', 'E77', 'E88', 'E3'] },
      { text: 'One job is not enough.', entries: ['E1', 'E2', 'E6'] },
      { text: 'Repeated ids count once.', entries: ['E1', 'E1', 'E3', ' E3'] },
      { text: 'Check SF-318 again.', entries: ['E1', 'E3', 'E5'] },
      { text: 'Update src/cli.ts too.', entries: ['E1', 'E3', 'E5'] },
      { text: 'Keep cli.ts small.', entries: ['E1', 'E3', 'E5'] },
      { text: 'Call `readLedger` once.', entries: ['E1', 'E3', 'E5'] },
      { text: 'Use readLedger once.', entries: ['E1', 'E3', 'E5'] },
      { text: 'Read fixed_by_clean first.', entries: ['E1', 'E3', 'E5'] },
      { text: 'Never call load() twice.', entries: ['E1', 'E3', 'E5'] },
      { text: `${'Long '.repeat(50)}text.`, entries: ['E1', 'E3', 'E5'] },
    ],
  };
  const { checks, dropped } = keptChecks(output, findings);
  assert.deepEqual(checks, [
    { text: 'Name the failure in the message.', findings: 5, jobs: 3 },
    { text: 'Test every new error path.', findings: 3, jobs: 2 },
  ]);
  assert.equal(dropped, 11);

  const many: FindingsOutput = { checks: Array.from({ length: 15 }, (_, index) => ({ text: `Check number ${index + 1}.`, entries: index === 14 ? ['E1', 'E2', 'E3', 'E4'] : ['E1', 'E3', 'E5'] })) };
  const kept = keptChecks(many, findings);
  assert.equal(kept.checks.length, MAX_CHECKS);
  assert.equal(kept.checks[0]!.text, 'Check number 15.');
  assert.equal(kept.dropped, 3);
});

test('a generic text: no ticket id, path, file name or code', () => {
  for (const text of ['Test every new error path.', 'Say what the user sees when the request fails.', "Don't leave a timer running after close."]) {
    assert.equal(isGeneric(text), true, text);
  }
  for (const text of ['Check edge cases, e.g. empty input, i.e. nothing at all.', 'Name the error, the cause, etc. before the fix.',
    'Test the API error paths. Then check the UI in a narrow window.', 'Before the handover: Run every test once.', "Don't leave the user's timer running.",
    'Run the tests a 2nd time after the 1st fix, and keep under 10 steps.']) {
    assert.equal(isGeneric(text), true, text);
  }
  for (const text of [
    '', 'Fix ABC-123 first.', 'Fix SF318 first.', 'Fix sf318 first.', 'Fix Sf318 first.', 'Fix abc-123 first.', 'Fix 318sf first.', 'Upgrade to utf8 first.', 'See docs/guide.', 'Edit config.json.', 'Load the ontology.ttl fixture.', 'Never commit .env files.', 'Use a && b; then.', 'x => y',
    'Run `npm test`.', 'Set maxTurns.', 'Read it through JobStore.', 'Use SF_REVIEW_MODEL.', 'Call it()', 'Use job.ticket.',
    'Check Makefile before handing over.', 'Makefile targets must pass.', 'Set the "strict" flag.', "Set the 'strict' flag.",
    'Run the Cypress specs serially.', 'Update the Turtle fixtures.',
    // Symbols that are not plain text's.
    'Keep the list [0] safe.', 'Use a * b.', 'Pass -f to force it.', 'Check !done first.', 'Use 0x1F as the mask.', 'Cover 50% of the cases.', 'Use a & b.', 'Mention @owner.',
  ]) {
    assert.equal(isGeneric(text), false, text);
  }
});

test('code is told by its shape, not by its words: ordinary English words such as if and class pass, an identifier with a call does not', () => {
  for (const text of ['If the request fails, add a test.', 'Check that every class has a label.']) {
    assert.equal(isGeneric(text), true, text);
  }
  assert.equal(isGeneric('call fooBar() first'), false);
});

test('identifier shapes are told with Unicode letters too, while accented plain words pass', () => {
  for (const text of ['Check that every résumé has a date.', 'Keep the café menu in sync with the API.', 'Name every état of the form.']) {
    assert.equal(isGeneric(text), true, text);
  }
  for (const text of [
    'call résuméValeur first', 'use foo_βar carefully', 'call résuméÉtat first', 'read it through ÉtatStore', 'call éditer() first', 'Fix ÄBC-12 first.', 'Open ÜBER7 first.',
    'XMLParser reads the input.', 'Read the Ölçü value.',
  ]) {
    assert.equal(isGeneric(text), false, text);
  }
});

test('sf findings distill writes the checklist from the kept checks: the generated line, then one line per check with its count, 0600', async () => {
  const state = await stateDir();
  await realFindings(state, 12, 3);
  const calls: Array<{ prompt: string; model: string | undefined; cwd: string }> = [];
  const output: FindingsOutput = {
    checks: [
      { text: 'Cover each new branch with a test.', entries: ['E3', 'E4', 'E5', 'E6'] },
      { text: 'Name the case in the error message.', entries: ['E5', 'E6', 'E7', 'E8', 'E9', 'E404'] },
      { text: 'Only one job.', entries: ['E1', 'E2', 'E4'] },
    ],
  };
  const result = await distill('app', options(state, fakeModel(output, calls)));
  const path = checklistPath(state, 'app');
  assert.deepEqual(result, { workspace: 'app', path, written: true, findings: 12, jobs: 3, checks: 2, dropped: 1, existing: false });
  assert.equal(await readFile(path, 'utf8'), [
    `<!-- generated ${NOW.toISOString().slice(0, 10)} from 12 findings in 3 jobs -->`,
    '- Name the case in the error message. (5)',
    '- Cover each new branch with a test. (4)',
    '',
  ].join('\n'));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, 'review-model');
  assert.equal(calls[0]!.cwd, join(state, 'findings', 'session'));
  assert.ok(!calls[0]!.prompt.includes('secret-place'));
  const shown = await showChecklist(state, 'app');
  assert.equal(shown.age_days, 0);
  assert.deepEqual(answerLines(COMMANDS.findingsShow, shown as never, {}).lines.slice(-1), [`${path} (written today)`]);
  assert.match(answerLines(COMMANDS.findingsDistill, result as never, {}).lines[0]!, /^Wrote the findings checklist of app: 2 checks from 12 findings in 3 jobs/);
});

test('under 10 findings, or no surviving check, or a failed model call: no file written and the old file kept', async () => {
  const state = await stateDir();
  const path = checklistPath(state, 'app');
  await mkdir(join(state, 'findings'), { recursive: true });
  await writeFile(path, 'old checklist\n');

  await realFindings(state, 9, 3);
  const calls: Array<{ prompt: string; model: string | undefined; cwd: string }> = [];
  const few = await distill('app', options(state, fakeModel({ checks: [] }, calls)));
  assert.equal(few.written, false);
  assert.equal(few.reason, 'too_few_findings');
  assert.equal(few.existing, true);
  assert.equal(calls.length, 0);
  assert.match(answerLines(COMMANDS.findingsDistill, few as never, {}).lines.join('\n'), /only 9 findings in 3 jobs of the last 30 days; it takes 10\.\nThe checklist from before is kept/);

  await realFindings(state, 10, 3);
  const none = await distill('app', options(state, fakeModel({ checks: [{ text: 'Too thin.', entries: ['E1', 'E2'] }, { text: 'Path in src/x.ts.', entries: ['E1', 'E2', 'E3'] }] })));
  assert.equal(none.written, false);
  assert.equal(none.reason, 'no_check');
  assert.equal(none.dropped, 2);

  await assert.rejects(distill('app', options(state, failingModel)), (error: unknown) => error instanceof FactoryError && error.code === 'findings_failed' && /error_max_turns/.test(error.message));
  assert.equal(await readFile(path, 'utf8'), 'old checklist\n');

  const empty = await stateDir();
  const nothing = await distill('app', options(empty, fakeModel({ checks: [] })));
  assert.equal(nothing.existing, false);
  assert.match(answerLines(COMMANDS.findingsDistill, nothing as never, {}).lines.join('\n'), /It has no checklist\./);
  const shown = await showChecklist(empty, 'app');
  assert.equal(shown.text, null);
  assert.deepEqual(answerLines(COMMANDS.findingsShow, shown as never, {}).lines, ['app has no findings checklist (sf findings distill app makes one).']);
});

test('the refresh distils when the file is missing or older than 7 days and at least 10 findings are newer than it', async () => {
  const state = await stateDir();
  await realFindings(state, 9, 3);
  assert.equal(await refreshDue(state, 'app', NOW), false, 'missing, 9 findings');
  await realFindings(state, 10, 3, ago(5));
  assert.equal(await refreshDue(state, 'app', NOW), true, 'missing, 10 findings');

  const path = checklistPath(state, 'app');
  await mkdir(join(state, 'findings'), { recursive: true });
  await writeFile(path, 'old checklist\n');
  const fileAt = (days: number): Promise<void> => utimes(path, new Date(ago(days)), new Date(ago(days)));
  await fileAt(6);
  assert.equal(await refreshDue(state, 'app', NOW), false, 'six days old');
  await fileAt(8);
  assert.equal(await refreshDue(state, 'app', NOW), true, 'eight days old, 10 findings newer');
  await realFindings(state, 10, 3, ago(9));
  assert.equal(await refreshDue(state, 'app', NOW), false, 'eight days old, the findings are older');
});

test('a refresh pass distils the due workspaces only, and a failed distil keeps the old file and logs the error', async () => {
  const state = await stateDir();
  await realFindings(state, 10, 3);
  const path = checklistPath(state, 'app');
  await mkdir(join(state, 'findings'), { recursive: true });
  await writeFile(path, 'old checklist\n');
  await utimes(path, new Date(ago(8)), new Date(ago(8)));

  const errors: string[] = [];
  const distilled: string[] = [];
  const failing = new FindingsRefresh({
    stateDir: state, workspaces: async () => ['app', 'quiet'], now: () => NOW, log: () => undefined, error: (line) => errors.push(line),
    distill: (workspace) => {
      distilled.push(workspace);
      return distill(workspace, options(state, failingModel));
    },
  });
  await failing.pass();
  assert.deepEqual(distilled, ['app']);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /^findings refresh: The findings checklist of app could not be distilled/);
  assert.equal(await readFile(path, 'utf8'), 'old checklist\n');

  const logs: string[] = [];
  const working = new FindingsRefresh({
    stateDir: state, workspaces: async () => ['app'], now: () => NOW, log: (line) => logs.push(line), error: (line) => errors.push(line),
    distill: (workspace) => distill(workspace, options(state, fakeModel({ checks: [{ text: 'Test the new path.', entries: ['E3', 'E4', 'E5'] }] }))),
  });
  await working.pass();
  assert.deepEqual(logs, ['findings checklist of app: 1 checks from 10 findings']);
  assert.match(await readFile(path, 'utf8'), /^<!-- generated .* from 10 findings in 3 jobs -->\n- Test the new path\. \(3\)\n$/);
  // Fresh now: the next pass leaves it.
  await working.pass();
  assert.equal(logs.length, 1);
});

test('SF_FINDINGS_CHECKLIST: on by default, off turns the refresh off, anything else is refused', () => {
  assert.equal(findingsChecklistSetting({}), true);
  assert.equal(findingsChecklistSetting({ SF_FINDINGS_CHECKLIST: 'on' }), true);
  assert.equal(findingsChecklistSetting({ SF_FINDINGS_CHECKLIST: 'off' }), false);
  assert.throws(() => findingsChecklistSetting({ SF_FINDINGS_CHECKLIST: 'yes' }), /SF_FINDINGS_CHECKLIST must be on or off/);
  assert.equal(loadConfig({ SF_STATE_DIR: '/tmp/sf-state', SF_GATE: 'off', SF_FINDINGS_CHECKLIST: 'off' }).findingsChecklist, false);
  const refresh = startFindingsRefresh({ stateDir: '/nonexistent', findingsChecklist: false } as Config);
  assert.equal(refresh, undefined);
});

test('sf findings distill and show are in the help', () => {
  const help = usageLines().join('\n');
  assert.match(help, /sf findings distill <workspace> +Distil the workspace's findings checklist now/);
  assert.match(help, /sf findings show <workspace> +Print the workspace's findings checklist and its age/);
});
