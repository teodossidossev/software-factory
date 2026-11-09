// The Git host's merge requests (SF-048): GitHub (github.com, REST API v3) and GitLab (REST API
// v4), chosen from the workspace checkout's origin URL. Opens a pull request / merge request from
// the job's branch into its base (or reuses the open one), reads its state and merges it through
// the host's API; nothing is pushed or forced here. The tokens come from the environment file
// (SF_GITHUB_TOKEN, SF_GITLAB_TOKEN); each goes only in the Authorization header of a request to
// its own host's API, redirects are refused, and no message carries it.
import { FactoryError } from './errors.js';
import { parseOrigin } from './mr.js';

export type ForgeKind = 'github' | 'gitlab';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_HOST_MESSAGE = 300;
const GITHUB_HOST = 'github.com';
const GITHUB_API = 'https://api.github.com';
// Hosts known not to be GitLab: their origin never gets the GitLab token.
const NOT_GITLAB = /^(?:bitbucket\.org|codeberg\.org|gitee\.com|(?:ssh\.)?dev\.azure\.com|[^.]+\.visualstudio\.com)$/;

// The hosts' settings, read once when sf serve starts.
export interface ForgeSettings {
  githubToken: string | undefined;
  // The GitHub API base: https://api.github.com, or SF_GITHUB_API on loopback (tests only).
  githubApi: string;
  gitlabToken: string | undefined;
  // SF_GITLAB_URL: the GitLab API base when it is not https://<host>/api/v4.
  gitlabUrl: string | undefined;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// A configured URL as a message may show it: its credentials, query and fragment (which may hold a
// token) replaced by [redacted]; a value that is not a URL is not shown at all.
export function shownUrl(raw: string): string {
  const url = URL.parse(raw);
  if (url === null) {
    return 'a value that is not a URL';
  }
  const userinfo = url.username !== '' || url.password !== '' ? '[redacted]@' : '';
  const authority = url.host !== '' || userinfo !== '' ? `//${userinfo}${url.host}` : '';
  return `"${url.protocol}${authority}${url.pathname}${url.search !== '' ? '?[redacted]' : ''}${url.hash !== '' ? '#[redacted]' : ''}"`;
}

// An http(s) URL without credentials, query or fragment, without the trailing slash.
function apiBase(name: string, raw: string): URL {
  const url = URL.parse(raw);
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new FactoryError('invalid_config', `${name} must be an http(s) URL without credentials, query or fragment, got ${shownUrl(raw)}.`);
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

// SF_GITLAB_URL: https, or http on loopback only (the tests' fake GitLab), so the GitLab token
// never travels in cleartext.
function gitlabBase(raw: string): string {
  const url = apiBase('SF_GITLAB_URL', raw);
  if (url.protocol !== 'https:' && !LOOPBACK.has(url.hostname)) {
    throw new FactoryError('invalid_config', `SF_GITLAB_URL must use https; http is allowed on loopback only (127.0.0.1, localhost or [::1]), got ${shownUrl(raw)}.`);
  }
  return url.href.replace(/\/$/, '');
}

export function forgeSettings(env: NodeJS.ProcessEnv = process.env): ForgeSettings {
  let githubApi = GITHUB_API;
  if (env.SF_GITHUB_API) {
    const url = apiBase('SF_GITHUB_API', env.SF_GITHUB_API);
    // The GitHub token goes to GitHub's API only; another base is for the tests' fake host.
    if (!LOOPBACK.has(url.hostname)) {
      throw new FactoryError('invalid_config', 'SF_GITHUB_API is for tests only and must point at loopback (127.0.0.1, localhost or [::1]).');
    }
    githubApi = url.href.replace(/\/$/, '');
  }
  return {
    githubToken: env.SF_GITHUB_TOKEN || undefined,
    githubApi,
    gitlabToken: env.SF_GITLAB_TOKEN || undefined,
    gitlabUrl: env.SF_GITLAB_URL ? gitlabBase(env.SF_GITLAB_URL) : undefined,
  };
}

// The environment for a child process (the tunnel, the browser launcher, notify-send) without the
// Git hosts' tokens.
export const HOST_TOKEN_NAMES: readonly string[] = ['SF_GITHUB_TOKEN', 'SF_GITLAB_TOKEN'];

export function withoutHostTokens(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !HOST_TOKEN_NAMES.includes(name)));
}

