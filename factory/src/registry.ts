// The workspace registry: ${SF_CONFIG_DIR:-${XDG_CONFIG_HOME:-~/.config}/software-factory}/workspaces.json.
// Strictly parsed; an invalid file is an error, a missing file an empty registry. The checkout
// path is verified at use time: it must be the root of a non-bare Git work tree. A workspace is
// one checkout: the Implementer works in a worktree of it, so a separate work checkout
// (`work_checkout`) is read for compatibility and ignored. A workspace's optional `handoff` wins
// over SF_HANDOFF for its jobs; its optional `color` marks its cards on the board; its optional
// `label` is what the dashboard's cards call the workspace instead of its name; its optional
// `rules_skip` names the repository rule files not given to the agents. A workspace has an optional
// `description`, `app` (workspaces of one app share one daily) and `digest: {track, my_work}`, and
// the registry an optional top-level `digest` (the morning digest's times, weekdays only, model and
// language) and `explain` (the plain explanation of each stop: on, model and language). A workspace
// has an optional `guard` (src/guard.ts: its pushes and MR texts are checked for the names of the
// user's other workspaces; absent: false) and an optional `test_command` (src/test-command.ts: the
// factory runs it in a sandbox before a job is ready; absent: no run) and an optional `notify`
// (full, brief or off: how much its notifications tell; absent: full) and an optional `auto_queue`
// (src/queue.ts addByItself: a Task whose plan is ready joins the run queue by itself; absent: false)
// and an optional `auto_planner` (New ticket on the dashboard with the owner Claude Code starts the
// ticket's planner session once its images are stored; absent: false) and an optional
// `last_review_skill` (src/last-review.ts: the absolute path of the folder of the last review's
// skill; absent: no last review) and an optional `issue_import` (src/issue-import.ts: on, the issue
// key prefixes, the Jira site and the allowlist hook of the issue read; absent or off: no import).
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import * as z from 'zod/v4';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';
import { gitToplevel } from './git.js';
import { MAX_TEST_COMMAND_CHARS } from './test-command.js';

export const WORKSPACE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const WORKSPACE_NAME_DESCRIPTION = '1-64 characters of a-z, 0-9 and "-", starting and ending with a letter or digit';
const REGISTRY_FILE = 'workspaces.json';

// The workspace's test command: 1 to MAX_TEST_COMMAND_CHARS characters, no NUL.
const testCommand = z
  .string()
  .min(1)
  .max(MAX_TEST_COMMAND_CHARS)
  .refine((value) => !value.includes('\0'), 'must be a command without NUL');

const absolutePath = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value) && !value.includes('\0'), 'must be an absolute path without NUL');

// A workspace's issue import (src/issue-import.ts): on, the issue key prefixes it may read, the
// Jira site's host (the cloudId of every call) and the user's allowlist hook every call goes through.
export const ISSUE_PREFIX_PATTERN = /^[A-Z][A-Z0-9_]{0,19}$/;
export const ISSUE_SITE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const MAX_ISSUE_PREFIXES = 20;
const issueImportSchema = z.strictObject({
  on: z.boolean(),
  prefixes: z.array(z.string().regex(ISSUE_PREFIX_PATTERN, 'must be an issue key prefix: A-Z, then up to 19 of A-Z, 0-9 and _')).min(1).max(MAX_ISSUE_PREFIXES),
  site: z.string().regex(ISSUE_SITE_PATTERN, 'must be the Jira site\'s host name in lower case, such as example.atlassian.net'),
  hook: absolutePath,
});
export type IssueImportSettings = Omit<z.infer<typeof issueImportSchema>, 'on'>;

// The hand-over settings: checkout hands a job ready for review over to the
// workspace's checkout; off leaves it in ready_for_human_review.
export const HANDOFF_MODES = ['checkout', 'off'] as const;
export type HandoffMode = (typeof HANDOFF_MODES)[number];
// The handoff_skipped code of a job that was not handed over because hand-over is off:
// a setting, not a refusal.
export const HANDOFF_OFF_CODE = 'handoff_off';

