// The coordinator's skills: the Claude Code session the user runs in the checkout of the workspace
// SF_COORDINATOR_WORKSPACE (software-factory by default). Its choice is Claude Code's own per-project
// switch, the skillOverrides key of <checkout>/.claude/settings.local.json ({ <skill>: "on" | "off" |
// "name-only" | "user-invocable-only" }; absent is on), so the file is the truth: read on every
// view, never stored by the factory. A change reads the file (missing: {}), sets or removes the
// keys of skillOverrides it changes (removing skillOverrides once empty), keeps every other key in
// value and order, and writes it atomically with its mode (a new file 0600, a new .claude 0700).
// The file is reached only through one handle on .claude, opened without following a link and
// checked to be the checkout's own .claude; the read, the temporary file and the rename all go
// through that handle (Linux's /proc/self/fd/<fd>), so a .claude swapped for a link meanwhile
// cannot send a read or a write anywhere else.
// Refused, the file untouched: a file that is not a JSON object or whose skillOverrides is not one
// (coordinator_settings_unreadable), and a .claude or settings file that is a symlink or not a
// folder / file, or a .claude that is not the checkout's (coordinator_settings_unsafe); a file the
// system will not let it read or write is coordinator_settings_unreadable / _unwritable. No key but
// skillOverrides is read for meaning or written. Messages name the file relative to the checkout.
import { constants } from 'node:fs';
import { type FileHandle, mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomicWith } from './atomic.js';
import { FactoryError } from './errors.js';
import { configDir, resolveWorkspace } from './registry.js';
import { SKILL_NAME } from './skill-roles.js';

// A skill's override, as Claude Code writes it; "on" also stands for an absent one.
export const OVERRIDES = ['on', 'off', 'name-only', 'user-invocable-only'] as const;
export type SkillOverride = (typeof OVERRIDES)[number];

// The coordinator's column as the dashboard gets it: the workspace and each installed skill's
// state; or why there is none.
export type CoordinatorColumn = { workspace: string; skills: Record<string, SkillOverride> } | { error: { code: string; message: string } };
// The same with the checkout and its settings file (absolute paths, for the local CLI only).
export type CoordinatorSkills = Extract<CoordinatorColumn, { error: unknown }> | (Exclude<CoordinatorColumn, { error: unknown }> & { checkout: string; settings: string });

// The column's name where a role's would be: sf skills set coordinator, PUT api/skills/roles/coordinator.
export const COORDINATOR = 'coordinator';

// The view without the absolute paths, for the dashboard: a checkout's path never reaches a client.
export const coordinatorForClients = (view: CoordinatorSkills): CoordinatorColumn => ('error' in view ? view : { workspace: view.workspace, skills: view.skills });

const DEFAULT_WORKSPACE = 'software-factory';
const FOLDER = '.claude';
const FILE = 'settings.local.json';

// For the tests only: called in a change after the file was read through the folder's handle and
// before the write, so a test can swap .claude in between.
export const coordinatorTestHooks: { beforeWrite?: () => Promise<void> } = {};

// The coordinator's workspace: SF_COORDINATOR_WORKSPACE, else software-factory.
export const coordinatorWorkspace = (env: NodeJS.ProcessEnv = process.env): string => env.SF_COORDINATOR_WORKSPACE || DEFAULT_WORKSPACE;

// The coordinator's checkout: workspace_not_found becomes no_coordinator_workspace; the
// registry's other refusals (workspace_invalid, registry_invalid) pass through.
async function coordinatorCheckout(env: NodeJS.ProcessEnv): Promise<{ workspace: string; checkout: string }> {
  const workspace = coordinatorWorkspace(env);
  try {
    return { workspace, checkout: (await resolveWorkspace(workspace, configDir(env))).readCheckout };
  } catch (error) {
    if (error instanceof FactoryError && error.code === 'workspace_not_found') {
      throw new FactoryError('no_coordinator_workspace', `No coordinator workspace (SF_COORDINATOR_WORKSPACE): "${workspace.slice(0, 100)}" is not registered.`);
    }
    throw error;
  }
}

