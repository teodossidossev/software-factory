// New ticket's issue read on the dashboard (POST api/tickets/<ws>/<ticket>/import): the
// route in process against startDashboard with a fake DashboardIssues (the answer, the body, the
// method, each refusal's status, none without the issue read), then end to end through sf serve
// with the fake Claude and real hook scripts (the session's options on its argv, the user's hook run
// for the allowed Atlassian call only, the hook's refusal, the server's sign-in, the checks before
// any session).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DashboardIssues } from '../src/dashboard.js';
import { startDashboard } from '../src/dashboard.js';
import { FactoryError } from '../src/errors.js';
import { type ImportedIssue, ISSUE_ALLOWED_TOOLS, issuePrompt } from '../src/issue-import.js';
import { JobStore } from '../src/jobs.js';
import { saveRegistry } from '../src/registry.js';
import { act, fakeActions, fetchRaw, type Reply } from './support/dashboard-client.js';
import { type Env, newEnv, newRepo, probeLog, serve, stop } from './support/harness.js';

const SITE = 'example.atlassian.net';
const PATH = 'api/tickets/app/ABC-123/import';
const IMPORTED: ImportedIssue = {
  ticket: 'ABC-123', title: 'Export the report as CSV', request: 'Imported by the factory from ABC-123.\n',
  images: [{ name: 'mockup.png', url: `https://${SITE}/rest/api/3/attachment/content/10001` }],
};
// Each refusal of the issue read with the status the route answers it with (src/http.ts ERROR_STATUS).
const REFUSALS: Array<[string, number]> = [
  ['issue_import_off', 409], ['issue_key_invalid', 400], ['issue_key_not_allowed', 403], ['issue_import_refused', 403],
  ['issue_import_unavailable', 503], ['issue_not_found', 404], ['issue_import_failed', 502], ['workspace_not_found', 404],
];

const parsed = (reply: Reply): any => JSON.parse(reply.body);

// A DashboardIssues that records its calls and answers IMPORTED, or throws refusal when set.
function fakeIssues(): DashboardIssues & { calls: Array<[string, string]>; refusal: FactoryError | undefined } {
  const fake = {
    calls: [] as Array<[string, string]>,
    refusal: undefined as FactoryError | undefined,
    async import(workspace: string, ticket: string): Promise<ImportedIssue> {
      fake.calls.push([workspace, ticket]);
      if (fake.refusal !== undefined) {
        throw fake.refusal;
      }
      return IMPORTED;
    },
  };
  return fake;
}

