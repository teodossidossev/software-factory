// The sf command: `sf serve`, `sf up` (serve, the tunnel and the browser), `sf workspace
// add|list|remove`, `sf start|say|review|approve|abort|reset` and `sf mr create|merge|status`
// (through the socket of sf serve),
// `sf status|watch|dashboard` (reading the state directory directly), `sf notify-test`, `sf info`
// and `sf run`, the job's runner that sf serve starts (SF-042, src/runner.ts).
// Exit codes: 0 ok, 1 error, 2 usage.
import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openInBrowser } from './browser.js';
import { envFilePath, gateConfig, loadConfig, loadEnvFile, stateDir } from './config.js';
import { DEFAULT_DASHBOARD_PORT, dashboardUrl, readToken, removeToken, type RunningDashboard, startDashboard } from './dashboard.js';
import { FactoryError } from './errors.js';
import { Execution, type StateListener } from './execution.js';
import { forgeSettings, withoutHostTokens } from './forge.js';
import { codexVersion } from './gate.js';
import { existsSync } from 'node:fs';
import { callSocket, listenSocket, socketPath } from './ipc.js';
import { type Job, JobStore } from './jobs.js';
import { followJobs, runJob } from './runner.js';
import { jobNotification, notifyConfig, sendNotification, stateNotifier } from './notify.js';
import { configDir, ignoredWorkCheckouts, loadRegistry, resolveWorkspace, saveRegistry, verifyCheckout, WORKSPACE_NAME_DESCRIPTION, WORKSPACE_NAME_PATTERN } from './registry.js';
import { loadHandbook, packageVersion, PortInUseError, SERVER_NAME, startServer } from './server.js';
import { Setup } from './setup.js';
import { type StatusRow, statusRows } from './status.js';
import { fileSummaryLines } from './patch.js';
import { TICKET_DESCRIPTION, TICKET_PATTERN } from './task-file.js';
import { watchEvents } from './watch.js';

const DEFAULT_PORT = 8787;
const USAGE = `Usage:
  sf serve                                              Serve the MCP tools on 127.0.0.1:\${SF_PORT:-${DEFAULT_PORT}}/mcp and the dashboard
  sf up [--no-open] [--no-tunnel]                       sf serve plus the planning tunnel for ChatGPT (scripts/sf-tunnel.sh run) in one terminal, and open the dashboard; Ctrl+C stops both
  sf dashboard [--open] [--rotate]                      Print the dashboard URL; --open also opens it (xdg-open); --rotate removes the token so the next sf serve makes a new one
  sf workspace add <name> --read <path>                 Register a workspace: the local checkout (every job works in a worktree of it)
  sf workspace list                                     List registered workspaces
  sf workspace remove <name>                            Unregister a workspace
  sf start <workspace> <ticket>                         Start the job for .software-factory/<ticket>.md in a worktree of its own (up to SF_MAX_JOBS per workspace)
  sf say <workspace> <ticket> <message...>              Send a message into the job's Implementer session
  sf review <workspace> <ticket>                        Retry a failed Claude review (needs_human with review_failed) of the last iteration
  sf accept <workspace> <ticket>                        Accept a clean Claude review over a stopped gate (needs_human with gate_rounds, gate_budget or gate_failed) and prepare the MR
  sf status [<workspace> <ticket>]                      Show one job or all jobs: state, iterations, estimated cost, elapsed time
  sf watch <workspace> <ticket> [--once]                Show the session live (Ctrl+C stops)
  sf approve <workspace> <ticket> [--as-is]             Push the branch prepared at Clean; --as-is pushes it even if its tip was edited by hand
  sf mr create <workspace> <ticket>                     Open the merge request of a pushed job on GitHub or GitLab (or reuse the open one); from ready_for_human_review: approve, then open it
  sf mr merge <workspace> <ticket>                      Merge the job's open merge request through the host's API; refused with the host's reason when it cannot be merged
  sf mr status <workspace> <ticket>                     The merge request's state on the host: open, merged or closed, mergeable or not, the checks
  sf abort <workspace> <ticket> [--discard]             End the job; the worktree stays (its path is printed); --discard removes the worktree and the branch
  sf reset <workspace> <ticket>                         End the session, remove the worktree and archive the job; the branch is untouched
  sf notify-test                                        Send a test notification on every channel
  sf info                                               Version, directories, settings, whether sf serve and the tunnel run, workspaces, jobs
  sf run <workspace> <ticket>                           The job's runner: its turns, reviews and gate, detached from sf serve (sf serve starts it; one per job)

Notes:
  EST_USD: an estimate of the API-equivalent price, not a charge (the session usually runs on your Claude plan):
           cost_usd of the published iterations summed, four decimals; 0.0000 before the first one, unknown when one has no usable cost.
           A running iteration or MR preparation adds nothing until its iteration is published.
  SINCE:   the last state change in local time (the stored times are UTC).
  ELAPSED: wall-clock time since the job was created, waiting included; stops at the last state change once pushed, aborted or failed.
  dashboard --open: Linux with xdg-open; waits for the launcher at most 10 s; on a launcher failure exits 1 and leaves the printed URL to open by hand.
Exit codes: 0 ok, 1 error, 2 usage.`;

