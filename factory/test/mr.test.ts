// Unit tests for the MR preparation rules: the commit header, the MR text and the commit message, the
// merge request link, the factory's commit (paths, submodules, conflict markers), the push
// protection, the Handbook section extraction, the MR and conflict prompts, the deny list and the
// sandbox settings.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, type FileHandle, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandboxSettings } from '../src/config.js';
import { commitAndRebase, commitPaths, continueRebase, filesWithMarkers, gitFailure, MAX_MR_TEXT_BYTES, mergeRequestLink, mrMessage, mrTextProblem, pushBranch, pushProtection, rebaseInProgress, submodulePaths, withChecks, withNits } from '../src/mr.js';
import { conflictPrompt, FACTORY_PROMPT_RULES, handbookSection, mrPrompt } from '../src/prompts.js';
import { COMMIT_TYPES, commitHeader, DENIED_TOOLS, headerProblem, testingProblem } from '../src/rules.js';
import type { ReviewItem } from '../src/review.js';
import { quickStartSection } from '../src/server.js';

const HANDBOOK = fileURLToPath(new URL('../../HANDBOOK.md', import.meta.url));

const VALID_MR_TEXT = [
  'feat(T-1): Change the README',
  '',
  '## What', 'x', '## Why', 'x', '## How', 'x', '## Why the change', 'x', '## Special things to note', '- None.',
  '## Change outline', 'x', '## Testing', 'x', '## Screenshots', 'N/A', '## Checklist', '- [x] Branch name', '',
].join('\n');

