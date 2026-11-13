// The agents' skills: the user's installed ones (the `skills` tool's ~/.agents/skills, or
// SF_SKILLS_DIR), copied verbatim into a snapshot under the state directory, never edited. Which
// skills each agent role uses is the user's choice (src/skill-roles.ts); the snapshot holds every
// skill some role chose. The Implementer's wrapper binds its own skills' folders read-only at
// <config dir>/skills; the reviewers and the Task check get theirs in their prompts (code-review as
// the reviewers' method, the others as <skill> blocks, skillBlocks); the planning method is the
// planner's skills.
//
// The snapshot, <state dir>/skills, is a link to one folder of <state dir>/skills.d/, each folder a
// full set: every chosen skill's folder and versions.json ({ <name>: <skillFolderHash> }). A sync
// (once at each job's start, at sf serve's start and after each change of the choice) compares the
// lock file's hashes with versions.json (each skill's source folder looked up, never walked): equal,
// nothing is copied; else a new folder is built (the changed skills from the source, the others from
// the current snapshot) and the link swapped to it by a rename, so a session
// never sees a half copy. Two syncs at once each build their own folder; the last swap wins.
// A skill absent from the source or the lock file keeps its copy (none when it never had one).
// A job is pinned to its snapshot and its choice: its skills event records the folder the link
// named at its start and each role's list, every wrapper of the job binds that folder's skills of
// the job's Implementer (jobSkills), and the cleanup keeps the folders the jobs not yet archived recorded.
// Nothing here writes into the skills' source, ~/.claude or a workspace's checkout, with one
// exception: the coordinator's column (src/coordinator-skills.ts) changes the skillOverrides key of
// the coordinator checkout's .claude/settings.local.json, Claude Code's own per-project switch.
import { randomBytes } from 'node:crypto';
import { appendFile, cp, mkdir, open, readdir, readFile, readlink, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import {
  COORDINATOR, type CoordinatorColumn, coordinatorForClients, coordinatorSkills, type CoordinatorSkills, setCoordinatorSkills, switchCoordinatorSkill,
} from './coordinator-skills.js';
import { FactoryError } from './errors.js';
import { JobStore } from './jobs.js';
import { chosenSkills, isRole, readRoles, type Role, ROLES, type RoleSkills, rolesOf, SKILL_NAME, withRole, writeRoles } from './skill-roles.js';

const VERSIONS = 'versions.json';
const FOLDERS = 'skills.d';
// A folder of skills.d that is not current and no live job recorded is removed once this long
// past being replaced: a job with no recorded folder, or one just archived, may still bind it.
const KEEP_OLD_MS = 7 * 24 * 3600 * 1000;
// A folder as a job's skills event records it, relative to the state directory: skills.d/<id>.
const RECORDED = /^skills\.d\/[\w-]+$/;
// The bytes of a job's events.jsonl read for its skills event, which its start writes among its first lines.
const EVENTS_HEAD = 64 * 1024;
// The most of the <skill> blocks one prompt takes, all together (skillBlocks).
export const MAX_SKILL_BLOCKS_BYTES = 64 * 1024;
// The most of a skill's SKILL.md GET api/skills/<name> answers (skillText).
export const MAX_SKILL_TEXT_BYTES = 256 * 1024;

export interface SkillsSync {
  // The hash of each skill the snapshot holds.
  versions: Record<string, string>;
  // The chosen skills absent from the source or the lock file (all when either is missing).
  missing: string[];
  // The choice the sync read, and the folder its link named once it was done (the one it built, or
  // the current one it compared against; none without a snapshot): one pair, which a later sync
  // cannot change, since that one builds a folder of its own and only swaps the link.
  roles: RoleSkills;
  folder: string | undefined;
}

// A sync that failed after it read the choice and the current snapshot: its cause, and the pair of
// that snapshot as it was (versions, roles, folder), which a job then records.
export class SyncFailed extends Error {
  constructor(message: string, readonly snapshot: Omit<SkillsSync, 'missing'>) {
    super(message);
    this.name = 'SyncFailed';
  }
}

// The source: the skills folder (SF_SKILLS_DIR, else ~/.agents/skills) and the lock file next to it.
export function skillsSource(env: NodeJS.ProcessEnv = process.env): { dir: string; lock: string } {
  const dir = env.SF_SKILLS_DIR || join(env.HOME || homedir(), '.agents', 'skills');
  return { dir, lock: join(dirname(dir), '.skill-lock.json') };
}

// The snapshot's link; a skill's file in it.
export const skillsSnapshot = (stateDir: string): string => join(stateDir, 'skills');
export const snapshotSkillFile = (stateDir: string, skill: string): string => join(skillsSnapshot(stateDir), skill, 'SKILL.md');

// The lock file's entries by skill name; undefined when the file is missing or not a lock file.
async function lockEntries(env: NodeJS.ProcessEnv): Promise<Record<string, Record<string, unknown>> | undefined> {
  try {
    const skills = (JSON.parse(await readFile(skillsSource(env).lock, 'utf8')) as { skills?: unknown }).skills ?? {};
    return typeof skills === 'object' && skills !== null && !Array.isArray(skills) ? skills as Record<string, Record<string, unknown>> : undefined;
  } catch { // no lock file, or a file that is not JSON
    return undefined;
  }
}

// The lock file's hash of each of names that has one; undefined when the file or the source
// folder is missing or the file is not a lock file.
async function sourceHashes(env: NodeJS.ProcessEnv, names: readonly string[]): Promise<Record<string, string> | undefined> {
  const skills = await lockEntries(env);
  if (skills === undefined || !(await isFolder(skillsSource(env).dir))) {
    return undefined;
  }
  const hash = (name: string): unknown => (Object.hasOwn(skills, name) ? skills[name]?.skillFolderHash : undefined);
  return Object.fromEntries(names.flatMap((name) => (typeof hash(name) === 'string' && hash(name) !== '' ? [[name, hash(name) as string]] : [])));
}

// The current snapshot: the folder its link names, read once so the copies taken from it match its
// versions even when another sync swaps the link meanwhile, and its versions; none before the first sync.
async function currentSnapshot(stateDir: string): Promise<{ folder: string | undefined; versions: Record<string, string> }> {
  const target = await readlink(skillsSnapshot(stateDir)).catch(() => undefined);
  const folder = target === undefined ? undefined : resolve(stateDir, target);
  try {
    return { folder, versions: folder === undefined ? {} : JSON.parse(await readFile(join(folder, VERSIONS), 'utf8')) as Record<string, string> };
  } catch { // an unreadable versions.json: nothing is kept, every skill is copied from the source
    return { folder, versions: {} };
  }
}

// One copy of a skill's folder, links followed; false when the folder is not there.
async function copySkill(from: string, to: string): Promise<boolean> {
  try {
    await cp(from, to, { recursive: true, dereference: true, errorOnExist: true, force: false });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await rm(to, { recursive: true, force: true });
      return false;
    }
    throw error;
  }
}