class UsageError extends Error {}

function parsePort(name: 'SF_PORT' | 'SF_DASHBOARD_PORT', fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65535) {
    throw new FactoryError('invalid_port', `${name} must be an integer between 0 and 65535, got "${raw}".`);
  }
  return port;
}

const dashboardOn = (): boolean => process.env.SF_DASHBOARD !== 'off';

interface ServeHooks {
  // Called once, before the servers close, when a signal stops sf serve.
  beforeStop?: () => void;
}

async function serve(hooks: ServeHooks = {}): Promise<{ dashboard: URL | undefined }> {
  const port = parsePort('SF_PORT', DEFAULT_PORT);
  const dashboardPort = parsePort('SF_DASHBOARD_PORT', DEFAULT_DASHBOARD_PORT);
  const config = loadConfig();
  const handbook = await loadHandbook();
  // Fail at startup on an invalid registry rather than on the first tool call.
  const registry = await loadRegistry();
  const ignored = ignoredWorkCheckouts(registry);
  if (ignored.length > 0) {
    console.error(`warning: the work_checkout of workspace(s) ${ignored.join(', ')} is ignored since SF-019: every job works in a worktree of the checkout.`);
  }
  const jobs = new JobStore(config.stateDir);
  const notify = stateNotifier(notifyConfig(), jobs);
  // The dashboard starts after recovery; until then its listener is a no-op.
  let dashboard: RunningDashboard | undefined;
  const onStateChange: StateListener = (job, from, lines) => {
    notify(job, from, lines);
    dashboard?.onStateChange(job, from);
  };
  const execution = new Execution(config, (name) => resolveWorkspace(name), onStateChange, handbook.text);
  // The start screen of the dashboard: the registry and the Task files, under the Execution's lock.
  // A finished job leaves with its Task file through the lock's scope, in the same acquisition as
  // the ticket action's checks: it is archived and a kept worktree removed.
  const setup = new Setup({ configDir: configDir(), jobs, exclusive: (work) => execution.exclusive(work) });
  const testHooks = process.env.SF_TEST_HOOKS === 'on';
  // The socket first: it refuses a second sf serve on the same state before recovery touches it.
  const socket = await listenSocket(config.stateDir, async ({ command, args }) => {
    // sf info: whether sf serve answers.
    if (command === 'ping') {
      return {};
    }
    const [workspace = '', ticket = '', ...words] = args;
    if (command === 'start' && words.length === 0) {
      return execution.start(workspace, ticket);
    }
    if (command === 'say') {
      return execution.say(workspace, ticket, words.join(' '));
    }
    if (command === 'review' && words.length === 0) {
      return execution.retryReview(workspace, ticket);
    }
    if (command === 'accept' && words.length === 0) {
      return execution.acceptGate(workspace, ticket);
    }
    if (command === 'approve' && (words.length === 0 || (words.length === 1 && words[0] === '--as-is'))) {
      return execution.approve(workspace, ticket, words.length === 1);
    }
    if (command === 'abort' && (words.length === 0 || (words.length === 1 && words[0] === '--discard'))) {
      return execution.abort(workspace, ticket, words.length === 1);
    }
    if (command === 'reset' && words.length === 0) {
      return execution.reset(workspace, ticket);
    }
    // sf mr create|merge|status (SF-048).
    if (command === 'mr-create' && words.length === 0) {
      return execution.createMergeRequest(workspace, ticket);
    }
    if (command === 'mr-merge' && words.length === 0) {
      return execution.mergeMergeRequest(workspace, ticket);
    }
    if (command === 'mr-status' && words.length === 0) {
      return execution.mergeRequestStatus(workspace, ticket);
    }
    // Tests only (SF_TEST_HOOKS=on): check, and a reviewer's verdict without a review session,
    // so the end-to-end tests drive the cycle step by step. No CLI command sends these.
    if (testHooks && command === 'check' && words.length <= 2) {
      const [offset, maxBytes] = words.map(Number);
      return execution.check(workspace, ticket, offset, maxBytes);
    }
    if (testHooks && command === 'fix' && words.length === 1) {
      return execution.requestFix(workspace, ticket, words[0]!);
    }
    if (testHooks && command === 'clean') {
      return execution.markClean(workspace, ticket, words);
    }
    throw new FactoryError('bad_request', `Unknown command "${command}".`);
  });
  let server;
  try {
    await execution.recover();
    server = await startServer(port, handbook, await packageVersion(), execution);
  } catch (error) {
    await socket.close();
    throw error;
  }
  try {
    if (dashboardOn()) {
      // The dashboard's actions (DashboardActions: start, approve, abort, say, retryReview,
      // acceptGate and archiveFinished) run on the same Execution as the socket commands.
      dashboard = await startDashboard(dashboardPort, config.stateDir, jobs, execution, setup, { gate: config.gate.on });
    } else {
      await removeToken(config.stateDir);
    }
  } catch (error) {
    await Promise.all([server.close(), socket.close()]);
    throw error;
  }
  console.log(dashboard !== undefined ? `${SERVER_NAME} dashboard ${dashboard.url.href}` : `${SERVER_NAME} dashboard off (SF_DASHBOARD=off)`);
  if (!config.gate.on && config.gate.missing === true) {
    console.log(`gate: off (${config.gate.reason}); the Claude review decides`);
  }
  console.log(`${SERVER_NAME} listening on ${server.url.href}`);
  console.log(`${SERVER_NAME} socket ${socket.path}`);
  // The runners write the state of their jobs; the dashboard hears of it from disk (SF-042).
  const followed = followJobs(jobs, (job, from) => dashboard?.onStateChange(job, from));

  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`${SERVER_NAME} received ${signal}, shutting down`);
    hooks.beforeStop?.();
    followed.close();
    Promise.all([server.close(), socket.close(), dashboard?.close()]).then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return { dashboard: dashboard?.url };
}

