// The code checks npm test runs before the unit tests; npm run check-code runs them alone.
// A size ratchet: a .ts module under src/ or web/ aims to stay under 600 lines (LIMIT). One that
// code-size.json does not list warns past 600 lines and fails past 800 (CEILING); a listed one
// warns past its recorded count and fails past that count plus 100 (GROWTH). A warning asks for a
// split and leaves the check passing; the summary counts the warnings. A listed file that shrank
// by more than 50 lines, fell to 600 lines or fewer, or is gone fails until --update lowers the
// list.
// --update rewrites code-size.json with today's counts and only ever lowers them: it never adds a
// file and never raises a count. Also: no .js file under static/, and every web/X.ts is a
// dashboard script or the script of a page beside it (X.js in DASHBOARD_SCRIPTS or POINT_SCRIPTS
// of src/dashboard.ts). Declaration files (.d.ts) are exempt from those rules. Last, no comment in
// a .ts file under src/ or web/, .d.ts included, cites a ticket (SF- and a number): comments say
// what the code does now; the ticket lives in the commit and the Task file. And every catch without a binding (`catch {`) under src/ or web/ has a
// comment after it on its line, saying why any failure there is fine. Comments, strings and
// templates are told apart by a lexer that follows them across lines (lex), so a ticket or a catch
// in a string, and a catch in a comment, do not count; a file it cannot read to the end fails.
// The root is the package directory: the working directory, or --root.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const LIMIT = 600;
const CEILING = 800;
const GROWTH = 100;
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

// The keywords after which a / starts a regular expression, not a division.
const REGEX_AFTER = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const WORD = /[\w$]/;

// A source read as JavaScript is lexed, its strings, templates, comments and regular expressions
// followed across lines: each line as its code (the content of strings, templates and regular
// expressions and every comment blanked to spaces, so a word in them is not read as code and the
// columns hold) and its comments (every comment character at its column, the rest spaces);
// and clean, whether the source ends outside every string, template and comment. A / starts a
// regular expression after an operator, an opening bracket, a comma, a semicolon or a keyword
// such as return, else a division.
function lex(text) {
  const lines = [];
  let code = '';
  let comment = '';
  // The open contexts: the source's code and each ${} of a template, with their open braces; a
  // template's text.
  const stack = [{ template: false, braces: 0 }];
  let mode = 'code';
  let inClass = false;
  let last = '';
  let word = '';
  const emit = (char, kind) => {
    if (char === '\n') {
      lines.push({ code, comment });
      code = '';
      comment = '';
    } else {
      code += kind === 'code' ? char : ' ';
      comment += kind === 'comment' ? char : ' ';
    }
  };
  const value = () => {
    last = ')';
    word = '';
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    const top = stack.at(-1);
    if (top.template) {
      if (char === '\\') {
        emit(char, 'string');
        if (next !== undefined) emit(next, 'string');
        index += 1;
      } else if (char === '`') {
        emit(char, 'string');
        stack.pop();
        value();
      } else if (char === '$' && next === '{') {
        emit(' ', 'string');
        emit(' ', 'string');
        index += 1;
        stack.push({ template: false, braces: 0 });
        last = '(';
        word = '';
      } else {
        emit(char, 'string');
      }
      continue;
    }
    if (mode === 'line') {
      if (char === '\n') {
        mode = 'code';
        emit(char, 'code');
      } else {
        emit(char, 'comment');
      }
    } else if (mode === 'block') {
      emit(char, 'comment');
      if (char === '*' && next === '/') {
        emit(next, 'comment');
        index += 1;
        mode = 'code';
      }
    } else if (mode === "'" || mode === '"' || mode === 'regex') {
      if (char === '\\') {
        emit(char, 'string');
        if (next !== undefined) emit(next, 'string');
        index += 1;
      } else if (char === '\n') {
        // A string or a regular expression does not span lines: the code goes on.
        mode = 'code';
        emit(char, 'code');
      } else {
        emit(char, 'string');
        if (mode === 'regex' && char === '[') {
          inClass = true;
        } else if (mode === 'regex' && char === ']') {
          inClass = false;
        } else if (char === mode || (mode === 'regex' && char === '/' && !inClass)) {
          mode = 'code';
          value();
        }
      }
    } else if (char === '/' && next === '/') {
      mode = 'line';
      emit(char, 'comment');
    } else if (char === '/' && next === '*') {
      mode = 'block';
      emit(char, 'comment');
      emit(next, 'comment');
      index += 1;
    } else if (char === "'" || char === '"') {
      mode = char;
      emit(char, 'string');
    } else if (char === '`') {
      stack.push({ template: true, braces: 0 });
      emit(char, 'string');
    } else if (char === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last) || REGEX_AFTER.has(word))) {
      mode = 'regex';
      inClass = false;
      emit(char, 'string');
    } else if (char === '}' && top.braces === 0 && stack.length > 1) {
      // The end of a template's ${}: its text goes on.
      stack.pop();
      emit(char, 'string');
    } else {
      if (char === '{') {
        top.braces += 1;
      } else if (char === '}') {
        top.braces -= 1;
      }
      emit(char, 'code');
      if (WORD.test(char)) {
        word = WORD.test(last) ? word + char : char;
        last = char;
      } else if (!/\s/.test(char)) {
        word = '';
        last = char;
      }
    }
  }
  if (code !== '' || comment !== '') {
    lines.push({ code, comment });
  }
  return { lines, clean: stack.length === 1 && (mode === 'code' || mode === 'line') };
}

