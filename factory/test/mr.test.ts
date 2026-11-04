// Unit tests for the MR preparation rules: the commit header, the MR text and the commit body, the
// merge request link, the factory's commit (paths, submodules, conflict markers), the push
// protection, the Handbook section extraction, the MR and conflict prompts, the deny list and the
// sandbox settings.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { type FileHandle, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandboxSettings } from '../src/config.js';
import { commitAndRebase, commitBody, commitPaths, continueRebase, filesWithMarkers, gitFailure, mergeRequestLink, mrTextProblem, pushProtection, rebaseInProgress, submodulePaths } from '../src/mr.js';
import { conflictPrompt, FACTORY_PROMPT_RULES, handbookSection, mrPrompt } from '../src/prompts.js';
import { COMMIT_TYPES, commitHeader, DENIED_TOOLS, headerProblem, testingProblem } from '../src/rules.js';
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

test('commitBody takes the non-empty lines of the ## Why section, at most five', () => {
  assert.equal(commitBody(VALID_MR_TEXT), 'x');
  const text = ['feat(T-1): Change', '', '## What', 'w', '## Why', '', 'one', '  ', 'two', 'three', 'four', 'five', 'six', '### Detail', '## How', 'h', ''].join('\n');
  assert.equal(commitBody(text), 'one\ntwo\nthree\nfour\nfive');
  assert.equal(commitBody(text.replace('## Why\n', '## Whyever\n')), '');
  assert.equal(commitBody('feat(T-1): Change\r\n\r\n## Why\r\nBecause.\r\n## How\r\nh\r\n'), 'Because.');
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
    assert.equal(sh(repo, 'log', '-1', '--format=%B'), 'feat(T-1): Change the README\n\nThe README needed it.\nReaders asked.');
    assert.equal(sh(repo, 'show', '--name-only', '--format=', 'HEAD'), 'f.txt\nnew.txt');
    assert.match(sh(repo, 'ls-tree', 'HEAD', 'sub'), new RegExp(`^160000 commit ${sh(repo, 'rev-parse', `${base}:sub`)}\tsub$`));
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
  // The MR text only: the factory commits, rebases and pushes; the commit body is ## Why.
  assert.match(prompt, /^Your only task in this turn: write the MR text to \.software-factory\/T-1\.mr\.md\. Its first line is the title, which is also the commit header by the Git rules below;/m);
  assert.match(prompt, /^The factory commits, rebases and pushes, not you\. .*the body is the non-empty lines of the `## Why` section \(at most five.*Then it rebases that commit onto origin\/main\.$/m);
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
    enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true,
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