export function isHandoffMode(value: unknown): value is HandoffMode {
  return (HANDOFF_MODES as readonly unknown[]).includes(value);
}

// How much a workspace's notifications tell (src/notify.ts): full, the whole notification; brief,
// on ntfy only the title and one line with the workspace's name (and an error's code); off, none.
// Absent: full.
export const NOTIFY_MODES = ['full', 'brief', 'off'] as const;
export type NotifyMode = (typeof NOTIFY_MODES)[number];

export function isNotifyMode(value: unknown): value is NotifyMode {
  return (NOTIFY_MODES as readonly unknown[]).includes(value);
}

// The workspace colours: the board's palette, each a light and a dark token --ws-<name> in
// static/app.css. A workspace's optional `color` picks one; without it, workspaceColor hashes the name.
export const WORKSPACE_COLORS = ['blue', 'teal', 'green', 'olive', 'orange', 'red', 'purple', 'grey'] as const;
export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];

export function isWorkspaceColor(value: unknown): value is WorkspaceColor {
  return (WORKSPACE_COLORS as readonly unknown[]).includes(value);
}

// The colour of a workspace: its configured one, else the palette entry at the sum of the UTF-16
// code units of its name mod the palette's size (stable across starts and machines).
export function workspaceColor(name: string, color?: WorkspaceColor): WorkspaceColor {
  if (color !== undefined) {
    return color;
  }
  let sum = 0;
  for (let index = 0; index < name.length; index += 1) {
    sum += name.charCodeAt(index);
  }
  return WORKSPACE_COLORS[sum % WORKSPACE_COLORS.length]!;
}

// The morning digest: a workspace's description and app, at most this long.
export const MAX_DESCRIPTION_CHARS = 2000;
export const MAX_APP_CHARS = 64;
// A workspace's label: what fits a board card's first line beside a ticket key.
export const MAX_LABEL_CHARS = 24;
// "HH:MM", 00:00 to 23:59.
export const DIGEST_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const MAX_LANGUAGE_CHARS = 40;

// A workspace's digest switches: track, followed in the morning digest; my_work, my commits
// here go into the daily of its app. Absent: false.
const workspaceDigestSchema = z.strictObject({ track: z.boolean().optional(), my_work: z.boolean().optional() });

// The scheduled digest's times of day: 1 to MAX_DIGEST_TIMES distinct HH:MM, in any order
// (digestSettings sorts them).
export const MAX_DIGEST_TIMES = 4;
const clockTime = z.string().regex(DIGEST_TIME_PATTERN, 'must be HH:MM (00:00 to 23:59)');
export const digestTimesSchema = z.array(clockTime).min(1).max(MAX_DIGEST_TIMES)
  .refine((times) => new Set(times).size === times.length, 'must not hold a time twice');

// at: the single time of older files; times wins when both are there.
const digestSettingsSchema = z.strictObject({
  times: digestTimesSchema.optional(),
  at: clockTime.optional(),
  weekdays_only: z.boolean().optional(),
  model: z.string().min(1).optional(),
  language: z.string().trim().min(1).max(MAX_LANGUAGE_CHARS).optional(),
});

// The plain explanation of each stop: on, its language and model; every field optional.
const explainSettingsSchema = z.strictObject({
  on: z.boolean().optional(),
  language: z.string().trim().min(1).max(MAX_LANGUAGE_CHARS).optional(),
  model: z.string().min(1).optional(),
});

// A workspace's label: what the dashboard's cards call it instead of its name; one line, trimmed.
// The control characters are checked before the trim, so a line break or tab at either end is
// refused, not trimmed away.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const workspaceLabel = z.string()
  .refine((label) => !CONTROL_CHARACTER.test(label), 'must be one line without control characters')
  .trim().min(1).max(MAX_LABEL_CHARS);

