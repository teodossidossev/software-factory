// The findings checklist of a workspace: <state>/findings/<workspace>.md, a short list of generic
// checks distilled from the review findings of the workspace's jobs that turned out real. The
// source is the ledger of every job directory of the workspace, current and archived: the Claude
// review's and the Codex gate's blocker and major entries of the last SOURCE_DAYS days that the
// Implementer fixed, never one a clean verdict closed without a fix, nor the factory's own scope
// and sensitive-path entries; only their problem and expected texts. One read-only model session
// (no tools, no setting sources, the review model) groups them into checks, each citing its
// entries; the factory keeps a check only when its text is generic (no path, ticket id or code)
// and its real cited entries are at least MIN_CHECK_ENTRIES from at least MIN_CHECK_JOBS jobs,
// and counts them itself. Too few findings, or no check kept, writes nothing and leaves an
// existing file as it is. sf findings distill and show (sf serve's socket) and sf serve's daily
// refresh (SF_FINDINGS_CHECKLIST) are its callers.
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { writeFileAtomic } from './atomic.js';
import type { Answer, Command, Result } from './commands.js';
import { type Config, loadConfig, stateDir as serveStateDir } from './config.js';
import { FactoryError } from './errors.js';
import { GATE_REVIEWER } from './gate.js';
import { JobStore } from './jobs.js';
import { FACTORY_PROBLEMS, type LedgerEntry } from './ledger.js';
import { loadRegistry, WORKSPACE_NAME_PATTERN } from './registry.js';
import { REVIEWER, runStructuredSession, type StructuredOutcome } from './review.js';

export const FINDINGS_DIR = 'findings';
// The findings of the last SOURCE_DAYS days feed the checklist.
export const SOURCE_DAYS = 30;
// Fewer source findings than this: no checklist.
export const MIN_FINDINGS = 10;
// A check is kept when its real entries are at least this many, from at least MIN_CHECK_JOBS jobs.
export const MIN_CHECK_ENTRIES = 3;
export const MIN_CHECK_JOBS = 2;
export const MAX_CHECKS = 12;
// The longest check text kept, in characters.
export const MAX_CHECK_CHARS = 200;
// The longest problem or expected text given to the model, in characters.
export const MAX_SOURCE_CHARS = 600;
// The daily refresh distils again when the file is older than this and enough findings are newer.
export const REFRESH_AFTER_DAYS = 7;
export const REFRESH_EVERY_MS = 24 * 60 * 60_000;
// The first refresh pass after sf serve starts.
export const REFRESH_FIRST_MS = 10 * 60_000;
export const MODEL_TIMEOUT_MS = 10 * 60_000;
const MAX_TURNS = 3;
const DAY = 24 * 60 * 60_000;

// ---------- The source ----------

// One real finding: its job directory's name (<ticket>, or <ticket>.<stamp> when archived: each
// directory is a job of its own), its two texts, and when its review ran.
export interface SourceFinding {
  job: string;
  problem: string;
  expected: string;
  at: string;
}

const REVIEWERS: readonly string[] = [REVIEWER, GATE_REVIEWER];

// Whether a ledger entry is a real finding: a Claude review's or Codex gate's blocker or major,
// fixed by the Implementer (not closed by a clean verdict), and none of the factory's own items.
export function isRealFinding(entry: LedgerEntry): boolean {
  return REVIEWERS.includes(entry.reviewer) && entry.severity !== 'nit' && entry.status === 'fixed'
    && entry.fixed_by_clean === undefined && !FACTORY_PROBLEMS.includes(entry.problem);
}

const validTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

