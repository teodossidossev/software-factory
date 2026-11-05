// The workspace registry: ${SF_CONFIG_DIR:-${XDG_CONFIG_HOME:-~/.config}/software-factory}/workspaces.json.
// Strictly parsed; an invalid file is an error, a missing file an empty registry. The checkout
// path is verified at use time: it must be the root of a non-bare Git work tree. Since SF-019 a
// workspace is one checkout: the Implementer works in a worktree of it, so a separate work
// checkout (`work_checkout`) is read for compatibility and ignored. A workspace's optional `handoff`
// (SF-083) wins over SF_HANDOFF for its jobs.
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

const registrySchema = z.strictObject({
  workspaces: z.record(
    z.string().regex(WORKSPACE_NAME_PATTERN),
    z.strictObject({ read_checkout: absolutePath, work_checkout: absolutePath.optional(), handoff: z.enum(HANDOFF_MODES).optional() }),
  ),
});

export type Registry = z.infer<typeof registrySchema>;
export type WorkspaceEntry = Registry['workspaces'][string];

export interface Workspace {
  name: string;
  // The real path of the checkout, verified as a Git work tree root; for file operations only,
  // never returned to clients. Both names hold the same path since SF-019: the Context owner reads
  // it, the Task files live in it, and every job's worktree is created from it.
  readCheckout: string;
  workCheckout: string;
  // The workspace's own hand-over setting (SF-083); absent: SF_HANDOFF applies.
  handoff?: HandoffMode;
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
    return { name, readCheckout: checkout, workCheckout: checkout, ...(entry.handoff !== undefined ? { handoff: entry.handoff } : {}) };
  } catch (error) {
    if (error instanceof FactoryError) {
      throw new FactoryError(error.code, `Workspace "${name}": ${error.message}`);
    }
    throw error;
  }
}
