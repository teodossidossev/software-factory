// SF-124: no factory Git call runs a repository hook or an fsmonitor, enforced in git.ts: the hooks
// of a pushed, committed or checked-out repository and its fsmonitor never run through runGit and
// its siblings, a caller cannot switch that off, and no other module of src/ starts `git` (a scan of
// every spawn and exec call).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runGit, runGitToFile, runGitToHash, streamGitRecords } from '../src/git.js';
import { addWorktree } from '../src/worktree.js';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

// The commands of src/ that are not literals, as `file: argument text` (file relative to src/).
// Every one of them is checked not to be Git by review: adding to this list is a reviewed change.
const COMPUTED: readonly string[] = [
  'update.ts: file',
  'service.ts: file',
  'notify.ts: executable',
  'runner.ts: process.execPath',
  'cli.ts: script',
  'cli.ts: sf',
  'gate.ts: options.codexPath',
  'gate.ts: codexPath',
  'browser.ts: LAUNCHER',
  'live-smoke.ts: process.execPath',
];

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

// A hook or fsmonitor script that appends its name to the marker file.
async function writeMarkerScript(path: string, marker: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\necho "$0" >> '${marker}'\nexit 0\n`);
  await chmod(path, 0o755);
}

// A temporary directory with a bare origin.git and a clone repo/ of it, one commit on main, the
// identity in the repository's configuration.
async function withRepo(run: (dir: string, repo: string) => Promise<void>): Promise<void> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sf-git-')));
  try {
    const repo = join(dir, 'repo');
    git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    git(dir, 'init', '-q', '-b', 'main', repo);
    for (const [key, value] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgsign', 'false']] as const) {
      git(repo, 'config', key, value);
    }
    git(repo, 'remote', 'add', 'origin', join(dir, 'origin.git'));
    await writeFile(join(repo, 'f.txt'), 'f\n');
    git(repo, 'add', 'f.txt');
    git(repo, 'commit', '-q', '-m', 'base');
    await run(dir, repo);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a push through runGit does not run the repository\'s pre-push hook', async () => {
  await withRepo(async (dir, repo) => {
    const marker = join(dir, 'pre-push.marker');
    await writeMarkerScript(join(repo, '.git', 'hooks', 'pre-push'), marker);
    const pushed = await runGit(repo, ['push', 'origin', 'main:main']);
    assert.equal(pushed.code, 0, pushed.stderr);
    assert.equal(git(join(dir, 'origin.git'), 'rev-parse', 'main'), git(repo, 'rev-parse', 'main'));
    assert.equal(await exists(marker), false);
    // The hook is live: Git run directly runs it.
    git(repo, 'push', '-q', 'origin', 'main:refs/heads/control');
    assert.equal(await exists(marker), true);
  });
});

test('with core.hooksPath=.husky, addWorktree, a commit and a switch through runGit run no tracked hook, also when the environment sets the hooks path', async () => {
  await withRepo(async (dir, repo) => {
    const marker = join(dir, 'husky.marker');
    await mkdir(join(repo, '.husky'));
    await writeMarkerScript(join(repo, '.husky', 'post-checkout'), marker);
    await writeMarkerScript(join(repo, '.husky', 'pre-commit'), marker);
    git(repo, 'add', '.husky');
    git(repo, 'commit', '-q', '-m', 'hooks');
    git(repo, 'config', 'core.hooksPath', '.husky');

    await addWorktree(repo, join(dir, 'wt'), 'job', { create: true, ref: 'main' });
    assert.equal(git(join(dir, 'wt'), 'branch', '--show-current'), 'job');
    const committed = await runGit(repo, ['commit', '-q', '--allow-empty', '-m', 'by the factory']);
    assert.equal(committed.code, 0, committed.stderr);
    const switched = await runGit(repo, ['switch', '-q', '-c', 'other']);
    assert.equal(switched.code, 0, switched.stderr);
    // An environment variable does not switch the hooks back on: the -c of git.ts wins.
    const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '.husky' };
    const envCommit = await runGit(repo, ['commit', '-q', '--allow-empty', '-m', 'with env'], 1024 * 1024, undefined, env);
    assert.equal(envCommit.code, 0, envCommit.stderr);
    assert.equal(await exists(marker), false);

    // The hooks are live: Git run directly runs both.
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'control');
    git(repo, 'switch', '-q', 'main');
    assert.deepEqual((await readFile(marker, 'utf8')).trim().split('\n').map((line) => line.split('/').at(-1)), ['pre-commit', 'post-checkout']);
  });
});

test('runGit, runGitToFile, runGitToHash and streamGitRecords run no fsmonitor', async () => {
  await withRepo(async (dir, repo) => {
    const marker = join(dir, 'fsmonitor.marker');
    const script = join(dir, 'fsmonitor.sh');
    await writeMarkerScript(script, marker);
    git(repo, 'config', 'core.fsmonitor', script);

    assert.equal((await runGit(repo, ['status'])).code, 0);
    const out = await open(join(dir, 'status.out'), 'w');
    try {
      assert.equal((await runGitToFile(repo, ['status'], out.fd)).code, 0);
    } finally {
      await out.close();
    }
    assert.equal((await runGitToHash(repo, ['status'], createHash('sha256'))).code, 0);
    assert.equal((await streamGitRecords(repo, ['status'], 0x0a, () => {})).code, 0);
    assert.equal(await exists(marker), false);

    // The fsmonitor is live: Git run directly runs it.
    git(repo, 'status');
    assert.equal(await exists(marker), true);
  });
});

test('a caller\'s own -c or --config-env cannot set core.hooksPath or core.fsmonitor; the same values as git.ts\'s pass', async () => {
  await withRepo(async (_dir, repo) => {
    for (const args of [
      ['-c', 'core.hooksPath=.husky', 'status'],
      ['-c', 'CORE.HOOKSPATH=.husky', 'status'],
      ['-c', 'core.fsmonitor=true', 'status'],
      ['-c', 'core.fsmonitor', 'status'],
      ['--config-env=core.hooksPath=HOOKS', 'status'],
      ['--config-env', 'core.fsmonitor=MONITOR', 'status'],
      ['-c', 'user.name=x', '-c', 'core.hooksPath=hooks', 'status'],
      ['-C', repo, '-c', 'core.hooksPath=.husky', 'status'],
      ['--git-dir', join(repo, '.git'), '-c', 'core.fsmonitor=true', 'status'],
    ]) {
      await assert.rejects(runGit(repo, args), /refusing a factory Git call that sets core\.(hookspath|fsmonitor)/, args.join(' '));
    }
    await assert.rejects(runGitToHash(repo, ['-c', 'core.hooksPath=.husky', 'status'], createHash('sha256')), /refusing/);
    await assert.rejects(streamGitRecords(repo, ['-c', 'core.hooksPath=.husky', 'status'], 0x0a, () => {}), /refusing/);
    // live-smoke.ts's wrapper repeats git.ts's own value; a later argument named like it is not an option.
    assert.equal((await runGit(repo, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'status'])).code, 0);
    assert.equal((await runGit(repo, ['log', '-1', '--format=%s', '--grep', 'core.hooksPath=x'])).code, 0);
  });
});

// --- The scan: every `git` process starts in git.ts. ---

type Kind = 'code' | 'comment' | 'string' | 'template' | 'regex';

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'void', 'delete', 'throw', 'new', 'else', 'do', 'yield', 'await', 'instanceof']);

// The kind of every character of a TypeScript source: code, or inside a comment, a string, the text
// of a template literal (its ${} expressions are code) or a regular expression literal; and where
// each string and template literal that starts at an index ends (the index after it).
function lex(source: string): { kinds: Kind[]; ends: Map<number, number> } {
  const kinds: Kind[] = new Array<Kind>(source.length).fill('code');
  const ends = new Map<number, number>();
  // One entry per open template ${: the brace depth inside it and where its template starts.
  const open: Array<{ depth: number; start: number }> = [];
  let depth = 0;
  let index = 0;
  const mark = (from: number, to: number, kind: Kind) => kinds.fill(kind, from, to);
  // Reads the text of the template that starts at literal from index to its closing ` or a ${.
  const templateText = (literal: number) => {
    const from = index;
    while (index < source.length) {
      if (source[index] === '\\') {
        index += 2;
      } else if (source[index] === '`') {
        index += 1;
        ends.set(literal, index);
        break;
      } else if (source.startsWith('${', index)) {
        index += 2;
        open.push({ depth, start: literal });
        break;
      } else {
        index += 1;
      }
    }
    mark(from, index, 'template');
  };
  const regexAllowed = (at: number): boolean => {
    let back = at - 1;
    while (back >= 0 && (/\s/.test(source[back]!) || kinds[back] === 'comment')) {
      back -= 1;
    }
    if (back < 0) {
      return true;
    }
    if (/[\w$]/.test(source[back]!)) {
      return KEYWORDS_BEFORE_REGEX.has(/[\w$]+$/.exec(source.slice(0, back + 1))![0]);
    }
    return kinds[back] !== 'code' ? kinds[back] === 'comment' : !/[)\]}]/.test(source[back]!);
  };
  while (index < source.length) {
    const char = source[index]!;
    const start = index;
    if (source.startsWith('//', index)) {
      index = source.indexOf('\n', index);
      index = index < 0 ? source.length : index;
      mark(start, index, 'comment');
    } else if (source.startsWith('/*', index)) {
      index = source.indexOf('*/', index + 2);
      index = index < 0 ? source.length : index + 2;
      mark(start, index, 'comment');
    } else if (char === '\'' || char === '"') {
      index += 1;
      while (index < source.length && source[index] !== char && source[index] !== '\n') {
        index += source[index] === '\\' ? 2 : 1;
      }
      index += 1;
      mark(start, index, 'string');
      ends.set(start, index);
    } else if (char === '`') {
      index += 1;
      templateText(start);
      kinds[start] = 'template';
    } else if (char === '/' && regexAllowed(index)) {
      index += 1;
      let inClass = false;
      while (index < source.length && source[index] !== '\n' && (inClass || source[index] !== '/')) {
        if (source[index] === '\\') {
          index += 1;
        } else if (source[index] === '[') {
          inClass = true;
        } else if (source[index] === ']') {
          inClass = false;
        }
        index += 1;
      }
      index += 1;
      while (index < source.length && /[a-z]/i.test(source[index]!)) {
        index += 1;
      }
      mark(start, index, 'regex');
    } else if (char === '}' && open.length > 0 && open.at(-1)!.depth === depth) {
      const literal = open.pop()!.start;
      templateText(literal);
      kinds[start] = 'template';
    } else {
      depth += char === '{' ? 1 : char === '}' ? -1 : 0;
      index += 1;
    }
  }
  return { kinds, ends };
}

