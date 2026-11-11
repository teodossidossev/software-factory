// End-to-end execution tests, second part: what the factory keeps out of a job's results or asks
// to be acknowledged (sandbox placeholders, the Task's scope, sensitive paths), the job's images,
// the Fix round limit and the cloud credentials. The real `sf serve` and `sf` CLI with private
// config and state directories, throwaway Git repositories and the fake Claude Code as the
// Implementer executable, as in test/execution.test.ts, which runs the cycle, the rules and the
// queue (split so that no file runs near run-tests' per-file limit).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { addAttachment } from '../src/attachments.js';
import { firstPrompt } from '../src/execution.js';
import { JobStore } from '../src/jobs.js';
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import { sandboxSettings } from '../src/config.js';
import { ImplementerSession, type IdleOutcome, sandboxEnvDenials, sessionEnvironment } from '../src/session.js';
import { writeTask } from '../src/task-file.js';
import {
  call, codexLog, codexScript, FAKE, fakeCodex, fakeLog, git, newEnv, newRepo, putTask, refused, reviewLog, reviewScript, runCli, script, serve, stop, task, useFakeBwrap,
  jobPrompt, waitFor,
} from './support/harness.js';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];

function mrText(header: string): string {
  return [
    header, '',
    '## What', 'Changes the README.', '## Why', 'The ticket asks for it.', '## How', 'One line.', '## Why the change', 'Readers need it.',
    '## Special things to note', '- None.', '## Change outline', '- README.md', '## Testing', 'npm test: passed', '## Screenshots', 'N/A',
    '## Checklist', '- [x] Branch name', '- [x] Target branch', '',
  ].join('\n');
}

// The placeholders bubblewrap left in a real job's work checkout on 2026-11-02.
const PLACEHOLDERS = [
  '.bash_profile', '.bashrc', '.gitconfig', '.gitmodules', '.mcp.json',
  '.claude/agents', '.claude/commands', '.claude/hooks', '.claude/launch.json', '.claude/loop.md',
  '.claude/output-styles', '.claude/routines', '.claude/scheduled_tasks.json', '.claude/settings.json',
  '.claude/settings.local.json', '.claude/skills', '.claude/workflows',
];

async function events(env: { state: string }, ticket: string): Promise<Array<Record<string, any>>> {
  const text = await readFile(join(env.state, 'jobs', 'app', ticket, 'events.jsonl'), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.type === 'placeholders_removed');
}