export type MergeRequestState = 'open' | 'merged' | 'closed';

export interface MergeRequest {
  number: number;
  url: string;
  state: MergeRequestState;
}

// What the host says of a merge request: mergeable is null while the host does not know yet;
// reason says why it cannot be merged; checks summarizes the checks or the pipeline when the host
// reports them.
export interface MergeRequestStatus extends MergeRequest {
  draft: boolean;
  mergeable: boolean | null;
  reason?: string;
  checks?: string;
  merge_commit?: string;
}

export interface Forge {
  readonly kind: ForgeKind;
  // "GitHub" or "GitLab <host>", for messages.
  readonly name: string;
  // The open merge request from branch into base, or a new one with title and body.
  open(input: { branch: string; base: string; title: string; body: string }): Promise<MergeRequest & { reused: boolean }>;
  status(number: number): Promise<MergeRequestStatus>;
  // Merges an open, mergeable merge request; mr_not_open or mr_not_mergeable (the host's reason)
  // otherwise. GitHub: merge method merge with the host's commit title; GitLab: PUT .../merge.
  merge(number: number): Promise<{ merge_commit: string | null }>;
}

// Which host a workspace's origin is on, and why the merge request actions are off when they are:
// a token missing (missing names the variable), or an origin on no supported host.
export type ForgeChoice =
  | { ok: true; kind: ForgeKind; host: string; path: string; api: string; token: string; tokenName: string }
  | { ok: false; kind: ForgeKind | null; code: 'mr_host_unsupported' | 'mr_token_missing'; reason: string; missing?: string };

const hostnameOf = (host: string): string => URL.parse(`https://${host}`)?.hostname ?? host;

export function chooseForge(origin: string | undefined, settings: ForgeSettings): ForgeChoice {
  const parsed = origin === undefined ? undefined : parseOrigin(origin);
  if (parsed === undefined) {
    return { ok: false, kind: null, code: 'mr_host_unsupported', reason: 'the origin URL of the checkout names no GitHub or GitLab repository' };
  }
  const { host, path } = parsed;
  if (host === GITHUB_HOST) {
    if (path.split('/').length !== 2) {
      return { ok: false, kind: 'github', code: 'mr_host_unsupported', reason: `the origin path ${path} is not <owner>/<repository>` };
    }
    if (settings.githubToken === undefined) {
      return { ok: false, kind: 'github', code: 'mr_token_missing', reason: 'SF_GITHUB_TOKEN is not set in the environment file', missing: 'SF_GITHUB_TOKEN' };
    }
    return { ok: true, kind: 'github', host, path, api: settings.githubApi, token: settings.githubToken, tokenName: 'SF_GITHUB_TOKEN' };
  }
  // Any other host is GitLab. With SF_GITLAB_URL the GitLab token goes to that host only.
  if (NOT_GITLAB.test(hostnameOf(host))) {
    return { ok: false, kind: null, code: 'mr_host_unsupported', reason: `${hostnameOf(host)} is neither GitHub nor GitLab` };
  }
  let api = `https://${host}/api/v4`;
  if (settings.gitlabUrl !== undefined) {
    const configured = new URL(settings.gitlabUrl).hostname;
    if (configured !== hostnameOf(host)) {
      return {
        ok: false, kind: 'gitlab', code: 'mr_host_unsupported',
        reason: `the origin is on ${hostnameOf(host)}, but SF_GITLAB_URL is for ${configured}; the GitLab token is not sent to another host`,
      };
    }
    api = settings.gitlabUrl;
  }
  if (settings.gitlabToken === undefined) {
    return { ok: false, kind: 'gitlab', code: 'mr_token_missing', reason: 'SF_GITLAB_TOKEN is not set in the environment file', missing: 'SF_GITLAB_TOKEN' };
  }
  return { ok: true, kind: 'gitlab', host, path, api, token: settings.gitlabToken, tokenName: 'SF_GITLAB_TOKEN' };
}

