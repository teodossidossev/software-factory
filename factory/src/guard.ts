// The guard: one scan with two term sources keeps text out of what the factory publishes.
// The secret terms (the values of the environment file's secret keys, the factory's token files and
// a few generic key patterns) apply to every workspace; the name terms (the names, Git hosts, ticket
// key prefixes and email domains of the user's other workspaces, built from the registry and the job
// store at every check, plus the private list guard-terms.txt in the config directory) only to a
// workspace with "guard": true in workspaces.json. What is scanned: the commits a push publishes
// (message, added lines, new file paths; never the author or committer, the user's own identity),
// the branch name and the MR text; at MR preparation the worktree's change as the factory
// would commit it. Only `sf guard` (and the pre-push hook, which runs it) prints a matched text
// (hitReport, never a secret's); every other message names places only (hitPlace, guardMessage),
// with the terms inside them masked.
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseEnvFile } from './config.js';
import { TOKEN_FILE } from './dashboard.js';
import { FactoryError } from './errors.js';
import { type GitResult, runGit } from './git.js';
import { JobStore } from './jobs.js';
import { commitPaths, gitFailure, mrTextPath, mrTextProblem, parseOrigin } from './mr.js';
import { loadRegistry, verifyCheckout, type Workspace } from './registry.js';
import { MCP_TOKEN_FILE } from './server.js';
import { INSTALLED_SF } from './service.js';
import { ARCHIVE_DIR, TASK_DIR } from './task-file.js';

export const GUARD_TERMS_FILE = 'guard-terms.txt';
// At MR preparation: the Guard fixes of a job, and the MR text turns after the first one.
export const GUARD_MAX_FIXES = 2;
export const GUARD_MAX_MR_TURNS = 2;

export const PUBLIC_HOSTS: readonly string[] = ['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org'];
export const PUBLIC_EMAIL_DOMAINS: readonly string[] = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com',
  'me.com', 'proton.me', 'protonmail.com', 'gmx.de', 'gmx.net', 'web.de', 'users.noreply.github.com',
];

// The environment file's keys whose values are secrets (SF_NTFY_URL too: its topic is one).
export const SECRET_ENV_KEY = /(?:TOKEN|SECRET|PASSWORD|API_KEY)$/;
const SECRET_URL_KEY = 'SF_NTFY_URL';
const MIN_SECRET_CHARS = 12;
const NOT_SECRET = [/^(?:true|false|on|off|yes|no)$/i, /^-?\d+(?:\.\d+)?$/];
// Generic patterns of keys, matched case-sensitively.
export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  // With a left boundary: a branch slug such as task-check-s-... is no key.
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9_-])xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
];

export const GUARD_HOOK_MARKER = '# software-factory guard hook (sf guard install-hook); sf guard install-hook rewrites this file';

// The output of one Git call the guard reads: a diff of a whole commit may be large.
const MAX_GIT_BYTES = 16 * 1024 * 1024;
// Paths per git add of the temporary index.
const ADD_CHUNK = 500;
// The guard's messages and Fix sections list at most this many places.
const MAX_MESSAGE_PLACES = 20;
const MAX_FIX_PLACES = 50;
// A refusal or a stop message is cut here.
export const MAX_GUARD_MESSAGE = 2000;
const EMPTY_TREE: Record<string, string> = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};
const TICKET_KEY = /^([A-Za-z][A-Za-z0-9]*)-\d+$/;

export type GuardTermKind = 'name' | 'host' | 'key' | 'domain' | 'private' | 'secret';

export interface GuardTerm {
  kind: GuardTermKind;
  // What the term stands for: a name, a host, a key prefix, a domain, a private line, a secret value.
  // Never printed.
  text: string;
  label: string;
  pattern: RegExp;
}

export interface GuardHit {
  // The place: never the matched text, but a term may occur in it (a path).
  where: string;
  match: string;
  label: string;
  secret: boolean;
}

const LABELS = {
  name: 'name of another workspace',
  host: 'Git host of another workspace',
  key: 'ticket key of another workspace',
  domain: 'email domain of another workspace',
  secret: 'secret',
} as const;

const AROUND = '[\\p{L}\\p{N}_]';

// The text as a literal inside a pattern; valid with and without the u flag.
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

