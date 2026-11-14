// The reads of a project's merge requests on its Git host: the open merge requests of the origin's
// project and the review threads of one of them, for GitHub (REST v3) and GitLab (REST v4). Every
// request is a GET through the host's client of src/forge.ts (its token only to its own host, no
// redirect followed, failures as its FactoryErrors); nothing is written to the host. Comment bodies
// are returned as the host gives them: they are data, never logged here. Each comment says whether
// it is a bot's (GitHub's user.type, GitLab's author.bot when the host sends it, and the rules of
// src/mr-overview.ts).
import type { Config } from './config.js';
import { FactoryError } from './errors.js';
import { asArray, asRecord, type Forge, forgeFor, type HostClient, str } from './forge.js';
import { isBotComment } from './mr-overview.js';
import { originUrl } from './mr.js';
import type { Workspace } from './registry.js';

// The most open merge requests a list returns, newest update first.
const OPEN_REQUESTS_LIMIT = 50;
// The page size of a paged read.
const PAGE_SIZE = 100;

export interface OpenRequest {
  number: number;
  title: string;
  author: string;
  source: string;
  target: string;
  url: string;
  updated_at: string;
  draft: boolean;
}

// bot: a bot's comment or SonarQube's (src/mr-overview.ts isBotComment).
export interface ReviewComment {
  author: string;
  body: string;
  created_at: string;
  bot: boolean;
}

// path and line are null for a general comment; resolved is null where the host has no such
// notion (GitHub), and for a GitLab discussion without a resolvable note.
export interface ReviewThread {
  id: string;
  resolved: boolean | null;
  path: string | null;
  line: number | null;
  comments: ReviewComment[];
}

// The reads Forge offers, per host.
export type ForgeReads = Pick<Forge, 'openRequests' | 'threads'>;

type Json = Record<string, unknown>;
const lineOf = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null);
const idOf = (value: unknown): string | undefined => (typeof value === 'number' || (typeof value === 'string' && value !== '') ? String(value) : undefined);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const userOf = (value: unknown, key: 'login' | 'username'): string => str(asRecord(value)[key]) ?? 'unknown';

// The open merge requests, newest update first, at most OPEN_REQUESTS_LIMIT; an entry without its
// number or URL is mr_host_error, as in src/forge.ts.
function openRequestsOf(client: HostClient, entries: Json[], map: (entry: Json) => Omit<OpenRequest, 'number'> & { number: unknown }): OpenRequest[] {
  const requests = entries.map((entry) => {
    const { number, ...request } = map(entry);
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || request.url === '') {
      throw new FactoryError('mr_host_error', `${client.name} answered without the merge request's number or URL.`);
    }
    return { number, ...request };
  });
  return requests.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, OPEN_REQUESTS_LIMIT);
}

// Every page of a list (page=1, 2, ...) until a page holds fewer than PAGE_SIZE entries: no page
// limit, so nothing is cut off silently.
export async function allPages(client: HostClient, path: string, what: string): Promise<Json[]> {
  const entries: Json[] = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const batch = asArray(client.expect(await client.request('GET', `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`), what, 200));
    entries.push(...batch);
    if (batch.length < PAGE_SIZE) {
      break;
    }
  }
  return entries;
}

// The threads, oldest first: by their first comment's time, in the host's order on a tie.
const oldestFirst = (threads: ReviewThread[]): ReviewThread[] =>
  threads.filter((thread) => thread.comments.length > 0).sort((a, b) => a.comments[0]!.created_at.localeCompare(b.comments[0]!.created_at));