// The Forge of the origin; mr_host_unsupported or mr_token_missing when the actions are off.
export function forgeFor(origin: string | undefined, settings: ForgeSettings): Forge {
  const choice = chooseForge(origin, settings);
  if (!choice.ok) {
    throw new FactoryError(choice.code, `Merge requests are off for this workspace: ${choice.reason}.`);
  }
  if (choice.kind === 'github') {
    return githubForge(new HostClient(choice, 'GitHub'), choice.path);
  }
  return gitlabForge(new HostClient(choice, `GitLab ${hostnameOf(choice.host)}`), choice.path);
}

// The forge tokens' check of sf health (SF-153): one read-only "who am I" call to the host's API
// (GitHub GET /user, GitLab GET /api/v4/user), the token in the Authorization header only, no
// redirect followed. The answer's body is never read: the result names the host, the variable and
// the status only.
export const TOKEN_CHECK_TIMEOUT_MS = 10_000;

export async function checkForgeToken(choice: Extract<ForgeChoice, { ok: true }>, timeoutMs = TOKEN_CHECK_TIMEOUT_MS): Promise<{ ok: true } | { ok: false; reason: string }> {
  const name = choice.kind === 'github' ? 'GitHub' : `GitLab ${hostnameOf(choice.host)}`;
  let response: Response;
  try {
    response = await fetch(`${choice.api}/user`, {
      headers: {
        authorization: `Bearer ${choice.token}`,
        accept: choice.kind === 'github' ? 'application/vnd.github+json' : 'application/json',
        'user-agent': 'software-factory',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = (error as Error).name === 'TimeoutError';
    return { ok: false, reason: `${name} did not answer${timedOut ? ` within ${timeoutMs / 1000} s` : ''}` };
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 200) {
    return { ok: true };
  }
  if (response.status === 401) {
    return { ok: false, reason: `${name} refused ${choice.tokenName} (401): renew it in the environment file` };
  }
  return { ok: false, reason: `${name} answered ${choice.tokenName}'s check with HTTP ${response.status}` };
}

interface Reply {
  status: number;
  data: unknown;
}

// Requests to one host's API with its token. Every failure is a FactoryError whose message holds
// no token.
class HostClient {
  readonly #api: string;
  readonly #token: string;
  readonly #tokenName: string;
  readonly #kind: ForgeKind;
  readonly name: string;

  constructor(choice: Extract<ForgeChoice, { ok: true }>, name: string) {
    this.name = name;
    this.#api = choice.api;
    this.#token = choice.token;
    this.#tokenName = choice.tokenName;
    this.#kind = choice.kind;
  }

  // The host's own words, cut short, never the token.
  clean(text: string): string {
    const cut = text.replace(/\s+/g, ' ').trim().slice(0, MAX_HOST_MESSAGE);
    return this.#token === '' ? cut : cut.split(this.#token).join('[redacted]');
  }

  // The message of an error reply: GitHub's message and errors, GitLab's message or error.
  hostMessage(data: unknown): string {
    if (data === null || typeof data !== 'object') {
      return typeof data === 'string' ? this.clean(data) : '';
    }
    const record = data as { message?: unknown; error?: unknown; errors?: unknown };
    const parts: string[] = [];
    const add = (value: unknown): void => {
      if (typeof value === 'string') {
        parts.push(value);
      } else if (Array.isArray(value)) {
        value.forEach(add);
      } else if (value !== null && typeof value === 'object') {
        const inner = value as { message?: unknown };
        if (typeof inner.message === 'string') {
          parts.push(inner.message);
        } else {
          for (const [key, entry] of Object.entries(value)) {
            parts.push(`${key} ${Array.isArray(entry) ? entry.join(', ') : String(entry)}`);
          }
        }
      }
    };
    add(record.message);
    add(record.error);
    add(record.errors);
    return this.clean(parts.join('; '));
  }

  async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<Reply> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
      accept: this.#kind === 'github' ? 'application/vnd.github+json' : 'application/json',
      'user-agent': 'software-factory',
      ...(this.#kind === 'github' ? { 'x-github-api-version': '2022-11-28' } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    };
    let response: Response;
    try {
      response = await fetch(`${this.#api}${path}`, {
        method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        // A redirect would carry the token elsewhere.
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      const timedOut = (error as Error).name === 'TimeoutError';
      throw new FactoryError('mr_host_unreachable', `${this.name} did not answer: ${timedOut ? `no reply within ${REQUEST_TIMEOUT_MS / 1000} s` : `${this.clean((error as Error).message)}${cause !== undefined ? ` (${cause})` : ''}`}.`);
    }
    const text = await response.text();
    let data: unknown = text;
    try {
      data = text === '' ? null : JSON.parse(text);
    } catch {
      // Not JSON: the text itself is the message.
    }
    if (response.status >= 300 && response.status < 400) {
      throw new FactoryError('mr_host_error', `${this.name} answered ${method} with a redirect (${response.status}); it is not followed.`);
    }
    if (response.status === 401) {
      const said = this.hostMessage(data);
      throw new FactoryError('mr_auth_failed', `${this.name} refused the token in ${this.#tokenName} (401${said !== '' ? `: ${said}` : ''}). Check the token and its permissions.`);
    }
    return { status: response.status, data };
  }

  // A reply that must be one of the expected statuses; anything else is mr_host_error.
  expect(reply: Reply, what: string, ...statuses: number[]): unknown {
    if (statuses.includes(reply.status)) {
      return reply.data;
    }
    const said = this.hostMessage(reply.data);
    const hint = reply.status === 403 || reply.status === 404 ? ` (does ${this.#tokenName} have access to the repository?)` : '';
    throw new FactoryError('mr_host_error', `${this.name} refused to ${what}: HTTP ${reply.status}${said !== '' ? `: ${said}` : ''}${hint}.`);
  }
}

type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {});
const asArray = (value: unknown): Json[] => (Array.isArray(value) ? value.map(asRecord) : []);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const commitOf = (value: unknown): string | undefined => (typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value) ? value : undefined);

function numbered(client: HostClient, data: Json, key: 'number' | 'iid', urlKey: 'html_url' | 'web_url', state: MergeRequestState): MergeRequest {
  const number = data[key];
  const url = str(data[urlKey]);
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || url === undefined) {
    throw new FactoryError('mr_host_error', `${client.name} answered without the merge request's number or URL.`);
  }
  return { number, url, state };
}

// "2 passed, 1 failed, 1 running" from GitHub's check runs.
function checkSummary(runs: Json[]): string | undefined {
  if (runs.length === 0) {
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const run of runs) {
    const conclusion = str(run.conclusion);
    const word = run.status !== 'completed' ? 'running'
      : conclusion === 'success' ? 'passed'
        : conclusion === 'skipped' || conclusion === 'neutral' ? 'skipped'
          : 'failed';
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return ['passed', 'failed', 'running', 'skipped'].filter((word) => counts.has(word)).map((word) => `${counts.get(word)} ${word}`).join(', ');
}

function githubForge(client: HostClient, path: string): Forge {
  const [owner, repo] = path.split('/') as [string, string];
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const findOpen = async (branch: string, target: string): Promise<MergeRequest | undefined> => {
    const query = new URLSearchParams({ state: 'open', head: `${owner}:${branch}`, base: target });
    const [first] = asArray(client.expect(await client.request('GET', `${base}/pulls?${query}`), 'list the pull requests', 200));
    return first === undefined ? undefined : numbered(client, first, 'number', 'html_url', 'open');
  };
  const forge: Forge = {
    kind: 'github',
    name: 'GitHub',
    async open({ branch, base: target, title, body }) {
      const existing = await findOpen(branch, target);
      if (existing !== undefined) {
        return { ...existing, reused: true };
      }
      const reply = await client.request('POST', `${base}/pulls`, { title, head: branch, base: target, body });
      if (reply.status === 422) {
        // Opened meanwhile by someone else: that one is reused.
        const raced = await findOpen(branch, target);
        if (raced !== undefined) {
          return { ...raced, reused: true };
        }
      }
      const created = asRecord(client.expect(reply, 'open the pull request', 201));
      return { ...numbered(client, created, 'number', 'html_url', 'open'), reused: false };
    },
    async status(number) {
      const data = asRecord(client.expect(await client.request('GET', `${base}/pulls/${number}`), `read pull request #${number}`, 200));
      const state: MergeRequestState = data.merged === true || str(data.merged_at) !== undefined ? 'merged' : data.state === 'open' ? 'open' : 'closed';
      const draft = data.draft === true;
      const mergeableState = str(data.mergeable_state);
      const targetBranch = str(asRecord(data.base).ref) ?? 'the base';
      let mergeable: boolean | null = typeof data.mergeable === 'boolean' ? data.mergeable : null;
      let reason: string | undefined;
      if (state !== 'open') {
        mergeable = false;
        reason = `it is ${state}`;
      } else if (draft) {
        mergeable = false;
        reason = 'it is a draft';
      } else if (data.mergeable === false || mergeableState === 'dirty') {
        mergeable = false;
        reason = `it has conflicts with ${targetBranch}`;
      } else if (mergeableState === 'blocked') {
        mergeable = false;
        reason = 'it is blocked: required checks or reviews have not passed';
      } else if (mergeableState === 'behind') {
        mergeable = false;
        reason = `the branch is behind ${targetBranch}, which must be up to date before merging`;
      } else if (mergeable === null) {
        reason = 'GitHub has not computed yet whether it can be merged';
      }
      const sha = str(asRecord(data.head).sha);
      let checks: string | undefined;
      if (sha !== undefined && state === 'open') {
        // Best effort: a token without Checks read sees none.
        const runs = await client.request('GET', `${base}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`).catch(() => undefined);
        checks = runs?.status === 200 ? checkSummary(asArray(asRecord(runs.data).check_runs)) : undefined;
      }
      const mergeCommit = state === 'merged' ? commitOf(data.merge_commit_sha) : undefined;
      return {
        ...numbered(client, data, 'number', 'html_url', state), draft, mergeable,
        ...(reason !== undefined ? { reason } : {}), ...(checks !== undefined ? { checks } : {}), ...(mergeCommit !== undefined ? { merge_commit: mergeCommit } : {}),
      };
    },
    async merge(number) {
      const status = await forge.status(number);
      if (status.state !== 'open') {
        throw new FactoryError('mr_not_open', `Pull request #${number} is ${status.state} on GitHub; nothing was merged.`);
      }
      // A draft or a conflict is refused here; GitHub decides the rest (checks, reviews) and says why.
      if (status.mergeable === false && (status.draft || /conflicts/.test(status.reason ?? ''))) {
        throw new FactoryError('mr_not_mergeable', `GitHub cannot merge pull request #${number}: ${status.reason}.`);
      }
      const reply = await client.request('PUT', `${base}/pulls/${number}/merge`, { merge_method: 'merge' });
      if (reply.status === 405 || reply.status === 409 || reply.status === 422) {
        const said = client.hostMessage(reply.data);
        throw new FactoryError('mr_not_mergeable', `GitHub refused to merge pull request #${number}: ${said !== '' ? said : `HTTP ${reply.status}`}${status.reason !== undefined ? ` (${status.reason})` : ''}.`);
      }
      const data = asRecord(client.expect(reply, `merge pull request #${number}`, 200));
      if (data.merged === false) {
        throw new FactoryError('mr_not_mergeable', `GitHub did not merge pull request #${number}: ${client.hostMessage(data) || 'no reason given'}.`);
      }
      return { merge_commit: commitOf(data.sha) ?? null };
    },
  };
  return forge;
}

// GitLab's detailed_merge_status in words, for the ones that block a merge.
const GITLAB_REASONS: Record<string, string> = {
  conflict: 'it has conflicts with the target branch',
  draft_status: 'it is a draft',
  ci_must_pass: 'its pipeline must succeed first',
  ci_still_running: 'its pipeline is still running',
  not_approved: 'it needs approvals',
  discussions_not_resolved: 'its discussions are not resolved',
  blocked_status: 'it is blocked by another merge request',
  need_rebase: 'it must be rebased onto the target branch',
  not_open: 'it is not open',
  requested_changes: 'a reviewer requested changes',
  jira_association_missing: 'it lacks a Jira issue',
  external_status_checks: 'its external status checks have not passed',
  merge_request_blocked: 'it is blocked',
  security_policy_violations: 'it violates a security policy',
  commits_status: 'its source branch is missing or has no commits',
};
const GITLAB_PENDING = new Set(['checking', 'unchecked', 'preparing', 'approvals_syncing']);

function gitlabForge(client: HostClient, path: string): Forge {
  const project = `/projects/${encodeURIComponent(path)}`;
  const stateOf = (value: unknown): MergeRequestState => (value === 'opened' ? 'open' : value === 'merged' ? 'merged' : 'closed');
  const findOpen = async (branch: string, target: string): Promise<MergeRequest | undefined> => {
    const query = new URLSearchParams({ state: 'opened', source_branch: branch, target_branch: target });
    const [first] = asArray(client.expect(await client.request('GET', `${project}/merge_requests?${query}`), 'list the merge requests', 200));
    return first === undefined ? undefined : numbered(client, first, 'iid', 'web_url', 'open');
  };
  const forge: Forge = {
    kind: 'gitlab',
    name: client.name,
    async open({ branch, base: target, title, body }) {
      const existing = await findOpen(branch, target);
      if (existing !== undefined) {
        return { ...existing, reused: true };
      }
      const reply = await client.request('POST', `${project}/merge_requests`, { source_branch: branch, target_branch: target, title, description: body });
      if (reply.status === 409) {
        const raced = await findOpen(branch, target);
        if (raced !== undefined) {
          return { ...raced, reused: true };
        }
      }
      const created = asRecord(client.expect(reply, 'open the merge request', 201));
      return { ...numbered(client, created, 'iid', 'web_url', 'open'), reused: false };
    },
    async status(number) {
      const data = asRecord(client.expect(await client.request('GET', `${project}/merge_requests/${number}`), `read merge request !${number}`, 200));
      const state = stateOf(data.state);
      const draft = data.draft === true || data.work_in_progress === true;
      const detailed = str(data.detailed_merge_status);
      let mergeable: boolean | null;
      let reason: string | undefined;
      if (state !== 'open') {
        mergeable = false;
        reason = `it is ${state}`;
      } else if (detailed !== undefined) {
        mergeable = detailed === 'mergeable' ? true : GITLAB_PENDING.has(detailed) ? null : false;
        reason = mergeable === true ? undefined : mergeable === null ? 'GitLab is still checking whether it can be merged' : (GITLAB_REASONS[detailed] ?? `GitLab says ${detailed}`);
      } else if (data.has_conflicts === true || data.merge_status === 'cannot_be_merged') {
        mergeable = false;
        reason = draft ? 'it is a draft' : 'it has conflicts with the target branch';
      } else {
        mergeable = data.merge_status === 'can_be_merged' ? !draft : null;
        reason = draft ? 'it is a draft' : mergeable === null ? 'GitLab is still checking whether it can be merged' : undefined;
      }
      const pipeline = str(asRecord(data.head_pipeline ?? data.pipeline).status);
      const mergeCommit = state === 'merged' ? commitOf(data.merge_commit_sha) ?? commitOf(data.squash_commit_sha) : undefined;
      return {
        ...numbered(client, data, 'iid', 'web_url', state), draft, mergeable,
        ...(reason !== undefined ? { reason } : {}), ...(pipeline !== undefined ? { checks: `pipeline ${pipeline}` } : {}),
        ...(mergeCommit !== undefined ? { merge_commit: mergeCommit } : {}),
      };
    },
    async merge(number) {
      const status = await forge.status(number);
      if (status.state !== 'open') {
        throw new FactoryError('mr_not_open', `Merge request !${number} is ${status.state} on GitLab; nothing was merged.`);
      }
      if (status.mergeable === false) {
        throw new FactoryError('mr_not_mergeable', `GitLab cannot merge merge request !${number}: ${status.reason}.`);
      }
      const reply = await client.request('PUT', `${project}/merge_requests/${number}/merge`);
      if (reply.status === 405 || reply.status === 406 || reply.status === 409 || reply.status === 422) {
        const said = client.hostMessage(reply.data);
        throw new FactoryError('mr_not_mergeable', `GitLab refused to merge merge request !${number}: ${said !== '' ? said : `HTTP ${reply.status}`}.`);
      }
      const data = asRecord(client.expect(reply, `merge merge request !${number}`, 200));
      return { merge_commit: commitOf(data.merge_commit_sha) ?? commitOf(data.squash_commit_sha) ?? null };
    },
  };
  return forge;
}