// A file system failure on the settings file as a refusal that names it (name: relative to the
// checkout) and the error's code, never its path: a link where none may be (ELOOP, as O_NOFOLLOW
// reports one) or a .claude that is not a folder (ENOTDIR) is unsafe, any other failure unreadable
// or, for a write, unwritable. Anything else is returned as it is.
function refusalOf(error: unknown, name: string, writing: boolean): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (error instanceof FactoryError || typeof code !== 'string') {
    return error;
  }
  if (code === 'ELOOP' || code === 'ENOTDIR') {
    return new FactoryError('coordinator_settings_unsafe', `${name} is not changed: ${code === 'ELOOP' ? 'a symlink is on its path' : '.claude is not a folder'} (${code}).`);
  }
  return writing
    ? new FactoryError('coordinator_settings_unwritable', `${name} could not be written (${code}).`)
    : new FactoryError('coordinator_settings_unreadable', `${name} could not be read (${code}).`);
}

// A JSON.parse message without the excerpt of the file Node quotes in some ("..." is not valid JSON).
const parseError = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/, ".*" is not valid JSON$/s, ' (not valid JSON)');

// Whether a parsed JSON value is an object (not null, not an array).
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// The coordinator's .claude, open: the workspace, its checkout, the file's name for messages
// (relative to the checkout), and the folder as its handle's path (/proc/self/fd/<fd>), which
// names the folder opened whatever is at <checkout>/.claude later; none when .claude is missing.
interface Folder {
  workspace: string;
  checkout: string;
  name: string;
  path: string | undefined;
}

// Opens <checkout>/.claude without following a link (missing: undefined), and refuses it unless its
// handle resolves to the checkout's own .claude.
async function openFolder(checkout: string, name: string): Promise<FileHandle | undefined> {
  const dir = join(checkout, FOLDER);
  const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? undefined : Promise.reject(error)));
  if (handle !== undefined && (await realpath(`/proc/self/fd/${handle.fd}`).catch(() => undefined)) !== dir) {
    await handle.close();
    throw new FactoryError('coordinator_settings_unsafe', `${name} is not changed: .claude is not the checkout's own.`);
  }
  return handle;
}

// Runs work with the coordinator's .claude open (Folder), and closes it after; a file system
// failure on the way is a refusal (refusalOf; writing: of a change).
async function inFolder<T>(env: NodeJS.ProcessEnv, writing: boolean, work: (folder: Folder) => Promise<T>): Promise<T> {
  const { workspace, checkout } = await coordinatorCheckout(env);
  const name = `the ${workspace} checkout's ${FOLDER}/${FILE}`;
  let handle: FileHandle | undefined;
  try {
    handle = await openFolder(checkout, name);
    return await work({ workspace, checkout, name, path: handle === undefined ? undefined : `/proc/self/fd/${handle.fd}` });
  } catch (error) {
    throw refusalOf(error, name, writing);
  } finally {
    await handle?.close();
  }
}

// The settings file as read through the folder: the parsed file ({} when missing), its
// skillOverrides (undefined when absent) and its mode (undefined when missing).
interface Settings {
  data: Record<string, unknown>;
  overrides: Record<string, unknown> | undefined;
  mode: number | undefined;
}

// Reads and checks the settings file in the open folder, the file opened without following a link.
async function readSettings(folder: Folder): Promise<Settings> {
  if (folder.path === undefined) {
    return { data: {}, overrides: undefined, mode: undefined };
  }
  const handle = await open(join(folder.path, FILE), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? undefined : Promise.reject(error)));
  if (handle === undefined) {
    return { data: {}, overrides: undefined, mode: undefined };
  }
  let text: string;
  let mode: number;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new FactoryError('coordinator_settings_unsafe', `${folder.name} is not changed: it is not a file.`);
    }
    mode = stats.mode & 0o777;
    text = await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
  const unreadable = (why: string): FactoryError => new FactoryError('coordinator_settings_unreadable', `${folder.name} is not changed: ${why}.`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw unreadable(`it is not JSON (${parseError(error)})`);
  }
  if (!isObject(data)) {
    throw unreadable('it is not a JSON object');
  }
  const overrides = Object.hasOwn(data, 'skillOverrides') ? data.skillOverrides : undefined;
  if (overrides !== undefined && !isObject(overrides)) {
    throw unreadable('its skillOverrides is not an object');
  }
  return { data, overrides, mode };
}

// A skill's state in overrides: its value when it is one of OVERRIDES, else on.
function stateOf(overrides: Record<string, unknown> | undefined, skill: string): SkillOverride {
  const value = overrides !== undefined && Object.hasOwn(overrides, skill) ? overrides[skill] : undefined;
  return (OVERRIDES as readonly unknown[]).includes(value) ? value as SkillOverride : 'on';
}