const RUNBOOK = 'docs/runbooks/chatgpt-connection.md';

// scripts/sf-tunnel.sh of this package (dist/src/cli.js is three levels below the repository
// root), or SF_TUNNEL_SCRIPT.
function tunnelScript(): string {
  return process.env.SF_TUNNEL_SCRIPT || fileURLToPath(new URL('../../../scripts/sf-tunnel.sh', import.meta.url));
}

// The tunnel as a child of sf up, its output on stderr prefixed "tunnel | ". A missing script,
// a failed check or an exit is reported once; sf up goes on without the tunnel.
interface Tunnel {
  // Ends the tunnel on purpose: its exit is not reported as a failure.
  stop(): void;
}

function startTunnel(): Tunnel | undefined {
  const script = tunnelScript();
  if (!existsSync(script)) {
    console.error(`tunnel | not started: ${script} is missing; the dashboard works without it (${RUNBOOK}).`);
    return undefined;
  }
  const child: ChildProcess = spawn(script, ['run'], { env: withoutHostTokens(), stdio: ['ignore', 'pipe', 'pipe'] });
  const forward = (stream: NodeJS.ReadableStream): void => {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      rest += chunk;
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        console.error(`tunnel | ${line}`);
      }
    });
    stream.on('end', () => {
      if (rest !== '') {
        console.error(`tunnel | ${rest}`);
        rest = '';
      }
    });
  };
  forward(child.stdout!);
  forward(child.stderr!);
  let wanted = false;
  child.once('error', (error) => {
    console.error(`tunnel | could not start (${error.message}); sf up goes on without it (${RUNBOOK}).`);
  });
  child.once('exit', (code, signal) => {
    if (!wanted) {
      console.error(`tunnel | exited (${code ?? signal}); sf up goes on without it and the dashboard works. Fix it and run npm run tunnel in another terminal (${RUNBOOK}).`);
    }
  });
  return {
    stop() {
      wanted = true;
      child.kill('SIGTERM');
    },
  };
}