const CALL = /(?<![\w$#])(spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(/g;

// The problems of one source file (path relative to src/): every call of a process function
// whose first argument is a string or template literal with the command word git (any call, the
// excluded ones too), or is computed and not on COMPUTED. Excluded from the computed rule:
// `deps.spawn` (run-tests' injected spawn) and a `.exec(` member call (a RegExp's) whose receiver
// is not child_process bound to a name. Two rules beyond the Task's, which no source trips today:
// a template literal whose command word is a ${} expression counts as computed, and a process
// function imported from child_process under another name fails (the scan would miss its calls).
function scanSource(file: string, source: string, computed: readonly string[] = COMPUTED): string[] {
  const { kinds, ends } = lex(source);
  const problems: string[] = [];
  const lineOf = (at: number): number => source.slice(0, at).split('\n').length;
  // child_process bound to a name (import * as cp, a default import, require): cp.exec( is a call.
  const processModules = new Set<string>();
  for (const bound of source.matchAll(/import\s+(?:\*\s+as\s+)?([\w$]+)\s+from\s+['"](?:node:)?child_process['"]|([\w$]+)\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\)/g)) {
    processModules.add(bound[1] ?? bound[2]!);
  }
  // A process function imported under another name would escape the scan.
  for (const imported of source.matchAll(/import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g)) {
    for (const alias of imported[1]!.matchAll(/\b(spawn|spawnSync|execFile|execFileSync|exec|execSync)\s+as\s+([\w$]+)/g)) {
      problems.push(`${file}:${lineOf(imported.index)}: ${alias[1]} imported as ${alias[2]}`);
    }
  }
  for (const match of source.matchAll(CALL)) {
    const name = match[1]!;
    const at = match.index;
    if (kinds[at] !== 'code') {
      continue;
    }
    let back = at - 1;
    while (back >= 0 && /\s/.test(source[back]!)) {
      back -= 1;
    }
    const member = source[back] === '.';
    const receiver = member ? /[\w$]*$/.exec(source.slice(0, source[back - 1] === '?' ? back - 1 : back))![0] : '';
    const excluded = member && !processModules.has(receiver) && (name === 'exec' || (name === 'spawn' && receiver === 'deps'));
    // The first argument: from after the parenthesis, comments and blanks skipped.
    let start = at + match[0].length;
    while (start < source.length && (/\s/.test(source[start]!) || kinds[start] === 'comment')) {
      start += 1;
    }
    const where = `${file}:${lineOf(at)}`;
    const literalEnd = ends.get(start);
    if (literalEnd !== undefined) {
      const text = source.slice(start + 1, literalEnd - 1);
      const word = text.trim().split(/\s+/)[0] ?? '';
      if (word.split(/[\\/]/).at(-1)!.replace(/\.exe$/i, '') === 'git') {
        problems.push(`${where}: ${name}(${source.slice(start, literalEnd)}, …) starts git outside git.ts`);
        continue;
      }
      // A template whose command word is a ${} expression is a computed command.
      if (source[start] !== '`' || !/\$\{/.test(word)) {
        continue;
      }
    }
    if (excluded) {
      continue;
    }
    let end = start;
    let nested = 0;
    while (end < source.length && !(nested === 0 && kinds[end] === 'code' && (source[end] === ',' || source[end] === ')'))) {
      if (kinds[end] === 'code' && '([{'.includes(source[end]!)) {
        nested += 1;
      } else if (kinds[end] === 'code' && ')]}'.includes(source[end]!)) {
        nested -= 1;
      }
      end += 1;
    }
    const argument = source.slice(start, end).replace(/\s+/g, ' ').trim();
    if (!computed.includes(`${file}: ${argument}`)) {
      problems.push(`${where}: ${name}(${argument}, …) is not on COMPUTED`);
    }
  }
  return problems.sort((a, b) => Number(a.split(':')[1]) - Number(b.split(':')[1]));
}

test('the scan fails a git literal and a computed command off the list, by file and line, and passes the rest', () => {
  const source = [
    "import { spawn, execFileSync, exec } from 'node:child_process';",
    "spawn('git', ['push']);",
    'execFileSync("git", []);',
    "exec('git status');",
    'spawn(`/usr/bin/git`, []);',
    'spawn(`${dir}/git --version`);',
    "deps.spawn('git', []);",
    "spawn('node', ['-v']);",
    'spawn(`codex ${flag}`, []);',
    "execFileSync('gitk');",
    'spawn(file, []);',
    'spawn(other, []);',
    'spawn(\n  /* the tool */ process.execPath,\n  []);',
    '/^(\\d+)\\t/.exec(token);',
    'PATTERN.exec(name)?.[1];',
    'deps.spawn(process.execPath, []);',
    "// spawn('git', ['push']);",
    "const text = \"spawn('git')\";",
    'const later = `spawn(\'git\') ${spawn(\'git\')}`;',
    'this.#spawn(args);',
    "const ratio = a / b; spawn('ls'); const r = /'/; spawn(cmd);",
    "import * as cp from 'node:child_process';",
    'cp.exec(command);',
    'spawn(`${tool} --version`);',
    "import { execFile as run } from 'child_process';",
  ].join('\n');
  assert.deepEqual(scanSource('x.ts', source, ['x.ts: file', 'x.ts: process.execPath']), [
    "x.ts:2: spawn('git', …) starts git outside git.ts",
    'x.ts:3: execFileSync("git", …) starts git outside git.ts',
    "x.ts:4: exec('git status', …) starts git outside git.ts",
    'x.ts:5: spawn(`/usr/bin/git`, …) starts git outside git.ts',
    'x.ts:6: spawn(`${dir}/git --version`, …) starts git outside git.ts',
    "x.ts:7: spawn('git', …) starts git outside git.ts",
    'x.ts:12: spawn(other, …) is not on COMPUTED',
    "x.ts:21: spawn('git', …) starts git outside git.ts",
    'x.ts:23: spawn(cmd, …) is not on COMPUTED',
    'x.ts:25: exec(command, …) is not on COMPUTED',
    'x.ts:26: spawn(`${tool} --version`, …) is not on COMPUTED',
    'x.ts:27: execFile imported as run',
  ]);
  // The same computed call in another file is not on the list.
  assert.deepEqual(scanSource('y.ts', 'spawn(file, []);', ['x.ts: file']), ['y.ts:1: spawn(file, …) is not on COMPUTED']);
});

test('no module of src/ but git.ts starts git: every spawn and exec call has a non-git literal or a COMPUTED command', async () => {
  const files = (await readdir(SRC, { recursive: true })).filter((file) => file.endsWith('.ts') && file !== 'git.ts').sort();
  assert.ok(files.length > 50, `found only ${files.length} files under ${SRC}`);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const source = await readFile(join(SRC, file), 'utf8');
    problems.push(...scanSource(file.split('\\').join('/'), source));
    for (const entry of COMPUTED.filter((pair) => pair.startsWith(`${file}: `))) {
      if (scanSource(file, source, COMPUTED.filter((pair) => pair !== entry)).some((problem) => problem.endsWith(`(${entry.slice(file.length + 2)}, …) is not on COMPUTED`))) {
        seen.add(entry);
      }
    }
  }
  assert.deepEqual(problems, []);
  // Every entry of the list is still a real call; a stale one would hide nothing but mislead.
  assert.deepEqual(COMPUTED.filter((entry) => !seen.has(entry)), []);
});