test('sandbox placeholders: the Patch leaves them out, they are removed from the worktree after every turn and before abort --discard', async () => {
  const env = await newEnv('placeholders');
  const repo = await newRepo(env, 'placeholders-repo', false);
  await putTask(env, repo, 'P-1', 'Placeholders');
  // A real dotfile with content is a change of its own and stays.
  await script(env, [
    { tool: true, write: { 'README.md': 'hello placeholders\n', '.editorconfig': 'root = true\n' }, placeholders: [...PLACEHOLDERS, '.claude/.cc-writes/'] },
  ]);
  const served = await serve(env);
  assert.equal((await call(served, 'start', { workspace: 'app', ticket: 'P-1' })).state, 'working');
  const worktree = join(env.state, 'worktrees', 'app', 'P-1');
  const first = await waitFor(served, 'P-1', 'awaiting_review', 1);

  assert.match(first.patch.text, /\+\+\+ b\/README\.md/);
  assert.match(first.patch.text, /\+\+\+ b\/\.editorconfig/);
  assert.doesNotMatch(first.patch.text, /bash|gitconfig|gitmodules|mcp\.json|\.claude/);
  assert.match(first.report, /\| README\.md \| 1 \| 1 \|\n\| \.editorconfig \| 1 \| 0 \|\n/);
  assert.doesNotMatch(first.report, /\.bashrc|\.claude/);
  // .editorconfig is a sensitive path (tool configuration), undeclared by the Task file.
  assert.match(first.report, /\n## Changed files\n\n### Sensitive\n\n- \.editorconfig \(undeclared\)\n\n\| Path/);
  assert.deepEqual(first.files, { sensitive: [{ path: '.editorconfig', declared: false }], deleted: [] });
  const logged = await events(env, 'P-1');
  assert.deepEqual(logged.map((record) => [record.iteration, record.paths]), [[1, [...PLACEHOLDERS, '.claude', '.claude/.cc-writes'].sort()]]);
  for (const path of ['.bashrc', '.claude', '.mcp.json']) {
    await assert.rejects(stat(join(worktree, path)), { code: 'ENOENT' }, path);
  }
  const watched = await runCli(env, ['watch', 'app', 'P-1', '--once']);
  assert.match(watched.stdout, /^\d\d:\d\d:\d\d \[1\] placeholders removed: \.bash_profile, \.bashrc, \.claude, /m);

  // Placeholders recreated before abort --discard are removed and logged as well; the worktree goes.
  await writeFile(join(worktree, '.gitconfig'), '');
  await chmod(join(worktree, '.gitconfig'), 0o444);
  const aborted = await runCli(env, ['abort', 'app', 'P-1', '--discard']);
  assert.equal(aborted.code, 0, aborted.stdout + aborted.stderr);
  assert.match(aborted.stdout, /^discarded: true$/m);
  assert.deepEqual((await events(env, 'P-1')).at(-1)!.paths, ['.gitconfig']);
  await assert.rejects(stat(worktree), { code: 'ENOENT' });
  assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all').replace(/^\?\? \.software-factory\/.*\n/gm, ''), '');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  await stop(served);
});

test("the Task's scope (SF-053): mark_clean needs the paths outside it acknowledged, with the undeclared sensitive ones; the Report and sf status name them", async () => {
  const env = await newEnv('scope');
  const repo = await newRepo(env, 'scope-repo', true);
  const content = `---\nticket: O-2\ntitle: Scoped change\nbase: main\nscope: [README.md, src/**]\n---\n\n# O-2: Scoped change\n\nChange things.\n`;
  await writeTask({ name: 'app', readCheckout: repo, workCheckout: repo }, 'O-2', content, new JobStore(env.state));
  await script(env, [
    { write: { 'README.md': 'x\n', 'src/a.ts': 'a\n', 'notes.txt': 'n\n', '.editorconfig': 'root = true\n' }, text: 'iteration 1' },
    { write: { '.software-factory/O-2.mr.md': mrText('feat(O-2): Scoped change') }, text: 'prepared' },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'O-2' });
  const first = await waitFor(served, 'O-2', 'awaiting_review', 1);
  // .editorconfig is undeclared sensitive and out of scope: listed under both headings.
  assert.match(first.report, /\n## Changed files\n\n### Sensitive\n\n- \.editorconfig \(undeclared\)\n\n### Outside the Task's scope\n\n- \.editorconfig\n- notes\.txt\n\n\| Path/);
  const one = await runCli(env, ['status', 'app', 'O-2']);
  assert.match(one.stdout, /\nsensitive: \.editorconfig \(undeclared\)\nout of scope: \.editorconfig, notes\.txt\ndeleted: none\n$/);
  const unacknowledged = await refused(served, 'mark_clean', { workspace: 'app', ticket: 'O-2' });
  assert.equal(unacknowledged.code, 'sensitive_unacknowledged');
  assert.equal(unacknowledged.message, "Undeclared sensitive path(s) in the reviewed iteration: .editorconfig. Path(s) outside the Task's scope in the reviewed iteration: .editorconfig, notes.txt. Each must be named in the accepted sensitive paths with the reason it is needed; otherwise it is a fix item.");
  assert.equal((await refused(served, 'mark_clean', { workspace: 'app', ticket: 'O-2', sensitive: ['.editorconfig'] })).message, "Path(s) outside the Task's scope in the reviewed iteration: notes.txt. Each must be named in the accepted sensitive paths with the reason it is needed; otherwise it is a fix item.");
  assert.equal((await call(served, 'mark_clean', { workspace: 'app', ticket: 'O-2', sensitive: ['.editorconfig', 'notes.txt'] })).state, 'preparing_mr');
  await waitFor(served, 'O-2', 'ready_for_human_review', 1);
  await stop(served);
});

test('sensitive paths (SF-024): declared by may_touch or not, deleted files, mark_clean needs the undeclared ones acknowledged, the Report and notifications name them', async () => {
  const env = await newEnv('sensitive', { SF_SENSITIVE_PATHS: 'docs/*.lock' });
  const repo = await newRepo(env, 'sensitive-repo', true);
  await writeFile(join(repo, 'package.json'), '{}\n');
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'old.ts'), 'old\n');
  await writeFile(join(repo, 'package-lock.json'), '{}\n');
  git(repo, 'add', '.');
  git(repo, ...ID, 'commit', '-q', '-m', 'files');
  git(repo, 'push', '-q', 'origin', 'main');
  const content = `---\nticket: S-1\ntitle: Touch files\nbase: main\nmay_touch: [package.json, docs/**]\n---\n\n# S-1: Touch files\n\nChange things.\n`;
  await writeTask({ name: 'app', readCheckout: repo, workCheckout: repo }, 'S-1', content, new JobStore(env.state));
  await script(env, [
    {
      write: { 'package.json': '{"name":"x"}\n', '.github/workflows/ci.yml': 'on: push\n', 'src/a.ts': 'a\n', 'docs/dep.lock': 'x\n' },
      run: [['rm', 'src/old.ts', 'package-lock.json']],
      text: 'iteration 1',
    },
    { write: { '.software-factory/S-1.mr.md': mrText('feat(S-1): Touch files') }, text: 'prepared' },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'S-1' });
  const first = await waitFor(served, 'S-1', 'awaiting_review', 1);
  assert.deepEqual(first.files, {
    sensitive: [{ path: 'package-lock.json', declared: false }, { path: 'package.json', declared: true }, { path: '.github/workflows/ci.yml', declared: false }, { path: 'docs/dep.lock', declared: true }],
    deleted: ['package-lock.json', 'src/old.ts'],
  });
  assert.match(first.report, /\n## Changed files\n\n### Sensitive\n\n- package-lock\.json \(undeclared, deleted\)\n- package\.json \(declared\)\n- \.github\/workflows\/ci\.yml \(undeclared\)\n- docs\/dep\.lock \(declared\)\n\n### Deleted\n\n- package-lock\.json\n- src\/old\.ts\n\n\| Path/);
  const meta = JSON.parse(await readFile(join(env.state, 'jobs', 'app', 'S-1', 'iterations', '001', 'meta.json'), 'utf8'));
  assert.deepEqual(meta.files.map((file: Record<string, unknown>) => [file.path, file.status, file.sensitive]), [
    ['package-lock.json', 'deleted', 'undeclared'], ['package.json', 'modified', 'declared'], ['src/old.ts', 'deleted', 'no'],
    ['.github/workflows/ci.yml', 'added', 'undeclared'], ['docs/dep.lock', 'added', 'declared'], ['src/a.ts', 'added', 'no'],
  ]);
  const one = await runCli(env, ['status', 'app', 'S-1']);
  assert.match(one.stdout, /\nsensitive: package-lock\.json \(undeclared\), package\.json, \.github\/workflows\/ci\.yml \(undeclared\), docs\/dep\.lock\ndeleted: package-lock\.json, src\/old\.ts\n$/);

  // Clean without the undeclared paths is refused and starts nothing; with them it prepares the branch.
  const unacknowledged = await refused(served, 'mark_clean', { workspace: 'app', ticket: 'S-1' });
  assert.equal(unacknowledged.code, 'sensitive_unacknowledged');
  assert.match(unacknowledged.message, /^Undeclared sensitive path\(s\) in the reviewed iteration: package-lock\.json, \.github\/workflows\/ci\.yml\. Each must be named in the accepted sensitive paths with the reason it is needed; otherwise it is a fix item\.$/);
  assert.doesNotMatch(unacknowledged.message, /request_fix|mark_clean/);
  assert.equal((await refused(served, 'mark_clean', { workspace: 'app', ticket: 'S-1', sensitive: ['package-lock.json'] })).code, 'sensitive_unacknowledged');
  assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'S-1' })).state, 'awaiting_review');
  assert.equal((await fakeLog(env)).length, 1);
  assert.equal((await call(served, 'mark_clean', { workspace: 'app', ticket: 'S-1', sensitive: ['package-lock.json', '.github/workflows/ci.yml'] })).state, 'preparing_mr');
  await waitFor(served, 'S-1', 'ready_for_human_review', 1);
  assert.equal(git(repo, 'show', '--name-status', '--format=', 'S-1-touch-files').trim().split('\n').sort().join(','), 'A\t.github/workflows/ci.yml,A\tdocs/dep.lock,A\tsrc/a.ts,D\tpackage-lock.json,D\tsrc/old.ts,M\tpackage.json');
  await stop(served);
});