const BARE_CATCH = /\bcatch\s*\{/g;

// The lexed .ts files under src/ and web/, declaration files included; a file that does not end
// outside every string and comment cannot be read and is a problem of its own.
function sources(root) {
  const isSource = (name) => name.endsWith('.ts');
  return [...files(root, 'src', isSource), ...files(root, 'web', isSource)]
    .map((file) => ({ file, ...lex(readFileSync(join(root, file), 'utf8')) }));
}

function unreadProblems(lexed) {
  return lexed.filter(({ clean }) => !clean)
    .map(({ file }) => `${file}: ends inside a string, a template or a comment, so its comments cannot be checked: check its quotes and regular expressions.`);
}

// A catch without a binding needs, after it on its line, a comment with some text.
function catchProblems(lexed) {
  const problems = [];
  for (const { file, lines } of lexed) {
    lines.forEach(({ code }, index) => {
      for (const match of code.matchAll(BARE_CATCH)) {
        if (lines[index].comment.slice(match.index).replace(/\/\/|\/\*|\*\/|\*/g, '').trim() === '') {
          problems.push(`${file}:${index + 1}: a catch without a binding drops the error: say on its line why any failure is fine, catch { // <why>`);
        }
      }
    });
  }
  return problems;
}

function ticketProblems(lexed) {
  const problems = [];
  for (const { file, lines } of lexed) {
    lines.forEach(({ comment }, index) => {
      const ticket = TICKET.exec(comment);
      if (ticket !== null) {
        problems.push(`${file}:${index + 1}: a comment cites ${ticket[0]}: say what the code does now; the ticket lives in the commit and the Task file.`);
      }
    });
  }
  return problems;
}

// The names of a script list (export const <name> = [...]), read from its line in
// src/dashboard.ts; null when there is none.
function listedScripts(root, name) {
  const path = join(root, 'src', 'dashboard.ts');
  const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const line = new RegExp(`^export const ${name} = \\[([^\\]]*)\\]`, 'm').exec(source);
  return line === null ? null : [...line[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

// The names of DASHBOARD_SCRIPTS; null when there is no such line.
function dashboardScripts(root) {
  return listedScripts(root, 'DASHBOARD_SCRIPTS');
}

// The names of POINT_SCRIPTS; none when there is no such line.
function pointScripts(root) {
  return listedScripts(root, 'POINT_SCRIPTS') ?? [];
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

// The size problems, which fail the check, and the size warnings, which only ask for a split.
function sizeChecks(list, counts) {
  const problems = [];
  const warnings = [];
  for (const [file, recorded] of Object.entries(list)) {
    const count = counts.get(file);
    if (count === undefined) {
      problems.push(`${file} is listed in ${LIST} but is gone: run ${UPDATE}.`);
    } else if (count > recorded + GROWTH) {
      problems.push(`${file} has ${count} lines, more than the ${recorded} ${LIST} allows plus ${GROWTH}: split it.`);
    } else if (count > recorded) {
      warnings.push(`${file} has ${count} lines, ${count - recorded} more than the ${recorded} in ${LIST}: plan a split.`);
    } else if (count <= LIMIT) {
      problems.push(`${file} has ${count} lines, no more than ${LIMIT}: run ${UPDATE} to drop it from ${LIST}.`);
    } else if (recorded - count > SLACK) {
      problems.push(`${file} has ${count} lines, ${recorded - count} fewer than the ${recorded} in ${LIST}: run ${UPDATE} to lower it.`);
    }
  }
  for (const [file, count] of counts) {
    if (file in list) {
      continue;
    }
    if (count > CEILING) {
      problems.push(`${file} has ${count} lines, more than ${CEILING}: split it.`);
    } else if (count > LIMIT) {
      warnings.push(`${file} has ${count} lines, over the ${LIMIT}-line target: plan a split.`);
    }
  }
  return { problems, warnings };
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
  const pages = pointScripts(root);
  for (const file of web) {
    const script = file.slice('web/'.length).replace(/\.ts$/, '.js');
    if (!scripts.includes(script) && !pages.includes(script)) {
      problems.push(`${file}: ${script} is not in DASHBOARD_SCRIPTS or POINT_SCRIPTS of src/dashboard.ts.`);
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
  const lexed = sources(root);
  let list = readList(root);
  if (update) {
    const next = lowered(list, counts);
    const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    writeFileSync(join(root, LIST), `${JSON.stringify(sorted, null, 2)}\n`);
    list = sorted;
  }
  const sizes = sizeChecks(list, counts);
  const problems = [...sizes.problems, ...layoutProblems(root), ...unreadProblems(lexed), ...ticketProblems(lexed), ...catchProblems(lexed)];
  for (const warning of sizes.warnings) {
    console.error(`check-code: warning: ${warning}`);
  }
  for (const problem of problems) {
    console.error(`check-code: ${problem}`);
  }
  if (problems.length === 0) {
    const warned = sizes.warnings.length === 0 ? 'no size warning' : `${sizes.warnings.length} over the ${LIMIT}-line target: see the warnings`;
    console.log(`check-code: ${counts.size} modules, none over the limits (${warned}); no comment cites a ticket; every catch {} says why.`);
  }
  return problems.length === 0 ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
