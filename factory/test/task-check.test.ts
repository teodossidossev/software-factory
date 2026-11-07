// The Task check (SF-054): the schema (paraphrase first) and the verdict rule, the scope
// comparison, the prompt (the Task file and nothing of the Context owner or the jobs), the read-only
// session and what it may not read (the path guard of Read, Grep and Glob, end to end through the
// SDK's PreToolUse hook, which lets the SDK's StructuredOutput answer through), the storage by sha
// and the stale mark, the Start note; then end to end with the fake Claude: sf check-task, a failed
// check, the dashboard's Check, its endpoint and the tickets' summary, and the Context owner's
// task_check tool.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { addAttachment } from '../src/attachments.js';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { type Job, JobStore } from '../src/jobs.js';
import { readOnlySessionOptions, REVIEW_DENIED_TOOLS } from '../src/review.js';
import {
  CHECK_SCHEMA, type CheckFinding, type CheckOutput, type CheckRecord, CheckStore, TaskChecks, checkDeniedRules, checkLines, checkOutput, checkPrompt, checkSummary,
  checkVerdict, cutOutsideLinks, guardReason, OUTSIDE_LINK_NOTE, scopeFindings, settleCheck, startNote, taskCheckSha256, taskSha256,
} from '../src/task-check.js';
import { writeTask } from '../src/task-file.js';
import { act, fetchRaw } from './support/dashboard-client.js';
import { assertPathDenials, type Env, git, holdOpen, newEnv, newRepo, probeLog, putRules, reviewLog, reviewScript, runCli, serve, stop, temp } from './support/harness.js';

const finding = (severity: CheckFinding['severity'], kind: CheckFinding['kind'] = 'decision', where = '## Behaviour'): CheckFinding =>
  ({ kind, severity, where, problem: `A ${severity} problem.`, expected: 'Say which.' });

const OUTPUT: CheckOutput = {
  paraphrase: 'The Task greets the reader in the README. It changes one line. It is accepted when the README says hello reader.',
  findings: [
    finding('nit', 'unclear', '## Title'),
    { kind: 'contradiction', severity: 'major', where: 'README.md:1', problem: 'The Task says the README is empty; it says hello.', expected: 'Describe the README as it is.' },
    finding('major', 'decision'),
  ],
  files: [{ path: 'README.md', action: 'modify' }],
  verdict: 'ready',
};

function taskText(ticket: string, extra = '', body = 'Greet the reader in README.md.'): string {
  return `---\nticket: ${ticket}\ntitle: Greet the reader\nbase: main\n${extra}---\n\n# ${ticket}: Greet the reader\n\n${body}\n`;
}

function record(sha256: string, endedAt: string, output: CheckOutput | null = settleCheck('', OUTPUT)): CheckRecord {
  return {
    workspace: 'app', ticket: 'C-1', sha256, commit: 'c'.repeat(40), status: output === null ? 'failed' : 'checked', output, error: output === null ? 'The check ended with error_max_turns: limit' : null,
    model: 'fake-model', cost_usd: 0.01, started_at: endedAt, ended_at: endedAt,
  };
}

test('the schema: the paraphrase comes first, then findings, files and the verdict; draft-07 without $schema; the kinds and severities', () => {
  assert.equal(CHECK_SCHEMA.$schema, undefined);
  const properties = CHECK_SCHEMA.properties as Record<string, { items?: { properties?: Record<string, { enum?: string[] }> } }>;
  assert.deepEqual(Object.keys(properties), ['paraphrase', 'findings', 'files', 'verdict']);
  assert.deepEqual(CHECK_SCHEMA.required, ['paraphrase', 'findings', 'files', 'verdict']);
  const item = properties.findings!.items!.properties!;
  assert.deepEqual(Object.keys(item), ['kind', 'severity', 'where', 'problem', 'expected']);
  assert.deepEqual(item.kind!.enum, ['decision', 'contradiction', 'missing', 'overreach', 'unclear']);
  assert.deepEqual(item.severity!.enum, ['blocker', 'major', 'nit']);
  assert.deepEqual(properties.files!.items!.properties!.action!.enum, ['create', 'modify', 'delete']);
  assert.ok(checkOutput.safeParse(OUTPUT).success);
  // An empty paraphrase, an unknown kind and an extra key are refused.
  assert.ok(!checkOutput.safeParse({ ...OUTPUT, paraphrase: '' }).success);
  assert.ok(!checkOutput.safeParse({ ...OUTPUT, findings: [{ ...finding('nit'), kind: 'style' }] }).success);
  assert.ok(!checkOutput.safeParse({ ...OUTPUT, conversation: 'x' }).success);
});

test('the verdict rule: ready without a blocker or major, whatever the checker wrote; a contradiction is always a blocker', () => {
  assert.equal(checkVerdict([]), 'ready');
  assert.equal(checkVerdict([finding('nit'), finding('nit', 'overreach')]), 'ready');
  assert.equal(checkVerdict([finding('nit'), finding('major')]), 'not_ready');
  assert.equal(checkVerdict([finding('blocker')]), 'not_ready');
  // The checker wrote ready with a major and a contradiction it called a nit.
  const settled = settleCheck(taskText('C-1'), { ...OUTPUT, findings: [{ ...OUTPUT.findings[1]!, severity: 'nit' }], verdict: 'ready' });
  assert.deepEqual([settled.verdict, settled.findings[0]!.severity], ['not_ready', 'blocker']);
  // not_ready with nits only is ready.
  assert.equal(settleCheck(taskText('C-1'), { ...OUTPUT, findings: [finding('nit')], verdict: 'not_ready' }).verdict, 'ready');
  // The paraphrase stays first.
  assert.deepEqual(Object.keys(settled), ['paraphrase', 'findings', 'files', 'verdict']);
});