// `sf up`: sf serve in this process, the tunnel as a child, the dashboard in the browser.
async function up(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { 'no-open': { type: 'boolean' }, 'no-tunnel': { type: 'boolean' } } });
  if (positionals.length !== 0) {
    throw new UsageError('up takes no arguments (only --no-open and --no-tunnel).');
  }
  let tunnel: Tunnel | undefined;
  const { dashboard } = await serve({ beforeStop: () => tunnel?.stop() });
  // The tunnel's check needs the factory to answer, so it starts after serve.
  if (values['no-tunnel'] !== true) {
    tunnel = startTunnel();
  } else {
    console.log('tunnel: not started (--no-tunnel)');
  }
  if (values['no-open'] === true || dashboard === undefined) {
    return;
  }
  try {
    await openInBrowser(dashboard.href);
  } catch (error) {
    // The URL was printed by serve; the page can be opened by hand.
    console.error(`sf: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function checkName(name: string | undefined): string {
  if (name === undefined) {
    throw new UsageError('a workspace name is required.');
  }
  if (!WORKSPACE_NAME_PATTERN.test(name)) {
    throw new FactoryError('invalid_name', `workspace name must be ${WORKSPACE_NAME_DESCRIPTION}.`);
  }
  return name;
}

async function checkout(path: string, option: string): Promise<string> {
  try {
    return await verifyCheckout(resolve(path), `${option} ${path}`);
  } catch (error) {
    throw error instanceof FactoryError ? new FactoryError(error.code, error.message.replace(/^The /, '')) : error;
  }
}

async function workspace(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: true,
    options: command === 'add' ? { read: { type: 'string' }, work: { type: 'string' } } : {},
  });
  if (command === 'list') {
    if (positionals.length > 0) {
      throw new UsageError('workspace list takes no arguments.');
    }
    const entries = Object.entries((await loadRegistry()).workspaces);
    if (entries.length === 0) {
      console.log('No workspaces registered.');
    }
    for (const [name, entry] of entries) {
      console.log(`${name}\n  checkout: ${entry.read_checkout}`);
    }
    return;
  }
  if (positionals.length > 1) {
    throw new UsageError(`unexpected argument "${positionals[1]}".`);
  }
  if (command === 'add') {
    const name = checkName(positionals[0]);
    const read = values.read as string | undefined;
    if (read === undefined) {
      throw new UsageError('workspace add requires --read <path>.');
    }
    if (values.work !== undefined) {
      throw new FactoryError('work_checkout_retired', '--work is no longer supported: every job works in a worktree of the checkout (SF-019).');
    }
    const registry = await loadRegistry();
    if (Object.hasOwn(registry.workspaces, name)) {
      throw new FactoryError('workspace_exists', `workspace "${name}" is already registered; remove it first.`);
    }
    const entry = { read_checkout: await checkout(read, '--read') };
    registry.workspaces[name] = entry;
    await saveRegistry(registry);
    console.log(`Registered workspace "${name}" (checkout: ${entry.read_checkout}).`);
    return;
  }
  if (command === 'remove') {
    const name = checkName(positionals[0]);
    const registry = await loadRegistry();
    if (!Object.hasOwn(registry.workspaces, name)) {
      throw new FactoryError('workspace_not_found', `workspace "${name}" is not registered.`);
    }
    delete registry.workspaces[name];
    await saveRegistry(registry);
    console.log(`Removed workspace "${name}".`);
    return;
  }
  throw new UsageError(command === undefined ? 'a workspace command is required.' : `unknown workspace command "${command}".`);
}

function checkJob(args: string[], command: string): [string, string] {
  const [workspace, ticket] = args;
  if (workspace === undefined || ticket === undefined) {
    throw new UsageError(`${command} needs <workspace> <ticket>.`);
  }
  checkName(workspace);
  if (!TICKET_PATTERN.test(ticket)) {
    throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}.`);
  }
  return [workspace, ticket];
}

// The result of a socket command of sf serve; a refusal throws its code and message.
async function request(command: string, args: string[]): Promise<Record<string, unknown>> {
  const response = await callSocket(stateDir(), { command, args });
  if (!response.ok) {
    throw new FactoryError(response.error.code, response.error.message);
  }
  return response.result as Record<string, unknown>;
}