// A failure's cause, as one line.
const cause = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isFolder = async (path: string): Promise<boolean> => (await stat(path).catch(() => undefined))?.isDirectory() === true;

// Brings the snapshot up to the source for every skill some role chose (the choice read from
// skill-roles.json once, here), as the header says; what it then holds and what is missing, with the
// choice and the folder that holds those skills (SkillsSync). A skill no role chose is left out: a
// snapshot that holds one is replaced by a new folder without it. A failure past the reads is a
// SyncFailed carrying the current snapshot's pair.
export async function syncSkills(stateDir: string, env: NodeJS.ProcessEnv = process.env): Promise<SkillsSync> {
  const roles = await readRoles(stateDir);
  const names = chosenSkills(roles);
  const hashes = (await sourceHashes(env, names)) ?? {};
  const current = await currentSnapshot(stateDir);
  try {
    return await rebuild(stateDir, env, roles, names, hashes, current);
  } catch (error) {
    throw new SyncFailed(cause(error), { versions: current.versions, roles, folder: current.folder });
  }
}

// syncSkills' comparison and, when something changed or a skill was dropped, its new folder and the swap.
async function rebuild(
  stateDir: string, env: NodeJS.ProcessEnv, roles: RoleSkills, names: string[], hashes: Record<string, string>, current: { folder: string | undefined; versions: Record<string, string> },
): Promise<SkillsSync> {
  const source = skillsSource(env).dir;
  const kept = (name: string): boolean => typeof current.versions[name] === 'string';
  const versions: Record<string, string> = Object.fromEntries(names.filter(kept).map((name) => [name, current.versions[name]!]));
  const missing = new Set<string>(names.filter((name) => hashes[name] === undefined));
  const changed: string[] = [];
  // A lock-listed skill whose folder is gone from the source is missing, whatever its hash, and keeps
  // its copy; only a present one with a new hash is a change, so a gone one causes no rebuild.
  for (const name of names.filter((skill) => hashes[skill] !== undefined)) {
    if (!(await isFolder(join(source, name)))) {
      missing.add(name);
    } else if (hashes[name] !== current.versions[name]) {
      changed.push(name);
    }
  }
  const result = (folder: string | undefined): SkillsSync => ({ versions, missing: names.filter((name) => missing.has(name)), roles, folder });
  // A skill the snapshot holds that no role chose now: a new folder without it, though nothing else changed.
  const dropped = Object.keys(current.versions).filter((name) => !names.includes(name));
  if (changed.length === 0 && dropped.length === 0) {
    return result(current.folder);
  }
  const id = `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  const folder = join(stateDir, FOLDERS, id);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  for (const name of names) {
    if (changed.includes(name) && (await copySkill(join(source, name), join(folder, name)))) {
      versions[name] = hashes[name]!;
      continue;
    }
    if (changed.includes(name)) {
      missing.add(name);
    }
    if (kept(name) && (current.folder === undefined || !(await copySkill(join(current.folder, name), join(folder, name))))) {
      delete versions[name];
    }
  }
  await writeFile(join(folder, VERSIONS), `${JSON.stringify(versions, null, 2)}\n`);
  const link = join(stateDir, `.skills-${id}`);
  await symlink(join(FOLDERS, id), link);
  await rename(link, skillsSnapshot(stateDir)).catch(async (error: unknown) => {
    await unlink(link).catch(() => undefined);
    throw error;
  });
  // The snapshot is updated: a cleanup that fails is one line on stderr, not a failed sync.
  await removeOld(stateDir, current.folder).catch((error: unknown) => console.error(`warning: the old skills folders could not be removed: ${cause(error)}`));
  return result(folder);
}

// After a swap: the folder replaced is marked as of now (its age counts from when it stopped being
// current, not from when it was built), then every folder of skills.d but the one the link names now
// and those a job not yet archived recorded (pinnedFolders) is removed once older than KEEP_OLD_MS.
async function removeOld(stateDir: string, replaced: string | undefined): Promise<void> {
  if (replaced !== undefined) {
    await utimes(replaced, new Date(), new Date()).catch(() => undefined);
  }
  const current = (await readlink(skillsSnapshot(stateDir)).catch(() => '')).split('/').at(-1);
  const pinned = await pinnedFolders(stateDir);
  for (const name of await readdir(join(stateDir, FOLDERS))) {
    const path = join(stateDir, FOLDERS, name);
    if (name !== current && !pinned.has(`${FOLDERS}/${name}`) && Date.now() - (await stat(path).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > KEEP_OLD_MS) {
      await rm(path, { recursive: true, force: true });
    }
  }
}

// The folders the jobs not yet archived recorded at their start: their wrappers bind them.
async function pinnedFolders(stateDir: string): Promise<Set<string>> {
  const jobs = new JobStore(stateDir);
  const pinned = new Set<string>();
  for (const dir of (await jobs.listAll()).filter((entry) => !entry.archived)) {
    const { folder } = await recorded(jobs.eventsPath(dir.workspace, dir.name));
    if (folder !== undefined) {
      pinned.add(folder);
    }
  }
  return pinned;
}

// What a job's skills event recorded: the folder (skills.d/<id>; none for a job started before the
// event recorded it, or with no snapshot then) and the roles' lists (none for a job started before
// the event recorded them); nothing without the event or without events.jsonl.
async function recorded(events: string): Promise<{ folder?: string; roles?: RoleSkills }> {
  let head: string;
  try {
    const handle = await open(events, 'r');
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(EVENTS_HEAD), 0, EVENTS_HEAD, 0);
      head = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch { // no events.jsonl, or one that cannot be read: nothing recorded
    return {};
  }
  for (const line of head.split('\n')) {
    try {
      const record = JSON.parse(line) as { type?: unknown; folder?: unknown; roles?: unknown };
      if (record.type === 'skills') {
        return {
          ...(typeof record.folder === 'string' && RECORDED.test(record.folder) ? { folder: record.folder } : {}),
          ...(typeof record.roles === 'object' && record.roles !== null ? { roles: rolesOf({ roles: record.roles }) } : {}),
        };
      }
    } catch { // an empty line, or one cut at the end of the head: not the skills event
    }
  }
  return {};
}

// A job's skills (events: its events.jsonl): the folder its skills event recorded at its start, so a
// later sync never changes the skills of a job under way (the link when the event recorded none or
// that folder is gone), and the roles' lists it recorded (each role's default for a job started
// before they were recorded: the skills it ran with then).
export async function jobSkills(stateDir: string, events: string): Promise<{ folder: string; roles: RoleSkills }> {
  const { folder, roles } = await recorded(events);
  return { folder: folder !== undefined && (await isFolder(join(stateDir, folder))) ? join(stateDir, folder) : skillsSnapshot(stateDir), roles: roles ?? rolesOf(undefined) };
}

// The folders of the Implementer's skills its wrapper binds: of the job's pinned folder and its
// recorded list (jobSkills); without a job, of the snapshot's link and the choice now.
export async function implementerSkills(stateDir: string, events?: string): Promise<string[]> {
  const { folder, roles } = events !== undefined ? await jobSkills(stateDir, events) : { folder: skillsSnapshot(stateDir), roles: await readRoles(stateDir) };
  return roles.implementer.map((name) => join(folder, name));
}

// Where a sync's warning goes: env (the source), job (its workspace/ticket, at the start of the
// line) and log (the job's runner.log, appended to); stderr always.
export interface SyncLog {
  env?: NodeJS.ProcessEnv;
  job?: string;
  log?: string;
}

// One warning line: on stderr, and at the end of the job's runner.log when there is one (a log
// that cannot be written loses the line there, never the job).
async function warn(text: string, { job, log }: SyncLog): Promise<void> {
  const line = `warning: ${job === undefined ? '' : `${job}: `}${text}`;
  console.error(line);
  if (log !== undefined) {
    await appendFile(log, `${line}\n`, { mode: 0o600 }).catch(() => undefined);
  }
}

// A sync and its warning: one line for the skills missing in the source, or one for a sync that
// failed (rethrown). env defaults to the process's.
async function syncAndWarn(stateDir: string, options: SyncLog): Promise<SkillsSync> {
  const env = options.env ?? process.env;
  try {
    const result = await syncSkills(stateDir, env);
    if (result.missing.length > 0) {
      await warn(`skills missing in ${skillsSource(env).dir} or its lock file: ${result.missing.join(', ')}; the snapshot keeps the copies it has`, options);
    }
    return result;
  } catch (error) {
    await warn(`the skills could not be synced: ${cause(error)}`, options);
    throw error;
  }
}

// sf serve's sync at its start, before the planning method is read, with its warning line; a sync
// that fails leaves the snapshot as it was.
export async function serveSkills(stateDir: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await syncAndWarn(stateDir, { env }).catch(() => undefined);
}

// The skills event of a job: the versions it used, the missing skills when there are any, the
// folder its Implementer's wrappers bind (skills.d/<id>, the link's target then; none without a
// snapshot) and each role's list then (roles). The reviewers read their skills from that folder, at each review.
// error: why the sync failed (its cause); versions are then the snapshot's as it was, and missing is never given
// (a skill is missing only when the source or the lock file was seen without it).
export type SkillsEvent = { type: 'skills'; versions: Record<string, string>; missing?: string[]; folder?: string; error?: string; roles?: RoleSkills };

// A job's start: syncs the snapshot and records what the job uses, its one skills event: exactly the
// pair the sync returned (SkillsSync: the choice it read, the folder that holds those skills and its
// versions), never the roles or the link read again, so a choice changed meanwhile (a set builds its
// own folder and swaps the link) cannot pair this job's lists with a folder lacking their skills.
// Skills missing in the source, or a sync that failed (the state directory unwritable), also get one
// warning line naming the job, on stderr (sf serve's log) and in the job's runner.log. A failed sync
// records the snapshot as it was (SyncFailed's pair) and the failure; the job goes on.
export async function recordSkills(stateDir: string, append: (record: SkillsEvent) => Promise<void>, options: SyncLog = {}): Promise<void> {
  let used: Omit<SkillsSync, 'missing'> & { missing?: string[] };
  let error: string | undefined;
  try {
    used = await syncAndWarn(stateDir, options);
  } catch (failure) {
    if (!(failure instanceof SyncFailed)) {
      throw failure;
    }
    ({ snapshot: used, message: error } = failure);
  }
  const folder = used.folder === undefined ? undefined : relative(stateDir, used.folder);
  const missing = used.missing ?? [];
  await append({
    type: 'skills', versions: used.versions, ...(missing.length > 0 ? { missing } : {}),
    ...(folder !== undefined && RECORDED.test(folder) ? { folder } : {}), ...(error !== undefined ? { error } : {}), roles: used.roles,
  });
}

// The job page's line of a skills event: the versions, the missing skills, a failed sync, then each
// role's list when the event recorded them.
export function skillsText(record: Omit<SkillsEvent, 'type'>): string {
  const used = Object.entries(record.versions).map(([name, hash]) => `${name} ${hash.slice(0, 7)}`);
  const missing = (record.missing ?? []).map((name) => `${name} (${Object.hasOwn(record.versions, name) ? 'kept the copy' : 'not available'})`);
  const failed = record.error === undefined ? '' : `; the sync failed (${record.error}), the snapshot as it was`;
  const roles = record.roles === undefined ? '' : `; by role: ${ROLES.map((role) => `${role} ${record.roles![role].join(', ') || 'none'}`).join('; ')}`;
  return `Skills: ${used.length > 0 ? used.join(', ') : 'none'}${missing.length > 0 ? `; missing in the source: ${missing.join(', ')}` : ''}${failed}${roles}.`;
}

// The front matter's description of a SKILL.md (one line, quotes taken off); null without one.
function descriptionOf(text: string): string | null {
  const line = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]?.split(/\r?\n/).find((entry) => entry.startsWith('description:'));
  const value = line?.slice('description:'.length).trim().replace(/^(["'])(.*)\1$/, '$2') ?? '';
  return value === '' ? null : value;
}

// An installed skill: one the lock file lists whose folder in the source has a SKILL.md, with the
// lock file's source and updatedAt and the description of its SKILL.md.
export interface InstalledSkill {
  name: string;
  source: string | null;
  updated: string | null;
  description: string | null;
}

// The installed skills by name, read from the source and its lock file only; none without either.
export async function installedSkills(env: NodeJS.ProcessEnv = process.env): Promise<InstalledSkill[]> {
  const entries = (await lockEntries(env)) ?? {};
  const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
  const skills: InstalledSkill[] = [];
  for (const name of Object.keys(entries).filter((entry) => SKILL_NAME.test(entry)).sort()) {
    const file = await readFile(join(skillsSource(env).dir, name, 'SKILL.md'), 'utf8').catch(() => undefined);
    if (file !== undefined) {
      skills.push({ name, source: text(entries[name]?.source), updated: text(entries[name]?.updatedAt), description: descriptionOf(file) });
    }
  }
  return skills;
}

// sf skills and GET api/skills: the installed skills, each role's list, the chosen skills that
// are not installed, and the coordinator's column (src/coordinator-skills.ts, read from its file
// each time; never in skill-roles.json).
export interface SkillsView {
  skills: InstalledSkill[];
  roles: RoleSkills;
  missing: string[];
  coordinator: CoordinatorSkills;
}

export async function skillsView(stateDir: string, env: NodeJS.ProcessEnv = process.env): Promise<SkillsView> {
  const [skills, roles] = await Promise.all([installedSkills(env), readRoles(stateDir)]);
  const coordinator = await coordinatorSkills(skills.map((skill) => skill.name), env);
  return { skills, roles, missing: chosenSkills(roles).filter((name) => !skills.some((skill) => skill.name === name)), coordinator };
}

// The view for the dashboard: the coordinator's column without its absolute paths.
export const skillsForClients = (view: SkillsView): Omit<SkillsView, 'coordinator'> & { coordinator: CoordinatorColumn } => ({ ...view, coordinator: coordinatorForClients(view.coordinator) });

// Changes one role's list (sf skills set, PUT api/skills/roles/<role>), checked as withRole does
// (asked: the names checked, the list's by default), writes the file and syncs at once, so the
// snapshot holds the new union; a sync that fails is its warning line, the choice stays written.
// The coordinator's list is the skills that are on, written to its settings file instead (setCoordinatorSkills).
export async function setRoleSkills(stateDir: string, role: string, skills: readonly string[], env: NodeJS.ProcessEnv = process.env, asked: readonly string[] = skills): Promise<SkillsView> {
  const installed = (await installedSkills(env)).map((skill) => skill.name);
  if (role === COORDINATOR) {
    await setCoordinatorSkills(skills, installed, env);
    return skillsView(stateDir, env);
  }
  const roles = withRole(await readRoles(stateDir), role, skills, installed, asked);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeRoles(stateDir, roles);
  await syncAndWarn(stateDir, { env }).catch(() => undefined);
  return skillsView(stateDir, env);
}

// sf skills set <role> <skill> on|off: the role's list with the skill added at its end, or taken out;
// for the coordinator, that skill's override alone (switchCoordinatorSkill).
export async function switchSkill(stateDir: string, role: string, skill: string, on: boolean, env: NodeJS.ProcessEnv = process.env): Promise<SkillsView> {
  if (role === COORDINATOR) {
    await switchCoordinatorSkill(skill, on, (await installedSkills(env)).map((installed) => installed.name), env);
    return skillsView(stateDir, env);
  }
  const list = isRole(role) ? (await readRoles(stateDir))[role] : [];
  return setRoleSkills(stateDir, role, on ? [...list, skill] : list.filter((name) => name !== skill), env, [skill]);
}

// sf skills: one row per installed skill (its name, source, the date it was updated, on or - for each
// role, then the coordinator's state: on, - or the override, its description), then the chosen skills
// that are not installed, with the roles that chose them, and the coordinator's settings file (or
// why it has no column).
export function skillsLines(view: SkillsView): string[] {
  const coordinator = 'error' in view.coordinator ? undefined : view.coordinator;
  const state = (name: string): string[] => {
    const value = coordinator?.skills[name] ?? 'on';
    return coordinator === undefined ? [] : [value === 'on' ? 'on' : value === 'off' ? '-' : value];
  };
  const rows = [
    ['skill', 'source', 'updated', ...ROLES, ...(coordinator === undefined ? [] : [COORDINATOR]), 'description'],
    ...view.skills.map((skill) => [
      skill.name, skill.source ?? '-', skill.updated?.slice(0, 10) ?? '-', ...ROLES.map((role) => (view.roles[role].includes(skill.name) ? 'on' : '-')), ...state(skill.name), skill.description ?? '',
    ]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return [
    ...(view.skills.length === 0 ? ['No skills installed (npx skills add installs one).'] : rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd())),
    ...view.missing.map((name) => `missing: ${name} (chosen for ${ROLES.filter((role) => view.roles[role].includes(name)).join(', ')}, not installed)`),
    'error' in view.coordinator
      ? `coordinator: ${view.coordinator.error.message}`
      : `coordinator: Claude Code's skillOverrides in ${view.coordinator.settings}; it applies to the next Claude Code session there (or after /skills).`,
  ];
}