// The column's view for the installed skills; a refusal is its error, never thrown.
export async function coordinatorSkills(installed: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<CoordinatorSkills> {
  try {
    return await inFolder(env, false, async (folder) => {
      const settings = await readSettings(folder);
      return {
        workspace: folder.workspace, checkout: folder.checkout, settings: join(folder.checkout, FOLDER, FILE),
        skills: Object.fromEntries(installed.map((skill) => [skill, stateOf(settings.overrides, skill)])),
      };
    });
  } catch (error) {
    if (error instanceof FactoryError) {
      return { error: { code: error.code, message: error.message } };
    }
    throw error;
  }
}

// A key of an object set as its own property, whatever its name (no inherited setter runs).
const setOwn = (object: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
};

// The file's new content when a change differs from it (change: the skill's state now, the new
// value or undefined to leave it; on removes the key, off sets it); undefined when nothing changes.
function changed(settings: Settings, change: (state: SkillOverride, skill: string) => 'on' | 'off' | undefined, skills: readonly string[]): Record<string, unknown> | undefined {
  const overrides: Record<string, unknown> = { ...settings.overrides };
  let differs = false;
  for (const skill of skills) {
    const wanted = change(stateOf(settings.overrides, skill), skill);
    if (wanted === 'off' && !(Object.hasOwn(overrides, skill) && overrides[skill] === 'off')) {
      setOwn(overrides, skill, 'off');
      differs = true;
    } else if (wanted === 'on' && Object.hasOwn(overrides, skill)) {
      delete overrides[skill];
      differs = true;
    }
  }
  if (!differs) {
    return undefined;
  }
  const data: Record<string, unknown> = { ...settings.data };
  if (Object.keys(overrides).length === 0) {
    delete data.skillOverrides;
  } else {
    setOwn(data, 'skillOverrides', overrides);
  }
  return data;
}

// One change at a time per process, so two changes never read the same file and lose one's key.
let queue: Promise<unknown> = Promise.resolve();

// Reads the file through the folder's handle, applies the change (changed) and, when it differs,
// writes it atomically through the same handle: the temporary file and the rename in the folder
// read, never by its path. A missing .claude is made (0700) and the change run again through it.
async function changeOverrides(env: NodeJS.ProcessEnv, change: (state: SkillOverride, skill: string) => 'on' | 'off' | undefined, skills: readonly string[]): Promise<void> {
  const attempt = (): Promise<'made' | 'done'> => inFolder(env, true, async (folder) => {
    const settings = await readSettings(folder);
    const data = changed(settings, change, skills);
    if (data === undefined) {
      return 'done';
    }
    if (folder.path === undefined) {
      await mkdir(join(folder.checkout, FOLDER), { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => (error.code === 'EEXIST' ? undefined : Promise.reject(error)));
      return 'made';
    }
    await coordinatorTestHooks.beforeWrite?.();
    const mode = settings.mode ?? 0o600;
    await writeFileAtomicWith(join(folder.path, FILE), async (handle) => {
      await handle.chmod(mode);
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    }, mode);
    return 'done';
  });
  const run = queue.then(async () => {
    if ((await attempt()) === 'made' && (await attempt()) === 'made') {
      throw new FactoryError('coordinator_settings_unsafe', 'The coordinator checkout\'s .claude could not be opened after it was made.');
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

// Refuses names of another form than SKILL_NAME's or not installed.
function checkInstalled(names: readonly string[], installed: readonly string[]): void {
  const unknown = names.filter((name) => !SKILL_NAME.test(name) || !installed.includes(name));
  if (unknown.length > 0) {
    throw new FactoryError('skill_not_installed', `Not an installed skill: ${unknown.map((name) => name.slice(0, 100)).join(', ')}; installed: ${installed.length > 0 ? installed.join(', ') : 'none'} (npx skills add installs one).`);
  }
}

// PUT api/skills/roles/coordinator: the installed skills that are on. Only a state that differs
// changes: in the list and not on, the key removed; not in the list and on, set off; not in the
// list and name-only or user-invocable-only, left as it is.
export async function setCoordinatorSkills(on: readonly string[], installed: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  checkInstalled(on, installed);
  const switchable = installed.filter((name) => SKILL_NAME.test(name));
  await changeOverrides(env, (state, skill) => {
    if (on.includes(skill)) {
      return state === 'on' ? undefined : 'on';
    }
    return state === 'on' ? 'off' : undefined;
  }, switchable);
}

// sf skills set coordinator <skill> on|off: that skill's key only, whatever its state.
export async function switchCoordinatorSkill(skill: string, on: boolean, installed: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  checkInstalled([skill], installed);
  await changeOverrides(env, () => (on ? 'on' : 'off'), [skill]);
}