async function viaServer(command: string, args: string[]): Promise<Record<string, unknown>> {
  const result = await request(command, args);
  const show = (value: unknown): string => (typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value));
  console.log(Object.entries(result).map(([key, value]) => `${key}: ${show(value)}`).join('\n'));
  return result;
}

async function approve(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { 'as-is': { type: 'boolean' } } });
  if (positionals.length !== 2) {
    throw new UsageError('approve needs <workspace> <ticket> [--as-is].');
  }
  const result = await viaServer('approve', [...checkJob(positionals, 'approve'), ...(values['as-is'] === true ? ['--as-is'] : [])]);
  if (result.state === 'needs_human') {
    console.log('The push failed; fix it and run sf approve again.');
  } else if (result.state === 'pushed' && result.link === undefined) {
    console.log('No merge request link: the origin URL could not be parsed. Open the merge request for the branch above.');
  }
  if (result.state !== 'pushed') {
    process.exitCode = 1;
  }
}

// sf mr create|merge|status <workspace> <ticket> (SF-048), through the socket of sf serve.
async function mergeRequest(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub !== 'create' && sub !== 'merge' && sub !== 'status') {
    throw new UsageError(sub === undefined ? 'mr needs create, merge or status.' : `unknown mr command "${sub}".`);
  }
  if (rest.length !== 2) {
    throw new UsageError(`mr ${sub} needs <workspace> <ticket>.`);
  }
  const result = await request(`mr-${sub}`, checkJob(rest, `mr ${sub}`));
  const mr = result.mr as { number: number; url: string; state: string; reused?: boolean; merge_commit?: string | null } | undefined;
  const error = result.error as { code: string; message: string } | undefined;
  const lines: string[] = [`state: ${String(result.state)}`, `branch: ${String(result.branch)}`];
  if (sub === 'create') {
    if (typeof result.title === 'string') {
      lines.push(`title: ${result.title}`);
    }
    if (mr !== undefined) {
      lines.push(`merge request: #${mr.number} ${mr.reused === true ? 'already open, reused' : 'opened'}`, `url: ${mr.url}`);
    }
    if (error !== undefined) {
      lines.push(result.state === 'pushed'
        ? `The branch is pushed, but the merge request was not opened: ${error.code}: ${error.message}`
        : `The push failed: ${error.code}: ${error.message}`);
    }
  } else if (sub === 'merge' && mr !== undefined) {
    lines.push(`merge request: #${mr.number} merged`, ...(typeof mr.merge_commit === 'string' ? [`merge commit: ${mr.merge_commit}`] : []), `url: ${mr.url}`);
  } else if (sub === 'status') {
    const status = result.status as { number: number; url: string; state: string; draft: boolean; mergeable: boolean | null; reason?: string; checks?: string; merge_commit?: string };
    lines.push(
      `merge request: #${status.number} ${status.state}${status.draft ? ' (draft)' : ''}`,
      `url: ${status.url}`,
      ...(status.state === 'open' ? [`mergeable: ${status.mergeable === null ? 'not known yet' : status.mergeable ? 'yes' : 'no'}`] : []),
      ...(status.reason !== undefined && status.state === 'open' ? [`reason: ${status.reason}`] : []),
      ...(status.checks !== undefined ? [`checks: ${status.checks}`] : []),
      ...(status.merge_commit !== undefined ? [`merge commit: ${status.merge_commit}`] : []),
    );
  }
  console.log(lines.join('\n'));
  if (error !== undefined) {
    process.exitCode = 1;
  }
}

async function abort(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { discard: { type: 'boolean' } } });
  if (positionals.length !== 2) {
    throw new UsageError('abort needs <workspace> <ticket> [--discard].');
  }
  const result = await viaServer('abort', [...checkJob(positionals, 'abort'), ...(values.discard === true ? ['--discard'] : [])]);
  if (result.error !== undefined) {
    process.exitCode = 1;
  } else if (values.discard !== true) {
    console.log(result.worktree === null ? 'The branch is left as it is.' : `The branch and its worktree are left as they are: ${String(result.worktree)}`);
  }
}

async function reset(args: string[]): Promise<void> {
  if (args.length !== 2) {
    throw new UsageError('reset needs <workspace> <ticket>.');
  }
  const result = await viaServer('reset', checkJob(args, 'reset'));
  console.log(result.checkout === 'unavailable'
    ? 'The workspace is not registered (or its checkout is gone): only the job record was archived; nothing in Git was touched.'
    : 'The worktree is removed; the branch is untouched.');
}