test('the files against scope: an expected file outside it is missing (major), a scope entry no file needs is overreach (nit), once each', () => {
  const task = taskText('C-1', 'scope: [README.md, docs/**, src/old.ts]\nmay_touch: [package.json]\n');
  const files: CheckOutput['files'] = [
    { path: 'README.md', action: 'modify' }, { path: 'docs/a.md', action: 'create' }, { path: 'package.json', action: 'modify' }, { path: 'src/new.ts', action: 'create' },
  ];
  const found = scopeFindings(task, files);
  assert.deepEqual(found.map((item) => [item.kind, item.severity, item.where]), [['missing', 'major', 'scope:'], ['overreach', 'nit', 'scope:']]);
  assert.match(found[0]!.problem, /src\/new\.ts \(create\)/);
  assert.match(found[1]!.problem, /src\/old\.ts/);
  // The checker named them already: not repeated.
  assert.deepEqual(scopeFindings(task, files, [{ ...finding('major', 'missing'), problem: 'src/new.ts is needed' }, { ...finding('nit', 'overreach'), where: 'scope: src/old.ts' }]), []);
  // No scope: nothing compared.
  assert.deepEqual(scopeFindings(taskText('C-1'), files), []);
  assert.equal(settleCheck(task, { ...OUTPUT, findings: [], files }).verdict, 'not_ready');
});

test('the prompt holds the instructions and the Task file, nothing else', () => {
  const task = taskText('C-1', '', 'Greet the reader.\n\n## Fix 1\n\nReview by Claude: x');
  const prompt = checkPrompt('C-1', task);
  assert.ok(prompt.endsWith(`<task_file path=".software-factory/C-1.md">\n${task.trimEnd()}\n</task_file>`));
  assert.equal(prompt.split('<task_file').length, 2);
  for (const word of ['paraphrase', 'Zero-Decision Rule', 'contradiction', 'path:line', 'overreach', 'scope:', 'not_ready']) {
    assert.ok(prompt.includes(word), word);
  }
  // The paraphrase is asked first.
  assert.ok(prompt.indexOf('write paraphrase') < prompt.indexOf('Readiness, the Zero-Decision Rule'));
  for (const absent of ['<report>', '<patch>', '<settled_findings>', 'ledger', 'conversation', 'ChatGPT', '<rules>']) {
    assert.ok(!prompt.includes(absent), absent);
  }
  // SF-059: the coding rules, when there are some, right before the Task file; none: as before.
  assert.equal(checkPrompt('C-1', task, ''), prompt);
  const withRules = checkPrompt('C-1', task, '<rules>\nR\n</rules>');
  assert.equal(withRules, prompt.replace('\n<task_file', '\n<rules>\nR\n</rules>\n\n<task_file'));
});