test('in process: the route answers the read, refuses a body and a GET, gives each refusal its status, and is an empty 404 without the issue read', async () => {
  const state = await mkdtemp(join(tmpdir(), 'sf-issue-route-'));
  try {
    const issues = fakeIssues();
    const dashboard = await startDashboard(0, state, new JobStore(state), fakeActions(), undefined, { issues });
    try {
      const base = dashboard.url;
      // II2-1: the read's answer, the fake called once with the names of the path.
      const ok = await act(base, PATH, {});
      assert.deepEqual([ok.status, parsed(ok)], [200, { ok: true, result: IMPORTED }]);
      assert.deepEqual(issues.calls, [['app', 'ABC-123']]);
      issues.calls.length = 0;
      // A body with a key: refused before any call.
      const body = await act(base, PATH, { x: 1 });
      assert.deepEqual([body.status, parsed(body)], [400, { ok: false, error: { code: 'invalid_body', message: 'ticket-import expects {}; no other keys, no null.' } }]);
      // POST only.
      const get = await fetchRaw(new URL(PATH, base));
      assert.deepEqual([get.status, get.headers.allow], [405, 'POST']);
      assert.deepEqual(issues.calls, []);
      // Names that fail the workspace or ticket pattern: an empty 404, before any call.
      for (const path of ['api/tickets/App/ABC-123/import', 'api/tickets/app/..%2FABC-123/import']) {
        const reply = await act(base, path, {});
        assert.deepEqual([reply.status, reply.body], [404, ''], path);
      }
      assert.deepEqual(issues.calls, []);
      // Each refusal answers its own status with its code and message.
      for (const [code, status] of REFUSALS) {
        issues.refusal = new FactoryError(code, `The read refused: ${code}.`);
        const reply = await act(base, PATH, {});
        assert.deepEqual([reply.status, parsed(reply)], [status, { ok: false, error: { code, message: `The read refused: ${code}.` } }], code);
      }
      assert.equal(issues.calls.length, REFUSALS.length);
    } finally {
      await dashboard.close();
    }
    // Without the issue read: an empty 404.
    const without = await startDashboard(0, state, new JobStore(state), fakeActions());
    try {
      const reply = await act(without.url, PATH, {});
      assert.deepEqual([reply.status, reply.body], [404, '']);
    } finally {
      await without.close();
    }
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

// A #!/bin/sh hook with mode 0755 under the test's home.
async function hookScript(env: Env, name: string, body: string): Promise<string> {
  const path = join(env.home, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const DENIAL = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: "Atlassian allowlist: issueIdOrKey='ABC-123': project ABC is not allowed. Allowed projects: XYZ.",
  },
});

// What the fake logged of each issue read.
async function issueLog(env: Env): Promise<Array<{ argv: string[]; prompt: string; cwd: string }>> {
  const text = await readFile(join(env.home, 'fake-issue.log'), 'utf8').catch(() => '');
  return text.trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
}

// An option's value in either form, --name value or --name=value.
function optionOf(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

test('end to end through sf serve: the read with the real session options and the user hook, its refusal, the sign-in, and the checks before any session', async () => {
  const env = await newEnv('issue-import-route');
  const hookLog = join(env.home, 'hook.log');
  const allow = await hookScript(env, 'allow.sh', `cat >> '${hookLog}'; echo >> '${hookLog}'`);
  // A quoted here-document: the denial's own single quotes reach the factory as they are.
  const deny = await hookScript(env, 'deny.sh', `cat <<'EOF'\n${DENIAL}\nEOF`);
  const issueImport = (hook: string) => ({ on: true, prefixes: ['ABC'], site: SITE, hook });
  const [app, denied, plain] = [await newRepo(env, 'issue-app', false), await newRepo(env, 'issue-denied', false), await newRepo(env, 'issue-plain', false)];
  await saveRegistry({
    workspaces: {
      app: { read_checkout: app, work_checkout: app, issue_import: issueImport(allow) },
      denied: { read_checkout: denied, work_checkout: denied, issue_import: issueImport(deny) },
      plain: { read_checkout: plain, work_checkout: plain },
    },
  }, env.config);
  const getIssue = { tool: 'mcp__atlassian__getJiraIssue', input: { cloudId: SITE, issueIdOrKey: 'ABC-123' } };
  const imageUrl = `https://${SITE}/rest/api/3/attachment/content/10001`;
  const output = {
    found: true, problem: '', title: 'Export the report as CSV', description: 'Users need the report as CSV.',
    comments: [{ author: 'Reviewer', created: '2026-11-20', body: 'CSV with a header row.' }],
    attachments: [{ filename: 'mockup.png', mime_type: 'image/png', url: imageUrl }],
  };
  await writeFile(join(env.home, 'fake-issue.json'), JSON.stringify({
    issues: [
      {
        output,
        probes: [
          { tool: 'mcp__atlassian__createJiraIssue', input: { cloudId: SITE, projectKey: 'ABC' } },
          { ...getIssue, result: '{"key":"ABC-123"}' },
        ],
      },
      { probes: [getIssue] },
      { mcpStatus: 'needs-auth' },
    ],
  }));
  const served = await serve(env);
  try {
    const base = served.dashboard!;
    // II2-2: the read's answer.
    const ok = await act(base, 'api/tickets/app/ABC-123/import', {});
    assert.equal(ok.status, 200, ok.body);
    const { ok: done, result } = parsed(ok);
    assert.equal(done, true);
    assert.deepEqual([result.ticket, result.title, result.images], ['ABC-123', 'Export the report as CSV', [{ name: 'mockup.png', url: imageUrl }]]);
    assert.ok(result.request.startsWith(`Imported by the factory from ABC-123 (https://${SITE}/browse/ABC-123).`), result.request);
    assert.ok(result.request.includes('<issue key="ABC-123">'), result.request);
    // Every call went through the factory's callback; the one outside the read's tools was denied
    // without the user's hook, which ran for the allowed getJiraIssue only.
    const probes = await probeLog(env);
    assert.deepEqual(probes.map((entry) => [entry.tool, entry.decision, entry.hooks]), [
      ['mcp__atlassian__createJiraIssue', 'deny', 1], ['mcp__atlassian__getJiraIssue', 'allow', 1], ['StructuredOutput', 'allow', 1],
    ]);
    assert.equal(probes[0]!.output, 'The issue read calls getJiraIssue and listJiraIssueComments only; this mcp__atlassian__createJiraIssue call is refused.');
    assert.equal(probes[1]!.output, '{"key":"ABC-123"}');
    const hooked = (await readFile(hookLog, 'utf8')).trim().split('\n');
    assert.equal(hooked.length, 1);
    const call = JSON.parse(hooked[0]!);
    assert.deepEqual([call.tool_name, call.tool_input], [getIssue.tool, getIssue.input]);

    // II2-3: the session's options on the fake's argv, and its folder removed after the answer.
    const [read] = await issueLog(env);
    assert.equal(read!.prompt, issuePrompt('ABC-123', SITE));
    const { argv } = read!;
    assert.equal(optionOf(argv, 'permission-mode'), 'dontAsk');
    assert.equal(optionOf(argv, 'allowedTools'), ISSUE_ALLOWED_TOOLS.join(','));
    assert.ok(argv.includes('--strict-mcp-config'), argv.join(' '));
    assert.equal(optionOf(argv, 'tools'), '');
    assert.deepEqual(JSON.parse(optionOf(argv, 'mcp-config')!), { mcpServers: { atlassian: { type: 'http', url: 'https://mcp.atlassian.com/v2/mcp', alwaysLoad: true } } });
    assert.equal(optionOf(argv, 'setting-sources'), '');
    assert.ok(!argv.includes('--dangerously-skip-permissions'), argv.join(' '));
    assert.equal(existsSync(read!.cwd), false, read!.cwd);

    // II2-4: the user's hook refuses the call.
    const refused = await act(base, 'api/tickets/denied/ABC-123/import', {});
    assert.deepEqual([refused.status, parsed(refused).error], [403, {
      code: 'issue_import_refused', message: "Not allowed by your Atlassian allowlist: issueIdOrKey='ABC-123': project ABC is not allowed.",
    }]);

    // II2-5: the Atlassian server is not signed in.
    const unsigned = await act(base, 'api/tickets/app/ABC-124/import', {});
    assert.deepEqual([unsigned.status, parsed(unsigned).error], [503, {
      code: 'issue_import_unavailable',
      message: 'The Atlassian MCP server is not connected (needs-auth): sign in to it in Claude Code (/mcp, the server "atlassian"), then try again.',
    }]);

    // II2-6: a key of another project and a workspace without the setting, refused before any session.
    const other = await act(base, 'api/tickets/app/XYZ-1/import', {});
    assert.deepEqual([other.status, parsed(other).error], [403, {
      code: 'issue_key_not_allowed', message: 'XYZ-1 is not an issue of workspace "app": its issue_import prefixes are ABC.',
    }]);
    const off = await act(base, 'api/tickets/plain/ABC-1/import', {});
    assert.deepEqual([off.status, parsed(off).error.code], [409, 'issue_import_off']);
    assert.equal((await issueLog(env)).length, 3);
    // The hook ran once in all: the denied workspace's hook writes no log, the sign-in's read made no call.
    assert.equal((await readFile(hookLog, 'utf8')).trim().split('\n').length, 1);
  } finally {
    await stop(served);
  }
});