// A plain term: case-insensitive, with Unicode-aware word boundaries.
export function plainTerm(kind: GuardTermKind, text: string, label: string): GuardTerm {
  return { kind, text, label, pattern: new RegExp(`(?<!${AROUND})${escapeRegExp(text)}(?!${AROUND})`, 'giu') };
}

// A ticket key prefix P: P-<digits> between word boundaries.
export function keyTerm(prefix: string): GuardTerm {
  return { kind: 'key', text: prefix, label: LABELS.key, pattern: new RegExp(`(?<!${AROUND})${escapeRegExp(prefix)}-\\d+(?!${AROUND})`, 'giu') };
}

// A secret value: a literal, case-sensitive substring.
function secretValueTerm(value: string): GuardTerm {
  return { kind: 'secret', text: value, label: LABELS.secret, pattern: new RegExp(escapeRegExp(value), 'g') };
}

// Keeps the first term of each kind and text (case-insensitive; a secret's exactly).
function unique(terms: GuardTerm[]): GuardTerm[] {
  const seen = new Set<string>();
  return terms.filter((term) => {
    const key = `${term.kind}\0${term.kind === 'secret' || term.kind === 'private' ? `${term.pattern.source}\0${term.text}` : term.text.toLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

// --- The private list --------------------------------------------------------------------------

// The terms of guard-terms.txt and the texts its "!" lines drop from the automatic terms.
export function parsePrivateTerms(text: string): { terms: GuardTerm[]; drops: string[] } {
  const terms: GuardTerm[] = [];
  const drops: string[] = [];
  const refuse = (line: number, why: string): FactoryError => new FactoryError('guard_terms_invalid', `${GUARD_TERMS_FILE} line ${line} ${why}`);
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    const number = index + 1;
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const label = `private list line ${number}`;
    if (line.startsWith('re:')) {
      const source = line.slice(3).trim();
      if (source === '') {
        throw refuse(number, 'is empty after "re:".');
      }
      let pattern: RegExp;
      try {
        pattern = new RegExp(source, 'giu');
      } catch {
        // The engine's message quotes the pattern: never shown.
        throw refuse(number, 'is not a valid regular expression.');
      }
      if (new RegExp(source, 'iu').test('')) {
        throw refuse(number, 'matches the empty text.');
      }
      terms.push({ kind: 'private', text: source, label, pattern });
    } else if (line.startsWith('!')) {
      const dropped = line.slice(1).trim();
      if (dropped === '') {
        throw refuse(number, 'is empty after "!".');
      }
      drops.push(dropped.toLowerCase());
    } else {
      terms.push(plainTerm('private', line, label));
    }
  }
  return { terms, drops };
}

// The private list of the config directory; a missing file gives none.
async function readPrivateTerms(configDir: string): Promise<{ terms: GuardTerm[]; drops: string[] }> {
  let text: string;
  try {
    text = await readFile(join(configDir, GUARD_TERMS_FILE), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { terms: [], drops: [] };
    }
    throw new FactoryError('guard_terms_invalid', `${GUARD_TERMS_FILE} could not be read (${code ?? 'unknown error'}).`);
  }
  return parsePrivateTerms(text);
}

// --- The automatic terms -----------------------------------------------------------------------

// The hosts of a checkout's remotes, lower-cased and without a port; throws when Git fails.
async function remoteHosts(checkout: string): Promise<string[]> {
  const listed = await runGit(checkout, ['remote']);
  if (listed.code !== 0) {
    throw new Error(gitFailure(['remote'], listed));
  }
  const hosts: string[] = [];
  for (const name of listed.stdout.toString('utf8').split('\n').map((line) => line.trim()).filter((line) => line !== '')) {
    const args = ['remote', 'get-url', '--all', name];
    const urls = await runGit(checkout, args);
    if (urls.code !== 0) {
      throw new Error(gitFailure(args, urls));
    }
    for (const url of urls.stdout.toString('utf8').split('\n').map((line) => line.trim()).filter((line) => line !== '')) {
      const host = parseOrigin(url)?.host.toLowerCase().replace(/:\d+$/, '');
      if (host !== undefined && host !== '') {
        hosts.push(host);
      }
    }
  }
  return hosts;
}

// The ticket names of the Task files of a checkout (.software-factory/ and its archive/); a
// missing directory gives none.
async function taskTickets(checkout: string): Promise<string[]> {
  const tickets: string[] = [];
  for (const dir of [join(checkout, TASK_DIR), join(checkout, TASK_DIR, ARCHIVE_DIR)]) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
        continue;
      }
      throw error;
    }
    for (const name of names) {
      if (name.endsWith('.md')) {
        tickets.push(name.endsWith('.mr.md') ? name.slice(0, -'.mr.md'.length) : name.slice(0, -'.md'.length));
      }
    }
  }
  return tickets;
}

// The domain of the checkout's user.email, lower-cased; undefined when unset or without "@".
// Throws when Git fails otherwise.
async function emailDomain(checkout: string): Promise<string | undefined> {
  const args = ['config', '--get', 'user.email'];
  const result = await runGit(checkout, args);
  const value = result.stdout.toString('utf8').trim();
  if (result.code === 1 && value === '') {
    return undefined;
  }
  if (result.code !== 0) {
    throw new Error(gitFailure(args, result));
  }
  const at = value.lastIndexOf('@');
  const domain = at < 0 ? '' : value.slice(at + 1).trim().toLowerCase();
  return domain === '' ? undefined : domain;
}

// The upper-cased prefix of a ticket key (ABC of ABC-123); undefined for another ticket name.
function keyPrefix(ticket: string): string | undefined {
  return TICKET_KEY.exec(ticket)?.[1]?.toUpperCase();
}

// The name terms of the guarded workspace G, with the private list's terms
// and its "!" drops applied; warnings for the CLI (the factory's own checks ignore them).
export async function buildTerms(input: { workspace: Workspace; configDir: string; stateDir: string }): Promise<{ terms: GuardTerm[]; warnings: string[] }> {
  const { workspace, configDir, stateDir } = input;
  const own = workspace.name;
  const registry = await loadRegistry(configDir);
  const jobs = new JobStore(stateDir);
  const warnings: string[] = [];
  const entries = Object.entries(registry.workspaces);
  const guarded = new Set(entries.filter(([, entry]) => entry.guard === true).map(([name]) => name));
  const registered = new Map(entries.filter(([name, entry]) => name !== own && entry.guard !== true));
  const others = new Set<string>(registered.keys());
  for (const name of await jobs.workspaceNames()) {
    if (name !== own && !guarded.has(name)) {
      others.add(name);
    }
  }
  const jobTickets = new Map<string, string[]>();
  for (const dir of await jobs.listAll()) {
    if (dir.job !== undefined && dir.error === undefined) {
      jobTickets.set(dir.workspace, [...(jobTickets.get(dir.workspace) ?? []), dir.job.ticket]);
    }
  }

  // What G itself holds is never a term: its hosts and its own ticket prefixes.
  const ownHosts = new Set<string>();
  const ownPrefixes = new Set<string>();
  for (const ticket of jobTickets.get(own) ?? []) {
    const prefix = keyPrefix(ticket);
    if (prefix !== undefined) {
      ownPrefixes.add(prefix);
    }
  }
  try {
    for (const host of await remoteHosts(workspace.readCheckout)) {
      ownHosts.add(host);
    }
    for (const ticket of await taskTickets(workspace.readCheckout)) {
      const prefix = keyPrefix(ticket);
      if (prefix !== undefined) {
        ownPrefixes.add(prefix);
      }
    }
  } catch {
    // The checkout's own reads only narrow the terms; the scan of it reports its failure.
  }

  const automatic: GuardTerm[] = [];
  const prefixes: string[] = [];
  const domains: string[] = [];
  for (const name of [...others].sort()) {
    automatic.push(plainTerm('name', name, LABELS.name));
    const tickets = [...(jobTickets.get(name) ?? [])];
    const entry = registered.get(name);
    if (entry !== undefined) {
      try {
        const checkout = await verifyCheckout(entry.read_checkout, 'checkout');
        const hosts = await remoteHosts(checkout);
        const files = await taskTickets(checkout);
        const domain = await emailDomain(checkout);
        for (const host of hosts) {
          if (!ownHosts.has(host) && !PUBLIC_HOSTS.includes(host)) {
            automatic.push(plainTerm('host', host, LABELS.host));
          }
        }
        tickets.push(...files);
        if (domain !== undefined && !PUBLIC_EMAIL_DOMAINS.includes(domain)) {
          domains.push(domain);
        }
      } catch {
        warnings.push(`workspace "${name}": its checkout could not be read; only its name and job tickets are terms.`);
      }
    }
    for (const ticket of tickets) {
      const prefix = keyPrefix(ticket);
      if (prefix !== undefined && !ownPrefixes.has(prefix)) {
        prefixes.push(prefix);
      }
    }
  }
  automatic.push(...prefixes.map((prefix) => keyTerm(prefix)));
  automatic.push(...domains.map((domain) => plainTerm('domain', domain, LABELS.domain)));

  const { terms: privateTerms, drops } = await readPrivateTerms(configDir);
  const kept = unique(automatic).filter((term) => !drops.includes(term.text.toLowerCase()));
  return { terms: unique([...kept, ...privateTerms]), warnings };
}

// --- The secret terms --------------------------------------------------------------------------

// A file's text, undefined when it is missing; guard_failed when it cannot be read.
async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new FactoryError('guard_failed', `${basename(path)} could not be read for the secret check.`);
  }
}

// Whether a value is long enough and not a flag or a number.
function isSecretValue(value: string): boolean {
  return value.length >= MIN_SECRET_CHARS && !NOT_SECRET.some((pattern) => pattern.test(value));
}

// The secret terms of every workspace: the values of the environment file's
// secret keys and of the token files, as literal substrings, and the generic key patterns.
export async function secretTerms(input: { stateDir: string; envFile: string | undefined }): Promise<GuardTerm[]> {
  const values: string[] = [];
  if (input.envFile !== undefined) {
    const text = await readIfPresent(input.envFile);
    if (text !== undefined) {
      let parsed: Record<string, string>;
      try {
        parsed = parseEnvFile(text);
      } catch {
        // parseEnvFile's message quotes the line.
        throw new FactoryError('guard_failed', `${basename(input.envFile)} could not be read for the secret check.`);
      }
      for (const [key, value] of Object.entries(parsed)) {
        if (SECRET_ENV_KEY.test(key) || key === SECRET_URL_KEY) {
          values.push(value);
        }
      }
    }
  }
  for (const file of [TOKEN_FILE, MCP_TOKEN_FILE]) {
    const text = await readIfPresent(join(input.stateDir, file));
    if (text !== undefined) {
      values.push(text.trim());
    }
  }
  const exact = values.filter(isSecretValue).map(secretValueTerm);
  const generic = SECRET_PATTERNS.map((pattern) => ({ kind: 'secret' as const, text: pattern.source, label: LABELS.secret, pattern: new RegExp(pattern.source, 'g') }));
  return unique([...exact, ...generic]);
}

// The terms of one check: the secrets always, the name terms of a guarded workspace.
export async function checkTerms(input: { workspace: Workspace; guarded: boolean; configDir: string; stateDir: string; envFile: string | undefined }): Promise<{ terms: GuardTerm[]; warnings: string[] }> {
  const secrets = await secretTerms({ stateDir: input.stateDir, envFile: input.envFile });
  if (!input.guarded) {
    return { terms: secrets, warnings: [] };
  }
  const names = await buildTerms({ workspace: input.workspace, configDir: input.configDir, stateDir: input.stateDir });
  return { terms: [...secrets, ...names.terms], warnings: names.warnings };
}

// --- Matching ----------------------------------------------------------------------------------

// The hits of the terms in one line; place gives the hit's place from its 1-based column.
// The matched text of every other hit has the characters of a secret match in the same line masked
// by "*": a private regular expression that also covers a secret never carries it.
function lineHits(line: string, terms: readonly GuardTerm[], place: (column: number) => string): GuardHit[] {
  const secretRanges: Array<[number, number]> = [];
  for (const term of terms) {
    if (term.kind === 'secret') {
      for (const match of line.matchAll(term.pattern)) {
        secretRanges.push([match.index, match.index + match[0].length]);
      }
    }
  }
  const masked = (text: string, at: number): string => secretRanges.length === 0
    ? text
    : text.split('').map((unit, offset) => (secretRanges.some(([start, end]) => at + offset >= start && at + offset < end) ? '*' : unit)).join('');
  const hits: GuardHit[] = [];
  for (const term of terms) {
    for (const match of line.matchAll(term.pattern)) {
      if (match[0] === '') {
        continue;
      }
      const secret = term.kind === 'secret';
      hits.push({ where: place(match.index + 1), match: secret ? match[0] : masked(match[0], match.index), label: term.label, secret });
    }
  }
  return hits;
}

// Hits of the same place and matched text are kept once, the first term's label.
function dedupe(hits: GuardHit[]): GuardHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.where}\0${hit.match}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function textLines(text: string): string[] {
  return text.split('\n').map((line) => line.replace(/\r$/, ''));
}

// The hits of the terms in a text, line by line; place gives the place from the 1-based line and column.
export function scanText(text: string, terms: readonly GuardTerm[], place: (line: number, column: number) => string): GuardHit[] {
  return dedupe(textLines(text).flatMap((line, index) => lineHits(line, terms, (column) => place(index + 1, column))));
}

// The hits of an MR text (places MR text:<line>:<column>).
export function scanMrText(text: string, terms: readonly GuardTerm[]): GuardHit[] {
  return scanText(text, terms, (line, column) => `MR text:${line}:${column}`);
}

// The hits of a branch name (places branch name:<column>).
export function scanBranch(branch: string, terms: readonly GuardTerm[]): GuardHit[] {
  return dedupe(lineHits(branch, terms, (column) => `branch name:${column}`));
}

// Every match of any term in text replaced by "*" of the same length: also for a message that
// quotes text the guard has not checked yet (an invalid MR title).
export function maskTerms(text: string, terms: readonly GuardTerm[]): string {
  let masked = text;
  for (const term of terms) {
    masked = masked.replace(term.pattern, (found) => '*'.repeat(found.length));
  }
  return masked;
}

// The MR text's problem (mrTextProblem) quoted from the text with every term masked first: the
// problem cuts its quotes at 100 characters, which would cut a secret out of its match.
// Valid or not is the original text's; undefined when it is valid.
export function maskedMrTextProblem(ticket: string, text: string, terms: readonly GuardTerm[]): string | undefined {
  if (mrTextProblem(ticket, text) === undefined) {
    return undefined;
  }
  return mrTextProblem(ticket, maskTerms(text, terms)) ?? 'it does not pass the rules of the MR text';
}

// readMrText's failure for a message: an invalid text's problem rebuilt from the masked
// text in the worktree, or without any quote when it cannot be rebuilt; any other failure masked.
export async function maskedMrTextFailure(cwd: string, ticket: string, failure: { code: string; message: string }, terms: readonly GuardTerm[]): Promise<string> {
  const path = mrTextPath(ticket);
  if (failure.code === 'mr_text_invalid' && failure.message.startsWith(`${path} is invalid: `)) {
    const text = await readFile(join(cwd, path), 'utf8').catch(() => undefined);
    const problem = text === undefined ? undefined : maskedMrTextProblem(ticket, text, terms);
    return problem === undefined ? `${path} is invalid.` : maskTerms(`${path} is invalid: ${problem}.`, terms);
  }
  return maskTerms(failure.message, terms);
}

// A hit for every message but sf guard's: its place, masked, its length and its label.
export function hitPlace(hit: GuardHit, terms: readonly GuardTerm[]): string {
  return `${maskTerms(hit.where, terms)} (${hit.match.length} characters, ${hit.label})`;
}

// A hit as sf guard prints it: the matched text, except a secret's; a secret inside the place (a
// path holding one) is masked too.
export function hitReport(hit: GuardHit, terms: readonly GuardTerm[] = []): string {
  const where = maskTerms(hit.where, terms.filter((term) => term.kind === 'secret'));
  return hit.secret ? `${where}: [secret] (secret)` : `${where}: ${JSON.stringify(maskTerms(hit.match, terms.filter((term) => term.kind === 'secret')))} (${hit.label})`;
}

// The first places of the hits, joined; the count of the rest.
export function guardMessage(hits: readonly GuardHit[], terms: readonly GuardTerm[]): string {
  const shown = hits.slice(0, MAX_MESSAGE_PLACES).map((hit) => hitPlace(hit, terms)).join('; ');
  return hits.length > MAX_MESSAGE_PLACES ? `${shown}; and ${hits.length - MAX_MESSAGE_PLACES} more` : shown;
}

// The Guard fix section of MR preparation: the places of the hits, numbered.
export function guardFixContent(hits: readonly GuardHit[], terms: readonly GuardTerm[]): string {
  const lines = hits.slice(0, MAX_FIX_PLACES).map((hit, index) => `- G${index + 1}: ${hitPlace(hit, terms)}`);
  if (hits.length > MAX_FIX_PLACES) {
    lines.push(`- and ${hits.length - MAX_FIX_PLACES} more; the next check lists them.`);
  }
  return [
    "The guard of this workspace found text that must not be published in this repository: a name, Git host, ticket key or email domain of the user's other workspaces, or a term of the user's private list. Remove or reword each place below (its line, column and length mark the text); do not move the text to another file, comment or test fixture.",
    '',
    ...lines,
  ].join('\n');
}

// The number of Fix sections titled Guard in a Task file, outside ``` fences.
export function guardFixCount(task: string): number {
  let fenced = false;
  let count = 0;
  for (const line of textLines(task)) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && /^## Fix \d+: Guard$/.test(line)) {
      count += 1;
    }
  }
  return count;
}

// The factory text with every match on a line the factory added (a line that is not a line of the
// Implementer's text) replaced by "[removed by the guard]".
export function redactAdded(factoryText: string, written: string, terms: readonly GuardTerm[]): string {
  const own = new Set(written.split('\n'));
  return factoryText.split('\n').map((line) => {
    if (own.has(line)) {
      return line;
    }
    const ranges: Array<[number, number]> = [];
    for (const term of terms) {
      for (const match of line.matchAll(term.pattern)) {
        if (match[0] !== '') {
          ranges.push([match.index, match.index + match[0].length]);
        }
      }
    }
    if (ranges.length === 0) {
      return line;
    }
    ranges.sort((a, b) => a[0] - b[0]);
    let out = '';
    let at = 0;
    for (const [start, end] of ranges) {
      if (end <= at) {
        continue;
      }
      if (start >= at) {
        out += `${line.slice(at, start)}[removed by the guard]`;
      }
      at = end;
    }
    return out + line.slice(at);
  }).join('\n');
}

// --- Git scans ---------------------------------------------------------------------------------

// Git that must succeed: guard_failed with Git's reason otherwise. Output over MAX_GIT_BYTES is
// guard_failed with tooLarge, checked first: runGit stops such a Git, which then fails too.
async function gitOk(cwd: string, args: string[], env: Record<string, string> = {}, tooLarge = 'The output of Git is too large for the guard (over 16 MiB).'): Promise<GitResult> {
  const result = await runGit(cwd, args, MAX_GIT_BYTES, undefined, env);
  if (result.truncated) {
    throw new FactoryError('guard_failed', tooLarge);
  }
  if (result.code !== 0) {
    throw new FactoryError('guard_failed', gitFailure(args, result));
  }
  return result;
}

// A path Git printed C-quoted ("..." with backslash escapes, octal bytes), unquoted.
export function unquotePath(text: string): string {
  if (!(text.length >= 2 && text.startsWith('"') && text.endsWith('"'))) {
    return text;
  }
  const bytes: number[] = [];
  const named: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const inner = text.slice(1, -1);
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]!;
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = inner[index + 1] ?? '';
    const octal = /^[0-7]{3}/.exec(inner.slice(index + 1));
    if (octal !== null) {
      bytes.push(parseInt(octal[0], 8));
      index += 3;
    } else if (next in named) {
      bytes.push(named[next]!);
      index += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// The empty tree of the repository's object format: what a root commit is compared with.
async function emptyTree(cwd: string): Promise<string> {
  const format = (await gitOk(cwd, ['rev-parse', '--show-object-format'])).stdout.toString('utf8').trim();
  return EMPTY_TREE[format] ?? EMPTY_TREE.sha1!;
}

// The hits of the change from one tree-ish to another: the added lines and the new paths of
// added, copied and renamed files. With commit, the places end " in commit <sha12>".
export async function scanChange(cwd: string, from: string, to: string, terms: readonly GuardTerm[], commit?: string): Promise<GuardHit[]> {
  const suffix = commit === undefined ? '' : ` in commit ${commit.slice(0, 12)}`;
  const hits: GuardHit[] = [];
  // Explicit prefixes (the user's diff.noprefix or diff.mnemonicPrefix would change them); --text diffs every file as text, whatever its attributes or bytes.
  const diffArgs = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--text', '--src-prefix=a/', '--dst-prefix=b/', '-M', '-U0', from, to];
  const what = commit === undefined ? 'The change of the worktree' : `The change of commit ${commit.slice(0, 12)}`;
  const tooLarge = `${what} is too large for the guard (over 16 MiB of diff).`;
  const diff = await gitOk(cwd, diffArgs, {}, tooLarge);
  let header = false;
  let path: string | undefined;
  let line = 0;
  for (const raw of diff.stdout.toString('utf8').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      header = true;
      path = undefined;
      continue;
    }
    if (header) {
      if (raw.startsWith('+++ ')) {
        const named = unquotePath(raw.slice(4).replace(/\t$/, ''));
        path = named.startsWith('b/') ? named.slice(2) : named === '/dev/null' ? undefined : named;
        continue;
      }
      if (!raw.startsWith('@@')) {
        continue;
      }
      header = false;
    }
    if (raw.startsWith('@@')) {
      const start = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      line = start === null ? 0 : Number(start[1]);
      continue;
    }
    if (raw.startsWith('+')) {
      const number = line;
      const where = path ?? '(unknown path)';
      hits.push(...lineHits(raw.slice(1).replace(/\r$/, ''), terms, (column) => `${where}:${number}:${column}${suffix}`));
      line += 1;
    } else if (raw.startsWith(' ')) {
      line += 1;
    }
  }
  const namesArgs = ['-c', 'core.quotePath=false', 'diff', '-z', '--name-status', '-M', '--diff-filter=ACR', from, to];
  const names = (await gitOk(cwd, namesArgs, {}, tooLarge)).stdout.toString('utf8').split('\0');
  for (let index = 0; index < names.length; index += 1) {
    const status = names[index]!;
    if (status === '') {
      continue;
    }
    const twoPaths = status.startsWith('R') || status.startsWith('C');
    const newPath = names[index + (twoPaths ? 2 : 1)];
    index += twoPaths ? 2 : 1;
    if (newPath !== undefined && newPath !== '') {
      hits.push(...lineHits(newPath, terms, (column) => `${newPath} (file path, column ${column})${suffix}`));
    }
  }
  return dedupe(hits);
}

// The commit a revision names; guard_failed when it does not resolve (or looks like an option).
async function resolveCommit(cwd: string, rev: string): Promise<string> {
  const missing = new FactoryError('guard_failed', `The revision ${rev} does not exist in the checkout.`);
  if (rev === '' || rev.startsWith('-')) {
    throw missing;
  }
  const result = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  const sha = result.stdout.toString('utf8').trim();
  if (result.code !== 0 || sha === '') {
    throw missing;
  }
  return sha;
}

export type CommitSpec = { rev: string; remote: string; history: false } | { rev: string; history: true } | { range: string };

// The commits to check, oldest first: those a push of rev to remote publishes, every commit
// reachable from rev, or a range <a>..<b>.
export async function commitsToCheck(cwd: string, spec: CommitSpec): Promise<string[]> {
  let args: string[];
  if ('range' in spec) {
    const at = spec.range.indexOf('..');
    const [a, b] = [spec.range.slice(0, at), spec.range.slice(at + 2)];
    if (at < 0 || b.startsWith('.')) {
      throw new FactoryError('guard_failed', `The revision ${spec.range} does not exist in the checkout.`);
    }
    args = ['rev-list', '--reverse', `${await resolveCommit(cwd, a)}..${await resolveCommit(cwd, b)}`];
  } else if (spec.history) {
    args = ['rev-list', '--reverse', await resolveCommit(cwd, spec.rev)];
  } else {
    args = ['rev-list', '--reverse', await resolveCommit(cwd, spec.rev), '--not', `--remotes=${spec.remote}`];
  }
  const result = await gitOk(cwd, args, {}, 'The list of commits is too long for the guard.');
  return result.stdout.toString('utf8').split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

// The hits of the commits: message and the change against the first parent (a root commit against
// the empty tree). The author and committer are the user's own identity and never scanned.
export async function scanCommits(cwd: string, commits: readonly string[], terms: readonly GuardTerm[]): Promise<GuardHit[]> {
  const hits: GuardHit[] = [];
  for (const sha of commits) {
    const short = sha.slice(0, 12);
    const fields = (await gitOk(cwd, ['show', '-s', '--no-show-signature', '--format=%P%x00%B', sha])).stdout.toString('utf8');
    const [parents = '', ...rest] = fields.split('\0');
    const message = rest.join('\0');
    hits.push(...scanText(message.replace(/\n+$/, ''), terms, (line, column) => `commit ${short} message:${line}:${column}`));
    const parent = parents.trim().split(/\s+/).find((one) => one !== '');
    hits.push(...(await scanChange(cwd, parent ?? (await emptyTree(cwd)), sha, terms, sha)));
  }
  return dedupe(hits);
}

// The tree of what commitAndRebase would commit in the worktree, built in a temporary index.
export async function worktreeTree(cwd: string, baseCommit: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sf-guard-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    await gitOk(cwd, ['read-tree', baseCommit], env);
    const paths = await commitPaths(cwd, baseCommit);
    for (let start = 0; start < paths.length; start += ADD_CHUNK) {
      await gitOk(cwd, ['add', '--all', '--', ...paths.slice(start, start + ADD_CHUNK).map((path) => `:(literal)${path}`)], env);
    }
    return (await gitOk(cwd, ['write-tree'], env)).stdout.toString('utf8').trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- The pre-push hook -------------------------------------------------------------------------

// The text single-quoted for sh.
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

// The pre-push hook: sf guard for every pushed ref but a deletion; a hit refuses the push.
export function hookText(sf: string, workspace: string): string {
  const name = shellQuote(workspace);
  return [
    '#!/bin/sh',
    GUARD_HOOK_MARKER,
    `sf=${shellQuote(sf)}`,
    'remote="$1"',
    'while read -r local_ref local_sha remote_ref remote_sha; do',
    '  case "$local_sha" in *[!0]*) ;; *) continue ;; esac',
    '  case "$remote_ref" in',
    `    refs/heads/*) "$sf" guard ${name} "$local_sha" --remote "$remote" --branch "\${remote_ref#refs/heads/}" </dev/null || exit 1 ;;`,
    `    *) "$sf" guard ${name} "$local_sha" --remote "$remote" </dev/null || exit 1 ;;`,
    '  esac',
    'done',
    'exit 0',
    '',
  ].join('\n');
}

// Where Git looks for the checkout's pre-push hook: the repository's own core.hooksPath (every
// factory Git call sets it to /dev/null on its command line, so the value is read by
// scope, the command line's left out), resolved against the work tree's root (a leading ~/
// against the home directory); without one, hooks/ of the common Git dir.
async function prePushPath(checkout: string): Promise<string> {
  const args = ['config', '--show-scope', '--get-all', 'core.hooksPath'];
  const scoped = await runGit(checkout, args);
  if (scoped.code !== 0 && scoped.code !== 1) {
    throw new FactoryError('guard_failed', gitFailure(args, scoped));
  }
  const own = scoped.stdout.toString('utf8').split('\n').flatMap((line) => {
    const match = /^(\S+)\t(.*)$/.exec(line);
    return match !== null && match[1] !== 'command' ? [match[2]!] : [];
  }).at(-1);
  if (own !== undefined && own !== '') {
    return resolve(checkout, own.startsWith('~/') ? join(homedir(), own.slice(2)) : own, 'pre-push');
  }
  const common = (await gitOk(checkout, ['rev-parse', '--git-common-dir'])).stdout.toString('utf8').trim();
  return resolve(checkout, common, 'hooks', 'pre-push');
}

// Writes the pre-push hook of the checkout (core.hooksPath followed); an existing hook is
// rewritten only when it is the factory's own.
export async function installHook(checkout: string, workspace: string, sf = INSTALLED_SF): Promise<{ path: string; replaced: boolean }> {
  const path = await prePushPath(checkout);
  let existing: string | undefined;
  try {
    existing = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  if (existing !== undefined && existing.split('\n')[1]?.replace(/\r$/, '') !== GUARD_HOOK_MARKER) {
    throw new FactoryError('guard_hook_exists', `A pre-push hook that is not the factory's exists at ${path}; call sf guard ${workspace} "$local_sha" --remote "$1" from it yourself.`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, hookText(sf, workspace), { mode: 0o755 });
  await chmod(path, 0o755);
  return { path, replaced: existing !== undefined };
}