// GET api/skills/<name>: an installed skill's SKILL.md from its source folder, at most
// MAX_SKILL_TEXT_BYTES (cut at a character's start, truncated then true). A name not of SKILL_NAME's
// form (a path: / or ..) or not an installed skill's is refused before anything is read.
export async function skillText(name: string, env: NodeJS.ProcessEnv = process.env): Promise<{ name: string; text: string; truncated: boolean }> {
  if (!SKILL_NAME.test(name) || !(await installedSkills(env)).some((skill) => skill.name === name)) {
    throw new FactoryError('skill_not_installed', `"${name.slice(0, 100)}" is not an installed skill.`);
  }
  const handle = await open(join(skillsSource(env).dir, name, 'SKILL.md'), 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(MAX_SKILL_TEXT_BYTES + 1), 0, MAX_SKILL_TEXT_BYTES + 1, 0);
    let end = Math.min(bytesRead, MAX_SKILL_TEXT_BYTES);
    while (end < bytesRead && end > 0 && (buffer[end]! & 0xc0) === 0x80) {
      end -= 1;
    }
    return { name, text: buffer.subarray(0, end).toString('utf8'), truncated: bytesRead > MAX_SKILL_TEXT_BYTES };
  } finally {
    await handle.close();
  }
}

// The planning skills' files: SF_PLAN_SKILL (empty: none), else the snapshot's SKILL.md of each skill the
// planner role chose, in the file's order (the snapshot synced at sf serve's start).
export const planSkillPath = async (stateDir: string): Promise<string[]> =>
  (process.env.SF_PLAN_SKILL !== undefined ? [process.env.SF_PLAN_SKILL].filter((file) => file !== '') : (await readRoles(stateDir)).planner.map((name) => snapshotSkillFile(stateDir, name)));

