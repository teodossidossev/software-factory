// The norms the user tunes by hand, at once and per workspace: the size of a change slice, the
// lead-time target of a task by its size, and the globs of the documents that hold a workspace's
// product decisions. In <config dir>/norms.json (beside workspaces.json), every key optional; read
// at each use (no cache, no restart), written only by the user. A value comes from the workspace's
// entry, else the file's top level, else the default; slice and lead_time_hours merge key by key,
// decision_docs is replaced as a whole. A bad file never stops anything: a missing one is the
// defaults, one that is not JSON the defaults with one problem, a bad value falls back to the next
// source with one problem naming its key, an unknown key is ignored and listed. Nothing reads the
// values yet. Below, sf norms of src/commands.ts's table (spread into its COMMANDS) and its lines.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Answer, Command, Result } from './commands.js';
import { configDir } from './registry.js';

export interface Norms {
  // A slice that changes behaviour: the most added plus removed lines (tests included) and the most
  // changed files; under min_lines it should join its neighbour.
  slice: { change_max_lines: number; change_max_files: number; min_lines: number };
  // The target from a job's start to its merge request, by the Task's size.
  lead_time_hours: { small: number; medium: number; complex: number };
  // The globs, relative to the checkout, of the documents that hold the product's decisions.
  decision_docs: string[];
}
export type NormSource = 'default' | 'file' | 'workspace';
export interface NormsResult { norms: Norms; sources: Record<string, NormSource>; problems: string[] }

export const NORMS_FILE = 'norms.json';
export const normsFile = (dir: string): string => join(dir, NORMS_FILE);

export const DEFAULT_NORMS: Readonly<Norms> = Object.freeze({
  slice: Object.freeze({ change_max_lines: 400, change_max_files: 10, min_lines: 50 }),
  lead_time_hours: Object.freeze({ small: 2, medium: 4, complex: 8 }),
  decision_docs: Object.freeze(['GLOSSARY.md', 'docs/adr/**/*.md', 'docs/decisions/**/*.md', 'docs/terminology.md', 'docs/architecture.md']) as string[],
});

const SLICE_KEYS = ['change_max_lines', 'change_max_files', 'min_lines'] as const;
const HOURS_KEYS = ['small', 'medium', 'complex'] as const;
const LEVEL_KEYS = ['slice', 'lead_time_hours', 'decision_docs'];
const FILE_KEYS = ['version', ...LEVEL_KEYS, 'workspaces'];

export const MAX_DECISION_DOCS = 50;
export const MAX_GLOB_CHARS = 200;
const MAX_SHOWN_CHARS = 40;

// A value's rule, and what the problem says when it is broken.
interface Rule { ok(value: unknown): boolean; wrong: string }
const SLICE_RULE: Rule = { ok: (value) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 100_000, wrong: 'not an integer from 1 to 100000' };
const HOURS_RULE: Rule = { ok: (value) => typeof value === 'number' && value > 0 && value <= 1000, wrong: 'not a number above 0 and at most 1000' };
const PARTS = [['slice', SLICE_KEYS, SLICE_RULE], ['lead_time_hours', HOURS_KEYS, HOURS_RULE]] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// A glob relative to the checkout that cannot leave it: '/' separators only, no leading '/' or
// './', no '..' segment, no NUL; 1 to 200 characters ('~' is a plain character: Node's glob does not
// expand it to the home directory). No braces, parentheses or square brackets
// either: a brace's or an extglob's alternative expands on its own ('{/tmp,docs}/x.md' to
// '/tmp/x.md', '{..,docs}/x.md' to '../x.md'), and a character class of one character is that
// character (Node's glob reads 'docs/[.][.]/x.md' as 'docs/../x.md').
export function isDecisionGlob(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_GLOB_CHARS && !/[\\\0{}()[\]]/.test(value)
    && !value.startsWith('/') && !value.startsWith('./') && !value.split('/').includes('..');
}

// A value as a problem shows it: its JSON, cut to 40 characters.
function shown(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch { // a value JSON cannot write (only from a caller, never from a parsed file)
    text = String(value);
  }
  const chars = Array.from(text);
  return chars.length > MAX_SHOWN_CHARS ? `${chars.slice(0, MAX_SHOWN_CHARS - 1).join('')}…` : text;
}

// A key of the file as a problem names it: as it is when plain, else its JSON cut to 40 characters
// (a problem stays one line).
const keyName = (key: string): string => (/^[\w.-]{1,64}$/.test(key) ? key : shown(key));

const notObject = (path: string, value: unknown): string => `${path}: not an object (got ${shown(value)}), ignored`;