const registrySchema = z.strictObject({
  workspaces: z.record(
    z.string().regex(WORKSPACE_NAME_PATTERN),
    z.strictObject({
      read_checkout: absolutePath, work_checkout: absolutePath.optional(), handoff: z.enum(HANDOFF_MODES).optional(), color: z.enum(WORKSPACE_COLORS).optional(),
      label: workspaceLabel.optional(),
      notify: z.enum(NOTIFY_MODES).optional(),
      rules_skip: z.array(z.string().min(1)).optional(),
      description: z.string().max(MAX_DESCRIPTION_CHARS).optional(),
      app: z.string().trim().min(1).max(MAX_APP_CHARS).optional(),
      digest: workspaceDigestSchema.optional(),
      guard: z.boolean().optional(),
      test_command: testCommand.optional(),
      auto_queue: z.boolean().optional(),
      auto_planner: z.boolean().optional(),
      last_review_skill: absolutePath.optional(),
      issue_import: issueImportSchema.optional(),
    }),
  ),
  digest: digestSettingsSchema.optional(),
  explain: explainSettingsSchema.optional(),
});

export type Registry = z.infer<typeof registrySchema>;
export type WorkspaceEntry = Registry['workspaces'][string];

// The morning digest's settings with their defaults.
export interface DigestSettings {
  // Sorted ascending: times[0] is the earliest.
  times: string[];
  weekdays_only: boolean;
  model: string;
  language: string;
}
export const DIGEST_DEFAULTS: DigestSettings = { times: ['08:00'], weekdays_only: true, model: 'sonnet', language: 'English' };

// The settings: times from digest.times, else [digest.at], else the default, sorted ascending.
export function digestSettings(registry: Registry): DigestSettings {
  const { times, at, weekdays_only, model, language } = registry.digest ?? {};
  return {
    times: [...(times ?? (at !== undefined ? [at] : DIGEST_DEFAULTS.times))].sort(),
    weekdays_only: weekdays_only ?? DIGEST_DEFAULTS.weekdays_only,
    model: model ?? DIGEST_DEFAULTS.model,
    language: language ?? DIGEST_DEFAULTS.language,
  };
}

// The stop explanations' settings with their defaults.
export interface ExplainSettings {
  on: boolean;
  language: string;
  model: string;
}
export const EXPLAIN_DEFAULTS: ExplainSettings = { on: true, language: 'English', model: 'sonnet' };

export function explainSettings(registry: Registry): ExplainSettings {
  return { ...EXPLAIN_DEFAULTS, ...registry.explain };
}

// A workspace's digest switches, absent ones false.
export function workspaceDigest(entry: WorkspaceEntry): { track: boolean; my_work: boolean } {
  return { track: entry.digest?.track === true, my_work: entry.digest?.my_work === true };
}

// A workspace's app: its own, else its name (one repository, one project).
export function workspaceApp(name: string, entry: WorkspaceEntry): string {
  return entry.app ?? name;
}

// A workspace's issue import when it is on: its prefixes, site and hook; undefined when the key
// is absent or "on" is false.
export function workspaceIssueImport(entry: WorkspaceEntry): IssueImportSettings | undefined {
  const settings = entry.issue_import;
  if (settings === undefined || !settings.on) {
    return undefined;
  }
  return { prefixes: [...settings.prefixes], site: settings.site, hook: settings.hook };
}

// A workspace's notify setting, absent full.
export function workspaceNotify(entry: WorkspaceEntry): NotifyMode {
  return entry.notify ?? 'full';
}

// The notify setting of a workspace as the registry holds it now: read for each notification, so
// sf workspace notify applies to the next one; a workspace not registered, or a registry that
// cannot be read, is full.
export async function workspaceNotifyMode(name: string, dir = configDir()): Promise<NotifyMode> {
  try {
    const { workspaces } = await loadRegistry(dir);
    return Object.hasOwn(workspaces, name) ? workspaceNotify(workspaces[name]!) : 'full';
  } catch { // an unreadable or invalid registry: the notification goes out in full
    return 'full';
  }
}