// The bytes of the images of the SF-065 tests: told by their first bytes, as the factory reads them.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const GIF = Buffer.from('GIF89a-gif-body');
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

test('images (SF-065): Start refuses an unusable image; the job copies the referenced ones; the first turn, the reviews, the simplification pass and the gate get the same set from the job\'s copy, never its bytes in a log', async () => {
  const env = await newEnv('images', { SF_REVIEW: 'on', SF_GATE: 'codex', SF_GATE_LEVEL: 'full', SF_CODEX: fakeCodex, SF_SIMPLIFY: 'on' });
  const repo = await newRepo(env, 'images-repo', false);
  const workspace = { name: 'app', readCheckout: repo, workCheckout: repo };
  const jobs = new JobStore(env.state);
  await putTask(env, repo, 'D-1', 'Show the images');
  await addAttachment(workspace, 'D-1', PNG, jobs);
  await addAttachment(workspace, 'D-1', GIF, jobs, 'form.gif');
  await addAttachment(workspace, 'D-1', PNG, jobs, 'unused.png');
  const text = [
    task('D-1', 'Show the images').trimEnd(), '',
    'The form: ![the form](D-1/form.gif). The error: ![one](D-1/1.png), again ![](D-1/1.png).',
    'Not attachments: ![dot](./D-1/unused.png) <img src="D-1/unused.png"> ![url](https://example.invalid/D-1/unused.png)',
    '```', '![in code](D-1/unused.png)', '```', '',
  ].join('\n');
  await writeTask(workspace, 'D-1', text, jobs);
  const MAJOR = { path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.', severity: 'major' };
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: '| R1 | fixed | README.md:1 |' },
    { write: { '.software-factory/D-1.mr.md': mrText('feat(D-1): Show the images') }, text: 'prepared' },
  ]);
  const clean = { verdict: 'clean', summary: 'Right.', items: [], accepted_sensitive: [] };
  await reviewScript(env, [{ output: { verdict: 'fix', summary: 'Wrong greeting.', items: [MAJOR], accepted_sensitive: [] } }, { output: clean }, { output: { summary: 'Nothing to simplify.', suggestions: [] } }]);
  await codexScript(env, [{ output: clean }]);
  const served = await serve(env);
  try {
    // A referenced image that is missing refuses the start; nothing is created.
    await rm(join(repo, '.software-factory', 'D-1', '1.png'));
    const refusal = await refused(served, 'start', { workspace: 'app', ticket: 'D-1' });
    assert.equal(refusal.code, 'attachment_invalid');
    assert.match(refusal.message, /D-1\/1\.png: missing/);
    assert.equal(await jobs.read('app', 'D-1'), undefined);
    await addAttachment(workspace, 'D-1', PNG, jobs, '1.png');

    await call(served, 'start', { workspace: 'app', ticket: 'D-1' });
    const worktree = join(env.state, 'worktrees', 'app', 'D-1');
    const jobDir = jobs.dir('app', 'D-1');
    const records = [
      { name: 'form.gif', type: 'image/gif', bytes: GIF.length, sha256: sha(GIF) },
      { name: '1.png', type: 'image/png', bytes: PNG.length, sha256: sha(PNG) },
    ];
    assert.deepEqual((await jobs.read('app', 'D-1'))!.attachments, records);
    // Two copies: the job's own and the worktree's; only the referenced images.
    for (const dir of [join(jobDir, 'attachments'), join(worktree, '.software-factory', 'D-1')]) {
      assert.deepEqual((await readdir(dir)).sort(), ['1.png', 'form.gif']);
      assert.deepEqual(await readFile(join(dir, 'form.gif')), GIF);
    }
    assert.equal(git(worktree, 'status', '--porcelain'), '');
    // An edit of the work checkout's folder after Start changes nothing the job's agents get.
    const other = Buffer.concat([PNG, Buffer.from('-changed')]);
    await writeFile(join(repo, '.software-factory', 'D-1', '1.png'), other);

    await waitFor(served, 'D-1', 'ready_for_human_review', 2);
    const dir = join(worktree, '.software-factory', 'D-1');
    const imagesLine = { dir, names: ['form.gif', '1.png'] };
    const log = await fakeLog(env);
    // The first turn: the prompt text as before with the images line, then each image named and its block.
    assert.deepEqual(log[0]!.blocks, [
      { type: 'text', text: await jobPrompt(env, firstPrompt('D-1', []), 'D-1', 1, imagesLine) },
      { type: 'text', text: 'Image D-1/form.gif ("the form"), referenced in the Task file:' },
      { type: 'image', media_type: 'image/gif', bytes: GIF.length, sha256: sha(GIF) },
      { type: 'text', text: 'Image D-1/1.png ("one"), referenced in the Task file:' },
      { type: 'image', media_type: 'image/png', bytes: PNG.length, sha256: sha(PNG) },
    ]);
    assert.ok(log[0]!.prompt.startsWith('/implement .software-factory/D-1.md\n\nThe Task\'s images are in '), log[0]!.prompt);
    // A Fix prompt names the folder; no blocks. The MR text turn is as before.
    assert.equal(log[1]!.prompt, await jobPrompt(env, '/implement .software-factory/D-1.md Fix 1', 'D-1', 2, imagesLine));
    assert.equal(log[1]!.blocks, undefined);
    assert.doesNotMatch(log[2]!.prompt, /The Task's images/);
    assert.equal(log[2]!.blocks, undefined);

    // Both reviews and the simplification pass: the review prompt, then the same images, from the job's copy.
    const reviews = await reviewLog(env);
    assert.equal(reviews.length, 3);
    for (const review of reviews) {
      assert.equal(review.blocks?.[0]?.type, 'text');
      assert.deepEqual(review.blocks?.slice(1), log[0]!.blocks!.slice(1));
    }
    assert.match(reviews[2]!.prompt, /simplif/i);
    // The gate: --image per image of the job's copy, before --cd.
    const [gate] = await codexLog(env);
    const copy = join(jobDir, 'attachments');
    assert.deepEqual(gate!.images, [{ path: join(copy, 'form.gif'), sha256: sha(GIF) }, { path: join(copy, '1.png'), sha256: sha(PNG) }]);
    const cd = gate!.argv.indexOf('--cd');
    assert.deepEqual(gate!.argv.slice(cd - 4, cd), ['--image', join(copy, 'form.gif'), '--image', join(copy, '1.png')]);

    // The events: one attachments record, the first prompt's image names, types and sizes; no bytes.
    const raw = await readFile(join(jobDir, 'events.jsonl'), 'utf8');
    const events = raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(events.filter((record) => record.type === 'attachments').map((record) => record.images), [records]);
    const prompts = events.filter((record) => typeof record.prompt === 'string');
    assert.deepEqual(prompts[0]!.images, records.map(({ name, type, bytes }) => ({ name, type, bytes })));
    assert.ok(prompts.slice(1).every((record) => record.images === undefined));
    for (const data of [PNG, GIF, other]) {
      assert.ok(!raw.includes(data.toString('base64')), 'no image bytes in events.jsonl');
    }
    assert.match((await runCli(env, ['watch', 'app', 'D-1', '--once'])).stdout, /\[0\] attachments: form\.gif \(image\/gif, 15 bytes\), 1\.png \(image\/png, 16 bytes\)/);
  } finally {
    await stop(served);
  }
});

