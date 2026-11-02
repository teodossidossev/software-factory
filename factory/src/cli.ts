// The sf command: `sf serve`, `sf workspace add|list|remove`, `sf start|say|approve|abort|reset`
// (through the socket of sf serve), `sf status|watch|dashboard` (reading the state directory
// directly) and `sf notify-test`.
// Exit codes: 0 ok, 1 error, 2 usage.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openInBrowser } from './browser.js';
import { loadConfig, stateDir } from './config.js';
import { DEFAULT_DASHBOARD_PORT, dashboardUrl, readToken, removeToken, type RunningDashboard, startDashboard } from './dashboard.js';
import { FactoryError } from './errors.js';
import { Execution, type StateListener } from './execution.js';
import { callSocket, listenSocket } from './ipc.js';
import { type Job, JobStore } from './jobs.js';
import { jobNotification, notifyConfig, sendNotification, stateNotifier } from './notify.js';
import { loadRegistry, resolveWorkspace, saveRegistry, verifyCheckout, WORKSPACE_NAME_DESCRIPTION, WORKSPACE_NAME_PATTERN } from './registry.js';
import { loadHandbook, packageVersion, PortInUseError, SERVER_NAME, startServer } from './server.js';
import { type StatusRow, statusRows } from './status.js';
import { TICKET_DESCRIPTION, TICKET_PATTERN } from './task-file.js';
import { watchEvents } from './watch.js';

