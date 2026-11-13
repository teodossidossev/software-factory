// A fake Git host on loopback for the merge request tests (SF-048): GitHub's pulls API under
// /repos/<owner>/<repo>/ and GitLab's merge requests API under /api/v4/projects/<id>/, with the
// merge requests in memory. Every request is recorded (method, path, headers, body); a test can
// set what the next merge answers or make a route fail with a status, and give a GET path a list
// of the host's own entries (lists), answered page by page (page, per_page).
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface FakeMr {
  number: number;
  branch: string;
  base: string;
  title: string;
  body: string;
  state: 'open' | 'merged' | 'closed';
  draft: boolean;
  // GitHub's mergeable and mergeable_state; GitLab's detailed_merge_status.
  mergeable: boolean | null;
  mergeableState: string;
  detailed: string;
  merge_commit: string | null;
  // When it was merged: set by the merge routes, or by a test to place a merge before or after a job.
  merged_at?: string;
}

export interface FakeForge {
  url: string;
  requests: Recorded[];
  mrs: FakeMr[];
  // A status and body that the next request whose "METHOD path" matches answers instead.
  fail: Array<{ match: RegExp; status: number; body: unknown }>;
  // GitHub's check runs of every head commit.
  checkRuns: Array<{ status: string; conclusion: string | null }>;
  // The entries a GET of the path answers (the path as the client sends it, without the query):
  // page (default 1) of per_page (default 30) of them.
  lists: Record<string, unknown[]>;
  close(): Promise<void>;
}

const MERGE_SHA = 'c'.repeat(40);
const HEAD_SHA = 'd'.repeat(40);