test('the session is the review\'s, read-only, and may not read the .software-factory folder, the state or the config', () => {
  const deny = checkDeniedRules('/srv/app', '/home/u/.local/state/software-factory', '/home/u/.config/software-factory');
  assert.deepEqual(deny, ['Read(//srv/app/.software-factory/**)', 'Read(//home/u/.local/state/software-factory/**)', 'Read(//home/u/.config/software-factory/**)']);
  assert.deepEqual(checkDeniedRules('/srv/a (b)', '/s', '/c')[0], 'Read(//srv/a \\(b\\)/.software-factory/**)');
  const options = readOnlySessionOptions({ cwd: '/srv/app', claudePath: undefined, sandbox: undefined, model: undefined, maxTurns: 30 }, new AbortController(), CHECK_SCHEMA, deny);
  assert.deepEqual(options.tools, ['Read', 'Grep', 'Glob']);
  assert.deepEqual(options.disallowedTools, [...REVIEW_DENIED_TOOLS, ...deny]);
  assert.deepEqual(options.settingSources, ['project']);
  assert.deepEqual(options.outputFormat, { type: 'json_schema', schema: CHECK_SCHEMA });
  assert.equal(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
});

test('one check per ticket: a second start while the first is still being set up is check_running, and the reservation goes when the setup fails', async () => {
  let release!: (workspace: { name: string; readCheckout: string; workCheckout: string }) => void;
  const gate = new Promise<{ name: string; readCheckout: string; workCheckout: string }>((resolve) => (release = resolve));
  const repo = join(temp, 'concurrent-start');
  await mkdir(join(repo, '.software-factory'), { recursive: true });
  await writeFile(join(repo, '.software-factory', 'C-9.md'), '---\nticket: C-9\ntitle: Draft\nbase: main\n---\n\n## Status: waiting for the Context owner\n');
  const checks = new TaskChecks({
    resolve: () => gate, claudePath: undefined, sandbox: undefined, model: undefined, maxTurns: 1, rulesMaxBytes: 49152,
    stateDir: join(temp, 'concurrent-state'), configDir: join(temp, 'concurrent-config'), worktreeRoot: join(temp, 'concurrent-worktrees'),
  });
  const first = checks.start('app', 'C-9');
  const second = checks.start('app', 'C-9');
  await assert.rejects(second, (error: { code?: string }) => error.code === 'check_running');
  assert.equal(checks.isRunning('app', 'C-9'), true);
  release({ name: 'app', readCheckout: repo, workCheckout: repo });
  await assert.rejects(first, (error: { code?: string }) => error.code === 'task_draft');
  assert.equal(checks.isRunning('app', 'C-9'), false);
  await assert.rejects(checks.start('app', 'C-9'), (error: { code?: string }) => error.code === 'task_draft');
});

test('storage by the Task file\'s sha256: the file name, the last check, stale against the current Task file, and the Start note', async () => {
  const store = new CheckStore(join(temp, 'check-store'));
  const one = taskSha256(taskText('C-1'));
  const two = taskSha256(taskText('C-1', '', 'Greet the reader twice.'));
  assert.equal(store.path('app', 'C-1', one), join(temp, 'check-store', 'checks', 'app', 'C-1', `${one.slice(0, 16)}.json`));
  await store.write(record(one, '2026-11-05T10:00:00.000Z'));
  await store.write(record(two, '2026-11-05T11:00:00.000Z', null));
  assert.deepEqual(await readdir(join(temp, 'check-store', 'checks', 'app', 'C-1')), [`${one.slice(0, 16)}.json`, `${two.slice(0, 16)}.json`].sort());
  assert.equal((await store.read('app', 'C-1', one))?.status, 'checked');
  assert.equal(await store.read('app', 'C-1', taskSha256('other')), undefined);
  assert.equal((await store.last('app', 'C-1'))?.sha256, two);
  assert.equal(await store.last('app', 'C-9'), undefined);

  // The summary and its note: not checked, stale, failed, not ready, ready.
  assert.deepEqual(checkSummary(undefined, one), { state: 'none', check_reason: null, stale: false, running: false, blockers: 0, majors: 0, nits: 0, ended_at: null, start_note: 'not checked' });
  const ok = record(one, '2026-11-05T10:00:00.000Z');
  assert.equal(checkSummary(ok, two).start_note, 'stale');
  assert.equal(checkSummary(ok, undefined).stale, true);
  assert.deepEqual(checkSummary(ok, one), { state: 'not_ready', check_reason: null, stale: false, running: false, blockers: 1, majors: 1, nits: 1, ended_at: ok.ended_at, start_note: 'not ready: 1 blocker, 1 major' });
  assert.equal(checkSummary(record(two, 'x', null), two).start_note, 'check failed');
  assert.equal(checkSummary(record(one, 'x', settleCheck('', { ...OUTPUT, findings: [finding('nit')] })), one).start_note, null);
  assert.equal(startNote({ state: 'ready', stale: true, blockers: 0, majors: 0 }), 'stale');
});

test('CheckStore.records (SF-130): every stored check of the ticket, all versions, failed ones included, in the order they ended', async () => {
  const store = new CheckStore(join(temp, 'check-records'));
  const one = taskSha256(taskText('C-1'));
  const two = taskSha256(taskText('C-1', '', 'Twice.'));
  const three = taskSha256(taskText('C-1', '', 'Thrice.'));
  await store.write(record(two, '2026-11-05T11:00:00.000Z', null));
  await store.write(record(one, '2026-11-05T10:00:00.000Z'));
  await store.write(record(three, '2026-11-05T12:00:00.000Z'));
  // A file that cannot be read is left out.
  await writeFile(join(temp, 'check-records', 'checks', 'app', 'C-1', `${'f'.repeat(16)}.json`), 'not json');
  assert.deepEqual((await store.records('app', 'C-1')).map((item) => [item.sha256, item.status]), [[one, 'checked'], [two, 'failed'], [three, 'checked']]);
  assert.deepEqual(await store.records('app', 'C-9'), []);
});

test('TaskChecks.summary (SF-130): a Task that needs no check and has none of its current version is not_needed with the reason and no Start note; a record of it counts', async () => {
  const repo = join(temp, 'summary-not-needed');
  await mkdir(join(repo, '.software-factory'), { recursive: true });
  const small = taskText('C-1', 'scope: [README.md]\n');
  await writeFile(join(repo, '.software-factory', 'C-1.md'), small);
  await writeFile(join(repo, '.software-factory', 'C-2.md'), taskText('C-2'));
  const checks = new TaskChecks({
    resolve: async () => ({ name: 'app', readCheckout: repo, workCheckout: repo }), claudePath: undefined, sandbox: undefined, model: undefined, maxTurns: 1, rulesMaxBytes: 49152,
    stateDir: join(repo, 'state'), configDir: join(repo, 'config'), worktreeRoot: join(repo, 'worktrees'),
  });
  const words = small.split(/\s+/).filter((word) => word !== '').length;
  assert.deepEqual(await checks.summary('app', 'C-1'), {
    state: 'not_needed', check_reason: `small: 1 scope entries, ${words} words`, stale: false, running: false, blockers: 0, majors: 0, nits: 0, ended_at: null, start_note: null,
  });
  assert.equal((await checks.view('app', 'C-1')).check_reason, `small: 1 scope entries, ${words} words`);
  // A large one (no scope) is not checked.
  assert.deepEqual([(await checks.summary('app', 'C-2')).state, (await checks.summary('app', 'C-2')).start_note], ['none', 'not checked']);
  // A stale record of an earlier version: still not needed.
  await checks.store.write(record(taskSha256('earlier'), '2026-11-05T10:00:00.000Z'));
  assert.equal((await checks.summary('app', 'C-1')).state, 'not_needed');
  // A manual Check's record of the current version counts as today.
  await checks.store.write(record(taskSha256(small), '2026-11-05T11:00:00.000Z'));
  assert.deepEqual([(await checks.summary('app', 'C-1')).state, (await checks.summary('app', 'C-1')).check_reason], ['not_ready', null]);
});

// A workspace with a Task file; the check's record directory.
async function checkEnv(name: string, ticket: string, content: string): Promise<{ env: Env; repo: string }> {
  const env = await newEnv(name, { SF_REVIEW_MODEL: 'fake-checker', SF_TASK_CHECK_MAX_TURNS: '9' });
  const repo = await newRepo(env, `${name}-repo`, false);
  await writeTask({ name: 'app', readCheckout: repo, workCheckout: repo }, ticket, content, new JobStore(env.state));
  return { env, repo };
}

const option = (argv: string[], name: string): string | undefined => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

test('the guard: Read, Grep and Glob stay inside the check\'s worktree, symlinks resolved; no other tool, no climbing pattern', async () => {
  const root = await realpath(join(temp));
  const repo = join(root, 'guard-root');
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'a.ts'), 'x');
  await mkdir(join(root, 'guard-outside'), { recursive: true });
  await symlink(join(root, 'guard-outside'), join(repo, 'out'));
  const allowed = [
    ['Read', { file_path: 'src/a.ts' }], ['Read', { file_path: join(repo, 'src', 'a.ts') }], ['Read', { file_path: 'src/new.ts' }],
    ['Grep', { pattern: 'secret' }], ['Grep', { pattern: 'x', path: 'src', glob: '*.ts' }], ['Glob', { pattern: '**/*.md' }],
    ['Glob', { pattern: 'src/**/*.ts', path: repo }], ['Glob', { pattern: `${repo}/src/*.ts` }],
    // Brace alternatives, each inside: still usable.
    ['Glob', { pattern: '**/*.{ts,md}' }], ['Glob', { pattern: '{src,test}/**/*.ts' }], ['Glob', { pattern: `{${repo}/src/*.ts,README.md}` }],
    ['Glob', { pattern: 'src/{a,{b,c}}.ts' }], ['Grep', { pattern: 'x', glob: '*.{ts,js}' }],
  ] as const;
  for (const [tool, input] of allowed) {
    assert.equal(await guardReason(repo, tool, input), undefined, `${tool} ${JSON.stringify(input)}`);
  }
  const refused = [
    ['Read', { file_path: '/etc/passwd' }], ['Read', { file_path: '../guard-outside/x' }], ['Read', { file_path: 'out/x' }], ['Read', {}],
    ['Read', { file_path: '.software-factory/C-1.md' }], ['Grep', { pattern: 'secret', path: '/' }], ['Grep', { pattern: 'x', path: 'out' }],
    ['Grep', { pattern: 'x', glob: '../**' }], ['Grep', { pattern: 'x', path: '.software-factory' }], ['Glob', { pattern: '**', path: root }],
    ['Glob', { pattern: '../**/*.md' }], ['Glob', { pattern: `${root}/**/*.md` }], ['Glob', { pattern: '/**' }], ['Glob', { pattern: 'out/**' }],
    ['Bash', { command: 'cat /etc/passwd' }], ['Write', { file_path: 'a' }], ['Read', 'not an object'],
    // Values Claude Code trims or expands, and a path under another key, are refused too.
    ['Grep', { pattern: 'x', path: '~' }], ['Grep', { pattern: 'x', path: '~/.claude' }], ['Glob', { pattern: '**', path: ' /' }],
    ['Glob', { pattern: '~/**' }], ['Read', { file_path: '~root/x' }], ['Grep', { pattern: 'x', path: 'src ' }], ['Grep', { pattern: 'x', file_path: '/' }],
    ['Glob', { pattern: '*', notebook_path: '/etc' }], ['Grep', { pattern: 'x', path: 7 }],
    // A brace alternative outside, at any depth, or one the guard cannot expand, refuses the call.
    ['Glob', { pattern: `{${root}/guard-outside/**,README.md}` }], ['Glob', { pattern: '{/etc/*,*.md}' }], ['Glob', { pattern: '{a,{b,/etc/c}}' }],
    ['Glob', { pattern: '{..,src}/**' }], ['Glob', { pattern: '{~/x,a}' }], ['Glob', { pattern: '{src,out}/**' }], ['Glob', { pattern: '{src/**' }],
    ['Glob', { pattern: 'src}/**' }], ['Glob', { pattern: '\\{/etc,a}' }], ['Glob', { pattern: `{${'a,'.repeat(70)}b}` }],
    ['Grep', { pattern: 'x', glob: '{/etc/*,*.ts}' }], ['Grep', { pattern: 'x', glob: '{../*,*.ts}' }],
    // Patterns too long or with too many brace groups to expand safely (they overflowed the stack).
    ['Glob', { pattern: `/etc/*${'{,}'.repeat(7000)}` }], ['Grep', { pattern: 'x', path: '/', glob: `*${'{,}'.repeat(7000)}` }],
    ['Glob', { pattern: `*${'{a}'.repeat(17)}` }], ['Glob', { pattern: `src/${'a'.repeat(5000)}` }], ['Read', { file_path: `src/${'a'.repeat(5000)}` }],
    ['Glob', { pattern: '@(/etc/*|*.md)' }], ['Glob', { pattern: '!(src)/**' }], ['Glob', { pattern: '+(a|b)' }], ['Grep', { pattern: 'x', glob: '*(a|/etc)' }],
  ] as const;
  for (const [tool, input] of refused) {
    assert.match(await guardReason(repo, tool, input) ?? 'allowed', /^The Task check /, `${tool} ${JSON.stringify(input)}`);
  }
});