// sf workspace notify: sets the notify setting of a registered workspace (full removes the key,
// the default); workspace_not_found when it is not registered.
export async function setWorkspaceNotify(name: string, notify: NotifyMode, dir = configDir()): Promise<void> {
  const registry = await loadRegistry(dir);
  if (!Object.hasOwn(registry.workspaces, name)) {
    throw new FactoryError('workspace_not_found', `workspace "${name}" is not registered.`);
  }
  const { notify: _old, ...rest } = registry.workspaces[name]!;
  registry.workspaces[name] = notify === 'full' ? rest : { ...rest, notify };
  await saveRegistry(registry, dir);
}

// sf workspace auto-planner: on writes "auto_planner": true, off removes the key (the default);
// workspace_not_found when it is not registered.
export async function setWorkspaceAutoPlanner(name: string, on: boolean, dir = configDir()): Promise<void> {
  const registry = await loadRegistry(dir);
  if (!Object.hasOwn(registry.workspaces, name)) {
    throw new FactoryError('workspace_not_found', `workspace "${name}" is not registered.`);
  }
  const { auto_planner: _old, ...rest } = registry.workspaces[name]!;
  registry.workspaces[name] = on ? { ...rest, auto_planner: true } : rest;
  await saveRegistry(registry, dir);
}

// What the Setup's Edit replaces; "" removes description, app and label, 'default' the handoff
// key, 'auto' the color key, and digest with both false the digest key; an absent label keeps the
// label. work_checkout, rules_skip, guard, test_command, notify, auto_queue, auto_planner,
// last_review_skill and issue_import stay as they are.
export interface WorkspaceEdit {
  read_checkout: string;
  description: string;
  app: string;
  handoff: HandoffMode | 'default';
  color: WorkspaceColor | 'auto';
  // "" removes the label, a text sets it (through checkLabel), absent keeps it.
  label?: string;
  digest: { track: boolean; my_work: boolean };
}

// A label as sf workspace add --label and the Edit take it: trimmed, "" (also after trimming) is
// none (undefined); refused with workspace_invalid when it is not one line of at most
// MAX_LABEL_CHARS characters. A control character is refused even when it is all there is, so a
// lone line break or tab does not remove the label.
export function checkLabel(text: string): string | undefined {
  if (text.trim() === '' && !CONTROL_CHARACTER.test(text)) return undefined;
  const parsed = workspaceLabel.safeParse(text);
  if (!parsed.success) {
    throw new FactoryError('workspace_invalid', `The label must be one line of at most ${MAX_LABEL_CHARS} characters.`);
  }
  return parsed.data;
}

export function editedEntry(entry: WorkspaceEntry, edit: WorkspaceEdit): WorkspaceEntry {
  const { read_checkout: _read, description: _description, app: _app, handoff: _handoff, color: _color, label: _label, digest: _digest, ...kept } = entry;
  const description = edit.description.trim();
  const app = edit.app.trim();
  const label = typeof edit.label === 'string' ? checkLabel(edit.label) : entry.label;
  return {
    ...kept,
    read_checkout: edit.read_checkout,
    ...(edit.handoff !== 'default' ? { handoff: edit.handoff } : {}),
    ...(edit.color !== 'auto' ? { color: edit.color } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(description !== '' ? { description } : {}),
    ...(app !== '' ? { app } : {}),
    ...(edit.digest.track || edit.digest.my_work ? { digest: { track: edit.digest.track, my_work: edit.digest.my_work } } : {}),
  };
}

// The workspace's fields as the registry would hold them: refused with workspace_invalid when
// the description or the app is too long.
export function checkWorkspaceText(description: string, app: string): void {
  if (description.trim().length > MAX_DESCRIPTION_CHARS) {
    throw new FactoryError('workspace_invalid', `The description must be at most ${MAX_DESCRIPTION_CHARS} characters.`);
  }
  if (app.trim().length > MAX_APP_CHARS) {
    throw new FactoryError('workspace_invalid', `The app must be at most ${MAX_APP_CHARS} characters.`);
  }
}

export interface Workspace {
  name: string;
  // The real path of the checkout, verified as a Git work tree root; for file operations only,
  // never returned to clients. Both names hold the same path: the Context owner reads
  // it, the Task files live in it, and every job's worktree is created from it.
  readCheckout: string;
  workCheckout: string;
  // The workspace's own hand-over setting; absent: SF_HANDOFF applies.
  handoff?: HandoffMode;
  // The repository rule files not given to the agents, as globs.
  rulesSkip?: string[];
  // "guard": true in workspaces.json; absent otherwise.
  guard?: boolean;
  // The workspace's test_command; absent: no test run before a job is ready.
  testCommand?: string;
  // "auto_queue": true in workspaces.json; absent otherwise.
  autoQueue?: boolean;
  // "auto_planner": true in workspaces.json; absent otherwise.
  autoPlanner?: boolean;
  // The workspace's last_review_skill: the folder of the last review's skill; absent: no last review.
  lastReviewSkill?: string;
}

// The entries whose ignored work_checkout differs from the checkout, for one warning at start.
export function ignoredWorkCheckouts(registry: Registry): string[] {
  return Object.entries(registry.workspaces).filter(([, entry]) => entry.work_checkout !== undefined && entry.work_checkout !== entry.read_checkout).map(([name]) => name);
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SF_CONFIG_DIR) {
    return env.SF_CONFIG_DIR;
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'software-factory');
}