// `sf run <workspace> <ticket>` (SF-042): the job's runner, started detached by sf serve. Runs the
// queued requests, the turns, the reviews and the gate of the job, notifies like sf serve, and
// ends when nothing is left to run; runner_running when the job has a runner already.
async function run(args: string[]): Promise<void> {
  if (args.length !== 2) {
    throw new UsageError('run needs <workspace> <ticket>.');
  }
  const [workspace, ticket] = checkJob(args, 'run');
  const config = loadConfig();
  const handbook = await loadHandbook();
  const jobs = new JobStore(config.stateDir);
  if ((await jobs.read(workspace, ticket)) === undefined) {
    throw new FactoryError('job_not_found', `There is no job for ${workspace}/${ticket}.`);
  }
  const notify = stateNotifier(notifyConfig(), jobs);
  const sending = new Set<Promise<void>>();
  const onStateChange: StateListener = (job, from, lines) => {
    const sent = notify(job, from, lines);
    sending.add(sent);
    void sent.finally(() => sending.delete(sent));
  };
  const execution = new Execution(config, (name) => resolveWorkspace(name), onStateChange, handbook.text, { runner: { workspace, ticket } });
  console.log(`${new Date().toISOString()} runner ${process.pid} for ${workspace}/${ticket} started`);
  await runJob(jobs.dir(workspace, ticket), execution, { settle: async () => void (await Promise.allSettled([...sending])) });
  console.log(`${new Date().toISOString()} runner ${process.pid} for ${workspace}/${ticket} ended`);
}

async function notifyTest(args: string[]): Promise<void> {
  if (args.length !== 0) {
    throw new UsageError('notify-test takes no arguments.');
  }
  const now = new Date().toISOString();
  const job: Job = {
    workspace: 'test', ticket: 'SF-TEST', branch: 'SF-TEST-notification', base: 'main', base_commit: null, worktree: null, prepared_commit: null,
    target_commit: null, mr_attempts: 0, fixes: 0, gate_fixes: 0, gate_tokens: 0, state: 'pushed', iteration: 0, session_id: null, mr: null, created_at: now, updated_at: now,
  };
  const results = await sendNotification(jobNotification(job, ['A test notification from sf notify-test']), notifyConfig());
  for (const result of results) {
    console.log(`${result.channel}: ${result.status} (${result.message})`);
  }
  if (results.some((result) => result.status === 'failed')) {
    process.exitCode = 1;
  }
}

