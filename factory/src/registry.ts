// The workspace registry: ${SF_CONFIG_DIR:-${XDG_CONFIG_HOME:-~/.config}/software-factory}/workspaces.json.
// Strictly parsed; an invalid file is an error, a missing file an empty registry. The checkout
// path is verified at use time: it must be the root of a non-bare Git work tree. Since SF-019 a
// workspace is one checkout: the Implementer works in a worktree of it, so a separate work
// checkout (`work_checkout`) is read for compatibility and ignored. A workspace's optional `handoff`
// (SF-083) wins over SF_HANDOFF for its jobs; its optional `color` (SF-084) marks its cards on the board;
// its optional `rules_skip` (SF-059) names the repository rule files not given to the agents. Since
// SF-103 a workspace has an optional `description`, `app` (workspaces of one app share one daily) and
// `digest: {track, my_work}`, and the registry an optional top-level `digest` (the morning digest's
// time, weekdays only, model and language).
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import * as z from 'zod/v4';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';
import { gitToplevel } from './git.js';

export const WORKSPACE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const WORKSPACE_NAME_DESCRIPTION = '1-64 characters of a-z, 0-9 and "-", starting and ending with a letter or digit';
const REGISTRY_FILE = 'workspaces.json';

const absolutePath = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value) && !value.includes('\0'), 'must be an absolute path without NUL');

// The hand-over settings (SF-073, SF-083): checkout hands a job ready for review over to the
// workspace's checkout; off leaves it in ready_for_human_review.
export const HANDOFF_MODES = ['checkout', 'off'] as const;
export type HandoffMode = (typeof HANDOFF_MODES)[number];
// The handoff_skipped code of a job that was not handed over because hand-over is off (SF-083):
// a setting, not a refusal.
export const HANDOFF_OFF_CODE = 'handoff_off';

export function isHandoffMode(value: unknown): value is HandoffMode {
  return (HANDOFF_MODES as readonly unknown[]).includes(value);
}

// The workspace colours (SF-084): the board's palette, each a light and a dark token --ws-<name> in
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

// The morning digest (SF-103): a workspace's description and app, at most this long.
export const MAX_DESCRIPTION_CHARS = 2000;
export const MAX_APP_CHARS = 64;
// "HH:MM", 00:00 to 23:59.
export const DIGEST_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const MAX_LANGUAGE_CHARS = 40;

// A workspace's digest switches (SF-103): track, followed in the morning digest; my_work, my commits
// here go into the daily of its app. Absent: false.
const workspaceDigestSchema = z.strictObject({ track: z.boolean().optional(), my_work: z.boolean().optional() });

const digestSettingsSchema = z.strictObject({
  at: z.string().regex(DIGEST_TIME_PATTERN, 'must be HH:MM (00:00 to 23:59)').optional(),
  weekdays_only: z.boolean().optional(),
  model: z.string().min(1).optional(),
  language: z.string().trim().min(1).max(MAX_LANGUAGE_CHARS).optional(),
});

const registrySchema = z.strictObject({
  workspaces: z.record(
    z.string().regex(WORKSPACE_NAME_PATTERN),
    z.strictObject({
      read_checkout: absolutePath, work_checkout: absolutePath.optional(), handoff: z.enum(HANDOFF_MODES).optional(), color: z.enum(WORKSPACE_COLORS).optional(),
      rules_skip: z.array(z.string().min(1)).optional(),
      description: z.string().max(MAX_DESCRIPTION_CHARS).optional(),
      app: z.string().trim().min(1).max(MAX_APP_CHARS).optional(),
      digest: workspaceDigestSchema.optional(),
    }),
  ),
  digest: digestSettingsSchema.optional(),
});

export type Registry = z.infer<typeof registrySchema>;
export type WorkspaceEntry = Registry['workspaces'][string];

// The morning digest's settings with their defaults (SF-103).
export interface DigestSettings {
  at: string;
  weekdays_only: boolean;
  model: string;
  language: string;
}
export const DIGEST_DEFAULTS: DigestSettings = { at: '08:00', weekdays_only: true, model: 'sonnet', language: 'English' };

export function digestSettings(registry: Registry): DigestSettings {
  return { ...DIGEST_DEFAULTS, ...registry.digest };
}

// A workspace's digest switches, absent ones false.
export function workspaceDigest(entry: WorkspaceEntry): { track: boolean; my_work: boolean } {
  return { track: entry.digest?.track === true, my_work: entry.digest?.my_work === true };
}

// A workspace's app: its own, else its name (one repository, one project).
export function workspaceApp(name: string, entry: WorkspaceEntry): string {
  return entry.app ?? name;
}

// What the Setup's Edit replaces (SF-103); "" removes description and app, 'default' the handoff
// key, 'auto' the color key, and digest with both false the digest key. work_checkout and
// rules_skip stay as they are.
export interface WorkspaceEdit {
  read_checkout: string;
  description: string;
  app: string;
  handoff: HandoffMode | 'default';
  color: WorkspaceColor | 'auto';
  digest: { track: boolean; my_work: boolean };
}

export function editedEntry(entry: WorkspaceEntry, edit: WorkspaceEdit): WorkspaceEntry {
  const { read_checkout: _read, description: _description, app: _app, handoff: _handoff, color: _color, digest: _digest, ...kept } = entry;
  const description = edit.description.trim();
  const app = edit.app.trim();
  return {
    ...kept,
    read_checkout: edit.read_checkout,
    ...(edit.handoff !== 'default' ? { handoff: edit.handoff } : {}),
    ...(edit.color !== 'auto' ? { color: edit.color } : {}),
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
  // never returned to clients. Both names hold the same path since SF-019: the Context owner reads
  // it, the Task files live in it, and every job's worktree is created from it.
  readCheckout: string;
  workCheckout: string;
  // The workspace's own hand-over setting (SF-083); absent: SF_HANDOFF applies.
  handoff?: HandoffMode;
  // The repository rule files not given to the agents (SF-059), as globs.
  rulesSkip?: string[];
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
  } catch {
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
  } catch {
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
    };
  } catch (error) {
    if (error instanceof FactoryError) {
      throw new FactoryError(error.code, `Workspace "${name}": ${error.message}`);
    }
    throw error;
  }
}
