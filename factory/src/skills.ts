// The agents' skills: the user's installed ones (the `skills` tool's ~/.agents/skills, or
// SF_SKILLS_DIR), copied verbatim into a snapshot under the state directory, never edited.
// The Implementer's wrapper binds the snapshot read-only on <config dir>/skills; the reviewers read
// code-review/SKILL.md from it and the planning method grilling/SKILL.md.
//
// The snapshot, <state dir>/skills, is a link to one folder of <state dir>/skills.d/, each folder a
// full set: every listed skill's folder and versions.json ({ <name>: <skillFolderHash> }). A sync
// (once at each job's start and at sf serve's start) compares the lock file's hashes with
// versions.json (each skill's source folder looked up, never walked): equal, nothing is copied;
// else a new folder is built (the changed skills from the source, the others from the current
// snapshot) and the link swapped to it by a rename, so a session
// never sees a half copy. Two syncs at once each build their own folder; the last swap wins.
// A skill absent from the source or the lock file keeps its copy (none when it never had one).
// A job is pinned to its snapshot: its skills event records the folder the link named at its
// start, every wrapper of the job binds that folder (jobSkills), and the cleanup keeps the folders
// the jobs not yet archived recorded.
import { randomBytes } from 'node:crypto';
import { appendFile, cp, mkdir, open, readdir, readFile, readlink, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { JobStore } from './jobs.js';

// The skills the factory's agents use: the Implementer runs /implement (with tdd and code-review),
// the reviewers follow code-review, the Context owner plans by grilling.
export const AGENT_SKILLS = ['implement', 'tdd', 'code-review', 'grilling'] as const;

const VERSIONS = 'versions.json';
const FOLDERS = 'skills.d';
// A folder of skills.d that is not current and no live job recorded is removed once this long
// past being replaced: a job with no recorded folder, or one just archived, may still bind it.
const KEEP_OLD_MS = 7 * 24 * 3600 * 1000;
// A folder as a job's skills event records it, relative to the state directory: skills.d/<id>.
const RECORDED = /^skills\.d\/[\w-]+$/;
// The bytes of a job's events.jsonl read for its skills event, which its start writes among its first lines.
const EVENTS_HEAD = 64 * 1024;

export interface SkillsSync {
  // The hash of each skill the snapshot holds.
  versions: Record<string, string>;
  // The listed skills absent from the source or the lock file (all when either is missing).
  missing: string[];
}

// The source: the skills folder (SF_SKILLS_DIR, else ~/.agents/skills) and the lock file next to it.
export function skillsSource(env: NodeJS.ProcessEnv = process.env): { dir: string; lock: string } {
  const dir = env.SF_SKILLS_DIR || join(env.HOME || homedir(), '.agents', 'skills');
  return { dir, lock: join(dirname(dir), '.skill-lock.json') };
}

// The snapshot's link; a skill's file in it.
export const skillsSnapshot = (stateDir: string): string => join(stateDir, 'skills');
export const snapshotSkillFile = (stateDir: string, skill: string): string => join(skillsSnapshot(stateDir), skill, 'SKILL.md');

// The lock file's hash of each listed skill that has one; undefined when the file or the source
// folder is missing or the file is not a lock file.
async function sourceHashes(env: NodeJS.ProcessEnv): Promise<Record<string, string> | undefined> {
  const { dir, lock } = skillsSource(env);
  try {
    const skills = (JSON.parse(await readFile(lock, 'utf8')) as { skills?: Record<string, { skillFolderHash?: unknown }> }).skills ?? {};
    if (!(await stat(dir)).isDirectory()) {
      return undefined;
    }
    const hash = (name: string): unknown => (Object.hasOwn(skills, name) ? skills[name]?.skillFolderHash : undefined);
    return Object.fromEntries(AGENT_SKILLS.flatMap((name) => (typeof hash(name) === 'string' && hash(name) !== '' ? [[name, hash(name) as string]] : [])));
  } catch { // no lock file, no source folder, or a file that is not JSON: every skill is missing
    return undefined;
  }
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

// Brings the snapshot up to the source, as the header says; what it then holds and what is missing.
export async function syncSkills(stateDir: string, env: NodeJS.ProcessEnv = process.env): Promise<SkillsSync> {
  const hashes = (await sourceHashes(env)) ?? {};
  const source = skillsSource(env).dir;
  const current = await currentSnapshot(stateDir);
  const kept = (name: string): boolean => typeof current.versions[name] === 'string';
  const versions: Record<string, string> = Object.fromEntries(AGENT_SKILLS.filter(kept).map((name) => [name, current.versions[name]!]));
  const missing = new Set<string>(AGENT_SKILLS.filter((name) => hashes[name] === undefined));
  const changed: string[] = [];
  // A lock-listed skill whose folder is gone from the source is missing, whatever its hash, and keeps
  // its copy; only a present one with a new hash is a change, so a gone one causes no rebuild.
  for (const name of AGENT_SKILLS.filter((skill) => hashes[skill] !== undefined)) {
    if (!(await isFolder(join(source, name)))) {
      missing.add(name);
    } else if (hashes[name] !== current.versions[name]) {
      changed.push(name);
    }
  }
  const result = (): SkillsSync => ({ versions, missing: AGENT_SKILLS.filter((name) => missing.has(name)) });
  if (changed.length === 0) {
    return result();
  }
  const id = `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  const folder = join(stateDir, FOLDERS, id);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  for (const name of AGENT_SKILLS) {
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
  return result();
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
    const folder = await recordedFolder(jobs.eventsPath(dir.workspace, dir.name));
    if (folder !== undefined) {
      pinned.add(folder);
    }
  }
  return pinned;
}

// The folder a job's skills event recorded (skills.d/<id>); undefined without one (a job started
// before the event recorded it, or with no snapshot then) or without events.jsonl.
async function recordedFolder(events: string): Promise<string | undefined> {
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
    return undefined;
  }
  for (const line of head.split('\n')) {
    try {
      const record = JSON.parse(line) as { type?: unknown; folder?: unknown };
      if (record.type === 'skills') {
        return typeof record.folder === 'string' && RECORDED.test(record.folder) ? record.folder : undefined;
      }
    } catch { // an empty line, or one cut at the end of the head: not the skills event
    }
  }
  return undefined;
}

// The skills folder a job's wrapper binds (events: its events.jsonl): the folder its skills event
// recorded at its start, so a later sync never changes the skills of a job under way; the link when
// the event recorded none or that folder is gone.
export async function jobSkills(stateDir: string, events: string): Promise<string> {
  const folder = await recordedFolder(events);
  return folder !== undefined && (await isFolder(join(stateDir, folder))) ? join(stateDir, folder) : skillsSnapshot(stateDir);
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

// The skills event of a job: the versions it used, the missing skills when there are any, and the
// folder its Implementer's wrappers bind (skills.d/<id>, the link's target then; none without a
// snapshot). The reviewers read their method through the link, at each review.
// error: why the sync failed (its cause); versions are then the snapshot's as it was, and missing is never given
// (a skill is missing only when the source or the lock file was seen without it).
export type SkillsEvent = { type: 'skills'; versions: Record<string, string>; missing?: string[]; folder?: string; error?: string };

// A job's start: syncs the snapshot and records what the job uses, its one skills event: the
// versions and the folder are read together from the link once the sync is done, so they match
// even when another job's sync swapped it meanwhile. Skills missing in the source, or a sync that
// failed (the state directory unwritable), also get one warning line naming the job, on stderr
// (sf serve's log) and in the job's runner.log. A failed sync records the snapshot as it was and the
// failure; the job goes on.
export async function recordSkills(stateDir: string, append: (record: SkillsEvent) => Promise<void>, options: SyncLog = {}): Promise<void> {
  let missing: string[] = [];
  let error: string | undefined;
  try {
    ({ missing } = await syncAndWarn(stateDir, options));
  } catch (failure) {
    error = cause(failure);
  }
  const used = await currentSnapshot(stateDir);
  const folder = used.folder === undefined ? undefined : relative(stateDir, used.folder);
  await append({
    type: 'skills', versions: used.versions, ...(missing.length > 0 ? { missing } : {}),
    ...(folder !== undefined && RECORDED.test(folder) ? { folder } : {}), ...(error !== undefined ? { error } : {}),
  });
}

// The job page's line of a skills event.
export function skillsText(record: Omit<SkillsEvent, 'type'>): string {
  const used = Object.entries(record.versions).map(([name, hash]) => `${name} ${hash.slice(0, 7)}`);
  const missing = (record.missing ?? []).map((name) => `${name} (${Object.hasOwn(record.versions, name) ? 'kept the copy' : 'not available'})`);
  const failed = record.error === undefined ? '' : `; the sync failed (${record.error}), the snapshot as it was`;
  return `Skills: ${used.length > 0 ? used.join(', ') : 'none'}${missing.length > 0 ? `; missing in the source: ${missing.join(', ')}` : ''}${failed}.`;
}