export function githubReads(client: HostClient, base: string): ForgeReads {
  const comment = (entry: Json, time: unknown = entry.created_at): ReviewComment => {
    const author = userOf(entry.user, 'login');
    const body = text(entry.body);
    return { author, body, created_at: text(time), bot: isBotComment(author, asRecord(entry.user).type === 'Bot', body) };
  };
  return {
    async openRequests() {
      const query = new URLSearchParams({ state: 'open', sort: 'updated', direction: 'desc', per_page: String(OPEN_REQUESTS_LIMIT) });
      const entries = asArray(client.expect(await client.request('GET', `${base}/pulls?${query}`), 'list the pull requests', 200));
      return openRequestsOf(client, entries, (entry) => ({
        number: entry.number, title: text(entry.title), author: userOf(entry.user, 'login'), source: text(asRecord(entry.head).ref),
        target: text(asRecord(entry.base).ref), url: text(entry.html_url), updated_at: text(entry.updated_at), draft: entry.draft === true,
      }));
    },
    async threads(number) {
      const pull = `${base}/pulls/${number}`;
      const reviewComments = await allPages(client, `${pull}/comments`, `read the review comments of pull request #${number}`);
      const issueComments = await allPages(client, `${base}/issues/${number}/comments`, `read the comments of pull request #${number}`);
      const reviews = await allPages(client, `${pull}/reviews`, `read the reviews of pull request #${number}`);
      // A reply joins the thread of the comment it answers (followed to the thread's first comment).
      const byId = new Map(reviewComments.flatMap((entry) => {
        const id = idOf(entry.id);
        return id !== undefined ? [[id, entry] as const] : [];
      }));
      const rootOf = (entry: Json): Json => {
        let current = entry;
        for (let hops = 0; hops < byId.size; hops += 1) {
          const parent = idOf(current.in_reply_to_id);
          const next = parent === undefined ? undefined : byId.get(parent);
          if (next === undefined || next === current) {
            break;
          }
          current = next;
        }
        return current;
      };
      const diffThreads = new Map<Json, ReviewThread>();
      for (const entry of reviewComments) {
        const root = rootOf(entry);
        let thread = diffThreads.get(root);
        if (thread === undefined) {
          thread = { id: `comment-${idOf(root.id) ?? diffThreads.size}`, resolved: null, path: str(root.path) ?? null, line: lineOf(root.line) ?? lineOf(root.original_line), comments: [] };
          diffThreads.set(root, thread);
        }
        thread.comments.push(comment(entry));
      }
      const general = (id: string, entry: Json, time?: unknown): ReviewThread => ({ id, resolved: null, path: null, line: null, comments: [comment(entry, time)] });
      return oldestFirst([
        ...[...diffThreads.values()].map((thread) => ({ ...thread, comments: [...thread.comments].sort((a, b) => a.created_at.localeCompare(b.created_at)) })),
        ...issueComments.map((entry, index) => general(`issue-comment-${idOf(entry.id) ?? index}`, entry)),
        // A pending review (the token owner's draft, not submitted) is no comment yet.
        ...reviews.filter((entry) => entry.state !== 'PENDING' && text(entry.body).trim() !== '').map((entry, index) => general(`review-${idOf(entry.id) ?? index}`, entry, entry.submitted_at)),
      ]);
    },
  };
}

export function gitlabReads(client: HostClient, project: string): ForgeReads {
  return {
    async openRequests() {
      const query = new URLSearchParams({ state: 'opened', order_by: 'updated_at', per_page: String(OPEN_REQUESTS_LIMIT) });
      const entries = asArray(client.expect(await client.request('GET', `${project}/merge_requests?${query}`), 'list the merge requests', 200));
      return openRequestsOf(client, entries, (entry) => ({
        number: entry.iid, title: text(entry.title), author: userOf(entry.author, 'username'), source: text(entry.source_branch),
        target: text(entry.target_branch), url: text(entry.web_url), updated_at: text(entry.updated_at), draft: entry.draft === true || entry.work_in_progress === true,
      }));
    },
    async threads(number) {
      const discussions = await allPages(client, `${project}/merge_requests/${number}/discussions`, `read the discussions of merge request !${number}`);
      return oldestFirst(discussions.map((discussion, index) => {
        const notes = asArray(discussion.notes).filter((note) => note.system !== true);
        const placed = notes.find((note) => str(asRecord(note.position).new_path) !== undefined || str(asRecord(note.position).old_path) !== undefined);
        const position = asRecord(placed?.position);
        const resolvable = notes.find((note) => note.resolvable === true);
        const path = str(position.new_path) ?? str(position.old_path) ?? null;
        return {
          id: idOf(discussion.id) ?? String(index),
          resolved: resolvable === undefined ? null : resolvable.resolved === true,
          path,
          line: path === null ? null : lineOf(position.new_line) ?? lineOf(position.old_line),
          comments: notes.map((note) => {
            const author = userOf(note.author, 'username');
            const body = text(note.body);
            return { author, body, created_at: text(note.created_at), bot: isBotComment(author, asRecord(note.author).bot === true, body) };
          }),
        };
      }));
    },
  };
}

// The Forge of a registered workspace's origin: its work checkout's origin URL, the host chosen
// from it. mr_host_unsupported or mr_token_missing when the merge request actions are off.
export async function workspaceForge(config: Config, resolve: (name: string) => Promise<Workspace>, workspaceName: string): Promise<Forge> {
  const checkout = (await resolve(workspaceName)).workCheckout;
  return forgeFor(await originUrl(checkout), config.forge);
}