export function parseRegistry(text: string): Registry {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch { // not JSON: reported as registry_invalid
    throw new FactoryError('registry_invalid', `${REGISTRY_FILE} is not valid JSON.`);
  }
  const parsed = registrySchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new FactoryError('registry_invalid', `${REGISTRY_FILE} is invalid: ${issues.join('; ')}.`);
  }
  return parsed.data;
}

export async function loadRegistry(dir = configDir()): Promise<Registry> {
  let text: string;
  try {
    text = await readFile(join(dir, REGISTRY_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { workspaces: {} };
    }
    throw new FactoryError('registry_invalid', `${REGISTRY_FILE} could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`);
  }
  return parseRegistry(text);
}

export async function saveRegistry(registry: Registry, dir = configDir()): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(join(dir, REGISTRY_FILE), Buffer.from(`${JSON.stringify(registrySchema.parse(registry), null, 2)}\n`));
}

// Returns the real path of a checkout that is the root of a non-bare Git work tree; the
// message names only the role, never the path.
export async function verifyCheckout(path: string, role: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(path);
  } catch { // the path does not resolve: reported as workspace_invalid
    throw new FactoryError('workspace_invalid', `The ${role} does not exist.`);
  }
  if ((await gitToplevel(real)) !== real) {
    throw new FactoryError('workspace_invalid', `The ${role} is not the root of a non-bare Git work tree.`);
  }
  return real;
}

export async function resolveWorkspace(name: string, dir = configDir()): Promise<Workspace> {
  const { workspaces } = await loadRegistry(dir);
  // Own properties only: "constructor" is a valid name but must not reach Object.prototype.
  const entry = WORKSPACE_NAME_PATTERN.test(name) && Object.hasOwn(workspaces, name) ? workspaces[name] : undefined;
  if (entry === undefined) {
    throw new FactoryError('workspace_not_found', `Workspace "${name}" is not registered.`);
  }
  try {
    const checkout = await verifyCheckout(entry.read_checkout, 'checkout');
    return {
      name, readCheckout: checkout, workCheckout: checkout, ...(entry.handoff !== undefined ? { handoff: entry.handoff } : {}),
      ...(entry.rules_skip !== undefined ? { rulesSkip: entry.rules_skip } : {}),
      ...(entry.guard === true ? { guard: true } : {}),
      ...(entry.test_command !== undefined ? { testCommand: entry.test_command } : {}),
      ...(entry.auto_queue === true ? { autoQueue: true } : {}),
      ...(entry.auto_planner === true ? { autoPlanner: true } : {}),
      ...(entry.last_review_skill !== undefined ? { lastReviewSkill: entry.last_review_skill } : {}),
    };
  } catch (error) {
    if (error instanceof FactoryError) {
      throw new FactoryError(error.code, `Workspace "${name}": ${error.message}`);
    }
    throw error;
  }
}