test('the Fix round limit by default (SF-131): the fourth Fix is refused; its items are open ledger entries with ids; Accept after Claude\'s fix verdict prepares the MR with the open entries alone unapplied and listed, never a fix the user decided or a disputed contest', async () => {
  // SF_MAX_ITERATIONS empty: the default, 3 Fix sections.
  const env = await newEnv('limit-default', { SF_REVIEW: 'on', SF_MAX_ITERATIONS: '' });
  const repo = await newRepo(env, 'limit-default-repo', false);
  await putTask(env, repo, 'LIM-1', 'Round limit');
  const fix = (n: number) => ({ verdict: 'fix', summary: `Problem ${n}.`, items: [{ path: 'a.txt', problem: `Problem ${n}.`, expected: `Solved ${n}.`, severity: 'major' }], accepted_sensitive: [] });
  await script(env, [
    { write: { 'a.txt': '1\n' } },
    { write: { 'a.txt': '2\n' }, text: '| R1 | fixed | Done. |' },
    { write: { 'a.txt': '3\n' }, text: '| R2 | fixed | Done. |' },
    { write: { 'a.txt': '4\n' }, text: '| R3 | fixed | Done. |' },
    { write: { '.software-factory/LIM-1.mr.md': mrText('feat(LIM-1): Round limit') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: fix(1) }, { output: fix(2) }, { output: fix(3) }, { output: fix(4) }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'LIM-1' });
    const limited = await waitFor(served, 'LIM-1', 'needs_human', 4);
    assert.deepEqual(limited.error, {
      code: 'iteration_limit',
      message: '3 Fix sections were written, the limit of SF_MAX_ITERATIONS; 1 open blocker or major findings; the user decides how to go on: sf accept takes iteration 4 as it is (the open findings go unapplied and are listed in the MR text), sf say gives a direction.',
    });
    assert.deepEqual((await readFile(join(repo, '.software-factory', 'LIM-1.md'), 'utf8')).match(/^## Fix \d+$/gm), ['## Fix 1', '## Fix 2', '## Fix 3']);
    const jobs = new JobStore(env.state);
    const ledger = await jobs.readLedger('app', 'LIM-1');
    assert.deepEqual(ledger.map((entry) => [entry.id, entry.status]), [['R1', 'fixed'], ['R2', 'fixed'], ['R3', 'fixed'], ['R4', 'open']]);
    // A fix the user decided and a disputed contest are not open entries: the Accept at the limit
    // does not take them (rule 5).
    const r4 = ledger[3]!;
    await jobs.writeLedger('app', 'LIM-1', [
      ...ledger,
      { ...r4, id: 'R5', problem: 'Must fix.', status: 'user_fix', settled: { decision: 'fix', note: '', at: '2026-11-07T10:00:00.000Z' } },
      { ...r4, id: 'R6', problem: 'Disputed.', status: 'contested', evidence: 'a.txt:1', dispute: { reviewer: 'claude', iteration: 4, reason: 'Still wrong.' } },
    ]);

    // Claude's last verdict is fix: Accept still takes the iteration on (SF-131).
    const accepted = await runCli(env, ['accept', 'app', 'LIM-1']);
    assert.equal(accepted.code, 0, accepted.stderr);
    await waitFor(served, 'LIM-1', 'ready_for_human_review', 4);
    const override = await jobs.readGateOverride('app', 'LIM-1', 4);
    assert.deepEqual(override?.unapplied, [{ id: 'R4', path: 'a.txt', problem: 'Problem 4.', expected: 'Solved 4.', severity: 'major' }]);
    assert.doesNotMatch((await jobs.readMrText('app', 'LIM-1'))!, /### Accepted over a stop\n(- .*\n)*- R[56] /);
    assert.match((await jobs.readMrText('app', 'LIM-1'))!, /### Accepted over a stop\n- The user accepted iteration 4 over iteration_limit\.\n- R4 \[major\] `a\.txt`: Problem 4\. Expected: Solved 4\./);
  } finally {
    await stop(served);
  }
});

test('cloud credentials (SF-123): sessionEnvironment passes AWS_*, GOOGLE_* and CLOUD_ML_* only on Bedrock or Vertex; sandboxEnvDenials hides the passed credentials from sandboxed commands, never PATH', () => {
  const env = {
    PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'o', AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's',
    GOOGLE_APPLICATION_CREDENTIALS: '/g.json', CLOUD_ML_REGION: 'r', SF_STATE_DIR: '/x',
  };
  const plain = sessionEnvironment(env);
  assert.deepEqual(Object.keys(plain).filter((name) => /^(AWS|GOOGLE|CLOUD_ML)_/.test(name)), []);
  assert.deepEqual(sandboxEnvDenials(plain), [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }, { name: 'CLAUDE_CODE_OAUTH_TOKEN', mode: 'deny' }]);
  for (const provider of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
    const cloud = sessionEnvironment({ ...env, [provider]: '1' });
    assert.deepEqual([cloud.AWS_ACCESS_KEY_ID, cloud.AWS_SECRET_ACCESS_KEY, cloud.GOOGLE_APPLICATION_CREDENTIALS, cloud.CLOUD_ML_REGION, cloud[provider]], ['a', 's', '/g.json', 'r', '1']);
    const hidden = sandboxEnvDenials(cloud).map((entry) => entry.name);
    assert.deepEqual(hidden.sort(), ['ANTHROPIC_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLOUD_ML_REGION', 'GOOGLE_APPLICATION_CREDENTIALS']);
    assert.ok(!hidden.includes('PATH') && !hidden.includes(provider) && !hidden.includes('HOME'));
  }
  // An empty or plainly off switch is not set; any other value is.
  for (const off of ['', '0', 'false', 'off', 'No']) {
    assert.equal(sessionEnvironment({ ...env, CLAUDE_CODE_USE_BEDROCK: off }).AWS_ACCESS_KEY_ID, undefined, off);
  }
  assert.equal(sessionEnvironment({ ...env, CLAUDE_CODE_USE_VERTEX: 'true' }).AWS_ACCESS_KEY_ID, 'a');
});

test('cloud credentials (SF-123): an Implementer turn adds the denials to the sandbox\'s credentials.envVars after the entries already there', async () => {
  const env = await newEnv('session-env-denials');
  // With the sandbox on, the session starts Claude Code inside bwrap: the fake one.
  useFakeBwrap();
  await mkdir(join(env.home, 'work'), { recursive: true });
  await script(env, [{}]);
  const sandbox: SandboxSettings = { ...sandboxSettings({})!, credentials: { envVars: [{ name: 'MY_TOKEN', mode: 'mask' }] } };
  const saved = { ...process.env };
  Object.assign(process.env, { HOME: env.home, ANTHROPIC_API_KEY: 'sk-fake', CLAUDE_CODE_USE_BEDROCK: '1', AWS_SECRET_ACCESS_KEY: 'aws-fake' });
  try {
    const outcome = await new Promise<IdleOutcome>((resolve) => {
      new ImplementerSession({ cwd: join(env.home, 'work'), maxTurns: 3, claudePath: FAKE, sandbox }, {
        message: async () => undefined, prompt: async () => undefined, idle: async (ended) => resolve(ended),
      }).send('go', []);
    });
    assert.equal(outcome.ok, true);
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in saved)) {
        delete process.env[name];
      }
    }
    Object.assign(process.env, saved);
  }
  const [entry] = await fakeLog(env);
  const settings = JSON.parse(entry!.argv[entry!.argv.indexOf('--settings') + 1]!) as { sandbox: SandboxSettings };
  const envVars = settings.sandbox.credentials?.envVars ?? [];
  assert.deepEqual(envVars[0], { name: 'MY_TOKEN', mode: 'mask' });
  for (const name of ['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY']) {
    assert.ok(envVars.slice(1).some((found) => found.name === name && found.mode === 'deny'), JSON.stringify(envVars));
  }
  assert.ok(!envVars.some((found) => found.name === 'PATH' || found.name === 'CLAUDE_CODE_USE_BEDROCK'));
  // The CLI itself still gets them: Bedrock needs them.
  assert.ok(entry!.env.includes('AWS_SECRET_ACCESS_KEY') && entry!.env.includes('ANTHROPIC_API_KEY'));
});