// `sf info`: one screen with everything a person asks before the first command. Works without
// sf serve; what needs it says so.
async function info(args: string[]): Promise<void> {
  if (args.length !== 0) {
    throw new UsageError('info takes no arguments.');
  }
  const state = stateDir();
  const lines: string[] = [];
  const row = (name: string, value: string): void => {
    lines.push(`${name.padEnd(14)}${value}`);
  };
  row('version', `${SERVER_NAME} ${await packageVersion()}`);
  row('config', configDir());
  const envFile = envFilePath();
  row('env file', envFile === undefined ? 'off (SF_ENV_FILE is empty)' : `${envFile} (${existsSync(envFile) ? 'read' : 'absent'})`);
  row('state', state);
  row('mcp', `http://127.0.0.1:${parsePort('SF_PORT', DEFAULT_PORT)}/mcp (planning tools, loopback only)`);
  const token = dashboardOn() ? await readToken(state) : undefined;
  row('dashboard', !dashboardOn() ? 'off (SF_DASHBOARD=off)' : token === undefined ? 'no token yet (starts with sf serve)' : dashboardUrl(parsePort('SF_DASHBOARD_PORT', DEFAULT_DASHBOARD_PORT), token).href);
  row('model', process.env.SF_MODEL || 'Claude Code default');
  let gate: ReturnType<typeof gateConfig> | undefined;
  try {
    gate = gateConfig();
  } catch (error) {
    row('gate', `invalid: ${(error as Error).message}`);
  }
  if (gate?.on === true) {
    const version = await codexVersion(gate.codexPath);
    row('gate', `codex ${version === undefined ? gate.codexPath : `${version} (${gate.codexPath})`}`);
  } else if (gate !== undefined) {
    row('gate', `off (${gate.reason})`);
  }
  const notify = notifyConfig();
  row('notify', `ntfy ${notify.ntfyUrl === undefined ? 'off' : 'on'}, desktop ${notify.desktop ? 'on' : 'off'}, iterations ${notify.iterations ? 'on' : 'off'}`);
  // Whether the tokens are set, never their values; SF_GITLAB_URL as checked by forgeSettings (no
  // credentials, query or fragment), or its refusal, which never shows them either.
  const isSet = (name: string): string => (process.env[name] ? 'set' : 'not set');
  try {
    const { gitlabUrl } = forgeSettings();
    row('git hosts', `SF_GITHUB_TOKEN ${isSet('SF_GITHUB_TOKEN')}, SF_GITLAB_TOKEN ${isSet('SF_GITLAB_TOKEN')}${gitlabUrl !== undefined ? `, SF_GITLAB_URL ${gitlabUrl}` : ''}`);
  } catch (error) {
    row('git hosts', `invalid: ${(error as Error).message}`);
  }

  // sf serve answers on its socket; the tunnel on its health port.
  try {
    await callSocket(state, { command: 'ping', args: [] });
    row('serve', `running (${socketPath(state)})`);
  } catch {
    row('serve', 'not running (npm run serve)');
  }
  const health = process.env.SF_TUNNEL_HEALTH || '127.0.0.1:8790';
  try {
    const reply = await fetch(`http://${health}/readyz`, { signal: AbortSignal.timeout(1500) });
    row('tunnel', `${reply.ok ? 'ready' : `answers ${reply.status}`} (http://${health}/readyz)`);
  } catch {
    row('tunnel', 'not running (npm run tunnel)');
  }

  const registry = await loadRegistry();
  const names = Object.keys(registry.workspaces).sort();
  row('workspaces', names.length === 0 ? 'none (sf workspace add <name> --read <path>)' : '');
  for (const name of names) {
    const entry = registry.workspaces[name]!;
    lines.push(`  ${name}: ${entry.read_checkout}`);
  }
  console.log(lines.join('\n'));

  const jobs = new JobStore(state);
  const all = await jobs.list();
  console.log(`\njobs${all.length === 0 ? ': none' : ''}`);
  if (all.length > 0) {
    console.log(table(await statusRows(jobs, all, new Date())));
  }
}

function table(rows: StatusRow[]): string {
  const cells = [
    ['WORKSPACE', 'TICKET', 'STATE', 'ITER', 'BRANCH', 'SINCE', 'EST_USD', 'ELAPSED', 'ERROR'],
    ...rows.map(({ job, cost, elapsed, since }) => [job.workspace, job.ticket, job.state, String(job.iteration), job.branch, since, cost, elapsed, job.error?.code ?? '']),
  ];
  const widths = cells[0]!.map((_, column) => Math.max(...cells.map((row) => row[column]!.length)));
  return cells.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd()).join('\n');
}

