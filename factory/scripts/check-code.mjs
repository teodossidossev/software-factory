// The code checks npm test runs before the unit tests; npm run check-code runs them alone.
// A size ratchet: no .ts module under src/ or web/ passes 600 lines, except those code-size.json
// lists, and a listed one may not grow past its recorded count. A listed file that shrank by more
// than 50 lines, fell to 600 lines or fewer, or is gone fails until --update lowers the list.
// --update rewrites code-size.json with today's counts and only ever lowers them: it never adds a
// file and never raises a count. Also: no .js file under static/, and every web/X.ts is a
// dashboard script (X.js in DASHBOARD_SCRIPTS of src/dashboard.ts). Declaration files (.d.ts) are
// exempt from those rules. Last, no comment in a .ts file under src/ or web/, .d.ts included, cites
// a ticket (SF- and a number): comments say what the code does now; the ticket lives in the commit
// and the Task file. A comment is a line that starts with //, /* or *, or the text after a // on a
// code line that is not inside a string. The root is the package directory: the working
// directory, or --root.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const LIMIT = 600;
const SLACK = 50;
const LIST = 'code-size.json';
const UPDATE = 'npm run check-code -- --update';

// Every file under dir (relative to root, with / separators) whose name passes keep.
function files(root, dir, keep) {
  const base = join(root, dir);
  if (!existsSync(base)) {
    return [];
  }
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && keep(entry.name))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

// A file's lines: its \n-separated lines, not counting a final empty one.
function countLines(text) {
  const lines = text.split('\n');
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

const isModule = (name) => name.endsWith('.ts') && !name.endsWith('.d.ts');
const TICKET = /SF-\d+/;

// The comment of a line, or null: the whole line when it starts with //, /* or *; else the text
// from the first // that is not inside a '', "" or `` string. A line-based check: a string or a
// comment that spans lines is read line by line.
function commentOf(line) {
  const text = line.trimStart();
  if (text.startsWith('//') || text.startsWith('/*') || text.startsWith('*')) {
    return text;
  }
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== null) {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '/' && line[index + 1] === '/') {
      return line.slice(index);
    }
  }
  return null;
}

function ticketProblems(root) {
  const problems = [];
  const isSource = (name) => name.endsWith('.ts');
  for (const file of [...files(root, 'src', isSource), ...files(root, 'web', isSource)]) {
    readFileSync(join(root, file), 'utf8').split('\n').forEach((line, index) => {
      const ticket = TICKET.exec(commentOf(line) ?? '');
      if (ticket !== null) {
        problems.push(`${file}:${index + 1}: a comment cites ${ticket[0]}: say what the code does now; the ticket lives in the commit and the Task file.`);
      }
    });
  }
  return problems;
}

// The names of DASHBOARD_SCRIPTS, read from its line in src/dashboard.ts; null when there is none.
function dashboardScripts(root) {
  const path = join(root, 'src', 'dashboard.ts');
  const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const line = /^export const DASHBOARD_SCRIPTS = \[([^\]]*)\]/m.exec(source);
  return line === null ? null : [...line[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

function readList(root) {
  const path = join(root, LIST);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

// The list --update writes: each listed file still over the limit, at the lower of its recorded
// and today's count. No file is added and no count raised.
function lowered(list, counts) {
  const next = {};
  for (const [file, recorded] of Object.entries(list)) {
    const count = counts.get(file);
    if (count !== undefined && count > LIMIT) {
      next[file] = Math.min(recorded, count);
    }
  }
  return next;
}

function sizeProblems(list, counts) {
  const problems = [];
  for (const [file, recorded] of Object.entries(list)) {
    const count = counts.get(file);
    if (count === undefined) {
      problems.push(`${file} is listed in ${LIST} but is gone: run ${UPDATE}.`);
    } else if (count > recorded) {
      problems.push(`${file} has ${count} lines, more than the ${recorded} ${LIST} allows: make it smaller, do not let it grow.`);
    } else if (count <= LIMIT) {
      problems.push(`${file} has ${count} lines, no more than ${LIMIT}: run ${UPDATE} to drop it from ${LIST}.`);
    } else if (recorded - count > SLACK) {
      problems.push(`${file} has ${count} lines, ${recorded - count} fewer than the ${recorded} in ${LIST}: run ${UPDATE} to lower it.`);
    }
  }
  for (const [file, count] of counts) {
    if (!(file in list) && count > LIMIT) {
      problems.push(`${file} has ${count} lines, more than ${LIMIT}: split it.`);
    }
  }
  return problems;
}

function layoutProblems(root) {
  const problems = files(root, 'static', (name) => name.endsWith('.js'))
    .map((file) => `${file}: static/ holds no script; the dashboard's scripts are web/*.ts.`);
  const web = files(root, 'web', isModule);
  if (web.length === 0) {
    return problems;
  }
  const scripts = dashboardScripts(root);
  if (scripts === null) {
    return [...problems, `src/dashboard.ts has no line export const DASHBOARD_SCRIPTS = [...].`];
  }
  for (const file of web) {
    const script = file.slice('web/'.length).replace(/\.ts$/, '.js');
    if (!scripts.includes(script)) {
      problems.push(`${file}: ${script} is not in DASHBOARD_SCRIPTS of src/dashboard.ts.`);
    }
  }
  return problems;
}

function parseArgs(args) {
  let root = process.cwd();
  let update = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--update') {
      update = true;
    } else if (args[index] === '--root' && args[index + 1] !== undefined) {
      root = resolve(args[index + 1]);
      index += 1;
    } else {
      throw new Error(`check-code: unknown argument ${args[index]}; usage: check-code [--root <dir>] [--update]`);
    }
  }
  return { root, update };
}

function main(args) {
  const { root, update } = parseArgs(args);
  const counts = new Map([...files(root, 'src', isModule), ...files(root, 'web', isModule)]
    .map((file) => [file, countLines(readFileSync(join(root, file), 'utf8'))]));
  let list = readList(root);
  if (update) {
    const next = lowered(list, counts);
    const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    writeFileSync(join(root, LIST), `${JSON.stringify(sorted, null, 2)}\n`);
    list = sorted;
  }
  const problems = [...sizeProblems(list, counts), ...layoutProblems(root), ...ticketProblems(root)];
  for (const problem of problems) {
    console.error(`check-code: ${problem}`);
  }
  if (problems.length === 0) {
    console.log(`check-code: ${counts.size} modules, none over ${LIMIT} lines or past ${LIST}; no comment cites a ticket.`);
  }
  return problems.length === 0 ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