// SF-058: a ## Testing line that claims a manual step nobody ran is refused like a missing heading.
test('mrTextProblem refuses a ## Testing line "By hand" or "Manual" without "not", with the reason', () => {
  const withTesting = (...lines: string[]) => VALID_MR_TEXT.replace('## Testing\nx\n', `## Testing\n${lines.join('\n')}\n`);
  const refused = mrTextProblem('T-1', withTesting('- `npm test`: 412 passed', '- By hand: open the page'));
  assert.equal(refused, 'its ## Testing line "- By hand: open the page" reads as a check that was run; `## Testing` lists only what was run in this job, with its result; anything not run (manual steps, live checks, browsers) goes on a line starting with `Not checked:`, saying who can run it');
  assert.equal(mrTextProblem('T-1', withTesting('- `npm test`: 412 passed', '- Not checked: by hand, open the page (the user, in a browser)')), undefined);
  for (const line of ['By hand, open the page', '* Manual: click Save', '- Manually tested the drawer', '  - **By hand:** open the page', '1. manual check of the board']) {
    assert.match(mrTextProblem('T-1', withTesting(line))!, /^its ## Testing line ".*" reads as a check that was run;/, line);
  }
  for (const line of ['- By hand: not run; the user can open the page', '- Manual check: Not run', '- By hand: cannot run here', '- Nothing by hand', '- Opened by hand: the page loads', '- By handling the error twice: passed']) {
    assert.equal(mrTextProblem('T-1', withTesting(line)), undefined, line);
  }
  // Only the ## Testing section is checked.
  // A "# " line inside a code fence does not end the section.
  assert.match(mrTextProblem('T-1', withTesting('```sh', '# the suite', 'npm test', '```', '- By hand: open the page'))!, /^its ## Testing line "- By hand: open the page"/);
  assert.equal(mrTextProblem('T-1', VALID_MR_TEXT.replace('## How\nx\n', '## How\nBy hand: none of it\nManual wiring of the routes\n')), undefined);
  assert.match(testingProblem(['## Testing', '- By hand: open the page', '## Screenshots', 'Manual'])!, /^its ## Testing line "- By hand: open the page" reads as a check that was run;/);
  assert.equal(testingProblem(['## Testing', '- ran it', '## Checklist', '- By hand']), undefined);
});

test('commitHeader accepts every type with the ticket as scope and refuses the rest', () => {
  for (const type of COMMIT_TYPES) {
    assert.ok(commitHeader('PROJ-12').test(`${type}(PROJ-12): Add the export`), type);
  }
  assert.equal(COMMIT_TYPES.length, 11);
  const header = commitHeader('PROJ-12');
  for (const bad of [
    'feat(PROJ-13): Add the export',
    'feat(PROJ-1): Add the export',
    'feat: Add the export',
    'PROJ-12: Add the export',
    'feature(PROJ-12): Add the export',
    'feat(PROJ-12): Add the export.',
    'feat(PROJ-12):  ',
    'feat(PROJ-12):Add',
  ]) {
    assert.ok(!header.test(bad), bad);
  }
  // A ticket with regex characters is matched literally.
  assert.ok(!commitHeader('A.1').test('fix(AX1): Repair it'));
  const prefix = 'fix(PROJ-12): ';
  assert.ok(header.test(prefix + 'a'.repeat(72 - prefix.length)));
  assert.ok(!header.test(prefix + 'a'.repeat(73 - prefix.length)));
  assert.equal(headerProblem('PROJ-12', 'fix(PROJ-12): Repair it'), undefined);
  assert.equal(headerProblem('PROJ-12', prefix + 'a'.repeat(73 - prefix.length)), 'it has 73 characters, more than 72');
  assert.equal(headerProblem('PROJ-12', 'fix(PROJ-12): Repair it.'), 'it ends with a period');
  assert.match(headerProblem('PROJ-12', 'fix(PROJ-1): Repair it')!, /^it must match "<type>\(PROJ-12\): <imperative summary>"/);
});

test('mrTextProblem checks the title and every required heading but Screenshots', () => {
  assert.equal(mrTextProblem('T-1', VALID_MR_TEXT), undefined);
  assert.equal(mrTextProblem('T-1', VALID_MR_TEXT.replace('## Screenshots\nN/A\n', '')), undefined);
  assert.equal(mrTextProblem('T-1', '  \n'), 'it is empty');
  assert.match(mrTextProblem('T-1', VALID_MR_TEXT.replace('feat(T-1)', 'feat(T-2)'))!, /^its first line "feat\(T-2\): Change the README" is not a valid title/);
  assert.equal(mrTextProblem('T-1', VALID_MR_TEXT.replace('## Why the change\n', '').replace('## Checklist\n', '')), 'it lacks the heading(s) ## Why the change, ## Checklist');
  assert.match(mrTextProblem('T-1', `${VALID_MR_TEXT}${'x'.repeat(64 * 1024)}`)!, /more than 65536/);
  assert.match(mrTextProblem('T-1', VALID_MR_TEXT.replace('README', 'README.'))!, /is not a valid title: it ends with a period$/);
});

test('mergeRequestLink derives GitHub and GitLab pages from https and ssh origin URLs', () => {
  assert.equal(mergeRequestLink('https://github.com/acme/app.git', 'main', 'T-1-x'), 'https://github.com/acme/app/compare/main...T-1-x?expand=1');
  assert.equal(mergeRequestLink('git@github.com:acme/app.git', 'main', 'T-1-x'), 'https://github.com/acme/app/compare/main...T-1-x?expand=1');
  const gitlab = 'merge_requests/new?merge_request[source_branch]=T-1-x&merge_request[target_branch]=develop';
  assert.equal(mergeRequestLink('https://gitlab.example.com/group/sub/app.git', 'develop', 'T-1-x'), `https://gitlab.example.com/group/sub/app/-/${gitlab}`);
  assert.equal(mergeRequestLink('https://user@gitlab.example.com:8443/group/app', 'develop', 'T-1-x'), `https://gitlab.example.com:8443/group/app/-/${gitlab}`);
  assert.equal(mergeRequestLink('git@gitlab.example.com:group/app.git', 'develop', 'T-1-x'), `https://gitlab.example.com/group/app/-/${gitlab}`);
  assert.equal(mergeRequestLink('ssh://git@gitlab.example.com:2222/group/app.git', 'develop', 'T-1-x'), `https://gitlab.example.com/group/app/-/${gitlab}`);
  for (const unparseable of ['/tmp/origin.git', 'file:///tmp/origin.git', '../origin', 'https://github.com/', 'C:\\repos\\app']) {
    assert.equal(mergeRequestLink(unparseable, 'main', 'T-1-x'), undefined, unparseable);
  }
});

test('withChecks puts the factory\'s ### Checks line at the end of ## Testing, replacing any ### Checks there; a lone "- None." stays (SF-128)', () => {
  const text = (testing: string[]): string => ['feat(T-1): Change', '', '## Special things to note', '- None.', '## Testing', ...testing, '## Screenshots', 'N/A', ''].join('\n');
  const line = '- `npm test`: passed in 4 min 12 s on iteration 2.';
  assert.equal(withChecks(text(['npm run lint: passed', '']), line, 2), text(['npm run lint: passed', '', '### Checks', line, '']));
  assert.equal(withChecks(text(['- None.']), line, 2), text(['- None.', '', '### Checks', line, '']));
  // An earlier preparation's (or the user's own) ### Checks is replaced, the rest of ## Testing stays.
  const earlier = text(['- Unit tests.', '', '### Checks', '- `npm test`: passed in 1 s on iteration 1.', '- an extra claim', '']);
  assert.equal(withChecks(earlier, line, 2), text(['- Unit tests.', '', '### Checks', line, '']));
  // The last section of the text.
  assert.equal(withChecks('t\n\n## Testing\n- Unit tests.\n', line, 2), ['t', '', '## Testing', '- Unit tests.', '', '### Checks', line].join('\n'));
  // Without ## Testing the text stays as it is.
  assert.equal(withChecks('t\n\n## What\nx\n', line, 2), 't\n\n## What\nx\n');
  assert.equal(mrTextProblem('T-1', withChecks(VALID_MR_TEXT, line, 2)), undefined);
});

test('withNits puts the factory\'s ### Nits not applied list at the end of ## Special things to note, replacing any there (SF-051)', () => {
  const text = (special: string[]): string => ['feat(T-1): Change', '', '## Why', 'w', '## Special things to note', ...special, '## Testing', 't', ''].join('\n');
  const nitItems: ReviewItem[] = [{ path: 'a.txt', problem: 'Wording.', expected: 'Nicer.', severity: 'nit' }, { path: 'b.txt', problem: 'Naming.', expected: 'Nicer.', severity: 'nit' }];
  const nits = ['- [nit] `a.txt`: Wording. Expected: Nicer.', '- [nit] `b.txt`: Naming. Expected: Nicer.'];
  // A heading inside a code fence is not the section.
  const fencedText = ['feat(T-1): Change', '', '## What', '```', '## Special things to note', '```', '## Special things to note', '- None.', '## Testing', 't'].join('\n');
  assert.equal(withNits(fencedText, nitItems, 2), fencedText.replace('- None.\n## Testing', `### Nits not applied\n${nits.join('\n')}\n\n## Testing`));
  // A lone "- None." goes.
  assert.equal(withNits(text(['- None.', '']), nitItems, 2), text(['### Nits not applied', ...nits, '']));
  // Other notes stay; a list already there (the model's, or an earlier preparation's) is replaced.
  const written = text(['- A migration.', '', '### Nits not applied', '- [nit] `old.txt`: Old.', '```', '## not a heading', '```', '']);
  assert.equal(withNits(written, nitItems, 2), text(['- A migration.', '', '### Nits not applied', ...nits, '']));
  // Without nits only the old list goes.
  assert.equal(withNits(written, [], 2), text(['- A migration.', '']));
  assert.equal(withNits(text(['- None.']), [], 2), text(['- None.']));
  // The last section of the text.
  assert.equal(withNits('feat(T-1): Change\n\n## Special things to note\n- None.\n', nitItems, 2), ['feat(T-1): Change', '', '## Special things to note', '### Nits not applied', ...nits].join('\n'));
  assert.equal(mrTextProblem('T-1', withNits(VALID_MR_TEXT, nitItems, 2)), undefined);
  // Cut to stay within the MR text limit, with a line that counts the rest.
  const big: ReviewItem[] = Array.from({ length: 2000 }, (_, index) => ({ path: `f${index}.txt`, problem: 'x'.repeat(40), expected: 'y', severity: 'nit' }));
  const cut = withNits(text(['- None.']), big, 3);
  assert.ok(Buffer.byteLength(cut) <= MAX_MR_TEXT_BYTES);
  const rest = /^- … and (\d+) more: see review\.json and gate\.json of iteration 3\.$/m.exec(cut);
  assert.ok(rest !== null, cut.slice(-300));
  assert.equal(cut.split('\n').filter((line) => line.startsWith('- [nit]')).length + Number(rest[1]), 2000);
});

test('mrMessage splits the MR text into a title and the whole body, normalised', () => {
  assert.deepEqual(mrMessage(VALID_MR_TEXT), { title: 'feat(T-1): Change the README', body: VALID_MR_TEXT.split('\n').slice(2, -1).join('\n') });
  // CRLF becomes LF, trailing whitespace goes per line, blank lines around the body go; # lines stay.
  const text = 'feat(T-1): Change  \r\n\r\n  \r\n## What \r\nTwo spaces  \r\n\r\n# Not a comment\t\r\n\r\n\r\n';
  assert.deepEqual(mrMessage(text), { title: 'feat(T-1): Change', body: '## What\nTwo spaces\n\n# Not a comment' });
  assert.deepEqual(mrMessage('feat(T-1): Change'), { title: 'feat(T-1): Change', body: '' });
  assert.deepEqual(mrMessage('feat(T-1): Change\n\n \n'), { title: 'feat(T-1): Change', body: '' });
});

test('commitAndRebase makes one commit of the Patch paths without the submodule pointer; filesWithMarkers finds conflict markers', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sf-commit-')));
  try {
    const repo = join(dir, 'repo');
    const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    // A repository identity, so the test does not depend on the developer's Git configuration.
    for (const [key, value] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgsign', 'false']]) {
      sh(repo, 'config', key!, value!);
    }
    await writeFile(join(repo, 'f.txt'), 'f\n');
    await writeFile(join(repo, '.gitignore'), '*.log\n');
    // A submodule as a gitlink: a repository in sub/, recorded with mode 160000.
    execFileSync('git', ['init', '-q', '-b', 'main', join(repo, 'sub')]);
    sh(join(repo, 'sub'), 'commit', '-q', '--allow-empty', '-m', 'sub 1');
    sh(repo, 'add', 'f.txt', '.gitignore');
    sh(repo, 'update-index', '--add', '--cacheinfo', `160000,${sh(join(repo, 'sub'), 'rev-parse', 'HEAD')},sub`);
    sh(repo, 'commit', '-q', '-m', 'base');
    const base = sh(repo, 'rev-parse', 'HEAD');
    // The change: an edit, a new file, an ignored file, and a new commit checked out in the submodule.
    await writeFile(join(repo, 'f.txt'), 'f changed\n');
    await writeFile(join(repo, 'new.txt'), 'new\n');
    await writeFile(join(repo, 'debug.log'), 'ignored\n');
    sh(join(repo, 'sub'), 'commit', '-q', '--allow-empty', '-m', 'sub 2');
    assert.deepEqual(await submodulePaths(repo, ['f.txt', 'sub']), ['sub']);
    assert.deepEqual(await commitPaths(repo, base), ['f.txt', 'new.txt']);

    // A commit already on top of the base (a retry) is replaced: still one commit.
    sh(repo, 'commit', '-q', '--allow-empty', '-m', 'earlier');
    const mrText = VALID_MR_TEXT.replace('## Why\nx', '## Why\nThe README needed it.\nReaders asked.');
    assert.deepEqual(await commitAndRebase(repo, { baseCommit: base, targetCommit: base, mrText }), { kind: 'ready' });
    assert.equal(sh(repo, 'rev-list', '--count', `${base}..HEAD`), '1');
    // The commit message is the whole MR text, every # heading kept, and no message file is left.
    const message = mrMessage(mrText);
    assert.equal(sh(repo, 'log', '-1', '--format=%B'), `${message.title}\n\n${message.body}`);
    // The raw commit object: exactly that message and one final newline.
    const raw = execFileSync('git', ['cat-file', 'commit', 'HEAD'], { cwd: repo, encoding: 'utf8' });
    assert.equal(raw.slice(raw.indexOf('\n\n') + 2), `${message.title}\n\n${message.body}\n`);
    assert.match(message.body, /^## What\nx\n## Why\nThe README needed it\.\nReaders asked\.\n## How\n[^]*\n## Checklist\n- \[x\] Branch name$/);
    await assert.rejects(readFile(join(repo, '.git', 'factory-commit-msg')), { code: 'ENOENT' });
    // Only the submodule's own commit and the ignored file are left; the message file is no change.
    assert.equal(sh(repo, 'status', '--porcelain', '--untracked-files=all', '--ignored'), 'M sub\n!! debug.log');
    assert.equal(sh(repo, 'show', '--name-only', '--format=', 'HEAD'), 'f.txt\nnew.txt');
    assert.match(sh(repo, 'ls-tree', 'HEAD', 'sub'), new RegExp(`^160000 commit ${sh(repo, 'rev-parse', `${base}:sub`)}\tsub$`));
    // A commit that fails (a signing program that fails) is mr_commit_failed; the message file goes too.
    sh(repo, 'config', 'gpg.program', 'false');
    sh(repo, 'config', 'commit.gpgsign', 'true');
    const unsigned = await commitAndRebase(repo, { baseCommit: base, targetCommit: base, mrText });
    assert.equal(unsigned.kind === 'failed' ? unsigned.failure.code : unsigned.kind, 'mr_commit_failed');
    await assert.rejects(readFile(join(repo, '.git', 'factory-commit-msg')), { code: 'ENOENT' });
    sh(repo, 'config', 'commit.gpgsign', 'false');
    // Nothing left to commit against the base: mr_empty.
    sh(repo, 'reset', '-q', '--hard', base);
    const empty = await commitAndRebase(repo, { baseCommit: base, targetCommit: base, mrText });
    assert.equal(empty.kind === 'failed' ? empty.failure.code : empty.kind, 'mr_empty');

    await writeFile(join(repo, 'a.txt'), '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n');
    await writeFile(join(repo, 'b.txt'), 'Title\n=======\n');
    await writeFile(join(repo, 'c.txt'), 'a ======= b\n <<<<<<< not at the start\n');
    assert.deepEqual(await filesWithMarkers(repo, ['a.txt', 'b.txt', 'c.txt', 'missing.txt']), ['a.txt', 'b.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A repository whose change (one commit on base) conflicts with the target in conflict.txt; the
// factory's commit and rebase have stopped on it.
async function stoppedRebase(dir: string): Promise<{ repo: string; sh: (...args: string[]) => string; target: string }> {
  const repo = join(dir, 'repo');
  const sh = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  for (const [key, value] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgsign', 'false']]) {
    sh('config', key!, value!);
  }
  await writeFile(join(repo, 'conflict.txt'), 'base\n');
  await writeFile(join(repo, 'other.txt'), 'other\n');
  sh('add', '.');
  sh('commit', '-q', '-m', 'base');
  const base = sh('rev-parse', 'HEAD');
  await writeFile(join(repo, 'conflict.txt'), 'target\n');
  sh('commit', '-q', '-am', 'target');
  const target = sh('rev-parse', 'HEAD');
  sh('checkout', '-q', '-b', 'change', base);
  await writeFile(join(repo, 'conflict.txt'), 'change\n');
  const prepared = await commitAndRebase(repo, { baseCommit: base, targetCommit: target, mrText: VALID_MR_TEXT });
  assert.deepEqual(prepared, { kind: 'conflict', files: ['conflict.txt'] });
  return { repo, sh, target };
}

test('continueRebase stages every change of the conflict turn, not only the conflicted files, and commits them all', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sf-continue-')));
  try {
    const { repo, sh, target } = await stoppedRebase(dir);
    // The turn resolves the conflict, edits a file that did not conflict and adds one.
    await writeFile(join(repo, 'conflict.txt'), 'target and change\n');
    await writeFile(join(repo, 'other.txt'), 'other, adapted to the target\n');
    await writeFile(join(repo, 'new.txt'), 'new\n');
    const save = async (): Promise<string> => assert.fail('nothing is saved when the rebase continues');
    assert.equal(await continueRebase(repo, { files: ['conflict.txt'], targetCommit: target, save }), undefined);
    assert.equal(sh('rev-parse', 'HEAD~1'), target);
    assert.equal(sh('show', '--name-only', '--format=', 'HEAD'), 'conflict.txt\nnew.txt\nother.txt');
    assert.equal(sh('status', '--porcelain'), '');
    assert.equal(sh('show', 'HEAD:other.txt'), 'other, adapted to the target');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('continueRebase: a continue that fails with only stdout names it, saves the whole resolved worktree as a patch against the target and aborts', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sf-continue-fail-')));
  const path = process.env.PATH;
  try {
    const { repo, sh, target } = await stoppedRebase(dir);
    await writeFile(join(repo, 'conflict.txt'), 'target and change\n');
    await writeFile(join(repo, 'other.txt'), 'other, adapted to the target\n');
    // Larger than any in-memory Git output limit (1 MiB, the Patch's 2 MiB): the patch is not cut.
    const large = Array.from({ length: 100_000 }, (_, index) => `line ${index} of a large resolved file\n`).join('');
    await writeFile(join(repo, 'large.txt'), large);
    const binary = randomBytes(3 * 1024 * 1024);
    await writeFile(join(repo, 'new.bin'), binary);
    // A git that refuses `rebase --continue` on stdout only, with an empty stderr, as the
    // continue of the SF-046 job did.
    const bin = join(dir, 'bin');
    await mkdir(bin);
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    await writeFile(join(bin, 'git'), `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = --continue ]; then echo 'Could not continue: refused on stdout'; exit 1; fi\ndone\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${path}`;
    const resolutionPath = join(dir, 'conflict-resolution.diff');
    const save = async (write: (handle: FileHandle) => Promise<void>): Promise<string> => {
      // Saved while the rebase is still in progress, before the abort.
      assert.equal(await rebaseInProgress(repo), true);
      const handle = await open(resolutionPath, 'w');
      try {
        await write(handle);
      } finally {
        await handle.close();
      }
      return resolutionPath;
    };
    const failure = await continueRebase(repo, { files: ['conflict.txt'], targetCommit: target, save });
    assert.deepEqual(failure, {
      code: 'mr_conflict',
      message: `The rebase had conflicts in conflict.txt; the resolved files are saved in ${resolutionPath}, a patch against ${target}. git rebase failed: Could not continue: refused on stdout. The rebase was aborted.`,
    });
    assert.equal(await rebaseInProgress(repo), false);
    assert.equal(await readFile(join(repo, 'conflict.txt'), 'utf8'), 'change\n');
    // The patch brings the target to the resolved state, the binary file included.
    const patch = await readFile(resolutionPath, 'utf8');
    assert.match(patch, /^\+target and change$/m);
    assert.match(patch, /^\+other, adapted to the target$/m);
    assert.match(patch, /^GIT binary patch$/m);
    sh('checkout', '-q', '--detach', target);
    sh('clean', '-fdq');
    sh('apply', '--index', resolutionPath);
    assert.equal(await readFile(join(repo, 'conflict.txt'), 'utf8'), 'target and change\n');
    assert.equal(await readFile(join(repo, 'other.txt'), 'utf8'), 'other, adapted to the target\n');
    assert.equal(await readFile(join(repo, 'large.txt'), 'utf8'), large);
    assert.deepEqual(await readFile(join(repo, 'new.bin')), binary);
  } finally {
    process.env.PATH = path;
    await rm(dir, { recursive: true, force: true });
  }
});

test('gitFailure says why: stderr, else stdout when stderr is empty, cut at 500 characters', () => {
  assert.equal(gitFailure(['rebase'], { code: 1, stderr: ' error: refused \n', stdout: Buffer.from('ignored') }), 'git rebase failed: error: refused');
  assert.equal(gitFailure(['-c', 'x=y', 'rebase', '--continue'], { code: 1, stderr: '', stdout: Buffer.from('\nCould not continue\n') }), 'git rebase failed: Could not continue');
  assert.equal(gitFailure(['rebase'], { code: 1, stderr: '', stdout: Buffer.from('x'.repeat(600)) }), `git rebase failed: ${'x'.repeat(500)}`);
  assert.equal(gitFailure(['rebase'], { code: null, stderr: '', stdout: Buffer.alloc(0) }), 'git rebase did not finish within 60 s');
});

test('handbookSection extracts by heading and skips "## " lines inside fences; mrPrompt sends them verbatim', async () => {
  const handbook = await readFile(HANDBOOK, 'utf8');
  const rules = handbookSection(handbook, '## Git rules');
  assert.match(rules, /^## Git rules\n\n- The branch is `<ticket>-<slug>`/);
  assert.match(rules, /Header `<type>\(<ticket>\): <imperative summary>`/);
  assert.ok(rules.endsWith('pointer unless the Task file asks for it.'));
  const template = handbookSection(handbook, '## MR template');
  assert.match(template, /^## MR template\n/);
  for (const heading of ['## What', '## Why', '## How', '## Why the change', '## Special things to note', '## Change outline', '## Testing', '## Screenshots', '## Checklist']) {
    assert.match(template, new RegExp(`^${heading}$`, 'm'), heading);
  }
  assert.ok(template.endsWith('- [ ] Browser support verified\n```'));
  // SF-058: the template shows a step that was not run.
  assert.match(template, /^## Testing\n<[^>]*`- Not checked: [^`]+`[^>]*>\n\n## Screenshots$/m);
  assert.doesNotMatch(template, /What the factory never does/);
  assert.equal(quickStartSection(handbook), handbookSection(handbook, '## Quick start'));
  // SF-040: the Context owner plans only; the user starts; the reviewers review.
  const quick = handbookSection(handbook, '## Quick start');
  assert.match(quick, /You never start, review, fix,\s+clean or approve a job/);
  assert.match(quick, /The user reads it and starts the job on the dashboard/);
  assert.match(quick, /`## Review brief`/);
  for (const gone of [/`check`/, /`start`/, /request_fix/, /mark_clean/, /subscri/i, /event/i]) {
    assert.doesNotMatch(handbook, gone);
  }
  const review = handbookSection(handbook, '## Review rules');
  assert.match(review, /the factory sends this section to the Claude review and to the Codex gate/);
  assert.match(review, /A review ends with a verdict: `fix` with its items, or `clean`/);
  assert.throws(() => handbookSection(handbook, '## Nope'), /no "## Nope" section/);

  const input = { ticket: 'T-1', branch: 'T-1-x', targetRef: 'origin/main', targetCommit: 'a'.repeat(40), attempt: 1, handbook };
  const prompt = mrPrompt(input);
  assert.match(prompt, /^MR preparation for T-1 on branch T-1-x\. .*\nTarget: origin\/main at a{40}\.\n/);
  assert.ok(prompt.includes(rules) && prompt.endsWith(template));
  // The MR text only: the factory commits, rebases and pushes; the commit message is the whole MR text.
  assert.match(prompt, /^Your only task in this turn: write the MR text to \.software-factory\/T-1\.mr\.md\. Its first line is the title, which is also the commit header by the Git rules below;/m);
  assert.match(prompt, /^The factory commits, rebases and pushes, not you\. It commits the reviewed change as one commit on this branch; the commit message is the whole MR text: the title as the header, then the body\. Then it rebases that commit onto origin\/main\.$/m);
  assert.doesNotMatch(prompt, /## Why` section|at most five/);
  assert.match(prompt, /^Change no other file and run no Git command that changes the repository; those commands are denied\.$/m);
  assert.doesNotMatch(prompt, /git (add|commit|rebase) /);
  assert.match(prompt, /Do not edit \.software-factory\/T-1\.md;/);
  assert.match(prompt, /^ {2}# Report: T-1, MR preparation 1\n {2}## Done {8}\(the MR title\)\n {2}## Open questions/m);
  assert.ok(!prompt.includes(FACTORY_PROMPT_RULES.split('\n')[1]!));
  assert.doesNotMatch(prompt, /previous attempt/);
  // SF-058: ## Testing lists only what was run; the rest goes on a `Not checked:` line.
  assert.match(prompt, /^`## Testing` lists only what was run in this job, with its result; anything not run \(manual steps, live checks, browsers\) goes on a line starting with `Not checked:`, saying who can run it\.$/m);
  assert.match(mrPrompt({ ...input, attempt: 2, previousError: 'The MR text is missing.' }), /^This is attempt 2\. The previous attempt failed: The MR text is missing\.$/m);

  const conflict = conflictPrompt({ ticket: 'T-1', targetRef: 'origin/main', targetCommit: 'b'.repeat(40), files: ['a.txt', 'src/b.ts'] });
  assert.match(conflict, new RegExp(`^The factory's rebase of T-1 onto origin/main \\(${'b'.repeat(40)}\\) stopped with conflicts in these files:\n- a\\.txt\n- src/b\\.ts\n\n`));
  assert.match(conflict, /Keep the reviewed behaviour and the changes of the target\. Leave no conflict markers/);
  assert.match(conflict, /^Run the checks of these files\.$/m);
  assert.match(conflict, /^Edit other files only as far as the merge needs them to build and pass\. Run no Git command; the factory stages every change and continues the rebase\./m);
  assert.match(conflict, /^ {2}# Report: T-1, conflict resolution\n {2}## Done {8}\(per file: .*\)\n {2}## Checks .*\n {2}## Open questions/m);
});

test('the deny list of every turn, MR preparation included, denies every mutating Git command', () => {
  for (const command of ['add', 'commit', 'rebase', 'restore', 'checkout', 'switch', 'rm', 'mv', 'push', 'reset', 'clean', 'stash', 'merge', 'cherry-pick', 'revert', 'tag', 'branch', 'config', 'update-ref', 'update-index', 'worktree', 'am', 'pull', 'fetch']) {
    assert.ok(DENIED_TOOLS.includes(`Bash(git ${command}:*)`), command);
  }
  for (const rule of ['Bash(sudo:*)', 'EnterWorktree', 'Edit(.git/**)', 'Write(.git/**)', 'Read(**/.env)', 'Write(**/.env.*)']) {
    assert.ok(DENIED_TOOLS.includes(rule), rule);
  }
});

test('sandboxSettings allows the npm registry plus SF_SANDBOX_DOMAINS, local binding and Unix sockets, and SF_SANDBOX=off disables it', () => {
  assert.deepEqual(sandboxSettings({}), {
    enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, filesystem: { disabled: false },
    network: { allowedDomains: ['registry.npmjs.org'], allowLocalBinding: true, allowAllUnixSockets: true },
  });
  assert.deepEqual(sandboxSettings({ SF_SANDBOX_DOMAINS: ' pypi.org, *.example.com ,,registry.npmjs.org' })!.network, {
    allowedDomains: ['registry.npmjs.org', 'pypi.org', '*.example.com'], allowLocalBinding: true, allowAllUnixSockets: true,
  });
  assert.equal(sandboxSettings({ SF_SANDBOX: 'off', SF_SANDBOX_DOMAINS: 'pypi.org' }), undefined);
  assert.throws(() => sandboxSettings({ SF_SANDBOX_DOMAINS: 'https://x' }), /invalid domain/);
});

test('pushProtection refuses main, master and the base branch, and allows a ticket branch', () => {
  for (const [branch, base] of [['main', 'develop'], ['master', 'main'], ['release-1', 'release-1'], ['main', 'main']] as const) {
    const failure = pushProtection(branch, base);
    assert.equal(failure?.code, 'mr_push_protected', `${branch} onto ${base}`);
    assert.match(failure.message, /merge request/);
  }
  assert.equal(pushProtection('T-1-change-readme', 'main'), undefined);
  assert.equal(pushProtection('main-fix', 'master'), undefined);
});

// SF-124: a temporary bare origin.git and its clone repo/ with one commit on main pushed, the
// identity in the repository's configuration.
async function withPushRepo(run: (dir: string, repo: string, sh: (cwd: string, ...args: string[]) => string) => Promise<void>): Promise<void> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sf-push-')));
  const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const repo = join(dir, 'repo');
    sh(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    sh(dir, 'init', '-q', '-b', 'main', repo);
    for (const [key, value] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgsign', 'false']] as const) {
      sh(repo, 'config', key, value);
    }
    sh(repo, 'remote', 'add', 'origin', join(dir, 'origin.git'));
    await writeFile(join(repo, 'f.txt'), 'f\n');
    sh(repo, 'add', 'f.txt');
    sh(repo, 'commit', '-q', '-m', 'base');
    sh(repo, 'push', '-q', 'origin', 'main');
    await run(dir, repo, sh);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('pushBranch pushes past a pre-push hook that would refuse it, and the hook does not run (SF-124)', async () => {
  await withPushRepo(async (dir, repo, sh) => {
    const marker = join(dir, 'pre-push.marker');
    await writeFile(join(repo, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    await chmod(join(repo, '.git', 'hooks', 'pre-push'), 0o755);
    sh(repo, 'switch', '-q', '-c', 'T-1-change');
    sh(repo, 'commit', '-q', '--allow-empty', '-m', 'the change');
    assert.equal(await pushBranch(repo, 'T-1-change', 'main'), undefined);
    assert.equal(sh(join(dir, 'origin.git'), 'rev-parse', 'T-1-change'), sh(repo, 'rev-parse', 'HEAD'));
    assert.equal(await stat(marker).then(() => true, () => false), false);
    // A branch that does not exist fails at git push, with Git's text, as before.
    const missing = await pushBranch(repo, 'T-1-missing', 'main');
    assert.equal(missing?.code, 'mr_push_failed');
    assert.match(missing.message, /^git push origin T-1-missing failed: error: src refspec T-1-missing does not match any/);
  });
});

test('pushBranch sends the job\'s Git LFS objects with git lfs push first, only for LFS paths of the job\'s range, and refuses a changed .lfsconfig (SF-124)', async (t) => {
  await withPushRepo(async (dir, repo, sh) => {
    // A fake git-lfs on PATH: it logs its arguments, and fails a push while the file fail exists.
    const bin = join(dir, 'bin');
    const log = join(dir, 'lfs.log');
    await mkdir(bin);
    await writeFile(join(bin, 'git-lfs'), `#!/bin/sh\necho "$*" >> '${log}'\nif [ "$1" = push ] && [ -e '${join(dir, 'fail')}' ]; then echo 'batch request: 403 Forbidden' >&2; exit 2; fi\nexit 0\n`);
    await chmod(join(bin, 'git-lfs'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path ?? ''}`;
    t.after(() => {
      process.env.PATH = path;
    });
    const lfsCalls = async (): Promise<string[]> => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((line) => line !== '');
    const onOrigin = (branch: string): string => sh(join(dir, 'origin.git'), 'for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`);
    const commitOn = async (branch: string, files: Record<string, string>): Promise<void> => {
      sh(repo, 'switch', '-q', '-c', branch, 'main');
      for (const [name, content] of Object.entries(files)) {
        await writeFile(join(repo, name), content);
      }
      sh(repo, 'add', '--all');
      sh(repo, 'commit', '-q', '-m', branch);
    };

    await writeFile(join(repo, '.gitattributes'), '*.bin filter=lfs\n');
    sh(repo, 'add', '.gitattributes');
    sh(repo, 'commit', '-q', '-m', 'lfs attributes');
    sh(repo, 'push', '-q', 'origin', 'main');
    // Upstream commits on origin/main change .lfsconfig and an LFS file; they are not the job's.
    const other = join(dir, 'other');
    sh(dir, 'clone', '-q', join(dir, 'origin.git'), other);
    await writeFile(join(other, '.lfsconfig'), '[lfs]\n\turl = https://elsewhere.invalid/lfs\n');
    await writeFile(join(other, 'b.bin'), 'b\n');
    sh(other, 'add', '--all');
    sh(other, '-c', 'user.name=o', '-c', 'user.email=o@example.invalid', 'commit', '-q', '-m', 'upstream');
    sh(other, 'push', '-q', 'origin', 'main');
    sh(repo, 'fetch', '-q', 'origin');

    // A range that adds a.bin: git lfs push origin <source> before the branch.
    await commitOn('T-1-lfs', { 'a.bin': 'a\n' });
    assert.equal(await pushBranch(repo, 'T-1-lfs', 'main'), undefined);
    assert.deepEqual(await lfsCalls(), ['version', 'push origin refs/heads/T-1-lfs']);
    assert.equal(onOrigin('T-1-lfs'), sh(repo, 'rev-parse', 'T-1-lfs'));
    // The saved ref of a handed-over job is the source.
    sh(repo, 'update-ref', 'refs/factory/T-1', 'T-1-lfs');
    await rm(log);
    assert.equal(await pushBranch(repo, 'T-1-handed', 'main', 'refs/factory/T-1'), undefined);
    assert.deepEqual(await lfsCalls(), ['version', 'push origin refs/factory/T-1']);

    // A range without an LFS path: no git-lfs at all.
    await rm(log);
    await commitOn('T-2-plain', { 'c.txt': 'c\n' });
    assert.equal(await pushBranch(repo, 'T-2-plain', 'main'), undefined);
    assert.deepEqual(await lfsCalls(), []);
    assert.equal(onOrigin('T-2-plain'), sh(repo, 'rev-parse', 'T-2-plain'));

    // The attributes are those of the pushed commit, not of the checkout's working tree.
    await commitOn('T-3-tree', { 'd.bin': 'd\n' });
    sh(repo, 'checkout', '-q', 'main');
    await writeFile(join(repo, '.gitattributes'), '# edited by hand\n');
    assert.equal(await pushBranch(repo, 'T-3-tree', 'main'), undefined);
    assert.deepEqual(await lfsCalls(), ['version', 'push origin refs/heads/T-3-tree']);
    sh(repo, 'checkout', '-q', '--', '.gitattributes');
    await rm(log);
    await commitOn('T-3-plain', { '.gitattributes': '', 'd.bin': 'd\n' });
    sh(repo, 'checkout', '-q', 'main');
    await writeFile(join(repo, '.gitattributes'), '* filter=lfs\n');
    assert.equal(await pushBranch(repo, 'T-3-plain', 'main'), undefined);
    assert.deepEqual(await lfsCalls(), []);
    sh(repo, 'checkout', '-q', '--', '.gitattributes');

    // A job that changed .lfsconfig: refused, nothing pushed, git-lfs never asked to push.
    await commitOn('T-4-config', { 'a.bin': 'a\n', '.lfsconfig': '[lfs]\n\turl = https://attacker.invalid/lfs\n' });
    assert.deepEqual(await pushBranch(repo, 'T-4-config', 'main'), {
      code: 'mr_push_failed', message: 'refusing to push T-4-config: the job changed .lfsconfig; push it yourself after checking it',
    });
    assert.equal(onOrigin('T-4-config'), '');
    assert.equal((await lfsCalls()).some((line) => line.startsWith('push')), false);

    // R1: git-lfs takes its endpoint from the checkout's .lfsconfig (the working tree's file, else
    // the index's, else HEAD's), not from the pushed commit: one that is not the base's (another
    // job's, handed over to the checkout) is refused too, nothing pushed.
    sh(repo, 'switch', '-q', '-c', 'T-7-other', 'main');
    await writeFile(join(repo, '.lfsconfig'), '[lfs]\n\turl = https://attacker.invalid/lfs\n');
    sh(repo, 'add', '.lfsconfig');
    sh(repo, 'commit', '-q', '-m', 'another job');
    const checkoutRefusal = { code: 'mr_push_failed', message: 'refusing to push T-1-lfs-again: the checkout\'s .lfsconfig is not the one of main; push it yourself after checking it' };
    sh(repo, 'update-ref', 'refs/factory/T-1-again', 'T-1-lfs');
    await rm(log);
    // In the working tree (tracked here; an untracked one is read the same way).
    assert.deepEqual(await pushBranch(repo, 'T-1-lfs-again', 'main', 'refs/factory/T-1-again'), checkoutRefusal);
    // Only in the index.
    await rm(join(repo, '.lfsconfig'));
    assert.deepEqual(await pushBranch(repo, 'T-1-lfs-again', 'main', 'refs/factory/T-1-again'), checkoutRefusal);
    // Only in HEAD.
    sh(repo, 'rm', '-q', '--cached', '.lfsconfig');
    assert.deepEqual(await pushBranch(repo, 'T-1-lfs-again', 'main', 'refs/factory/T-1-again'), checkoutRefusal);
    assert.equal(onOrigin('T-1-lfs-again'), '');
    assert.equal((await lfsCalls()).some((line) => line.startsWith('push')), false);
    sh(repo, 'reset', '-q', '--hard');
    // The base's own .lfsconfig (origin/main's here) in the checkout is fine.
    sh(repo, 'switch', '-q', '--detach', 'origin/main');
    assert.equal(await pushBranch(repo, 'T-1-lfs-again', 'main', 'refs/factory/T-1-again'), undefined);
    assert.deepEqual(await lfsCalls(), ['version', 'version', 'version', 'version', 'push origin refs/factory/T-1-again']);
    assert.equal(onOrigin('T-1-lfs-again'), sh(repo, 'rev-parse', 'T-1-lfs'));

    // A failed git lfs push is mr_push_failed with git-lfs's text, and the branch is not pushed.
    await writeFile(join(dir, 'fail'), '');
    await commitOn('T-5-fail', { 'e.bin': 'e\n' });
    assert.deepEqual(await pushBranch(repo, 'T-5-fail', 'main'), { code: 'mr_push_failed', message: 'git lfs push origin T-5-fail failed: batch request: 403 Forbidden' });
    assert.equal(onOrigin('T-5-fail'), '');
  });
});

test('pushBranch refuses a job that changes Git LFS files when git-lfs is not installed (SF-124)', async (t) => {
  if (spawnSync('git', ['lfs', 'version']).status === 0) {
    t.skip('git-lfs is installed here');
    return;
  }
  await withPushRepo(async (dir, repo, sh) => {
    await writeFile(join(repo, '.gitattributes'), '*.bin filter=lfs\n');
    sh(repo, 'add', '.gitattributes');
    sh(repo, 'commit', '-q', '-m', 'lfs attributes');
    sh(repo, 'push', '-q', 'origin', 'main');
    sh(repo, 'switch', '-q', '-c', 'T-6-lfs');
    await writeFile(join(repo, 'a.bin'), 'a\n');
    sh(repo, 'add', 'a.bin');
    sh(repo, 'commit', '-q', '-m', 'binary');
    assert.deepEqual(await pushBranch(repo, 'T-6-lfs', 'main'), {
      code: 'mr_push_failed', message: 'git push origin T-6-lfs failed: the job changes Git LFS files and git-lfs is not installed',
    });
    assert.equal(sh(join(dir, 'origin.git'), 'for-each-ref', 'refs/heads/T-6-lfs'), '');
  });
});