export async function startFakeForge(kind: 'github' | 'gitlab', repoPath: string): Promise<FakeForge> {
  const fake: FakeForge = { url: '', requests: [], mrs: [], fail: [], checkRuns: [], lists: {}, close: async () => undefined };
  const github = `/repos/${repoPath}`;
  const gitlab = `/api/v4/projects/${encodeURIComponent(repoPath)}`;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      // GitLab's project id stays encoded, as the client sends it.
      const path = (req.url ?? '/').split('?')[0]!;
      let body: unknown = raw;
      try {
        body = raw === '' ? undefined : JSON.parse(raw);
      } catch {
        // Kept as text.
      }
      fake.requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      const send = (status: number, data: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      };
      const failure = fake.fail.findIndex((entry) => entry.match.test(`${req.method} ${path}`));
      if (failure >= 0) {
        const [entry] = fake.fail.splice(failure, 1);
        send(entry!.status, entry!.body);
        return;
      }
      if (req.method === 'GET' && Object.hasOwn(fake.lists, path)) {
        const size = Number(url.searchParams.get('per_page') ?? 30);
        const page = Number(url.searchParams.get('page') ?? 1);
        send(200, fake.lists[path]!.slice((page - 1) * size, page * size));
        return;
      }
      const input = (body ?? {}) as Record<string, string>;
      const mergedAt = (mr: FakeMr): string | null => (mr.state === 'merged' ? mr.merged_at ?? new Date().toISOString() : null);
      if (kind === 'github') {
        const pr = (mr: FakeMr) => ({
          number: mr.number, html_url: `https://github.com/${repoPath}/pull/${mr.number}`, state: mr.state === 'open' ? 'open' : 'closed',
          merged: mr.state === 'merged', merged_at: mergedAt(mr), draft: mr.draft,
          mergeable: mr.mergeable, mergeable_state: mr.mergeableState, merge_commit_sha: mr.merge_commit ?? 'e'.repeat(40),
          head: { ref: mr.branch, sha: HEAD_SHA }, base: { ref: mr.base }, title: mr.title, body: mr.body,
        });
        if (req.method === 'GET' && path === `${github}/pulls`) {
          const head = url.searchParams.get('head');
          // state=closed: the closed and the merged ones; without it or open: the open ones.
          const states = url.searchParams.get('state') === 'closed' ? ['closed', 'merged'] : ['open'];
          const found = fake.mrs.filter((mr) => states.includes(mr.state) && `${repoPath.split('/')[0]}:${mr.branch}` === head && mr.base === url.searchParams.get('base')).map(pr);
          send(200, url.searchParams.get('direction') === 'desc' ? found.reverse() : found);
          return;
        }
        if (req.method === 'POST' && path === `${github}/pulls`) {
          const mr: FakeMr = {
            number: fake.mrs.length + 1, branch: input.head!, base: input.base!, title: input.title!, body: input.body!, state: 'open', draft: false,
            mergeable: true, mergeableState: 'clean', detailed: 'mergeable', merge_commit: null,
          };
          fake.mrs.push(mr);
          send(201, pr(mr));
          return;
        }
        const one = new RegExp(`^${github}/pulls/(\\d+)(/merge)?$`).exec(path);
        const mr = one === null ? undefined : fake.mrs.find((entry) => entry.number === Number(one[1]));
        if (one !== null && mr === undefined) {
          send(404, { message: 'Not Found' });
          return;
        }
        if (req.method === 'GET' && mr !== undefined && one![2] === undefined) {
          send(200, pr(mr));
          return;
        }
        if (req.method === 'PUT' && mr !== undefined && one![2] === '/merge') {
          if (mr.state !== 'open' || mr.mergeableState !== 'clean') {
            send(405, { message: mr.mergeableState === 'blocked' ? 'Required status check "test" is failing.' : 'Pull Request is not mergeable' });
            return;
          }
          mr.state = 'merged';
          mr.merge_commit = MERGE_SHA;
          mr.merged_at = new Date().toISOString();
          send(200, { sha: MERGE_SHA, merged: true, message: 'Pull Request successfully merged' });
          return;
        }
        if (req.method === 'GET' && path === `${github}/commits/${HEAD_SHA}/check-runs`) {
          send(200, { total_count: fake.checkRuns.length, check_runs: fake.checkRuns });
          return;
        }
        send(404, { message: 'Not Found' });
        return;
      }
      const mrJson = (mr: FakeMr) => ({
        iid: mr.number, web_url: `${fake.url}/${repoPath}/-/merge_requests/${mr.number}`, state: mr.state === 'open' ? 'opened' : mr.state,
        draft: mr.draft, detailed_merge_status: mr.detailed, merge_commit_sha: mr.merge_commit, head_pipeline: { status: 'success' },
        source_branch: mr.branch, target_branch: mr.base, title: mr.title, description: mr.body, merged_at: mergedAt(mr),
      });
      if (req.method === 'GET' && path === `${gitlab}/merge_requests`) {
        // state=merged: the merged ones; without it or opened: the open ones.
        const wanted = url.searchParams.get('state') === 'merged' ? 'merged' : 'open';
        const found = fake.mrs.filter((mr) => mr.state === wanted && mr.branch === url.searchParams.get('source_branch') && mr.base === url.searchParams.get('target_branch')).map(mrJson);
        send(200, url.searchParams.get('sort') === 'desc' ? found.reverse() : found);
        return;
      }
      if (req.method === 'POST' && path === `${gitlab}/merge_requests`) {
        const mr: FakeMr = {
          number: fake.mrs.length + 1, branch: input.source_branch!, base: input.target_branch!, title: input.title!, body: input.description!, state: 'open', draft: false,
          mergeable: true, mergeableState: 'clean', detailed: 'mergeable', merge_commit: null,
        };
        fake.mrs.push(mr);
        send(201, mrJson(mr));
        return;
      }
      const one = new RegExp(`^${gitlab}/merge_requests/(\\d+)(/merge)?$`).exec(path);
      const mr = one === null ? undefined : fake.mrs.find((entry) => entry.number === Number(one[1]));
      if (req.method === 'GET' && mr !== undefined && one![2] === undefined) {
        send(200, mrJson(mr));
        return;
      }
      if (req.method === 'PUT' && mr !== undefined && one![2] === '/merge') {
        if (mr.detailed !== 'mergeable') {
          send(406, { message: 'Branch cannot be merged' });
          return;
        }
        mr.state = 'merged';
        mr.merge_commit = MERGE_SHA;
        mr.merged_at = new Date().toISOString();
        send(200, mrJson(mr));
        return;
      }
      send(404, { message: '404 Not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  return fake;
}

export const FAKE_MERGE_SHA = MERGE_SHA;