// The real findings of the workspace's job directories, current and archived, whose review ran
// within SOURCE_DAYS days before now, oldest first. A finding's time is the end of the iteration
// its review read (meta.json), else the job's last state change. A job whose job.json or
// ledger.json cannot be read gives none.
export async function sourceFindings(jobs: JobStore, workspace: string, now: Date): Promise<SourceFinding[]> {
  const from = now.getTime() - SOURCE_DAYS * DAY;
  const found: SourceFinding[] = [];
  for (const dir of await jobs.listAll()) {
    if (dir.workspace !== workspace || dir.job === undefined) {
      continue;
    }
    let ledger: LedgerEntry[];
    try {
      ledger = await jobs.readLedger(workspace, dir.name);
    } catch { // an unreadable ledger: its job gives no findings
      continue;
    }
    const times = new Map<number, string>();
    for (const entry of ledger.filter(isRealFinding)) {
      let at = times.get(entry.iteration);
      if (at === undefined) {
        const ended = await jobs.readMeta(workspace, dir.name, entry.iteration).then((meta) => meta.ended_at, () => undefined);
        at = validTime(ended) ? ended : dir.job.updated_at;
        times.set(entry.iteration, at);
      }
      if (Date.parse(at) >= from && Date.parse(at) <= now.getTime()) {
        found.push({ job: dir.name, problem: entry.problem, expected: entry.expected, at });
      }
    }
  }
  return found.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// ---------- The distil ----------

const findingsOutput = z.strictObject({
  checks: z.array(z.strictObject({
    text: z.string().describe('One imperative line a developer can verify before handing work over; generic: no ticket ids, file paths, slashes or code.'),
    entries: z.array(z.string()).describe('The ids (E<n>) of the findings this check would have caught.'),
  })).max(MAX_CHECKS),
});
export type FindingsOutput = z.output<typeof findingsOutput>;
const { $schema: _draft, ...findingsSchema } = z.toJSONSchema(findingsOutput, { target: 'draft-7' });
export const FINDINGS_SCHEMA: Record<string, unknown> = findingsSchema;

// The model call: one structured session; never throws.
export type FindingsModel = (prompt: string, options: { model: string | undefined; cwd: string; signal: AbortSignal }) => Promise<StructuredOutcome<FindingsOutput>>;

// The session: no tools besides the SDK's structured output, no setting sources (no CLAUDE.md,
// AGENTS.md or user settings), an empty directory of the state as its cwd.
export function sdkFindingsModel(claudePath: string | undefined): FindingsModel {
  return (prompt, { model, cwd, signal }) => runStructuredSession(prompt, { cwd, claudePath, sandbox: undefined, model, maxTurns: MAX_TURNS, signal, tools: [], settingSources: [] }, {
    schema: FINDINGS_SCHEMA, output: findingsOutput, noun: 'findings checklist', outputNoun: 'checklist',
  });
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

// The findings as the model reads them: E<n> in order, each with its job's key J<m> (by first
// appearance) and its two texts on one line each.
export function findingsInput(findings: readonly SourceFinding[]): Array<{ id: string; job: string; problem: string; expected: string }> {
  const keys = new Map<string, string>();
  return findings.map((finding, index) => {
    const job = keys.get(finding.job) ?? `J${keys.size + 1}`;
    keys.set(finding.job, job);
    return { id: `E${index + 1}`, job, problem: cut(oneLine(finding.problem), MAX_SOURCE_CHARS), expected: cut(oneLine(finding.expected), MAX_SOURCE_CHARS) };
  });
}

export function distillPrompt(findings: readonly SourceFinding[]): string {
  return [
    'Below are review findings that code reviewers raised on a team\'s changes and that turned out real: the developer had to fix each. You have no tools besides the structured output.',
    '',
    'Distil them into a short checklist the developer goes through before handing the next change over, so the same kinds of finding do not come back.',
    '',
    'Rules:',
    `- checks: at most ${MAX_CHECKS}, the kinds of finding that recur most first. Each covers one kind of mistake that several findings share, from more than one job (J<m>).`,
    '- text: one imperative line the developer can verify on their own change, such as "Cover every new error path with a test that triggers it.".',
    '- text is generic: no ticket ids, no file or directory paths, no slashes, no names of files, functions, variables, types or settings, no code, no quotes and no backticks. Plain English words only, ordinary words such as if, return or class included: a capital letter only at the start of a sentence and in short acronyms such as API.',
    '- text has only letters, digits, spaces and the punctuation , . : ? ! ( ) and -; no other symbol.',
    '- entries: the ids (E<n>) of every finding the check would have caught, exactly as given. A check with fewer than three findings, or with findings of only one job, is left out.',
    '- No check for a finding that only one job had.',
    '',
    '<findings>',
    ...findingsInput(findings).map((finding) => JSON.stringify(finding)),
    '</findings>',
  ].join('\n');
}

// Code is told by its shape, never by its words: a sentence of ordinary English words (if, return,
// class, string, true, git) is not code.
// The characters of plain text: letters, digits, spaces and sentence punctuation; any other (an
// operator, a bracket, a quote, a sigil) is code's.
const PLAIN_TEXT = /^[\p{L}\p{N} ,.:'’?!()-]+$/u;

// What never reaches the checklist: a character that is not plain text's, a ticket
// id in any case (ABC-123, abc-123, ABC123, abc123), a slash or backslash (a path), a dot followed by anything but a space (a
// file name of any extension, a dotfile, a member access; e.g., i.e., etc. and vs. aside), code
// characters and operators (a flag's leading hyphen, a negation's !, a hex number), an identifier
// (camelCase, PascalCase, an acronym run into a word as in XMLParser, snake_case), a well-known
// file name without an extension, a quoted word. Letters and digits are Unicode's (\p{L}, \p{N}):
// an identifier of accented or non-Latin letters has the same shape.
const NOT_GENERIC: readonly RegExp[] = [
  /(?:^|\s)-|!(?=\S)|(?<![\p{L}\p{N}_])0x[0-9a-f]+/iu,
  /\b(?:makefile|dockerfile|jenkinsfile|gemfile|rakefile|procfile|vagrantfile|gulpfile|gruntfile|readme|license|changelog|codeowners)\b/iu,
  /["“”]|(?:^|\s)'[^'\s]+'/u,
  /(?<![\p{L}\p{N}_])\p{L}[\p{L}\p{N}]*-\p{N}+(?![\p{L}\p{N}_])/u,
  // A word that mixes letters and digits in any case (a ticket key such as SF318, sf318 or 318sf,
  // a version, an identifier); an ordinal such as 2nd or 10th aside.
  /(?<![\p{L}\p{N}_])(?!\p{N}+(?:st|nd|rd|th)(?![\p{L}\p{N}_]))(?=[\p{L}\p{N}]*\p{L})(?=[\p{L}\p{N}]*\p{N})[\p{L}\p{N}]+/iu,
  /[/\\]/u,
  /\.(?=\S)/u,
  /[`{}<>=;$#|]/u,
  /[\p{L}\p{N}_]\(|::|->|=>/u,
  /\p{Ll}\p{Lu}/u,
  /\p{Lu}{2,}\p{Ll}{2,}/u,
  /[\p{L}\p{N}]_|_[\p{L}\p{N}]/u,
];
// The abbreviations whose dot is not a file name's.
const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs)\./giu;

// Whether the text has a word that starts with a capital inside a sentence: a name (a file such
// as Makefile, a type, a tool, a setting); acronyms of up to five capitals (API, UI) and I aside.
function namesSomething(text: string): boolean {
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_])\p{Lu}[\p{L}\p{N}_]*/gu)) {
    const before = text.slice(0, match.index).trimEnd();
    const startsSentence = before === '' || /[.!?:]$/u.test(before);
    if (!startsSentence && !/^\p{Lu}{1,5}$/u.test(match[0])) {
      return true;
    }
  }
  return false;
}

// Whether a check's text may reach the file: one line, not empty, at most MAX_CHECK_CHARS
// characters, and generic (NOT_GENERIC matches nothing, and no name inside a sentence).
export function isGeneric(text: string): boolean {
  const plain = text.replace(ABBREVIATIONS, ' ');
  return text !== '' && text.length <= MAX_CHECK_CHARS && PLAIN_TEXT.test(text) && NOT_GENERIC.every((pattern) => !pattern.test(plain)) && !namesSomething(plain);
}

// A kept check: its text, and the real findings and jobs behind it as the factory counted them.
export interface Check {
  text: string;
  findings: number;
  jobs: number;
}

// The checks the factory keeps of the model's: a generic text, at least MIN_CHECK_ENTRIES real
// findings from at least MIN_CHECK_JOBS jobs among the ids it cites (an id the input did not have
// counts for nothing, a repeated one once), the most findings first, at most MAX_CHECKS; and how
// many it dropped.
export function keptChecks(output: FindingsOutput, findings: readonly SourceFinding[]): { checks: Check[]; dropped: number } {
  const byId = new Map(findings.map((finding, index) => [`E${index + 1}`, finding]));
  const kept: Check[] = [];
  for (const check of output.checks) {
    const text = oneLine(check.text);
    const cited = [...new Set(check.entries.map((id) => id.trim()))].map((id) => byId.get(id)).filter((finding) => finding !== undefined);
    const jobs = new Set(cited.map((finding) => finding.job)).size;
    if (isGeneric(text) && cited.length >= MIN_CHECK_ENTRIES && jobs >= MIN_CHECK_JOBS) {
      kept.push({ text, findings: cited.length, jobs });
    }
  }
  const checks = kept.sort((a, b) => b.findings - a.findings).slice(0, MAX_CHECKS);
  return { checks, dropped: output.checks.length - checks.length };
}

// ---------- The file ----------

// <state>/findings/<workspace>.md; a name that is not a workspace's is refused (bad_request).
export function checklistPath(stateDir: string, workspace: string): string {
  if (!WORKSPACE_NAME_PATTERN.test(workspace)) {
    throw new FactoryError('bad_request', `"${workspace}" is not a workspace name.`);
  }
  return join(stateDir, FINDINGS_DIR, `${workspace}.md`);
}

// The file: the generated line (the UTC day, the source's findings and jobs), then one line per check.
export function checklistText(day: string, findings: number, jobs: number, checks: readonly Check[]): string {
  return [`<!-- generated ${day} from ${findings} findings in ${jobs} jobs -->`, ...checks.map((check) => `- ${check.text} (${check.findings})`), ''].join('\n');
}

export interface DistillOptions {
  stateDir: string;
  // The review model (SF_REVIEW_MODEL); undefined: the user's Claude Code default.
  model: string | undefined;
  claudePath: string | undefined;
  // The model call; the Agent SDK's by default (the tests give a fake).
  call?: FindingsModel;
  now?: () => Date;
  timeoutMs?: number;
}

export interface DistillResult {
  workspace: string;
  path: string;
  written: boolean;
  // Why nothing was written: too few findings, or no check kept.
  reason?: 'too_few_findings' | 'no_check';
  findings: number;
  jobs: number;
  checks: number;
  dropped: number;
  // Whether a checklist from before is there (kept as it was when nothing was written).
  existing: boolean;
}

// The workspaces whose distil runs in this process: a second one is refused.
const running = new Set<string>();

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

// Distils the workspace's checklist now: writes or replaces the file (0600), or writes nothing
// with too few findings or no check kept. A failed model call throws findings_failed and leaves
// the file as it was.
export async function distill(workspace: string, options: DistillOptions): Promise<DistillResult> {
  const path = checklistPath(options.stateDir, workspace);
  if (running.has(workspace)) {
    throw new FactoryError('findings_running', `The findings checklist of ${workspace} is being distilled already.`);
  }
  running.add(workspace);
  try {
    const now = (options.now ?? (() => new Date()))();
    const findings = await sourceFindings(new JobStore(options.stateDir), workspace, now);
    const jobs = new Set(findings.map((finding) => finding.job)).size;
    const result = { workspace, path, written: false, findings: findings.length, jobs, checks: 0, dropped: 0, existing: await exists(path) };
    if (findings.length < MIN_FINDINGS) {
      return { ...result, reason: 'too_few_findings' };
    }
    const session = join(options.stateDir, FINDINGS_DIR, 'session');
    await mkdir(session, { recursive: true, mode: 0o700 });
    const timeoutMs = options.timeoutMs ?? MODEL_TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeoutMs);
    const outcome = await (options.call ?? sdkFindingsModel(options.claudePath))(distillPrompt(findings), { model: options.model, cwd: session, signal });
    if (!outcome.ok) {
      const message = signal.aborted ? `the model call timed out after ${Math.round(timeoutMs / 60_000)} minutes` : outcome.message;
      throw new FactoryError('findings_failed', `The findings checklist of ${workspace} could not be distilled (${message}); the file is left as it was.`);
    }
    const { checks, dropped } = keptChecks(outcome.output, findings);
    if (checks.length === 0) {
      return { ...result, reason: 'no_check', dropped };
    }
    await writeFileAtomic(path, Buffer.from(checklistText(now.toISOString().slice(0, 10), findings.length, jobs, checks), 'utf8'), 0o600);
    return { ...result, written: true, checks: checks.length, dropped };
  } finally {
    running.delete(workspace);
  }
}

// The distil's settings from sf serve's configuration.
export function distillOptions(config: Pick<Config, 'stateDir' | 'reviewModel' | 'claudePath'>): DistillOptions {
  return { stateDir: config.stateDir, model: config.reviewModel, claudePath: config.claudePath };
}

export interface ShownChecklist {
  workspace: string;
  path: string;
  // The file's text, or null without one.
  text: string | null;
  // When it was written, and its age in whole days; null without one.
  written_at: string | null;
  age_days: number | null;
}

export async function showChecklist(stateDir: string, workspace: string, now: Date = new Date()): Promise<ShownChecklist> {
  const path = checklistPath(stateDir, workspace);
  const [text, info] = await Promise.all([readFile(path, 'utf8').catch(() => null), stat(path).catch(() => null)]);
  if (text === null || info === null) {
    return { workspace, path, text: null, written_at: null, age_days: null };
  }
  return { workspace, path, text, written_at: info.mtime.toISOString(), age_days: Math.max(0, Math.floor((now.getTime() - info.mtimeMs) / DAY)) };
}

// ---------- The refresh ----------

// Whether the daily refresh distils the workspace: its file is missing or older than
// REFRESH_AFTER_DAYS, and at least MIN_FINDINGS source findings are newer than the file.
export async function refreshDue(stateDir: string, workspace: string, now: Date): Promise<boolean> {
  const info = await stat(checklistPath(stateDir, workspace)).catch(() => null);
  if (info !== null && now.getTime() - info.mtimeMs <= REFRESH_AFTER_DAYS * DAY) {
    return false;
  }
  const findings = await sourceFindings(new JobStore(stateDir), workspace, now);
  const newer = info === null ? findings : findings.filter((finding) => Date.parse(finding.at) > info.mtimeMs);
  return newer.length >= MIN_FINDINGS;
}

const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));

export interface RefreshOptions {
  stateDir: string;
  // The registered workspaces.
  workspaces: () => Promise<string[]>;
  distill: (workspace: string) => Promise<DistillResult>;
  now?: () => Date;
  firstMs?: number;
  everyMs?: number;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

// sf serve's refresh: a pass REFRESH_FIRST_MS after the start, then once a day; each pass distils
// every registered workspace whose refresh is due, one at a time. A failure is logged and leaves
// the old file.
export class FindingsRefresh {
  readonly #options: RefreshOptions;
  #timers: NodeJS.Timeout[] = [];
  #passing = false;

  constructor(options: RefreshOptions) {
    this.#options = options;
  }

  async pass(): Promise<void> {
    if (this.#passing) {
      return;
    }
    this.#passing = true;
    const { log = console.log, error = console.error } = this.#options;
    try {
      const now = (this.#options.now ?? (() => new Date()))();
      for (const workspace of await this.#options.workspaces()) {
        try {
          if (await refreshDue(this.#options.stateDir, workspace, now)) {
            const result = await this.#options.distill(workspace);
            log(`findings checklist of ${workspace}: ${result.written ? `${result.checks} checks from ${result.findings} findings` : `not written (${result.reason ?? 'nothing'})`}`);
          }
        } catch (failure) {
          // distill's own errors name the workspace already.
          error(`findings refresh: ${messageOf(failure)}`);
        }
      }
    } catch (failure) {
      error(`findings refresh: ${messageOf(failure)}`);
    } finally {
      this.#passing = false;
    }
  }

  start(): void {
    const run = (): void => void this.pass();
    this.#timers = [setTimeout(run, this.#options.firstMs ?? REFRESH_FIRST_MS).unref(), setInterval(run, this.#options.everyMs ?? REFRESH_EVERY_MS).unref()];
  }

  close(): void {
    this.#timers.forEach((timer) => clearTimeout(timer));
    this.#timers = [];
  }
}

// sf serve's refresh, started; undefined with SF_FINDINGS_CHECKLIST=off.
export function startFindingsRefresh(config: Config): FindingsRefresh | undefined {
  if (config.findingsChecklist === false) {
    console.log('findings checklist: refresh off (SF_FINDINGS_CHECKLIST=off)');
    return undefined;
  }
  const refresh = new FindingsRefresh({
    stateDir: config.stateDir,
    workspaces: async () => Object.keys((await loadRegistry()).workspaces),
    distill: (workspace) => distill(workspace, distillOptions(config)),
  });
  refresh.start();
  return refresh;
}

// ---------- The commands ----------

// sf findings distill and show, run in sf serve (spread into src/commands.ts COMMANDS).
export const FINDINGS_COMMANDS = {
  findingsDistill: {
    name: 'findings distill', args: ['<workspace>'],
    description: `Distil the workspace's findings checklist now (one model call): the checks the review findings of its jobs of the last ${SOURCE_DAYS} days that were fixed have in common, each backed by at least ${MIN_CHECK_ENTRIES} findings from ${MIN_CHECK_JOBS} jobs; with fewer than ${MIN_FINDINGS} findings or no such check nothing is written and the old checklist stays. sf serve refreshes it once a day when it is older than ${REFRESH_AFTER_DAYS} days (SF_FINDINGS_CHECKLIST)`,
    run: (_s, [workspace = '']) => distill(workspace, distillOptions(loadConfig())),
  },
  findingsShow: {
    name: 'findings show', args: ['<workspace>'],
    description: 'Print the workspace\'s findings checklist and its age, or that it has none',
    run: (_s, [workspace = '']) => showChecklist(serveStateDir(), workspace),
  },
} satisfies Record<string, Command>;

function distilledLines(result: DistillResult): string[] {
  const source = `${result.findings} findings in ${result.jobs} jobs of the last ${SOURCE_DAYS} days`;
  if (result.written) {
    return [`Wrote the findings checklist of ${result.workspace}: ${result.checks} checks from ${source}${result.dropped > 0 ? ` (${result.dropped} proposed checks dropped)` : ''}.`, `file: ${result.path}`];
  }
  const why = result.reason === 'too_few_findings'
    ? `only ${source}; it takes ${MIN_FINDINGS}`
    : `no proposed check was generic and backed by ${MIN_CHECK_ENTRIES} findings from ${MIN_CHECK_JOBS} jobs (${source})`;
  return [`Nothing written for ${result.workspace}: ${why}.`, result.existing ? `The checklist from before is kept: ${result.path}` : 'It has no checklist.'];
}

function shownLines(shown: ShownChecklist): string[] {
  if (shown.text === null) {
    return [`${shown.workspace} has no findings checklist (sf findings distill ${shown.workspace} makes one).`];
  }
  const age = shown.age_days === 0 ? 'written today' : `${shown.age_days} ${shown.age_days === 1 ? 'day' : 'days'} old`;
  return [...shown.text.trimEnd().split('\n'), '', `${shown.path} (${age})`];
}

// How the CLI shows the commands' answers (src/commands.ts ANSWERS).
export const FINDINGS_ANSWERS: ReadonlyArray<[Command, (result: Result) => Answer]> = [
  [FINDINGS_COMMANDS.findingsDistill, (result) => ({ lines: distilledLines(result as unknown as DistillResult), failed: false })],
  [FINDINGS_COMMANDS.findingsShow, (result) => ({ lines: shownLines(result as unknown as ShownChecklist), failed: false })],
];
