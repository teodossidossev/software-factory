// The dashboard's start screen, server side: the workspaces of the registry (list, add, remove)
// and the tickets of each workspace (list the Task files without a live job, write a ticket draft
// from the User's request). It uses the same registry file, validation and Task file writer as
// `sf workspace add` and `write_task`, so the CLI and the page agree; a job is started through
// the Execution, never from here.
import { lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { FactoryError } from './errors.js';
import { runGit } from './git.js';
import { type JobState, type JobStore, TERMINAL_STATES } from './jobs.js';
import { loadRegistry, resolveWorkspace, saveRegistry, verifyCheckout, type Workspace, WORKSPACE_NAME_DESCRIPTION, WORKSPACE_NAME_PATTERN } from './registry.js';
import { MAX_TASK_BYTES, parseFrontMatter, TASK_DIR, TICKET_DESCRIPTION, TICKET_PATTERN, writeTask } from './task-file.js';

export const MAX_TITLE_CHARS = 200;
export const MAX_REQUEST_BYTES = 64 * 1024;
// The line that marks a Task file written from the dashboard and not yet rewritten by the
// Context owner.
export const DRAFT_MARKER = '## Status: draft';
export const DRAFT_NOTE = 'Written from the dashboard; the Context owner turns this into the Task format with write_task before start.';

export interface WorkspaceRow {
  name: string;
  // The registered checkout, as registered (the page shows what the User typed).
  path: string;
  // The jobs of the workspace that are not pushed, aborted or failed.
  liveJobs: number;
  // Why the checkout cannot be used right now (missing, not a Git work tree), or null.
  problem: string | null;
}

export interface TicketRow {
  workspace: string;
  ticket: string;
  title: string;
  base: string;
  // True while the file still carries the draft marker.
  draft: boolean;
  // The state of the ticket's last job when it ended, or null without a job.
  job: JobState | null;
}

// An archived Task file: .software-factory/archive/<ticket>.md (SF-027).
export interface ArchivedRow {
  workspace: string;
  ticket: string;
  title: string;
}

export const ARCHIVE_DIR = 'archive';

export interface TicketInput {
  workspace: string;
  ticket: string;
  title: string;
  request: string;
}

export interface SetupOptions {
  configDir: string;
  jobs: JobStore;
  // Runs work under the Execution's lock, so a registry change and a job start never interleave.
  exclusive: <T>(work: () => Promise<T>) => Promise<T>;
  // Ends a finished job of the ticket when its Task file is archived or deleted: the job leaves
  // the Jobs list (archived in the state directory) and its worktree, if one was kept, is removed.
  // sf serve binds it to Execution.reset, which takes the lock itself.
  retireJob?: (workspace: string, ticket: string) => Promise<unknown>;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

// The content of a ticket draft: the Task front matter, the User's request verbatim and the
// draft marker with its one-line note.
export function draftContent(ticket: string, title: string, base: string, request: string): string {
  return `---\nticket: ${ticket}\ntitle: ${title}\nbase: ${base}\n---\n\n# ${ticket}: ${title}\n\n## Request\n\n${request.replace(/\r\n/g, '\n').replace(/\n+$/, '')}\n\n${DRAFT_MARKER}\n\n${DRAFT_NOTE}\n`;
}

export function isDraft(content: string): boolean {
  return content.split(/\r?\n/).some((line) => line.trim() === DRAFT_MARKER);
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
  readonly #retireJob: SetupOptions['retireJob'];

  constructor(options: SetupOptions) {
    this.#configDir = options.configDir;
    this.#jobs = options.jobs;
    this.#exclusive = options.exclusive;
    this.#retireJob = options.retireJob;
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
      rows.push({ name, path: entry.read_checkout, liveJobs: live.get(name) ?? 0, problem });
    }
    return rows;
  }

  // The same rules as `sf workspace add <name> --read <path>`: the name pattern, an absolute path
  // that is the root of a non-bare Git work tree, a name not registered yet. Until SF-019 the
  // work checkout is the read checkout.
  addWorkspace(name: string, path: string): Promise<WorkspaceRow> {
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
      registry.workspaces[name] = { read_checkout: real };
      await saveRegistry(registry, this.#configDir);
      return { name, path: real, liveJobs: 0, problem: null };
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

  // The Task files of every usable workspace whose ticket has no live job, sorted by workspace
  // and ticket. A file that is not a Task file (no front matter, another ticket, no title) is
  // skipped, as `start` would refuse it anyway.
  async tickets(): Promise<TicketRow[]> {
    const { workspaces } = await loadRegistry(this.#configDir);
    const rows: TicketRow[] = [];
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
        const job = await this.#jobs.read(name, ticket);
        if (job !== undefined && !TERMINAL_STATES.includes(job.state)) {
          continue;
        }
        rows.push({ workspace: name, ticket, title: fields.get('title')!, base: fields.get('base')!, draft: isDraft(content), job: job?.state ?? null });
      }
    }
    return rows;
  }

  // The workspace of a ticket action, with both names checked; a live job refuses it.
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

  // A finished job of the ticket leaves the Jobs list once its Task file goes.
  async #retire(name: string, ticket: string, jobEnded: boolean): Promise<boolean> {
    if (!jobEnded || this.#retireJob === undefined) {
      return false;
    }
    await this.#retireJob(name, ticket);
    return true;
  }

  // Moves <ticket>.md (and <ticket>.mr.md) into .software-factory/archive/, replacing an older
  // archived copy; a finished job of the ticket is archived with it.
  async archiveTicket(name: string, ticket: string): Promise<{ workspace: string; ticket: string; path: string; jobArchived: boolean }> {
    const { jobEnded } = await this.#exclusive(async () => {
      const target = await this.#ticketTarget(name, ticket);
      if (!(await isFile(join(target.dir, `${ticket}.md`)))) {
        throw new FactoryError('task_not_found', `${TASK_DIR}/${ticket}.md does not exist in workspace "${name}".`);
      }
      await mkdir(join(target.dir, ARCHIVE_DIR), { recursive: true, mode: 0o700 });
      for (const file of [`${ticket}.md`, `${ticket}.mr.md`]) {
        if (await isFile(join(target.dir, file))) {
          await rename(join(target.dir, file), join(target.dir, ARCHIVE_DIR, file));
        }
      }
      return target;
    });
    const jobArchived = await this.#retire(name, ticket, jobEnded);
    return { workspace: name, ticket, path: `${TASK_DIR}/${ARCHIVE_DIR}/${ticket}.md`, jobArchived };
  }

  // Moves an archived Task file (and its MR text) back; refused when the ticket has a Task file.
  restoreTicket(name: string, ticket: string): Promise<{ workspace: string; ticket: string; path: string }> {
    return this.#exclusive(async () => {
      const { dir } = await this.#ticketTarget(name, ticket);
      if (await isFile(join(dir, `${ticket}.md`))) {
        throw new FactoryError('ticket_exists', `${TASK_DIR}/${ticket}.md already exists in workspace "${name}".`);
      }
      if (!(await isFile(join(dir, ARCHIVE_DIR, `${ticket}.md`)))) {
        throw new FactoryError('task_not_found', `${TASK_DIR}/${ARCHIVE_DIR}/${ticket}.md does not exist in workspace "${name}".`);
      }
      for (const file of [`${ticket}.md`, `${ticket}.mr.md`]) {
        if (await isFile(join(dir, ARCHIVE_DIR, file))) {
          await rename(join(dir, ARCHIVE_DIR, file), join(dir, file));
        }
      }
      return { workspace: name, ticket, path: `${TASK_DIR}/${ticket}.md` };
    });
  }

  // Deletes the Task file and the MR text of the ticket, active or archived; a finished job of the
  // ticket is archived (its history stays in the state directory).
  async deleteTicket(name: string, ticket: string): Promise<{ workspace: string; ticket: string; deleted: string[]; jobArchived: boolean }> {
    const { deleted, jobEnded } = await this.#exclusive(async () => {
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
      for (const path of found) {
        await rm(join(target.dir, path));
      }
      return { deleted: found.map((path) => `${TASK_DIR}/${path}`), jobEnded: target.jobEnded };
    });
    const jobArchived = await this.#retire(name, ticket, jobEnded);
    return { workspace: name, ticket, deleted, jobArchived };
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

  // Writes the ticket draft through the Task file writer (the exclude entry, the job guard); an
  // existing Task file for the ticket is never replaced from here.
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
      await writeTask(workspace, ticket, draftContent(ticket, title, base, request), this.#jobs);
      return { workspace: name, ticket, path, base };
    });
  }
}