const DEFAULT_PORT = 8787;
const USAGE = `Usage:
  sf serve                                              Serve the MCP tools on 127.0.0.1:\${SF_PORT:-${DEFAULT_PORT}}/mcp and the dashboard
  sf dashboard [--open]                                 Print the dashboard URL of the running sf serve; --open also opens it (xdg-open)
  sf workspace add <name> --read <path> [--work <path>] Register a workspace (--work defaults to --read)
  sf workspace list                                     List registered workspaces
  sf workspace remove <name>                            Unregister a workspace
  sf start <workspace> <ticket>                         Start the job for .software-factory/<ticket>.md
  sf say <workspace> <ticket> <message...>              Send a message into the job's Implementer session
  sf status [<workspace> <ticket>]                      Show one job or all jobs: state, iterations, recorded cost, elapsed time
  sf watch <workspace> <ticket> [--once]                Show the session live (Ctrl+C stops)
  sf approve <workspace> <ticket>                       MR preparation: commit, rebase, verify, push
  sf abort <workspace> <ticket> [--discard]             End the job; --discard also removes the branch and its changes
  sf reset <workspace> <ticket>                         End the session and archive the job; Git is not touched
  sf notify-test                                        Send a test notification on every channel

Notes:
  COST_USD: cost_usd of the published iterations summed, four decimals; 0.0000 before the first one, unknown when one has no usable cost.
            A running iteration or MR preparation adds nothing until its iteration is published.
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

async function serve(): Promise<void> {
  const port = parsePort('SF_PORT', DEFAULT_PORT);
  const dashboardPort = parsePort('SF_DASHBOARD_PORT', DEFAULT_DASHBOARD_PORT);
  const config = loadConfig();
  const handbook = await loadHandbook();
  // Fail at startup on an invalid registry rather than on the first tool call.
  await loadRegistry();
  const jobs = new JobStore(config.stateDir);
  const notify = stateNotifier(notifyConfig(), jobs);
  // The dashboard starts after recovery; until then its listener is a no-op.
  let dashboard: RunningDashboard | undefined;
  const onStateChange: StateListener = (job, from, lines) => {
    notify(job, from, lines);
    dashboard?.onStateChange(job, from);
  };
  const execution = new Execution(config, (name) => resolveWorkspace(name), onStateChange, handbook.text);
  // The socket first: it refuses a second sf serve on the same state before recovery touches it.
  const socket = await listenSocket(config.stateDir, async ({ command, args }) => {
    const [workspace = '', ticket = '', ...words] = args;
    if (command === 'start' && words.length === 0) {
      return execution.start(workspace, ticket);
    }
    if (command === 'say') {
      return execution.say(workspace, ticket, words.join(' '));
    }
    if (command === 'approve' && words.length === 0) {
      return execution.approve(workspace, ticket);
    }
    if (command === 'abort' && (words.length === 0 || (words.length === 1 && words[0] === '--discard'))) {
      return execution.abort(workspace, ticket, words.length === 1);
    }
    if (command === 'reset' && words.length === 0) {
      return execution.reset(workspace, ticket);
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
      dashboard = await startDashboard(dashboardPort, config.stateDir, jobs);
    } else {
      await removeToken(config.stateDir);
    }
  } catch (error) {
    await Promise.all([server.close(), socket.close()]);
    throw error;
  }
  console.log(dashboard !== undefined ? `${SERVER_NAME} dashboard ${dashboard.url.href}` : `${SERVER_NAME} dashboard off (SF_DASHBOARD=off)`);
  console.log(`${SERVER_NAME} listening on ${server.url.href}`);
  console.log(`${SERVER_NAME} socket ${socket.path}`);

  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`${SERVER_NAME} received ${signal}, shutting down`);
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
      console.log(`${name}\n  read: ${entry.read_checkout}\n  work: ${entry.work_checkout}`);
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
    const work = (values.work as string | undefined) ?? read;
    const registry = await loadRegistry();
    if (Object.hasOwn(registry.workspaces, name)) {
      throw new FactoryError('workspace_exists', `workspace "${name}" is already registered; remove it first.`);
    }
    const entry = { read_checkout: await checkout(read, '--read'), work_checkout: await checkout(work, '--work') };
    registry.workspaces[name] = entry;
    await saveRegistry(registry);
    console.log(`Registered workspace "${name}" (read: ${entry.read_checkout}, work: ${entry.work_checkout}).`);
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

async function viaServer(command: string, args: string[]): Promise<Record<string, unknown>> {
  const response = await callSocket(stateDir(), { command, args });
  if (!response.ok) {
    throw new FactoryError(response.error.code, response.error.message);
  }
  const result = response.result as Record<string, unknown>;
  const show = (value: unknown): string => (typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value));
  console.log(Object.entries(result).map(([key, value]) => `${key}: ${show(value)}`).join('\n'));
  return result;
}

async function approve(args: string[]): Promise<void> {
  if (args.length !== 2) {
    throw new UsageError('approve needs <workspace> <ticket>.');
  }
  console.log('MR preparation started; waiting for it to end (Ctrl+C stops waiting, not the preparation; sf watch shows it).');
  const result = await viaServer('approve', checkJob(args, 'approve'));
  if (result.state === 'awaiting_review') {
    console.log('The prepared commit differs from the reviewed change; it went back to the Context owner. Run sf approve again after Clean.');
  } else if (result.state === 'needs_human') {
    console.log('Fix it with sf say or by hand, then run sf approve again.');
  } else if (result.state === 'pushed' && result.link === undefined) {
    console.log('No merge request link: the origin URL could not be parsed. Open the merge request for the branch above.');
  }
  if (result.state !== 'pushed') {
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
    console.log('The branch and the files are left as they are.');
  }
}

async function reset(args: string[]): Promise<void> {
  if (args.length !== 2) {
    throw new UsageError('reset needs <workspace> <ticket>.');
  }
  await viaServer('reset', checkJob(args, 'reset'));
  console.log('The branch and the files in the work checkout are untouched.');
}

async function notifyTest(args: string[]): Promise<void> {
  if (args.length !== 0) {
    throw new UsageError('notify-test takes no arguments.');
  }
  const now = new Date().toISOString();
  const job: Job = {
    workspace: 'test', ticket: 'SF-TEST', branch: 'SF-TEST-notification', base: 'main', base_commit: null,
    target_commit: null, mr_attempts: 0, state: 'pushed', iteration: 0, session_id: null, created_at: now, updated_at: now,
  };
  const results = await sendNotification(jobNotification(job, ['A test notification from sf notify-test']), notifyConfig());
  for (const result of results) {
    console.log(`${result.channel}: ${result.status} (${result.message})`);
  }
  if (results.some((result) => result.status === 'failed')) {
    process.exitCode = 1;
  }
}

function table(rows: StatusRow[]): string {
  const cells = [
    ['WORKSPACE', 'TICKET', 'STATE', 'ITER', 'BRANCH', 'SINCE', 'COST_USD', 'ELAPSED', 'ERROR'],
    ...rows.map(({ job, cost, elapsed }) => [job.workspace, job.ticket, job.state, String(job.iteration), job.branch, job.updated_at, cost, elapsed, job.error?.code ?? '']),
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
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { open: { type: 'boolean' } } });
  if (positionals.length !== 0) {
    throw new UsageError('dashboard takes no arguments (only --open).');
  }
  if (!dashboardOn()) {
    throw new FactoryError('dashboard_off', 'The dashboard is off (SF_DASHBOARD=off).');
  }
  const port = parsePort('SF_DASHBOARD_PORT', DEFAULT_DASHBOARD_PORT);
  const token = await readToken(stateDir());
  if (token === undefined) {
    throw new FactoryError('no_dashboard_token', 'There is no dashboard token: sf serve has not started with the dashboard on this state directory.');
  }
  const url = dashboardUrl(port, token).href;
  console.log(url);
  console.log('The token changes on every sf serve start; the URL works while that sf serve runs.');
  if (values.open === true) {
    // The URL is printed first so it can be opened by hand when the launcher fails.
    await openInBrowser(url);
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === 'start') {
    if (rest.length !== 2) {
      throw new UsageError('start needs <workspace> <ticket>.');
    }
    await viaServer('start', checkJob(rest, 'start'));
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
  if (command === 'reset') {
    await reset(rest);
    return;
  }
  if (command === 'notify-test') {
    await notifyTest(rest);
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
  if (command === 'serve' && rest.length === 0) {
    await serve();
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