// A bad value: its fallback is known only once every level is read.
interface BadValue { path: string; key: string; wrong: string; got: unknown }
// One level's valid values by key (slice.min_lines, decision_docs), and its problems in order.
interface Level { values: Map<string, unknown>; issues: Array<string | BadValue> }

// One level (the file's top level, or a workspace's entry): its unknown keys, then each part.
function readLevel(data: Record<string, unknown>, prefix: string, known: readonly string[]): Level {
  const level: Level = { values: new Map(), issues: [] };
  for (const key of Object.keys(data).filter((name) => !known.includes(name))) {
    level.issues.push(`${prefix}${keyName(key)}: unknown key, ignored`);
  }
  for (const [part, keys, rule] of PARTS) {
    if (!Object.hasOwn(data, part)) {
      continue;
    }
    const object = data[part];
    if (!isRecord(object)) {
      level.issues.push(notObject(`${prefix}${part}`, object));
      continue;
    }
    for (const key of Object.keys(object).filter((name) => !(keys as readonly string[]).includes(name))) {
      level.issues.push(`${prefix}${part}.${keyName(key)}: unknown key, ignored`);
    }
    for (const key of keys.filter((name) => Object.hasOwn(object, name))) {
      const value = object[key];
      if (rule.ok(value)) {
        level.values.set(`${part}.${key}`, value);
      } else {
        level.issues.push({ path: `${prefix}${part}.${key}`, key: `${part}.${key}`, wrong: rule.wrong, got: value });
      }
    }
  }
  if (Object.hasOwn(data, 'decision_docs')) {
    const list = data.decision_docs;
    const path = `${prefix}decision_docs`;
    const bad = Array.isArray(list) ? list.findIndex((entry) => !isDecisionGlob(entry)) : -1;
    if (!Array.isArray(list) || list.length > MAX_DECISION_DOCS) {
      level.issues.push({ path, key: 'decision_docs', wrong: `not a list of at most ${MAX_DECISION_DOCS} globs`, got: list });
    } else if (bad >= 0) {
      level.issues.push({ path: `${path}[${bad}]`, key: 'decision_docs', wrong: 'not a relative glob inside the checkout', got: list[bad] });
    } else {
      level.values.set('decision_docs', [...(list as string[])]);
    }
  }
  return level;
}

const EMPTY_LEVEL: Level = { values: new Map(), issues: [] };

// The effective norms and whether the workspace has an entry (an object) in the file.
function resolveNorms(file: unknown, workspace: string | undefined): NormsResult & { entry: boolean } {
  const issues: string[] = [];
  let top = EMPTY_LEVEL;
  let own: Level | undefined;
  if (file !== undefined && !isRecord(file)) {
    issues.push(notObject(NORMS_FILE, file));
  } else if (file !== undefined) {
    if (Object.hasOwn(file, 'version') && file.version !== 1) {
      issues.push(`version: not 1 (got ${shown(file.version)}); the file is read as version 1`);
    }
    top = readLevel(file, '', FILE_KEYS);
    // A top-level value falls back to the default; a workspace's to the file's value when it has one.
    const fallback = (issue: string | BadValue, inTopLevel: boolean): string => (typeof issue === 'string' ? issue
      : `${issue.path}: ${issue.wrong} (got ${shown(issue.got)}); ${inTopLevel ? 'the file\'s value' : 'the default'} is used`);
    issues.push(...top.issues.map((issue) => fallback(issue, false)));
    // Every workspace's entry is checked, in the file's order; only the asked one gives values.
    const workspaces = file.workspaces;
    if (Object.hasOwn(file, 'workspaces') && !isRecord(workspaces)) {
      issues.push(notObject('workspaces', workspaces));
    } else if (isRecord(workspaces)) {
      // Object.keys: the entries' own keys only, so the asked one is found as Object.hasOwn finds it.
      for (const name of Object.keys(workspaces)) {
        const entry = workspaces[name];
        if (!isRecord(entry)) {
          issues.push(notObject(`workspaces.${keyName(name)}`, entry));
          continue;
        }
        const level = readLevel(entry, `workspaces.${keyName(name)}.`, LEVEL_KEYS);
        issues.push(...level.issues.map((issue) => fallback(issue, typeof issue !== 'string' && top.values.has(issue.key))));
        if (name === workspace) {
          own = level;
        }
      }
    }
  }
  const sources: Record<string, NormSource> = {};
  const pick = <T>(key: string, fallback: T): T => {
    const source = own?.values.has(key) === true ? 'workspace' : top.values.has(key) ? 'file' : 'default';
    sources[key] = source;
    return source === 'workspace' ? own!.values.get(key) as T : source === 'file' ? top.values.get(key) as T : fallback;
  };
  const norms: Norms = {
    slice: Object.fromEntries(SLICE_KEYS.map((key) => [key, pick(`slice.${key}`, DEFAULT_NORMS.slice[key])])) as Norms['slice'],
    lead_time_hours: Object.fromEntries(HOURS_KEYS.map((key) => [key, pick(`lead_time_hours.${key}`, DEFAULT_NORMS.lead_time_hours[key])])) as Norms['lead_time_hours'],
    decision_docs: [...pick('decision_docs', DEFAULT_NORMS.decision_docs)],
  };
  return { norms, sources, problems: issues, entry: own !== undefined };
}

