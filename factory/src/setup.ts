// The dashboard's start screen, server side: the workspaces of the registry (list, add, remove)
// and the tickets of each workspace (list the Task files without a live job, write a ticket draft
// from the User's request, read a Task file's text and title for the board). It uses the same
// registry file, validation and Task file reader and writer as `sf workspace add` and
// `write_task`, so the CLI and the page agree; a job is started through the Execution, never from
// here.
import { lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';
import type { ExclusiveScope } from './execution.js';
import { runGit } from './git.js';
import { type JobState, type JobStore, TERMINAL_STATES } from './jobs.js';
import { loadRegistry, resolveWorkspace, saveRegistry, verifyCheckout, type Workspace, WORKSPACE_NAME_DESCRIPTION, WORKSPACE_NAME_PATTERN } from './registry.js';
import { ARCHIVE_DIR, DRAFT_MARKER, isDraft, MAX_TASK_BYTES, parseFrontMatter, readTask, TASK_DIR, TICKET_DESCRIPTION, TICKET_PATTERN, writeTask } from './task-file.js';

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
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
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

  constructor(options: SetupOptions) {
    this.#configDir = options.configDir;
    this.#jobs = options.jobs;
    this.#exclusive = options.exclusive;
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
        rows.push({ workspace: name, ticket, title: fields.get('title')!, base: fields.get('base')!, draft: isDraft(content), request: await this.#readRequest(name, ticket), job: job?.state ?? null });
      }
    }
    return rows;
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
  // archived copy; a finished job of the ticket is archived first. All under one lock acquisition:
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
      return { workspace: name, ticket, path: `${TASK_DIR}/${ARCHIVE_DIR}/${ticket}.md`, jobArchived };
    });
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

  // Deletes the Task file and the MR text of the ticket, active or archived, and the stored
  // request; a finished job of the ticket is archived first (its history stays in the state
  // directory). The same order and failure behaviour as archiveTicket.
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
      const jobArchived = await this.#retire(scope, name, ticket, target.jobEnded);
      for (const path of found) {
        await rm(join(target.dir, path));
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
      await writeTask(workspace, ticket, draftContent(ticket, title, base), this.#jobs);
      await mkdir(dirname(this.#requestPath(name, ticket)), { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.#requestPath(name, ticket), Buffer.from(request.replace(/\r\n/g, '\n'), 'utf8'));
      return { workspace: name, ticket, path, base };
    });
  }
}