// The planning method of the skill files (skillPath, else planSkillPath's): their bodies without the
// front matter, joined in order (undefined without any), and the files missing (left out; planWarning).
export async function planSkills(stateDir: string, skillPath?: string | readonly string[]): Promise<{ planSkill: string | undefined; planMissing: string[] }> {
  const paths = typeof skillPath === 'string' ? [skillPath].filter((file) => file !== '') : skillPath ?? (await planSkillPath(stateDir));
  const read = await Promise.all(paths.map((file) => readFile(file, 'utf8').catch((error: unknown) => ((error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : Promise.reject(error)))));
  const bodies = read.flatMap((skill) => (skill === undefined ? [] : [skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()]));
  return { planSkill: bodies.length > 0 ? bodies.join('\n\n') : undefined, planMissing: paths.filter((_, index) => read[index] === undefined) };
}

// sf serve's line on the planning method: the skill files missing, or no skill chosen; none with
// SF_PLAN_SKILL empty or every file there.
export function planWarning({ planSkill, planMissing = [] }: { planSkill: string | undefined; planMissing?: string[] }): string | undefined {
  const alone = planSkill === undefined ? 'the instructions are the Quick start alone' : 'the method is the other skills';
  if (planMissing.length > 0) {
    return `warning: no planning skill at ${planMissing.join(', ')}; ${alone}`;
  }
  return planSkill === undefined && process.env.SF_PLAN_SKILL !== '' ? `warning: the planner role has no skill (sf skills set planner <skill> on); ${alone}` : undefined;
}

// The line in front of a prompt's <skill> blocks.
export const SKILL_BLOCKS_LINE = 'The user chose the skills below (<skill> blocks) for this work: follow each where it fits what you are asked to do here; where one and the rules above differ, the rules win.';

// The <skill name="..."> blocks of a prompt: each of names' SKILL.md in folder (a snapshot), whole,
// in order, at most maxBytes in all; a skill that would pass the limit, or has no SKILL.md there, is
// left out and the later ones are still tried. included and omitted name them.
export async function skillBlocks(folder: string, names: readonly string[], maxBytes = MAX_SKILL_BLOCKS_BYTES): Promise<{ text: string; included: string[]; omitted: string[] }> {
  const blocks: string[] = [];
  const included: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const name of names) {
    const file = SKILL_NAME.test(name) ? await readFile(join(folder, name, 'SKILL.md'), 'utf8').catch(() => undefined) : undefined;
    const block = file === undefined ? undefined : `<skill name="${name}">\n${file.trim()}\n</skill>`;
    const bytes = block === undefined ? 0 : Buffer.byteLength(block) + 1;
    if (block === undefined || used + bytes > maxBytes) {
      omitted.push(name);
      continue;
    }
    blocks.push(block);
    included.push(name);
    used += bytes;
  }
  return { text: blocks.join('\n'), included, omitted };
}

// What a record says of its session's <skill> blocks: the names sent and those left out; neither when
// the role chose no skill to send that way.
export interface SkillNames {
  skills?: string[];
  skills_omitted?: string[];
}

// The <skill> blocks of chosen (skillBlocks) in folder (a job's snapshot folder, or the link), and their names for a record.
export async function skillBlocksOf(folder: string, chosen: readonly string[]): Promise<{ text: string; names: SkillNames }> {
  const blocks = await skillBlocks(folder, chosen);
  return { text: blocks.text, names: chosen.length > 0 ? { skills: blocks.included, skills_omitted: blocks.omitted } : {} };
}

// A role's <skill> blocks by the choice now, through the snapshot's link (the Task check's, read at its start).
export const roleSkillBlocks = async (stateDir: string, role: Role): Promise<{ text: string; names: SkillNames }> => skillBlocksOf(skillsSnapshot(stateDir), (await readRoles(stateDir))[role]);