async function status(args: string[]): Promise<void> {
  const jobs = new JobStore(stateDir());
  // One clock reading for every row.
  const now = new Date();
  if (args.length === 0) {
    const all = await jobs.list();
    console.log(all.length === 0 ? 'No jobs.' : table(await statusRows(jobs, all, now)));
    return;
  }
  if (args.length !== 2) {
    throw new UsageError('status takes no arguments or <workspace> <ticket>.');
  }
  const [workspace, ticket] = checkJob(args, 'status');
  const job = await jobs.read(workspace, ticket);
  if (job === undefined) {
    throw new FactoryError('job_not_found', `There is no job for ${workspace}/${ticket}.`);
  }
  console.log(table(await statusRows(jobs, [job], now)));
  if (job.error !== undefined) {
    console.log(`\n${job.error.code}: ${job.error.message}`);
  }
  if (job.worktree !== null) {
    console.log(`\nworktree: ${job.worktree}`);
  }
  // The sensitive and the deleted paths of the last published iteration (SF-024).
  if (job.iteration > 0) {
    try {
      const files = (await jobs.readMeta(workspace, ticket, job.iteration)).files ?? [];
      for (const line of fileSummaryLines(files)) {
        console.log(line);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

async function watch(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { once: { type: 'boolean' } } });
  if (positionals.length !== 2) {
    throw new UsageError('watch needs <workspace> <ticket>.');
  }
  const [workspace, ticket] = checkJob(positionals, 'watch');
  const jobs = new JobStore(stateDir());
  if ((await jobs.read(workspace, ticket)) === undefined) {
    throw new FactoryError('job_not_found', `There is no job for ${workspace}/${ticket}.`);
  }
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  await watchEvents(jobs.eventsPath(workspace, ticket), values.once !== true, (line) => console.log(line), abort.signal);
}

async function dashboardCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { open: { type: 'boolean' }, rotate: { type: 'boolean' } } });
  if (positionals.length !== 0) {
    throw new UsageError('dashboard takes no arguments (only --open and --rotate).');
  }
  if (!dashboardOn()) {
    throw new FactoryError('dashboard_off', 'The dashboard is off (SF_DASHBOARD=off).');
  }
  if (values.rotate === true) {
    // The running sf serve keeps its token in memory; the new one appears at the next start.
    await removeToken(stateDir());
    console.log('Dashboard token removed; the next sf serve start creates a new one and prints the new URL.');
    return;
  }
  const port = parsePort('SF_DASHBOARD_PORT', DEFAULT_DASHBOARD_PORT);
  const token = await readToken(stateDir());
  if (token === undefined) {
    throw new FactoryError('no_dashboard_token', 'There is no dashboard token: sf serve has not started with the dashboard on this state directory.');
  }
  const url = dashboardUrl(port, token).href;
  console.log(url);
  console.log('The token stays the same across sf serve starts; sf dashboard --rotate makes the next start pick a new one.');
  if (values.open === true) {
    // The URL is printed first so it can be opened by hand when the launcher fails.
    await openInBrowser(url);
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  // SF_* settings from the environment file (auth.env), for every command alike.
  loadEnvFile();
  if (command === 'start') {
    if (rest.length !== 2) {
      throw new UsageError('start needs <workspace> <ticket>.');
    }
    await viaServer('start', checkJob(rest, 'start'));
    return;
  }
  if (command === 'review') {
    if (rest.length !== 2) {
      throw new UsageError('review needs <workspace> <ticket>.');
    }
    await viaServer('review', checkJob(rest, 'review'));
    return;
  }
  if (command === 'accept') {
    if (rest.length !== 2) {
      throw new UsageError('accept needs <workspace> <ticket>.');
    }
    await viaServer('accept', checkJob(rest, 'accept'));
    return;
  }
  if (command === 'approve') {
    await approve(rest);
    return;
  }
  if (command === 'abort') {
    await abort(rest);
    return;
  }
  if (command === 'mr') {
    await mergeRequest(rest);
    return;
  }
  if (command === 'reset') {
    await reset(rest);
    return;
  }
  if (command === 'notify-test') {
    await notifyTest(rest);
    return;
  }
  if (command === 'info') {
    await info(rest);
    return;
  }
  if (command === 'say') {
    checkJob(rest, 'say');
    if (rest.length < 3) {
      throw new UsageError('say needs <workspace> <ticket> <message...>.');
    }
    await viaServer('say', rest);
    return;
  }
  if (command === 'status') {
    await status(rest);
    return;
  }
  if (command === 'watch') {
    await watch(rest);
    return;
  }
  if (command === 'dashboard') {
    await dashboardCommand(rest);
    return;
  }
  if (command === 'run') {
    await run(rest);
    // Nothing is left to wait for; an idle HTTP keep-alive of a notification must not hold the exit.
    process.exit(0);
  }
  if (command === 'serve' && rest.length === 0) {
    await serve();
    return;
  }
  if (command === 'up') {
    await up(rest);
    return;
  }
  if (command === 'workspace') {
    await workspace(rest);
    return;
  }
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    process.exit(command === undefined ? 2 : 0);
  }
  throw new UsageError(command === 'serve' ? 'serve takes no arguments.' : `unknown command "${command}".`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  // parseArgs reports unknown or malformed options with ERR_PARSE_ARGS_* codes.
  const code = (error as NodeJS.ErrnoException).code ?? '';
  if (error instanceof UsageError || code.startsWith('ERR_PARSE_ARGS')) {
    console.error(`sf: ${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (error instanceof PortInUseError) {
    console.error(`sf: ${error.message} Set SF_PORT to a free port.`);
  } else if (error instanceof FactoryError || (error instanceof Error && 'code' in error)) {
    console.error(`sf: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
