// npm run sync-skills: updates the factory's own copies of the agents' skills (skills/, the folder
// the Implementer's wrapper binds read-only on <config dir>/skills) from the installed ones.
//
// 1. The skills are those skills/SOURCE.md lists in its table (one row per skill, its name in the
//    first column, in backticks).
// 2. Each is read from the source folder (--from, default ~/.agents/skills, where the `skills` tool
//    installs them), links followed, and its row from the lock file (--lock, default .skill-lock.json
//    next to the source folder: ~/.agents/.skill-lock.json): { "skills": { "<name>": { "skillPath",
//    "skillFolderHash", "updatedAt", ... } } }.
// 3. A listed skill missing from the source or from the lock file: exit 1 naming it, nothing written.
// 4. Else each skill's folder in the target (--to, default this package's skills/) is replaced whole
//    (stale files go), and SOURCE.md's rows are rewritten: path from skillPath, folder hash from
//    skillFolderHash, date from updatedAt's first 10 characters.
// 5. It prints each changed file (added, changed, removed) relative to the target, and never
//    commits: the change goes through a pull request.
//
// A usage error exits 2.
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_SKILLS = fileURLToPath(new URL('../skills', import.meta.url));
const SOURCE_FILE = 'SOURCE.md';
const USAGE = 'usage: sync-skills [--from <dir>] [--lock <file>] [--to <dir>]';
// A row of SOURCE.md's table: | `<name>` | `<path>` | `<hash>` | <date> |
const ROW = /^\| `([^`]+)` \|.*\|\s*$/;

class UsageError extends Error {}

function parseArgs(args) {
  const options = { from: join(process.env.HOME || homedir(), '.agents', 'skills'), lock: undefined, to: PACKAGE_SKILLS };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--from', '--lock', '--to'].includes(name)) {
      throw new UsageError(`sync-skills: unknown argument ${name}; ${USAGE}`);
    }
    if (args[index + 1] === undefined) {
      throw new UsageError(`sync-skills: ${name} needs a value; ${USAGE}`);
    }
    options[name.slice(2)] = resolve(args[index + 1]);
  }
  return { ...options, lock: options.lock ?? join(dirname(options.from), '.skill-lock.json') };
}

// Every file under dir, links followed: its path relative to dir, its content and mode.
async function files(dir, base = dir, found = new Map()) {
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const info = await stat(path);
    if (info.isDirectory()) {
      await files(path, base, found);
    } else if (info.isFile()) {
      found.set(relative(base, path), { content: await readFile(path), mode: info.mode & 0o777 });
    }
  }
  return found;
}

// The lock file's skills, or an error naming the file.
async function lockedSkills(lock) {
  try {
    const parsed = JSON.parse(await readFile(lock, 'utf8'));
    return parsed !== null && typeof parsed.skills === 'object' && parsed.skills !== null ? parsed.skills : {};
  } catch (error) {
    throw new Error(`sync-skills: cannot read the lock file ${lock}: ${error.message}`);
  }
}

// The row of one skill from its lock entry, or undefined when the entry lacks a field.
function row(name, entry) {
  const { skillPath, skillFolderHash, updatedAt } = entry ?? {};
  if (typeof skillPath !== 'string' || typeof skillFolderHash !== 'string' || typeof updatedAt !== 'string') {
    return undefined;
  }
  return `| \`${name}\` | \`${skillPath}\` | \`${skillFolderHash}\` | ${updatedAt.slice(0, 10)} |`;
}

async function main(args) {
  const { from, lock, to } = parseArgs(args);
  const sourcePath = join(to, SOURCE_FILE);
  const source = await readFile(sourcePath, 'utf8');
  const names = source.split('\n').map((line) => ROW.exec(line)?.[1]).filter((name) => name !== undefined);
  if (names.length === 0) {
    throw new Error(`sync-skills: ${sourcePath} lists no skill.`);
  }
  const locked = await lockedSkills(lock);
  // Everything is read and checked before anything is written.
  const missing = [];
  const copies = new Map();
  const rows = new Map();
  for (const name of names) {
    const folder = join(from, name);
    const lockRow = row(name, locked[name]);
    if (!existsSync(folder) || !(await stat(folder)).isDirectory()) {
      missing.push(`${name} (not in ${from})`);
    } else if (lockRow === undefined) {
      missing.push(`${name} (not in ${lock})`);
    } else {
      copies.set(name, await files(folder));
      rows.set(name, lockRow);
    }
  }
  if (missing.length > 0) {
    throw new Error(`sync-skills: missing skill(s), nothing written: ${missing.join(', ')}`);
  }
  const changes = [];
  for (const [name, copy] of copies) {
    const target = join(to, name);
    const old = existsSync(target) ? await files(target) : new Map();
    for (const [path, file] of copy) {
      const before = old.get(path);
      if (before === undefined) {
        changes.push(`added   ${join(name, path)}`);
      } else if (!before.content.equals(file.content) || before.mode !== file.mode) {
        changes.push(`changed ${join(name, path)}`);
      }
    }
    for (const path of old.keys()) {
      if (!copy.has(path)) {
        changes.push(`removed ${join(name, path)}`);
      }
    }
    await rm(target, { recursive: true, force: true });
    for (const [path, file] of copy) {
      await mkdir(dirname(join(target, path)), { recursive: true });
      await writeFile(join(target, path), file.content);
      await chmod(join(target, path), file.mode);
    }
  }
  const rewritten = source.split('\n').map((line) => {
    const name = ROW.exec(line)?.[1];
    return name === undefined ? line : rows.get(name);
  }).join('\n');
  if (rewritten !== source) {
    await writeFile(sourcePath, rewritten);
    changes.push(`changed ${SOURCE_FILE}`);
  }
  console.log(changes.length === 0 ? 'sync-skills: no changes.' : [`sync-skills: ${changes.length} file(s) changed in ${to}; review and open a pull request:`, ...changes.map((line) => `  ${line}`)].join('\n'));
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