test('the guard lets the SDK\'s StructuredOutput through, by its exact name only; any other tool keeps its rules', async () => {
  const root = await realpath(temp);
  const repo = join(root, 'guard-answer');
  await mkdir(repo, { recursive: true });
  // The answer, whatever it holds: it is not a file access.
  for (const input of [OUTPUT, {}, { paraphrase: 'x', file_path: '/etc/passwd', path: '~', pattern: '../**' }, 'not an object', null]) {
    assert.equal(await guardReason(repo, 'StructuredOutput', input), undefined, JSON.stringify(input));
  }
  // Names like it are other tools, refused.
  for (const tool of ['structuredoutput', 'StructuredOutput ', ' StructuredOutput', 'StructuredOutputs', 'StructuredOutput*', 'mcp__x__StructuredOutput', 'Structured', 'Frobnicate']) {
    assert.match(await guardReason(repo, tool, OUTPUT) ?? 'allowed', /^The Task check reads the repository with Read, Grep and Glob only/, tool);
  }
  // Read, Grep and Glob outside the root are still refused.
  for (const [tool, input] of [['Read', { file_path: '/etc/passwd' }], ['Grep', { pattern: 'x', path: root }], ['Glob', { pattern: `${root}/**` }]] as const) {
    assert.match(await guardReason(repo, tool, input) ?? 'allowed', /^The Task check may read only the repository checkout /, `${tool} ${JSON.stringify(input)}`);
  }
});

test('the links out of the check\'s worktree are cut, the links inside it kept', async () => {
  const root = await realpath(temp);
  const tree = join(root, 'links-root');
  await mkdir(join(tree, 'src', 'deep'), { recursive: true });
  await writeFile(join(tree, 'src', 'a.ts'), 'x');
  await symlink(join(tree, 'src', 'a.ts'), join(tree, 'inside-abs'));
  await symlink('src', join(tree, 'inside-rel'));
  await symlink(root, join(tree, 'src', 'deep', 'outside-dir'));
  await symlink('../../../../etc/passwd', join(tree, 'src', 'deep', 'outside-rel'));
  await symlink('missing', join(tree, 'dangling'));
  assert.deepEqual((await cutOutsideLinks(tree)).sort(), ['dangling', 'src/deep/outside-dir', 'src/deep/outside-rel']);
  assert.equal(await readFile(join(tree, 'src', 'deep', 'outside-dir'), 'utf8'), OUTSIDE_LINK_NOTE);
  assert.equal(await readFile(join(tree, 'inside-abs'), 'utf8'), 'x');
  assert.deepEqual(await readdir(join(tree, 'inside-rel')), ['a.ts', 'deep']);
});

