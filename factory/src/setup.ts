// The dashboard's start screen, server side: the workspaces of the registry (list, add, remove)
// and the tickets of each workspace (list the Task files without a live job, write a ticket draft
// from the User's request, read a Task file's text and title for the board). It uses the same
// registry file, validation and Task file reader and writer as `sf workspace add` and
// `write_task`, so the CLI and the page agree; a job is started through the Execution, never from
// here.
import { lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { addAttachment, type Attachment, canHaveAttachments, listAttachments, readAttachment, removeAttachment } from './attachments.js';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';
import type { ExclusiveScope } from './execution.js';
import { runGit } from './git.js';
import { type Job, type JobState, type JobStore, TERMINAL_STATES } from './jobs.js';
import { type HandoffMode, loadRegistry, type Registry, resolveWorkspace, saveRegistry, verifyCheckout, type Workspace, type WorkspaceColor, workspaceColor, type WorkspaceEntry, WORKSPACE_NAME_DESCRIPTION, WORKSPACE_NAME_PATTERN } from './registry.js';
import { ARCHIVE_DIR, DRAFT_MARKER, isDraft, landsAfter, MAX_TASK_BYTES, parseFrontMatter, readTask, TASK_DIR, taskSha256, TICKET_DESCRIPTION, TICKET_PATTERN, type TicketRef, writeTask, type WriteTaskResult } from './task-file.js';
import type { TicketHistory } from './ticket-history.js';

export const MAX_TITLE_CHARS = 200;
export const MAX_REQUEST_BYTES = 64 * 1024;
// The line that marks a Task file written from the dashboard and not yet rewritten by the
// Context owner.
export { DRAFT_MARKER, isDraft } from './task-file.js';
export const DRAFT_NOTE = 'Created from the dashboard. The Context owner writes the Task here with write_task after discussing the ticket with the User; the User starts the job on the dashboard.';

export interface WorkspaceRow {
  name: string;
  // The registered checkout, as registered (the page shows what the User typed).
  path: string;
  // The jobs of the workspace that are not pushed, aborted or failed.
  liveJobs: number;
  // Why the checkout cannot be used right now (missing, not a Git work tree), or null.
  problem: string | null;
  // The workspace's own hand-over setting (SF-083), or null: SF_HANDOFF applies.
  handoff: HandoffMode | null;
  // The workspace's colour on the board (SF-084): its configured color, else the hash of its name.
  color: WorkspaceColor;
}

// The state of a ticket another one lands after (SF-084), one rule for the board and the job page:
// merged: its last job (live or archived) is pushed and merged into its base (the merge request
// state the factory recorded, else Git: the branch tip is an ancestor of origin/<base> in the
// workspace's checkout, only when no merge request state is recorded); pushed: pushed, not merged
// by that rule, its Task file active or gone; running: a live job in any other state; planned: a
// Task file (active or archived) and no live job, its job not merged (an archived Task file with a
// pushed job not merged too); missing: none of these.
export const DEPENDENCY_STATES = ['merged', 'pushed', 'running', 'planned', 'missing'] as const;
export type DependencyState = (typeof DEPENDENCY_STATES)[number];

export interface DependencyRow {
  workspace: string;
  ticket: string;
  state: DependencyState;
}

// The Git answer of whether a pushed job's branch is merged is kept this long per ticket, so the
// payload, built on every state change and page connect, runs no Git command beyond it.
export const MERGE_CHECK_TTL_MS = 30_000;

// A live job's Task file and the tickets it lands after (SF-084): the job page's Waits for, and the
// board's Needed by of the tickets it waits for.
export interface JobDependencies {
  workspace: string;
  ticket: string;
  lands_after: DependencyRow[];
}

export interface TicketRow {
  workspace: string;
  ticket: string;
  title: string;
  base: string;
  // True while the file still carries the draft marker.
  draft: boolean;
  // The User's words of New ticket, kept for the conversation (not in the Task file), or null.
  request: string | null;
  // The state of the ticket's last job when it ended, or null without a job.
  job: JobState | null;
  // The tickets it lands after (SF-084), with their states, in the order of the Task file.
  lands_after: DependencyRow[];
  // Its images (SF-064): .software-factory/<ticket>/, as listAttachments sees them.
  attachments: Attachment[];
}

// An archived Task file: .software-factory/archive/<ticket>.md (SF-027).
export interface ArchivedRow {
  workspace: string;
  ticket: string;
  title: string;
}

export { ARCHIVE_DIR } from './task-file.js';

export interface TicketInput {
  workspace: string;
  ticket: string;
  title: string;
  request: string;
}

export interface SetupOptions {
  configDir: string;
  jobs: JobStore;
  // Runs work under the Execution's lock, so a registry or ticket change and a job start never
  // interleave. Its scope retires a finished job of the ticket within the same lock acquisition
  // when the Task file is archived or deleted: the job leaves the Jobs list (archived in the state
  // directory) and its worktree, if one was kept, is removed. sf serve binds it to
  // Execution.exclusive.
  exclusive: <T>(work: (scope: ExclusiveScope) => Promise<T>) => Promise<T>;
  // The clock of the merge check's cache (tests); Date.now by default.
  now?: () => number;
  // The tickets' history (SF-081): New ticket records "created", Save "edited"; without it
  // nothing is recorded.
  history?: TicketHistory;
}

// What the dependency rule reads of a job, current or archived.
interface JobFacts {
  state: string;
  branch: string;
  base: string;
  prepared_commit: string | null;
  mr: { state: string } | null;
}

// An archived job directory of the ticket: <ticket>.<YYYYMMDDTHHMMSSZ> (JobStore.archive).
const ARCHIVED_JOB_STAMP = /^\d{8}T\d{6}Z$/;

// The commit a ref names in the checkout, or undefined.
async function commitOf(checkout: string, ref: string): Promise<string | undefined> {
  const result = await runGit(checkout, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = result.stdout.toString('utf8').trim();
  return result.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
}

// Whether a pushed job's branch is merged into its base by Git: its tip (origin's branch, else the
// commit the factory prepared and pushed, else the local branch, which the user may have moved) is
// an ancestor of origin/<base> as the checkout last fetched it. No fetch: the checkout's own view of
// origin.
async function branchMerged(checkout: string, job: JobFacts): Promise<boolean> {
  try {
    const tip = (await commitOf(checkout, `refs/remotes/origin/${job.branch}`)) ?? job.prepared_commit ?? (await commitOf(checkout, `refs/heads/${job.branch}`));
    if (tip === undefined) {
      return false;
    }
    return (await runGit(checkout, ['merge-base', '--is-ancestor', tip, `refs/remotes/origin/${job.base}`])).code === 0;
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

// A ticket's images for its row (SF-064); none when they cannot be listed (the row still shows).
async function attachmentsOf(workspace: Workspace, ticket: string): Promise<Attachment[]> {
  if (!canHaveAttachments(ticket)) {
    return [];
  }
  try {
    return await listAttachments(workspace, ticket);
  } catch (error) {
    console.error(error);
    return [];
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

// The skeleton of a new ticket (SF-028): the Task front matter, the heading and the marker with
// its note. The User's own words are not in it: they open the conversation instead.
export function draftContent(ticket: string, title: string, base: string): string {
  return `---\nticket: ${ticket}\ntitle: ${title}\nbase: ${base}\n---\n\n# ${ticket}: ${title}\n\n${DRAFT_MARKER}\n\n${DRAFT_NOTE}\n`;
}



// The checkout's default branch: the branch origin/HEAD points at, else "main".
export async function defaultBranch(checkout: string): Promise<string> {
  const result = await runGit(checkout, ['symbolic-ref', '--short', '--quiet', 'refs/remotes/origin/HEAD']);
  const ref = result.stdout.toString('utf8').trim();
  const match = /^origin\/(.+)$/.exec(ref);
  return result.code === 0 && match !== null ? match[1]! : 'main';
}

export class Setup {
  readonly #configDir: string;
  readonly #jobs: JobStore;
  readonly #exclusive: SetupOptions['exclusive'];
  readonly #now: () => number;
  readonly #history: TicketHistory | undefined;
  // "<workspace>/<ticket>" -> the Git answer of branchMerged for the job's branch, and when.
  readonly #mergeChecks = new Map<string, { at: number; branch: string; merged: boolean }>();

  constructor(options: SetupOptions) {
    this.#configDir = options.configDir;
    this.#jobs = options.jobs;
    this.#exclusive = options.exclusive;
    this.#now = options.now ?? Date.now;
    this.#history = options.history;
  }

  // The history record of a write by the User (SF-081), or none without a history.
  #record(name: string, ticket: string, kind: 'created' | 'edited'): ((sha256: string) => Promise<void>) | undefined {
    const history = this.#history;
    return history === undefined ? undefined : (sha256) => history.append(name, ticket, { kind, by: 'you', sha256 });
  }

  async #liveJobs(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const job of await this.#jobs.list()) {
      if (!TERMINAL_STATES.includes(job.state)) {
        counts.set(job.workspace, (counts.get(job.workspace) ?? 0) + 1);
      }
    }
    return counts;
  }

  async workspaces(): Promise<WorkspaceRow[]> {
    const { workspaces } = await loadRegistry(this.#configDir);
    const live = await this.#liveJobs();
    const rows: WorkspaceRow[] = [];
    for (const name of Object.keys(workspaces).sort()) {
      const entry = workspaces[name]!;
      let problem: string | null = null;
      try {
        await verifyCheckout(entry.read_checkout, 'checkout');
      } catch (error) {
        problem = error instanceof FactoryError ? error.message : 'The checkout could not be verified.';
      }
      rows.push({ name, path: entry.read_checkout, liveJobs: live.get(name) ?? 0, problem, handoff: entry.handoff ?? null, color: workspaceColor(name, entry.color) });
    }
    return rows;
  }

  // The same rules as `sf workspace add <name> --read <path> [--handoff ...] [--color ...]`: the name
  // pattern, an absolute path that is the root of a non-bare Git work tree, a name not registered
  // yet. Until SF-019 the work checkout is the read checkout. handoff: the workspace's own hand-over
  // setting (SF-083); undefined: SF_HANDOFF applies. color: its colour on the board (SF-084);
  // undefined: the hash of its name.
  addWorkspace(name: string, path: string, handoff?: HandoffMode, color?: WorkspaceColor): Promise<WorkspaceRow> {
    return this.#exclusive(async () => {
      if (!WORKSPACE_NAME_PATTERN.test(name)) {
        throw new FactoryError('invalid_name', `workspace name must be ${WORKSPACE_NAME_DESCRIPTION}.`);
      }
      if (!isAbsolute(path) || path.includes('\0')) {
        throw new FactoryError('workspace_invalid', 'The path must be absolute.');
      }
      const registry = await loadRegistry(this.#configDir);
      if (Object.hasOwn(registry.workspaces, name)) {
        throw new FactoryError('workspace_exists', `workspace "${name}" is already registered; remove it first.`);
      }
      const real = await verifyCheckout(path, 'path');
      registry.workspaces[name] = { read_checkout: real, ...(handoff !== undefined ? { handoff } : {}), ...(color !== undefined ? { color } : {}) };
      await saveRegistry(registry, this.#configDir);
      return { name, path: real, liveJobs: 0, problem: null, handoff: handoff ?? null, color: workspaceColor(name, color) };
    });
  }

  // Refused while a job of the workspace is live: its session and branch belong to the checkout.
  removeWorkspace(name: string): Promise<{ removed: string }> {
    return this.#exclusive(async () => {
      if (!WORKSPACE_NAME_PATTERN.test(name)) {
        throw new FactoryError('invalid_name', `workspace name must be ${WORKSPACE_NAME_DESCRIPTION}.`);
      }
      const registry = await loadRegistry(this.#configDir);
      if (!Object.hasOwn(registry.workspaces, name)) {
        throw new FactoryError('workspace_not_found', `workspace "${name}" is not registered.`);
      }
      const live = (await this.#jobs.list()).filter((job) => job.workspace === name && !TERMINAL_STATES.includes(job.state));
      if (live.length > 0) {
        throw new FactoryError('workspace_busy', `workspace "${name}" has a live job (${live.map((job) => `${job.ticket} ${job.state}`).join(', ')}); finish or abort it first.`);
      }
      delete registry.workspaces[name];
      await saveRegistry(registry, this.#configDir);
      return { removed: name };
    });
  }

  // The Task files of every usable workspace, sorted by workspace and ticket, each with its fields,
  // its text and its job. A file that is not a Task file (no front matter, another ticket, no
  // title) is skipped, as `start` would refuse it anyway.
  async #taskFiles(): Promise<Array<{ name: string; workspace: Workspace; ticket: string; fields: Map<string, string>; content: string; job: Job | undefined }>> {
    const { workspaces } = await loadRegistry(this.#configDir);
    const files = [];
    for (const name of Object.keys(workspaces).sort()) {
      let workspace: Workspace;
      try {
        workspace = await resolveWorkspace(name, this.#configDir);
      } catch {
        continue;
      }
      let names: string[];
      try {
        names = (await readdir(join(workspace.workCheckout, TASK_DIR), { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      for (const file of names) {
        const match = /^(.+)\.md$/.exec(file);
        const ticket = match?.[1];
        if (ticket === undefined || ticket.endsWith('.mr') || !TICKET_PATTERN.test(ticket)) {
          continue;
        }
        const content = await readFile(join(workspace.workCheckout, TASK_DIR, file), 'utf8');
        if (Buffer.byteLength(content) > MAX_TASK_BYTES) {
          continue;
        }
        const fields = parseFrontMatter(content);
        if (fields === undefined || fields.get('ticket') !== ticket || !fields.get('title') || !fields.get('base')) {
          continue;
        }
        files.push({ name, workspace, ticket, fields, content, job: await this.#jobs.read(name, ticket) });
      }
    }
    return files;
  }

  // The Task files whose ticket has no live job, sorted by workspace and ticket, each with the
  // tickets it lands after and their states (SF-084).
  async tickets(): Promise<TicketRow[]> {
    const states = this.#dependencyStates();
    const rows: TicketRow[] = [];
    for (const { name, workspace, ticket, fields, content, job } of await this.#taskFiles()) {
      if (job !== undefined && !TERMINAL_STATES.includes(job.state)) {
        continue;
      }
      rows.push({
        workspace: name, ticket, title: fields.get('title')!, base: fields.get('base')!, draft: isDraft(content), request: await this.#readRequest(name, ticket), job: job?.state ?? null,
        lands_after: await states(landsAfter(fields, name)), attachments: await attachmentsOf(workspace, ticket),
      });
    }
    return rows;
  }

  // The Task files whose ticket has a live job and lands after another ticket (SF-084), with the
  // states of those tickets.
  async jobDependencies(): Promise<JobDependencies[]> {
    const states = this.#dependencyStates();
    const rows: JobDependencies[] = [];
    for (const { name, ticket, fields, job } of await this.#taskFiles()) {
      const refs = landsAfter(fields, name);
      if (job !== undefined && !TERMINAL_STATES.includes(job.state) && refs.length > 0) {
        rows.push({ workspace: name, ticket, lands_after: await states(refs) });
      }
    }
    return rows;
  }

  // The states of the tickets refs names (SF-071: the run queue's merged check), in their order;
  // fresh: the Git answer of whether a pushed job is merged is asked again, not taken from the
  // MERGE_CHECK_TTL_MS cache (and the cache gets the new answer).
  dependencyStates(refs: TicketRef[], { fresh }: { fresh: boolean }): Promise<DependencyRow[]> {
    return this.#dependencyStates(fresh)(refs);
  }

  // The base of the ticket's last job, live or archived (the branch it is merged into), or
  // undefined without one: where the run queue fetches before it checks again whether the ticket is
  // merged (SF-071).
  async lastJobBase(ref: TicketRef): Promise<string | undefined> {
    const current = await this.#jobs.read(ref.workspace, ref.ticket).catch(() => undefined);
    return (current ?? (await this.#lastArchivedJob(ref)))?.base;
  }

  // The states of tickets, each worked out once per call of the returned function's owner (one
  // payload), the registry read once. fresh: see dependencyStates.
  #dependencyStates(fresh = false): (refs: TicketRef[]) => Promise<DependencyRow[]> {
    const known = new Map<string, Promise<DependencyState>>();
    let registry: Promise<Registry> | undefined;
    return async (refs) => {
      const rows: DependencyRow[] = [];
      for (const ref of refs) {
        const key = `${ref.workspace}/${ref.ticket}`;
        if (!known.has(key)) {
          registry ??= loadRegistry(this.#configDir);
          known.set(key, registry.then((loaded) => this.#dependencyState(ref, Object.hasOwn(loaded.workspaces, ref.workspace) ? loaded.workspaces[ref.workspace] : undefined, fresh)));
        }
        rows.push({ ...ref, state: await known.get(key)! });
      }
      return rows;
    };
  }

  // The dependency rule (DependencyState) for one ticket; entry: its workspace's registration, if
  // any. A job record that cannot be read counts as none. fresh: see dependencyStates.
  async #dependencyState(ref: TicketRef, entry: WorkspaceEntry | undefined, fresh: boolean): Promise<DependencyState> {
    const current = await this.#jobs.read(ref.workspace, ref.ticket).catch(() => undefined);
    if (current !== undefined && !TERMINAL_STATES.includes(current.state)) {
      return 'running';
    }
    const dir = entry === undefined ? undefined : join(entry.read_checkout, TASK_DIR);
    const active = dir !== undefined && (await isFile(join(dir, `${ref.ticket}.md`)));
    const archived = dir !== undefined && !active && (await isFile(join(dir, ARCHIVE_DIR, `${ref.ticket}.md`)));
    const last: JobFacts | undefined = current ?? (await this.#lastArchivedJob(ref));
    if (last?.state === 'pushed') {
      if (await this.#merged(ref, last, entry, fresh)) {
        return 'merged';
      }
      // An archived Task file whose job was not merged counts as planned (the Task's rule).
      return archived ? 'planned' : 'pushed';
    }
    return active || archived ? 'planned' : 'missing';
  }

  // The newest archived job of the ticket (JobStore.archive's <ticket>.<stamp> directories), or
  // undefined.
  async #lastArchivedJob(ref: TicketRef): Promise<JobFacts | undefined> {
    let names: string[];
    try {
      names = await readdir(join(this.#jobs.root, ref.workspace));
    } catch {
      return undefined;
    }
    const prefix = `${ref.ticket}.`;
    const archived = names.filter((name) => name.startsWith(prefix) && ARCHIVED_JOB_STAMP.test(name.slice(prefix.length))).sort();
    for (const name of archived.reverse()) {
      try {
        const data = JSON.parse(await readFile(join(this.#jobs.root, ref.workspace, name, 'job.json'), 'utf8')) as Record<string, unknown>;
        const mr = data.mr as Record<string, unknown> | null | undefined;
        if (data.workspace === ref.workspace && data.ticket === ref.ticket && typeof data.state === 'string' && typeof data.branch === 'string' && typeof data.base === 'string') {
          return {
            state: data.state, branch: data.branch, base: data.base, prepared_commit: typeof data.prepared_commit === 'string' ? data.prepared_commit : null,
            mr: mr !== null && typeof mr === 'object' && typeof mr.state === 'string' ? { state: mr.state } : null,
          };
        }
      } catch {
        // Not a readable job record: the one before it.
      }
    }
    return undefined;
  }

  // Merged: the merge request state the factory recorded (SF-048) decides when there is one (merged
  // or not: open and closed are not merged); only without one does Git decide, its answer kept
  // MERGE_CHECK_TTL_MS per ticket (fresh: asked again).
  async #merged(ref: TicketRef, job: JobFacts, entry: WorkspaceEntry | undefined, fresh: boolean): Promise<boolean> {
    if (job.mr !== null) {
      return job.mr.state === 'merged';
    }
    if (entry === undefined) {
      return false;
    }
    const key = `${ref.workspace}/${ref.ticket}`;
    const now = this.#now();
    const cached = this.#mergeChecks.get(key);
    if (!fresh && cached !== undefined && cached.branch === job.branch && now - cached.at < MERGE_CHECK_TTL_MS) {
      return cached.merged;
    }
    const merged = await branchMerged(entry.read_checkout, job);
    this.#mergeChecks.set(key, { at: now, branch: job.branch, merged });
    return merged;
  }

  // The workspace of an attachment action (SF-064), with its name checked; the ticket's rules are
  // the attachments module's.
  async #attachmentWorkspace(name: string): Promise<Workspace> {
    if (!WORKSPACE_NAME_PATTERN.test(name)) {
      throw new FactoryError('invalid_name', `workspace name must be ${WORKSPACE_NAME_DESCRIPTION}.`);
    }
    return resolveWorkspace(name, this.#configDir);
  }

  // Adds one image to the ticket (SF-064) under file, or the next number; under the Execution's
  // lock, so a job cannot start between the guard and the write.
  addAttachment(name: string, ticket: string, data: Uint8Array, file?: string): Promise<Attachment> {
    return this.#exclusive(async () => addAttachment(await this.#attachmentWorkspace(name), ticket, data, this.#jobs, file));
  }

  // Removes one image of the ticket (SF-064), under the same lock and guard.
  removeAttachment(name: string, ticket: string, file: string): Promise<{ name: string }> {
    return this.#exclusive(async () => removeAttachment(await this.#attachmentWorkspace(name), ticket, file, this.#jobs));
  }

  // One image of the ticket with its bytes (SF-064).
  async readAttachment(name: string, ticket: string, file: string): Promise<Attachment & { data: Buffer }> {
    return readAttachment(await this.#attachmentWorkspace(name), ticket, file);
  }

  // The User's words of New ticket live in the state directory, next to the jobs, never in the
  // repository: <state dir>/requests/<workspace>/<ticket>.md.
  #requestPath(name: string, ticket: string): string {
    return join(dirname(this.#jobs.root), 'requests', name, `${ticket}.md`);
  }

  async #readRequest(name: string, ticket: string): Promise<string | null> {
    try {
      return await readFile(this.#requestPath(name, ticket), 'utf8');
    } catch {
      return null;
    }
  }

  // The workspace of a ticket action, with both names checked; a live job refuses it. jobEnded:
  // the ticket has a finished job, read under the lock of the action that retires it.
  async #ticketTarget(name: string, ticket: string): Promise<{ workspace: Workspace; dir: string; jobEnded: boolean }> {
    if (!WORKSPACE_NAME_PATTERN.test(name)) {
      throw new FactoryError('invalid_name', `workspace name must be ${WORKSPACE_NAME_DESCRIPTION}.`);
    }
    if (!TICKET_PATTERN.test(ticket)) {
      throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}.`);
    }
    const workspace = await resolveWorkspace(name, this.#configDir);
    const job = await this.#jobs.read(name, ticket);
    if (job !== undefined && !TERMINAL_STATES.includes(job.state)) {
      throw new FactoryError('job_active', `The job for ${name}/${ticket} is ${job.state}; abort it first.`);
    }
    return { workspace, dir: join(workspace.workCheckout, TASK_DIR), jobEnded: job !== undefined };
  }

  // A finished job of the ticket leaves the Jobs list before its Task file goes, in the same lock
  // acquisition as the check that found it.
  async #retire(scope: ExclusiveScope, name: string, ticket: string, jobEnded: boolean): Promise<boolean> {
    if (!jobEnded) {
      return false;
    }
    await scope.retireFinished(name, ticket);
    return true;
  }

  // Moves <ticket>.md (and <ticket>.mr.md) into .software-factory/archive/, replacing an older
  // archived copy, then the ticket's images (SF-064: the folder <ticket>/, replacing an older
  // archive/<ticket>/); a finished job of the ticket is archived first. All under one lock acquisition:
  // check, retire the job, then move the files. A failed retirement moves nothing; a file
  // operation that fails after it leaves the job archived and the files as far as they got.
  archiveTicket(name: string, ticket: string): Promise<{ workspace: string; ticket: string; path: string; jobArchived: boolean }> {
    return this.#exclusive(async (scope) => {
      const target = await this.#ticketTarget(name, ticket);
      if (!(await isFile(join(target.dir, `${ticket}.md`)))) {
        throw new FactoryError('task_not_found', `${TASK_DIR}/${ticket}.md does not exist in workspace "${name}".`);
      }
      const files: string[] = [];
      for (const file of [`${ticket}.md`, `${ticket}.mr.md`]) {
        if (await isFile(join(target.dir, file))) {
          files.push(file);
        }
      }
      const jobArchived = await this.#retire(scope, name, ticket, target.jobEnded);
      await mkdir(join(target.dir, ARCHIVE_DIR), { recursive: true, mode: 0o700 });
      for (const file of files) {
        await rename(join(target.dir, file), join(target.dir, ARCHIVE_DIR, file));
      }
      // The older archived images go with the older archived Task file, images or not now.
      if (canHaveAttachments(ticket)) {
        await rm(join(target.dir, ARCHIVE_DIR, ticket), { recursive: true, force: true });
        if (await isDirectory(join(target.dir, ticket))) {
          await rename(join(target.dir, ticket), join(target.dir, ARCHIVE_DIR, ticket));
        }
      }
      return { workspace: name, ticket, path: `${TASK_DIR}/${ARCHIVE_DIR}/${ticket}.md`, jobArchived };
    });
  }

  // Moves an archived Task file (and its MR text) back, then its images (SF-064); refused when the
  // ticket has a Task file or an images folder.
  restoreTicket(name: string, ticket: string): Promise<{ workspace: string; ticket: string; path: string }> {
    return this.#exclusive(async () => {
      const { dir } = await this.#ticketTarget(name, ticket);
      if (await isFile(join(dir, `${ticket}.md`))) {
        throw new FactoryError('ticket_exists', `${TASK_DIR}/${ticket}.md already exists in workspace "${name}".`);
      }
      if (!(await isFile(join(dir, ARCHIVE_DIR, `${ticket}.md`)))) {
        throw new FactoryError('task_not_found', `${TASK_DIR}/${ARCHIVE_DIR}/${ticket}.md does not exist in workspace "${name}".`);
      }
      const hasImages = canHaveAttachments(ticket);
      if (hasImages && (await exists(join(dir, ticket)))) {
        throw new FactoryError('ticket_exists', `${TASK_DIR}/${ticket}/ already exists in workspace "${name}"; remove it first.`);
      }
      for (const file of [`${ticket}.md`, `${ticket}.mr.md`]) {
        if (await isFile(join(dir, ARCHIVE_DIR, file))) {
          await rename(join(dir, ARCHIVE_DIR, file), join(dir, file));
        }
      }
      if (hasImages && (await isDirectory(join(dir, ARCHIVE_DIR, ticket)))) {
        await rename(join(dir, ARCHIVE_DIR, ticket), join(dir, ticket));
      }
      return { workspace: name, ticket, path: `${TASK_DIR}/${ticket}.md` };
    });
  }

  // Deletes the Task file and the MR text of the ticket, active or archived, its images (SF-064:
  // <ticket>/ and archive/<ticket>/) and the stored request; a finished job of the ticket is archived first (its history stays in the state
  // directory, and so does the ticket's history file of SF-081, on purpose). The same order and
  // failure behaviour as archiveTicket.
  deleteTicket(name: string, ticket: string): Promise<{ workspace: string; ticket: string; deleted: string[]; jobArchived: boolean }> {
    return this.#exclusive(async (scope) => {
      const target = await this.#ticketTarget(name, ticket);
      const paths = [`${ticket}.md`, `${ticket}.mr.md`, `${ARCHIVE_DIR}/${ticket}.md`, `${ARCHIVE_DIR}/${ticket}.mr.md`];
      const found: string[] = [];
      for (const path of paths) {
        if (await isFile(join(target.dir, path))) {
          found.push(path);
        }
      }
      if (!found.some((path) => path.endsWith(`${ticket}.md`) && !path.endsWith('.mr.md'))) {
        throw new FactoryError('task_not_found', `There is no Task file for ${ticket} in workspace "${name}".`);
      }
      const folders: string[] = [];
      if (canHaveAttachments(ticket)) {
        for (const folder of [ticket, `${ARCHIVE_DIR}/${ticket}`]) {
          if (await isDirectory(join(target.dir, folder))) {
            folders.push(folder);
          }
        }
      }
      const jobArchived = await this.#retire(scope, name, ticket, target.jobEnded);
      for (const path of found) {
        await rm(join(target.dir, path));
      }
      for (const folder of folders) {
        await rm(join(target.dir, folder), { recursive: true, force: true });
        found.push(`${folder}/`);
      }
      await rm(this.#requestPath(name, ticket), { force: true });
      return { workspace: name, ticket, deleted: found.map((path) => `${TASK_DIR}/${path}`), jobArchived };
    });
  }

  // The text of a ticket's Task file (archived: its copy in the archive), through the Task file
  // reader: both names checked, a regular file of valid Task content, else a refusal.
  async taskText(name: string, ticket: string, archived = false): Promise<string> {
    if (!WORKSPACE_NAME_PATTERN.test(name)) {
      throw new FactoryError('invalid_name', `workspace name must be ${WORKSPACE_NAME_DESCRIPTION}.`);
    }
    if (!TICKET_PATTERN.test(ticket)) {
      throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}.`);
    }
    return readTask(await resolveWorkspace(name, this.#configDir), ticket, archived);
  }

  // The planned ticket page's Task file (SF-081): its text through the Task file reader (as
  // taskText), its sha256 (the version a Save starts from) and its modification time.
  async taskFile(name: string, ticket: string): Promise<{ text: string; sha256: string; mtime: string }> {
    const text = await this.taskText(name, ticket);
    const workspace = await resolveWorkspace(name, this.#configDir);
    const stats = await lstat(join(workspace.workCheckout, TASK_DIR, `${ticket}.md`));
    return { text, sha256: taskSha256(text), mtime: stats.mtime.toISOString() };
  }

  // Save on the planned ticket page (SF-081): the whole Task file through the Task file writer (its
  // validation, its refusal while a job of the ticket runs), only over the version the page read
  // (sha256; another one is task_changed), recorded as "edited" by you.
  saveTask(name: string, ticket: string, content: string, sha256: string): Promise<WriteTaskResult> {
    return this.#exclusive(async () => {
      if (!WORKSPACE_NAME_PATTERN.test(name)) {
        throw new FactoryError('invalid_name', `workspace name must be ${WORKSPACE_NAME_DESCRIPTION}.`);
      }
      if (!TICKET_PATTERN.test(ticket)) {
        throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}.`);
      }
      const workspace = await resolveWorkspace(name, this.#configDir);
      return writeTask(workspace, ticket, content, this.#jobs, { expectedSha256: sha256, record: this.#record(name, ticket, 'edited') });
    });
  }

  // The title of a ticket's Task file, read from the active file or, when it is not there, from
  // its archived copy (SF-057); null when there is none to read (a deleted Task file, an
  // unregistered workspace): the board's card falls back to the branch. Read for every job on
  // every refresh, so only the registry and the file are read (no Git check of the checkout); the
  // title is display text, never a decision.
  async taskTitle(name: string, ticket: string): Promise<string | null> {
    try {
      const { workspaces } = await loadRegistry(this.#configDir);
      const entry = WORKSPACE_NAME_PATTERN.test(name) && TICKET_PATTERN.test(ticket) && Object.hasOwn(workspaces, name) ? workspaces[name] : undefined;
      if (entry === undefined) {
        return null;
      }
      const dir = join(entry.read_checkout, TASK_DIR);
      for (const path of [join(dir, `${ticket}.md`), join(dir, ARCHIVE_DIR, `${ticket}.md`)]) {
        if (await isFile(path)) {
          return (await lstat(path)).size > MAX_TASK_BYTES ? null : parseFrontMatter(await readFile(path, 'utf8'))?.get('title') || null;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // The archived Task files of every usable workspace, sorted by workspace and ticket.
  async archivedTickets(): Promise<ArchivedRow[]> {
    const { workspaces } = await loadRegistry(this.#configDir);
    const rows: ArchivedRow[] = [];
    for (const name of Object.keys(workspaces).sort()) {
      let workspace: Workspace;
      try {
        workspace = await resolveWorkspace(name, this.#configDir);
      } catch {
        continue;
      }
      const dir = join(workspace.workCheckout, TASK_DIR, ARCHIVE_DIR);
      let names: string[];
      try {
        names = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
      } catch {
        continue;
      }
      for (const file of names) {
        const ticket = /^(.+)\.md$/.exec(file)?.[1];
        if (ticket === undefined || ticket.endsWith('.mr') || !TICKET_PATTERN.test(ticket)) {
          continue;
        }
        const fields = parseFrontMatter(await readFile(join(dir, file), 'utf8'));
        rows.push({ workspace: name, ticket, title: fields?.get('title') || ticket });
      }
    }
    return rows;
  }

  // Writes the ticket skeleton through the Task file writer (the exclude entry, the job guard) and
  // keeps the User's words for the conversation in the state directory; an existing Task file for
  // the ticket is never replaced from here.
  createTicket(input: TicketInput): Promise<{ workspace: string; ticket: string; path: string; base: string }> {
    return this.#exclusive(async () => {
      const { workspace: name, ticket } = input;
      if (!WORKSPACE_NAME_PATTERN.test(name)) {
        throw new FactoryError('invalid_name', `workspace name must be ${WORKSPACE_NAME_DESCRIPTION}.`);
      }
      if (!TICKET_PATTERN.test(ticket)) {
        throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}.`);
      }
      const title = input.title.trim();
      if (title === '' || /[\r\n\0]/.test(title) || title.length > MAX_TITLE_CHARS) {
        throw new FactoryError('invalid_content', `The title must be one line of 1 to ${MAX_TITLE_CHARS} characters.`);
      }
      const request = input.request;
      if (request.trim() === '' || request.includes('\0') || /\p{Surrogate}/u.test(request) || Buffer.byteLength(request, 'utf8') > MAX_REQUEST_BYTES) {
        throw new FactoryError('invalid_content', `The request must be 1 to ${MAX_REQUEST_BYTES} bytes of text.`);
      }
      const workspace = await resolveWorkspace(name, this.#configDir);
      const path = `${TASK_DIR}/${ticket}.md`;
      let exists = true;
      try {
        await readFile(join(workspace.workCheckout, path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        exists = false;
      }
      if (exists) {
        throw new FactoryError('ticket_exists', `${path} already exists in workspace "${name}"; the ticket is listed below.`);
      }
      const base = await defaultBranch(workspace.workCheckout);
      await writeTask(workspace, ticket, draftContent(ticket, title, base), this.#jobs, { record: this.#record(name, ticket, 'created') });
      // A new ticket starts without images (SF-064): a folder left behind by a Task file removed by
      // hand goes, once the skeleton is written (the writer's guard has passed).
      if (canHaveAttachments(ticket)) {
        await rm(join(workspace.workCheckout, TASK_DIR, ticket), { recursive: true, force: true });
      }
      await mkdir(dirname(this.#requestPath(name, ticket)), { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.#requestPath(name, ticket), Buffer.from(request.replace(/\r\n/g, '\n'), 'utf8'));
      return { workspace: name, ticket, path, base };
    });
  }
}