// The norms in force for the workspace (none: the file's top level and the defaults). file: the
// parsed JSON of norms.json, undefined when there is no file. Problems: the whole file's, every
// workspace's entry included.
export function effectiveNorms(file: unknown, workspace?: string): NormsResult {
  const { norms, sources, problems } = resolveNorms(file, workspace);
  return { norms, sources, problems };
}

// What sf norms shows: the effective norms, the file's path, whether there is one, and whether the
// workspace has an entry.
export interface NormsView extends NormsResult { path: string; file: boolean; workspace: string | null; entry: boolean }

async function readNorms(workspace: string | undefined, dir: string): Promise<NormsView> {
  const path = normsFile(dir);
  const view = (file: unknown, exists: boolean, problem?: string): NormsView => {
    const { norms, sources, problems, entry } = resolveNorms(file, workspace);
    return { path, file: exists, workspace: workspace ?? null, entry, norms, sources, problems: problem === undefined ? problems : [problem] };
  };
  try {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) { // no file: the defaults; one that cannot be read: the defaults, said once
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? view(undefined, false) : view(undefined, true, `${NORMS_FILE} cannot be read: ${(error as Error).message}; the defaults are used`);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) { // not JSON: the defaults, said once
      return view(undefined, true, `${NORMS_FILE} is not JSON: ${(error as Error).message}; the defaults are used`);
    }
    return view(data, true);
  } catch (error) { // never into a caller: the defaults, said once
    return view(undefined, true, `${NORMS_FILE} cannot be read: ${String((error as Error)?.message ?? error)}; the defaults are used`);
  }
}

// The norms in force now for the workspace, from <dir>/norms.json read at this call (dir: the
// configuration directory, configDir(env)). Never throws.
export async function norms(workspace: string | undefined, dir: string): Promise<NormsResult> {
  const { norms: values, sources, problems } = await readNorms(workspace, dir);
  return { norms: values, sources, problems };
}

// ------------------------------------------------------------------ sf norms

// The command of the table in src/commands.ts (spread into its COMMANDS): a read, so it answers
// while sf update drains or builds. [workspace] is checked by checkArgs as a name; the registry is
// not read.
export const NORMS_COMMANDS = {
  norms: {
    name: 'norms', args: ['[workspace]'], openWhileUpdating: true,
    description: 'The norms in force (norms.json in the configuration directory, read at each use; you edit it): the slice size, the lead-time targets, the decision documents, each with its source (default, file or workspace), then the file\'s problems',
    run: (_s, [workspace]) => readNorms(workspace, configDir()),
  },
} satisfies Record<string, Command>;

// sf norms's lines: the file's path, a table of each value with its source (the decision documents
// under it, one per line), then the problems.
export function normsLines(view: NormsView): string[] {
  const rows = [
    ...SLICE_KEYS.map((key) => [`slice.${key}`, String(view.norms.slice[key])]),
    ...HOURS_KEYS.map((key) => [`lead_time_hours.${key}`, String(view.norms.lead_time_hours[key])]),
    ['decision_docs', ''],
  ].map((row) => [...row, view.sources[row[0]!] ?? 'default']);
  const widths = [0, 1].map((column) => Math.max(...rows.map((row) => row[column]!.length)));
  const where = !view.file ? ' (no file: the defaults)' : view.workspace !== null ? ` (workspace ${view.workspace})` : '';
  return [
    `norms: ${view.path}${where}`,
    ...(view.workspace !== null && !view.entry ? [`workspace ${view.workspace}: no entry`] : []),
    ...rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd()),
    ...(view.norms.decision_docs.length === 0 ? ['  (none)'] : view.norms.decision_docs.map((glob) => `  ${glob}`)),
    ...(view.problems.length === 0 ? [] : ['problems:', ...view.problems.map((problem) => `  ${problem}`)]),
  ];
}

// How the CLI shows the answer (src/commands.ts ANSWERS); problems do not make sf exit 1.
export const NORMS_ANSWERS: ReadonlyArray<[Command, (result: Result) => Answer]> = [
  [NORMS_COMMANDS.norms, (result) => ({ lines: normsLines(result as unknown as NormsView), failed: false })],
];