test('sf check-task: the read-only session in the work checkout, its prompt the Task file only, the paraphrase first in the output, stored by sha', async () => {
  const content = taskText('C-2');
  const { env, repo } = await checkEnv('check-cli', 'C-2', content);
  // What the Context owner's side and the jobs keep, which the checker never gets: the user's request and a ledger.
  await mkdir(join(env.state, 'requests', 'app'), { recursive: true });
  await writeFile(join(env.state, 'requests', 'app', 'C-2.md'), 'the secret request words');
  await mkdir(join(env.state, 'jobs', 'app', 'C-2'), { recursive: true });
  await writeFile(join(env.state, 'jobs', 'app', 'C-2', 'ledger.json'), '[{"id":"R1","problem":"ledger words"}]');
  await reviewScript(env, [{ output: OUTPUT }]);

  const run = await runCli(env, ['check-task', 'app', 'C-2']);
  assert.equal(run.code, 0, run.stderr);
  const [entry] = await reviewLog(env);
  // A worktree of its own at the base, removed afterwards; the checkout has no other worktree.
  assert.notEqual(entry!.cwd, repo);
  assert.equal(basename(entry!.cwd), 'repo');
  assert.equal(existsSync(entry!.cwd), false);
  // Under the Task checks' parent directory (SF-100): <tmp>/sf-task-checks-<uid>/check-*/repo, 0700.
  assert.match(basename(dirname(entry!.cwd)), /^check-/);
  const parent = dirname(dirname(entry!.cwd));
  assert.equal(basename(parent), `sf-task-checks-${process.getuid!()}`);
  assert.equal((await stat(parent)).mode & 0o777, 0o700);
  assert.equal(existsSync(dirname(entry!.cwd)), false);
  assert.deepEqual(git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')), [`worktree ${repo}`]);
  assert.equal(entry!.prompt, checkPrompt('C-2', content));
  assert.ok(!entry!.prompt.includes('secret request words') && !entry!.prompt.includes('ledger words'));
  assert.equal(option(entry!.argv, 'tools'), 'Read,Grep,Glob');
  // The path denials (SF-100) on top of checkDeniedRules, but the Task checks' parent it runs in.
  const extra = assertPathDenials(entry!.argv, env, entry!.cwd, [...REVIEW_DENIED_TOOLS, ...checkDeniedRules(repo, env.state, env.config)]);
  assert.ok(extra.includes(`Read(/${join(env.state, 'requests')}/**)`), extra.join(', '));
  assert.ok(!extra.some((rule) => rule.includes('sf-task-checks-')), extra.join(', '));
  assert.deepEqual(JSON.parse(option(entry!.argv, 'json-schema')!), CHECK_SCHEMA);
  assert.deepEqual([option(entry!.argv, 'max-turns'), option(entry!.argv, 'model'), option(entry!.argv, 'setting-sources')], ['9', 'fake-checker', 'project']);

  // The output: the paraphrase, then the findings by severity, the files, the verdict.
  const out = run.stdout;
  const at = (text: string): number => {
    const index = out.indexOf(text);
    assert.ok(index >= 0, `${text} not in:\n${out}`);
    return index;
  };
  assert.ok(at('Paraphrase:') < at('Findings:') && at('Findings:') < at('  blocker (1):') && at('  blocker (1):') < at('  major (1):') && at('  major (1):') < at('  nit (1):'));
  assert.ok(at('[contradiction] README.md:1') < at('  major (1):'));
  assert.ok(at('Files:\n  modify README.md') < at('Verdict: not ready (1 blocker, 1 major, 1 nit)'));
  const sha = taskSha256(content);
  const path = join(env.state, 'checks', 'app', 'C-2', `${sha.slice(0, 16)}.json`);
  assert.ok(out.includes(`stored: ${path}`));
  const stored = JSON.parse(await readFile(path, 'utf8')) as CheckRecord;
  assert.deepEqual([stored.status, stored.sha256, stored.commit, stored.model, stored.cost_usd, stored.output?.verdict], ['checked', sha, git(repo, 'rev-parse', 'main').trim(), 'fake-model', 0.0456, 'not_ready']);
  assert.deepEqual(Object.keys(stored.output!), ['paraphrase', 'findings', 'files', 'verdict']);
  assert.ok(stored.started_at <= stored.ended_at);
  // Never in the work checkout.
  assert.deepEqual((await readdir(join(repo, '.software-factory'))).sort(), ['C-2.md']);
  // Usage and refusals.
  assert.equal((await runCli(env, ['check-task', 'app'])).code, 2);
  assert.match((await runCli(env, ['check-task', 'app', 'C-404'])).stderr, /does not exist/);
});

test('sf check-task with coding rules (SF-059): the prompt gives the <rules> block read at the commit of the check\'s checkout', async () => {
  const content = taskText('C-9');
  const { env, repo } = await checkEnv('check-rules', 'C-9', content);
  const block = await putRules(env, repo);
  // Not committed: not at the base the check reads.
  await writeFile(join(repo, 'AGENTS.md'), 'Uncommitted rules.\n');
  await reviewScript(env, [{ output: OUTPUT }]);
  const run = await runCli(env, ['check-task', 'app', 'C-9']);
  assert.equal(run.code, 0, run.stderr);
  const [entry] = await reviewLog(env);
  assert.equal(entry!.prompt, checkPrompt('C-9', content, block));
  assert.ok(!entry!.prompt.includes('Uncommitted rules.'));
});

test('a failed check is stored as failed with its redacted error, exits 1 and never counts as ready', async () => {
  const content = taskText('C-3');
  const { env } = await checkEnv('check-failed', 'C-3', content);
  await reviewScript(env, [{ subtype: 'error_max_turns', errors: ['turn limit reached'] }, { output: { paraphrase: 'x' } }]);
  const run = await runCli(env, ['check-task', 'app', 'C-3']);
  assert.equal(run.code, 1);
  assert.match(run.stdout, /Check failed: The check ended with error_max_turns: turn limit reached/);
  assert.match(run.stdout, /Verdict: failed \(a failed check never counts as ready\)/);
  const store = new CheckStore(env.state);
  const stored = (await store.read('app', 'C-3', taskSha256(content)))!;
  assert.deepEqual([stored.status, stored.output, stored.cost_usd], ['failed', null, null]);
  assert.equal(checkSummary(stored, stored.sha256).state, 'failed');
  assert.equal(checkSummary(stored, stored.sha256).start_note, 'check failed');
  // An invalid output is a failed check too.
  const invalid = await runCli(env, ['check-task', 'app', 'C-3']);
  assert.equal(invalid.code, 1);
  assert.match((await store.read('app', 'C-3', taskSha256(content)))!.error!, /^The check returned an invalid output: /);
  assert.deepEqual(checkLines(stored).slice(1), ['Check failed: The check ended with error_max_turns: turn limit reached', 'Verdict: failed (a failed check never counts as ready)']);
});

test('end to end, Grep, Glob and Read cannot reach the Context owner\'s material, the jobs, the ledger, the state or the config: the hook refuses, the worktree has none of it', async () => {
  const SECRET = 'sf054-secret';
  const content = taskText('C-6');
  const { env, repo } = await checkEnv('check-isolation', 'C-6', content);
  // The user's request, a ledger, another Task file, an archived one and a config file, each with the secret.
  await mkdir(join(env.state, 'requests', 'app'), { recursive: true });
  await writeFile(join(env.state, 'requests', 'app', 'C-6.md'), `${SECRET} request`);
  await mkdir(join(env.state, 'jobs', 'app', 'C-7'), { recursive: true });
  await writeFile(join(env.state, 'jobs', 'app', 'C-7', 'ledger.json'), `[{"problem":"${SECRET} ledger"}]`);
  await writeTask({ name: 'app', readCheckout: repo, workCheckout: repo }, 'C-7', taskText('C-7', '', `${SECRET} other task`), new JobStore(env.state));
  await mkdir(join(repo, '.software-factory', 'archive'), { recursive: true });
  await writeFile(join(repo, '.software-factory', 'archive', 'C-0.md'), `${SECRET} archived task`);
  await writeFile(join(env.config, 'notes.txt'), `${SECRET} config`);
  // A committed symlink into the state directory.
  await symlink(env.state, join(repo, 'state-link'));
  git(repo, 'add', 'state-link');
  git(repo, 'commit', '-q', '-m', 'link');
  const probes = [
    ['allow', 'Grep', { pattern: SECRET }],
    ['allow', 'Glob', { pattern: '**/*.md' }],
    ['allow', 'Glob', { pattern: '**' }],
    ['allow', 'Read', { file_path: 'README.md' }],
    ['deny', 'Grep', { pattern: SECRET, path: env.state }],
    ['deny', 'Grep', { pattern: SECRET, path: repo }],
    // The link is cut in the check's worktree: a file holding the note.
    ['allow', 'Grep', { pattern: SECRET, path: 'state-link' }],
    ['allow', 'Read', { file_path: 'state-link' }],
    ['deny', 'Grep', { pattern: SECRET, path: '/' }],
    ['deny', 'Glob', { pattern: '**/*', path: env.config }],
    ['deny', 'Glob', { pattern: `${env.state}/**/*.json` }],
    ['deny', 'Glob', { pattern: '../**/*.md' }],
    // Absolute brace alternatives into the state and the config, at any depth.
    ['deny', 'Glob', { pattern: `{${env.state}/**,README.md}` }],
    ['deny', 'Glob', { pattern: `{${env.config}/*,*.md}` }],
    ['deny', 'Glob', { pattern: `{README.md,{a,${env.state}/requests/**}}` }],
    ['deny', 'Grep', { pattern: SECRET, glob: `{${env.state}/**,*.md}` }],
    ['deny', 'Glob', { pattern: `${env.state}/*${'{,}'.repeat(7000)}` }],
    ['deny', 'Grep', { pattern: SECRET, path: env.state, glob: `*${'{,}'.repeat(7000)}` }],
    ['allow', 'Glob', { pattern: '**/*.{md,json}' }],
    ['deny', 'Glob', { pattern: '**/*.md', path: join(repo, '.software-factory') }],
    ['allow', 'Read', { file_path: 'state-link/requests/app/C-6.md' }],
    ['deny', 'Read', { file_path: join(repo, '.software-factory', 'C-7.md') }],
    ['deny', 'Read', { file_path: join(env.config, 'notes.txt') }],
    // Paths Claude Code trims or expands, and Grep's file_path for path.
    ['deny', 'Grep', { pattern: SECRET, path: '~' }],
    ['deny', 'Glob', { pattern: '**/*.json', path: '~/' }],
    ['deny', 'Grep', { pattern: SECRET, path: ` ${env.state}` }],
    ['deny', 'Grep', { pattern: SECRET, file_path: env.state }],
  ] as const;
  await reviewScript(env, [{ output: OUTPUT, probes: probes.map(([, tool, input]) => ({ tool, input })) }]);
  const run = await runCli(env, ['check-task', 'app', 'C-6']);
  assert.equal(run.code, 0, run.stderr);
  const log = await probeLog(env);
  // The answer came last, through the same hook, and was let through.
  const answer = log.pop()!;
  assert.deepEqual([answer.tool, answer.decision, answer.hooks], ['StructuredOutput', 'allow', 1]);
  // Every call went through the factory's hook, which decided as expected.
  assert.deepEqual(log.map((entry) => entry.hooks), probes.map(() => 1));
  assert.deepEqual(log.map((entry) => entry.decision), probes.map(([decision]) => decision));
  // Nothing the session saw holds the secret; the allowed searches saw the repository only.
  for (const entry of log) {
    assert.ok(!entry.output.includes(SECRET), `${entry.tool} ${JSON.stringify(entry.input)}: ${entry.output}`);
  }
  assert.deepEqual([log[0]!.output, log[1]!.output.split('\n').map((line) => basename(line)), log[3]!.output], ['', ['README.md'], 'hello\n']);
  assert.ok(!log[2]!.output.includes('.software-factory') && log[2]!.output.includes('README.md'), log[2]!.output);
  assert.match(log[4]!.output, /^The Task check may read only the repository checkout /);
  assert.equal(log[7]!.output, OUTSIDE_LINK_NOTE);
  // Glob answers with paths: no allowed call named one in the state or the config.
  for (const entry of log.filter((item) => item.decision === 'allow')) {
    assert.ok(!entry.output.includes(env.state) && !entry.output.includes(env.config), `${entry.tool} ${JSON.stringify(entry.input)}: ${entry.output}`);
  }
  const braces = log.find((entry) => entry.input.pattern === '**/*.{md,json}')!;
  assert.deepEqual(braces.output.split('\n').map((line) => basename(line)), ['README.md']);
});

test('end to end, the session answers with StructuredOutput after a Read: the hook lets the answer through and the check is stored as done', async () => {
  const content = taskText('C-8');
  const { env } = await checkEnv('check-answer', 'C-8', content);
  await reviewScript(env, [{ output: OUTPUT, probes: [{ tool: 'Read', input: { file_path: 'README.md' } }] }]);
  const run = await runCli(env, ['check-task', 'app', 'C-8']);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const log = await probeLog(env);
  assert.deepEqual(log.map((entry) => [entry.tool, entry.decision, entry.hooks]), [['Read', 'allow', 1], ['StructuredOutput', 'allow', 1]]);
  assert.deepEqual(log[1]!.input, OUTPUT);
  const stored = (await new CheckStore(env.state).read('app', 'C-8', taskSha256(content)))!;
  assert.deepEqual([stored.status, stored.error, stored.output?.paraphrase], ['checked', null, OUTPUT.paraphrase]);
});

test('a check whose base cannot be checked out fails without a session', async () => {
  const content = taskText('C-8').replace('base: main', 'base: no-such-base');
  const { env } = await checkEnv('check-no-base', 'C-8', content);
  const run = await runCli(env, ['check-task', 'app', 'C-8']);
  assert.equal(run.code, 1);
  assert.match(run.stdout, /Check failed: The check could not prepare its checkout: The base "no-such-base" was not found\./);
  const stored = (await new CheckStore(env.state).read('app', 'C-8', taskSha256(content)))!;
  assert.deepEqual([stored.status, stored.commit, stored.output], ['failed', null, null]);
  assert.equal(existsSync(join(env.home, 'fake-review.log')), false);
});

test('the dashboard: Check runs one check at a time, the tickets carry its summary and Start note, the endpoint its view and stale mark; task_check reads it', async () => {
  const content = taskText('C-4');
  const { env, repo } = await checkEnv('check-dashboard', 'C-4', content);
  await reviewScript(env, [{ output: { ...OUTPUT, findings: [finding('nit')] }, delayMs: 500 }]);
  const served = await serve(env);
  try {
    const base = served.dashboard!;
    const tickets = async (): Promise<Array<Record<string, any>>> => JSON.parse((await fetchRaw(new URL('api/tickets', base))).body).tickets;
    const taskCheck = async (): Promise<Record<string, any>> => (await served.client.callTool({ name: 'task_check', arguments: { workspace: 'app', ticket: 'C-4' } })).structuredContent as Record<string, any>;
    assert.deepEqual((await tickets())[0]!.check, { state: 'none', check_reason: null, stale: false, running: false, blockers: 0, majors: 0, nits: 0, ended_at: null, start_note: 'not checked' });
    assert.deepEqual(JSON.parse((await fetchRaw(new URL('api/tickets/app/C-4/check', base))).body), { check: null, stale: false, running: false, current_sha256: taskSha256(content), check_reason: null });
    assert.deepEqual(await taskCheck(), { verdict: 'none', sha256: taskSha256(content), paraphrase: null, findings: [], files: [], error: null, model: null, checked_at: null, running: false, pending: false });

    // Two Checks at the same moment: one starts, the other is check_running; one session runs.
    const replies = await Promise.all([act(base, 'api/tickets/app/C-4/check', {}), act(base, 'api/tickets/app/C-4/check', {})]);
    const started = replies.find((reply) => reply.status === 200)!;
    const again = replies.find((reply) => reply !== started)!;
    assert.deepEqual(JSON.parse(started.body), { ok: true, result: { started: true, sha256: taskSha256(content) } });
    assert.deepEqual([again.status, JSON.parse(again.body).error.code], [409, 'check_running']);
    assert.equal((await tickets())[0]!.check.running, true);
    const another = await act(base, 'api/tickets/app/C-4/check', {});
    assert.deepEqual([another.status, JSON.parse(another.body).error.code], [409, 'check_running']);
    const deadline = Date.now() + 20_000;
    while ((await tickets())[0]!.check.running === true) {
      assert.ok(Date.now() < deadline, 'the check did not end');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual((await tickets())[0]!.check, { state: 'ready', check_reason: null, stale: false, running: false, blockers: 0, majors: 0, nits: 1, ended_at: (await tickets())[0]!.check.ended_at, start_note: null });
    const view = JSON.parse((await fetchRaw(new URL('api/tickets/app/C-4/check', base))).body);
    assert.deepEqual([view.stale, view.check.output.verdict, Object.keys(view.check.output)[0]], [false, 'ready', 'paraphrase']);
    assert.equal((await reviewLog(env)).length, 1);
    const read = await taskCheck();
    assert.deepEqual([read.verdict, read.paraphrase, read.findings.length, read.model], ['ready', OUTPUT.paraphrase, 1, 'fake-model']);

    // The Task file changes: the check is stale, task_check has none for it, Start says so.
    await writeTask({ name: 'app', readCheckout: repo, workCheckout: repo }, 'C-4', taskText('C-4', '', 'Greet the reader twice.'), new JobStore(env.state));
    assert.deepEqual([(await tickets())[0]!.check.stale, (await tickets())[0]!.check.start_note], [true, 'stale']);
    assert.equal(JSON.parse((await fetchRaw(new URL('api/tickets/app/C-4/check', base))).body).stale, true);
    assert.equal((await taskCheck()).verdict, 'none');

    // Refusals: a draft, a missing ticket, the wrong method, a body with keys.
    await writeFile(join(repo, '.software-factory', 'C-5.md'), '---\nticket: C-5\ntitle: Draft\nbase: main\n---\n\n## Status: waiting for the Context owner\n');
    assert.equal(JSON.parse((await act(base, 'api/tickets/app/C-5/check', {})).body).error.code, 'task_draft');
    assert.equal((await act(base, 'api/tickets/app/C-404/check', {})).status, 404);
    assert.equal((await fetchRaw(new URL('api/tickets/app/C-404/check', base))).status, 404);
    assert.equal((await fetchRaw(new URL('api/tickets/app/C-4/check', base), { method: 'PUT' })).status, 405);
    assert.equal((await act(base, 'api/tickets/app/C-4/check', { force: true })).status, 400);
    // The check only advises: Start is not refused for a stale check.
    assert.equal((await act(base, 'api/tickets/app/C-4/start', {})).status, 200);
  } finally {
    await stop(served);
  }
});

test('sf check-task (SF-085): the config lock the check\'s sandbox left goes once the check ended, an event in the ticket\'s job log; kept while a job of the workspace runs', async () => {
  const { env, repo } = await checkEnv('check-lock', 'C-9', taskText('C-9'));
  const jobs = new JobStore(env.state);
  const created = new Date().toISOString();
  const job: Job = {
    workspace: 'app', ticket: 'C-9', branch: 'C-9-x', base: 'main', base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
    mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state: 'working', iteration: 0, session_id: null, mr: null, created_at: created, updated_at: created,
  };
  const lock = join(repo, '.git', 'config.lock');
  const staleLock = async (): Promise<void> => {
    await writeFile(lock, '');
    await chmod(lock, 0o444);
  };
  const removals = async (): Promise<unknown[]> => (await readFile(join(env.state, 'jobs', 'app', 'C-9', 'events.jsonl'), 'utf8').catch(() => ''))
    .split('\n').filter((line) => line !== '').map((line) => JSON.parse(line)).filter((event) => event.type === 'sandbox_lock_removed').map((event) => event.path);
  // A job of the workspace in working: its sandbox may be using the lock.
  await jobs.write({ ...job, ticket: 'C-8', branch: 'C-8-x' });
  await staleLock();
  await reviewScript(env, [{ output: OUTPUT }, { output: OUTPUT }, { output: OUTPUT }]);
  const kept = await runCli(env, ['check-task', 'app', 'C-9']);
  assert.equal(kept.code, 0, kept.stderr);
  assert.ok(existsSync(lock));

  // No job runs any more, but a process has the lock open (sf check-task scans the test's fake
  // /proc, SF-105): kept.
  await jobs.write({ ...job, ticket: 'C-8', branch: 'C-8-x', state: 'aborted' });
  await jobs.write({ ...job, state: 'ready_for_human_review' });
  const release = await holdOpen(env, lock);
  const held = await runCli(env, ['check-task', 'app', 'C-9']);
  assert.equal(held.code, 0, held.stderr);
  assert.ok(existsSync(lock));
  assert.deepEqual(await removals(), []);

  // Nobody holds it any more; the ticket's own job (not running) gets the event.
  await release();
  const removed = await runCli(env, ['check-task', 'app', 'C-9']);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(existsSync(lock), false);
  assert.deepEqual(await removals(), [lock]);
});

// The images of the SF-065 tests.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

test('taskCheckSha256 (SF-065): the text\'s sha256 without images; with them the text, a newline and the sorted name:sha256 lines', () => {
  const text = taskText('C-1');
  assert.equal(taskCheckSha256(text, []), taskSha256(text));
  const images = [{ name: '2.png', sha256: 'b'.repeat(64) }, { name: '1.png', sha256: 'a'.repeat(64) }];
  const expected = sha(`${text}\n1.png:${'a'.repeat(64)}\n2.png:${'b'.repeat(64)}`);
  assert.equal(taskCheckSha256(text, images), expected);
  assert.equal(taskCheckSha256(text, [...images].reverse()), expected);
  assert.notEqual(taskCheckSha256(text, [images[0]!, { name: '1.png', sha256: 'c'.repeat(64) }]), expected);
  assert.equal(taskCheckSha256(text, [{ name: '1.png', sha256: 'missing' }]), sha(`${text}\n1.png:missing`));
});

test('the Task check with images (SF-065): the factory gives the referenced images as blocks; a changed image makes the check stale; a missing one fails the check without a session; archived, the images come from archive/', async () => {
  const env = await newEnv('check-images', { SF_REVIEW_MODEL: 'fake-checker', SF_TASK_CHECK_MAX_TURNS: '9' });
  const repo = await newRepo(env, 'check-images-repo', false);
  const workspace = { name: 'app', readCheckout: repo, workCheckout: repo };
  const jobs = new JobStore(env.state);
  await writeTask(workspace, 'C-10', taskText('C-10'), jobs);
  await addAttachment(workspace, 'C-10', PNG, jobs);
  await addAttachment(workspace, 'C-10', PNG, jobs, 'unused.png');
  const content = taskText('C-10', '', 'Greet the reader as in ![the mockup](C-10/1.png).');
  await writeTask(workspace, 'C-10', content, jobs);
  await reviewScript(env, [{ output: OUTPUT }]);

  const run = await runCli(env, ['check-task', 'app', 'C-10']);
  assert.equal(run.code, 0, run.stderr);
  const [entry] = await reviewLog(env);
  assert.deepEqual(entry!.blocks, [
    { type: 'text', text: checkPrompt('C-10', content) },
    { type: 'text', text: 'Image C-10/1.png ("the mockup"), referenced in the Task file:' },
    { type: 'image', media_type: 'image/png', bytes: PNG.length, sha256: sha(PNG) },
  ]);
  const checkSha = taskCheckSha256(content, [{ name: '1.png', sha256: sha(PNG) }]);
  assert.notEqual(checkSha, taskSha256(content));
  const store = new CheckStore(env.state);
  assert.equal((await store.read('app', 'C-10', checkSha))?.status, 'checked');
  const checks = new TaskChecks({
    resolve: async () => workspace, claudePath: undefined, sandbox: undefined, model: undefined, maxTurns: 1, rulesMaxBytes: 49152, stateDir: env.state, configDir: env.config, worktreeRoot: join(env.state, 'worktrees'),
  });
  assert.deepEqual([(await checks.view('app', 'C-10')).stale, (await checks.view('app', 'C-10')).current_sha256], [false, checkSha]);
  assert.equal((await checks.current('app', 'C-10')).record?.sha256, checkSha);

  // The image changes, the text does not: the check is stale, task_check has none for this version.
  const other = Buffer.concat([PNG, Buffer.from('-changed')]);
  await writeFile(join(repo, '.software-factory', 'C-10', '1.png'), other);
  assert.equal((await checks.view('app', 'C-10')).stale, true);
  assert.equal((await checks.current('app', 'C-10')).record, undefined);

  // A missing image: a failed check naming it, stored under name:missing; no session runs.
  await rm(join(repo, '.software-factory', 'C-10', '1.png'));
  const failed = await runCli(env, ['check-task', 'app', 'C-10']);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /Check failed: The Task file refers to images that cannot be used: C-10\/1\.png: missing\./);
  assert.equal((await reviewLog(env)).length, 1);
  const missingSha = taskCheckSha256(content, [{ name: '1.png', sha256: 'missing' }]);
  assert.deepEqual([(await store.read('app', 'C-10', missingSha))?.status, (await checks.view('app', 'C-10')).stale], ['failed', false]);

  // Archived with its images: the hash reads archive/C-10/, and the first check is current again.
  await writeFile(join(repo, '.software-factory', 'C-10', '1.png'), PNG);
  await mkdir(join(repo, '.software-factory', 'archive'), { recursive: true });
  await rename(join(repo, '.software-factory', 'C-10.md'), join(repo, '.software-factory', 'archive', 'C-10.md'));
  await rename(join(repo, '.software-factory', 'C-10'), join(repo, '.software-factory', 'archive', 'C-10'));
  const archived = await checks.view('app', 'C-10');
  assert.equal(archived.current_sha256, checkSha);
  // A referenced image missing from the archive enters as missing; the view never throws.
  await rm(join(repo, '.software-factory', 'archive', 'C-10', '1.png'));
  assert.equal((await checks.view('app', 'C-10')).current_sha256, missingSha);
});
