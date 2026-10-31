// Operator CLI of the SF-009 supervisor (scripts/sf009-executor.sh):
//
//   enable --app <app-id> --disposable-pilot [--protect <path>]... [--yes]
//                                                          the one-time opt-in for one disposable pilot app:
//                                                          binds its repository and the installed Claude Code.
//                                                          Without --disposable-pilot it is refused: no
//                                                          enforceable sandbox exists (policy.ts, Isolation)
//   enable --app <app-id> --self-hosting [--protect <path>]... [--yes]
//                                                          the separate self-hosting opt-in: the app whose
//                                                          APP_REPO is this Software Factory checkout works on
//                                                          it, beside your uncommitted work (kept out of its
//                                                          diffs). Operator-controlled and unconfined: no sandbox
//   disable [--app <app-id>]                               withdraws one app, or the whole opt-in (and the
//                                                          self-hosting opt-in with its app)
//   status [--app <id>] [--job <id>] [--all]               the policy (no salt), the supervisor and, per job: the
//                                                          actual repository, the processes, the iteration, the
//                                                          last activity and what it waits for (status.ts)
//   watch [--app <id>] [--job <id>] [--all] [--interval <s>]
//                                                          the same, refreshed until Ctrl+C; read-only
//   observe --app <id> --job <id> [--once]                 the job's managed Claude session as readable text
//                                                          (user/assistant text, tool calls and results): a
//                                                          recent history, then new records until Ctrl+C;
//                                                          read-only (observe.ts)
//   accept --app <app-id> --job <job-id> [--yes]           the operator's final acceptance of the current
//                                                          iteration, from this terminal (same as factory_accept_job)
//   run                                                    the supervisor in the foreground until SIGINT/SIGTERM
//   render-unit <new-dir>                                  writes a systemd user unit for the operator to install
//   probe-protocol --dir <empty-dir> [--overlap] [--yes]   Review 03 (R3-3): one real Claude Code process with
//                                                          the managed flags, two messages, through the session
//                                                          gate; prints the event shape (protocol-probe.ts).
//                                                          Operator-invoked only, never inside a managed session
//
// Nothing here installs, enables or starts a service, listens on a port or changes Claude Code
// settings. `run` launches only jobs that ChatGPT authorized through the bridge for an opted-in app.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SelfHostingGrant } from '../execution/app-config.js';
import { claudeInstallation, managedExecutionService } from '../execution/local-service.js';
import { ManagedClaudeRunner } from '../execution/runner.js';
import { defaultSessionGatePath, SessionGate } from '../execution/session-gate.js';
import type { ExecutionService } from '../execution/service.js';
import { resolveRepoRoot } from '../repo-files.js';
import { defaultStateHome, isCodedError, OperatorError } from '../operator/store.js';
import { FactoryJobs } from '../factory-jobs.js';
import { ExecutionGateway } from './gateway.js';
import { appIsolation, ExecutorState, policyRunnable, RUNNABLE_ISOLATIONS } from './policy.js';
import { readStatus, renderStatus } from './status.js';
import { observeTarget, runObserverProcess } from './observe.js';
import { probeCommand, probeRefusal, runProtocolProbe } from './protocol-probe.js';
import { Supervisor } from './supervisor.js';

// Compiled to bridge/dist/src/executor/main.js; the mediator is the checkout that contains it.
const MEDIATOR_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const USAGE =
  'usage: sf009-executor <enable --app <id> (--disposable-pilot | --self-hosting) [--protect <path>]... [--yes] | disable [--app <id>] | ' +
  'status [--app <id>] [--job <id>] [--all] | watch [--app <id>] [--job <id>] [--all] [--interval <s>] | observe --app <id> --job <id> [--once] | accept --app <id> --job <id> [--yes] | run | ' +
  'render-unit <new-dir> | probe-protocol --dir <empty-dir> [--overlap] [--yes]>';

interface Options {
  app?: string;
  job?: string;
  protect: string[];
  yes: boolean;
  disposablePilot: boolean;
  selfHosting: boolean;
  all: boolean;
  interval?: number;
  dir?: string;
  overlap: boolean;
  once: boolean;
  extra: string[];
}

function options(rest: string[]): Options {
  const parsed: Options = { protect: [], yes: false, disposablePilot: false, selfHosting: false, all: false, overlap: false, once: false, extra: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === '--app' && rest[index + 1] !== undefined) {
      parsed.app = rest[++index];
    } else if (arg === '--job' && rest[index + 1] !== undefined) {
      parsed.job = rest[++index];
    } else if (arg === '--protect' && rest[index + 1] !== undefined) {
      parsed.protect.push(resolve(rest[++index]!));
    } else if (arg === '--yes') {
      parsed.yes = true;
    } else if (arg === '--disposable-pilot') {
      parsed.disposablePilot = true;
    } else if (arg === '--self-hosting') {
      parsed.selfHosting = true;
    } else if (arg === '--all') {
      parsed.all = true;
    } else if (arg === '--interval' && /^[1-9][0-9]{0,3}$/.test(rest[index + 1] ?? '')) {
      parsed.interval = Number(rest[++index]);
    } else if (arg === '--dir' && rest[index + 1] !== undefined) {
      parsed.dir = rest[++index];
    } else if (arg === '--overlap') {
      parsed.overlap = true;
    } else if (arg === '--once') {
      parsed.once = true;
    } else {
      parsed.extra.push(arg);
    }
  }
  return parsed;
}

async function confirm(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

// The supervisor's service: Claude Code's login is probed afresh for each preflight; launches use
// the executable the operator opted in with, which must still be the installed one.
function supervisorService(
  mediatorRoot: string,
  executable: string,
  base: ExecutionService,
  selfHosting: () => Promise<SelfHostingGrant | undefined>,
): Pick<ExecutionService, 'preflight' | 'prepare' | 'runManaged' | 'status' | 'collect'> {
  return {
    status: (appId, jobId) => base.status(appId, jobId),
    collect: (appId, jobId, opts) => base.collect(appId, jobId, opts),
    prepare: (appId, jobId, expected) => base.prepare(appId, jobId, expected),
    runManaged: (appId, jobId, expected, drive) => base.runManaged(appId, jobId, expected, drive),
    preflight: async (appId, jobId) => managedExecutionService(mediatorRoot, await claudeInstallation(), executable, selfHosting).preflight(appId, jobId),
  };
}

// Claude Code's transcript directory: the default one (CLAUDE_CONFIG_DIR or ~/.claude).
const claudeProjectsDir = (): string => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');

// status and watch: read-only, see status.ts; `claude` itself is not run.
async function showStatus(mediatorRoot: string, state: ExecutorState, opts: Options, watch: boolean): Promise<number> {
  const projectsDir = claudeProjectsDir();
  const render = async () => renderStatus(await readStatus({ mediatorRoot, state, projectsDir, ...(opts.app ? { app: opts.app } : {}), ...(opts.job ? { job: opts.job } : {}), all: opts.all }));
  if (!watch) {
    process.stdout.write(await render());
    return 0;
  }
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const clear = process.stdout.isTTY === true ? '\x1b[2J\x1b[H' : '';
  while (!stopped) {
    process.stdout.write(`${clear}${await render()}\nRefreshing every ${opts.interval ?? 2} s; Ctrl+C stops watching (nothing else is affected).\n`);
    const until = Date.now() + (opts.interval ?? 2) * 1000;
    while (!stopped && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return 0;
}

// observe: read-only, see observe.ts. The private state is opened without creating anything;
// Ctrl+C (or SIGTERM) ends only this process, within a bound even if its output cannot drain.
async function observeJob(mediatorRoot: string, opts: Options): Promise<number> {
  if (opts.app === undefined || opts.job === undefined) {
    console.error(USAGE);
    return 2;
  }
  const app = opts.app;
  const job = opts.job;
  const state = await ExecutorState.openExisting(defaultStateHome(), mediatorRoot);
  const projectsDir = claudeProjectsDir();
  return runObserverProcess({
    resolve: async () => observeTarget(app, job, await readStatus({ mediatorRoot, state, projectsDir, app, job })),
    projectsDir,
    once: opts.once,
  });
}

// The final acceptance from the operator's terminal: shows what is accepted, then writes the same
// bound acceptance request the MCP tool writes. The supervisor validates it the same way.
async function accept(mediatorRoot: string, opts: { app?: string; job?: string; yes: boolean }): Promise<number> {
  if (opts.app === undefined || opts.job === undefined) {
    console.error(USAGE);
    return 2;
  }
  const gateway = new ExecutionGateway(new FactoryJobs(mediatorRoot), mediatorRoot);
  const status = await gateway.status(opts.app, opts.job);
  const iteration = status.job?.iterations.find((entry) => entry.id === status.job?.current_iteration);
  if (status.job === null || iteration?.snapshot_sha256 == null || iteration.state !== 'ready_for_review') {
    console.log(`${opts.app}/${opts.job} is ${status.status}; there is no snapshot ready to accept. Nothing was done.`);
    return 1;
  }
  console.log(`Accept ${opts.app}/${opts.job} ${iteration.id} (snapshot sha256 ${iteration.snapshot_sha256})?`);
  console.log('The supervisor then ends the Claude session and collects the results. Nothing is staged, committed or pushed.');
  if (!opts.yes && !(await confirm('Accept?'))) {
    console.log('Nothing was accepted.');
    return 1;
  }
  const result = await gateway.accept({ app_id: opts.app, job_id: opts.job, iteration_id: iteration.id, snapshot_sha256: iteration.snapshot_sha256, acceptance_id: randomUUID() });
  console.log(`acceptance ${result.acceptance_id} ${result.status}; the supervisor closes the job when it has validated it.`);
  return 0;
}

async function renderUnit(mediatorRoot: string, target: string | undefined): Promise<number> {
  if (target === undefined) {
    console.error('usage: sf009-executor render-unit <new-directory>');
    return 2;
  }
  const root = mediatorRoot.replace(/\/$/, '');
  if (!SAFE_PATH.test(root) || !SAFE_PATH.test(process.execPath)) {
    console.error('The mediator or node path contains characters that need quoting in a unit file; write the unit by hand.');
    return 1;
  }
  const dir = resolve(target);
  await mkdir(dir, { mode: 0o755 });
  let text = await readFile(join(root, 'deploy', 'executor', 'sf009-supervisor.service.in'), 'utf8');
  for (const [key, value] of Object.entries({ '@MEDIATOR@': root, '@NODE@': process.execPath })) text = text.replaceAll(key, value);
  await writeFile(join(dir, 'sf009-supervisor.service'), text, { mode: 0o644, flag: 'wx' });
  console.log(`wrote ${join(dir, 'sf009-supervisor.service')}`);
  console.log('Nothing was installed or enabled. See docs/runbooks/SF-009-autonomous-session-loop.md, "One-time setup".');
  return 0;
}

// Review 03 (R3-3): the operator's live protocol probe. It starts one real Claude Code process (it
// uses the operator's Claude Code login like any session), so it asks first.
async function probe(opts: Options): Promise<number> {
  if (opts.dir === undefined) {
    console.error(USAGE);
    return 2;
  }
  const refusal = await probeRefusal(opts.dir);
  if (refusal !== null) throw new OperatorError('not_ready', `Protocol probe ${refusal}. Nothing was started.`);
  const claude = await claudeInstallation();
  if (claude.executable === undefined || claude.version === 'unknown') throw new OperatorError('not_ready', 'Claude Code is not installed or its version cannot be read.');
  console.error(`This starts one Claude Code ${claude.version} process in --permission-mode auto in the empty directory given, through the`);
  console.error('Software Factory session gate (refused while another session holds it), sends two short messages asking for a');
  console.error('one-word reply and no tool use, and prints the event shape only (no text, prompt, transcript, stderr or path).');
  if (!opts.yes && !(await confirm('Run the probe?'))) {
    console.error('Nothing was started.');
    return 1;
  }
  const runner = new ManagedClaudeRunner(claude.executable, claude.version, new SessionGate(defaultSessionGatePath()));
  const dir = opts.dir;
  // 0 PASS, 3 FAIL; 4 (exits at once, gate left to the process) when the process was not shown to end,
  // or when the probe threw launch_unconfirmed or gate_unresponsive (Review 05).
  return probeCommand(() => runProtocolProbe(runner, dir, { mode: opts.overlap ? 'overlap' : 'sequential' }));
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const mediatorRoot = await resolveRepoRoot(MEDIATOR_ROOT);
  if (command === 'render-unit') return renderUnit(mediatorRoot, rest[0]);
  const opts = options(rest);
  if (opts.extra.length > 0 || command === undefined || !['enable', 'disable', 'status', 'watch', 'observe', 'accept', 'run', 'probe-protocol'].includes(command) || (opts.once && command !== 'observe')) {
    console.error(USAGE);
    return 2;
  }
  if (command === 'accept') return accept(mediatorRoot, opts);
  if (command === 'probe-protocol') return probe(opts);
  if (command === 'observe') {
    return observeJob(mediatorRoot, opts);
  }
  const state = await ExecutorState.open(defaultStateHome(), mediatorRoot);
  if (command === 'enable') {
    if (opts.app === undefined) {
      console.error(USAGE);
      return 2;
    }
    if (opts.disposablePilot === opts.selfHosting) {
      throw new OperatorError(
        'unsupported_isolation',
        'Production automatic execution is not supported: no enforceable OS sandbox confines the session (files, credentials, Git, network). Enable either a disposable pilot app (--disposable-pilot) or the self-hosting app (--self-hosting), exactly one. Nothing was enabled.',
      );
    }
    const claude = await claudeInstallation();
    if (claude.executable === undefined || claude.version === 'unknown') throw new OperatorError('not_ready', 'Claude Code is not installed or its version cannot be read.');
    if (opts.selfHosting) {
      console.log(`Opt in to SELF-HOSTING for app ${opts.app}: Software Factory works on its own checkout,`);
      console.log(`  ${mediatorRoot}`);
      console.log(`- Jobs that ChatGPT authorizes for ${opts.app} start without a console approval, one at a time, with`);
      console.log(`  Claude Code ${claude.version} in --permission-mode auto, in THIS checkout: the one you work in.`);
      console.log('- Your uncommitted changes stay where they are. Each job records a baseline of them (content hashes,');
      console.log('  no copies) and launches only if the tree still matches it; its diffs leave unchanged existing work out');
      console.log('  and name what the session changed, reverted or removed. Do not edit this checkout while a job runs.');
      console.log('- This is operator-controlled and UNCONFINED, not a sandbox and not a disposable pilot: the session runs');
      console.log('  as you and can read and write whatever you can, including this checkout\'s factory-data/, bridge/dist/');
      console.log('  and the supervisor\'s own source. A job\'s build or source change takes effect only when you restart');
      console.log('  the supervisor or the bridge yourself; nothing restarts or reloads them.');
      console.log('- Nothing is staged, committed or pushed. Final acceptance closes a job; Git stays yours.');
      if (!opts.yes && !(await confirm('Enable self-hosting?'))) {
        console.log('Nothing was enabled.');
        return 1;
      }
      const policy = await state.enable(opts.app, { executable: claude.executable, version: claude.version }, opts.protect, new Date(), 'self_hosting_unconfined');
      console.log(`enabled self-hosting for ${opts.app} (policy epoch ${policy.epoch}). The supervisor is not started or reloaded by this.`);
      return 0;
    }
    console.log(`Opt in to automatic execution for app ${opts.app}, as a DISPOSABLE PILOT:`);
    console.log(`- Jobs that ChatGPT authorizes for ${opts.app} through the bridge start without a console approval,`);
    console.log(`  one at a time, with Claude Code ${claude.version} in --permission-mode auto (never bypassPermissions).`);
    console.log('- Claude Code\'s auto mode decides tool calls; what it refuses is reported, never approved for it.');
    console.log('- This is not a sandbox: the session runs as you and can read and write whatever you can (other checkouts,');
    console.log('  credentials, ~/.ssh, Git remotes, the network). The --disallowedTools rules match command prefixes only; Git,');
    console.log('  scope and export checks run at every turn end and detect some effects after they happened, never before.');
    console.log(`- By enabling you declare ${opts.app} a disposable checkout, on a host session that exposes no real credentials`);
    console.log('  and no other writable checkout. Never enable a real application this way.');
    console.log('- Nothing is staged, committed or pushed. Final acceptance closes a job; Git stays yours.');
    if (!opts.yes && !(await confirm('Enable?'))) {
      console.log('Nothing was enabled.');
      return 1;
    }
    const policy = await state.enable(opts.app, { executable: claude.executable, version: claude.version }, opts.protect, new Date(), 'disposable_pilot');
    console.log(`enabled ${opts.app} (policy epoch ${policy.epoch}). Start the supervisor with: scripts/sf009-executor.sh run`);
    return 0;
  }
  if (command === 'disable') {
    const policy = await state.disable(opts.app);
    console.log(policy === undefined ? 'Nothing was enabled.' : `disabled ${opts.app ?? 'automatic execution'} (policy epoch ${policy.epoch}).`);
    return 0;
  }
  const policy = await state.policy();
  if (command === 'watch') {
    return showStatus(mediatorRoot, state, opts, true);
  }
  if (command === 'status') {
    if (policy === undefined) {
      console.log('Automatic execution: not enabled (no opt-in).');
    } else {
      console.log(`Automatic execution: ${policy.enabled ? 'enabled' : 'disabled'}${policyRunnable(policy) || !policy.enabled ? '' : ' (last change incomplete: not runnable; run enable or disable again)'}, policy epoch ${policy.epoch}, Claude Code ${policy.claude.version}`);
      for (const appId of Object.keys(policy.apps).sort()) {
        const isolation = appIsolation(policy.apps[appId]);
        const note = RUNNABLE_ISOLATIONS.includes(isolation) ? '' : ' (refused: no enforceable sandbox; enable again with --disposable-pilot or --self-hosting)';
        console.log(`  app ${appId}: permission mode ${policy.apps[appId]!.permission_mode}, isolation ${isolation}${note}`);
      }
      console.log(`  protected checkouts: ${policy.protected_paths.length}`);
    }
    console.log('');
    return showStatus(mediatorRoot, state, opts, false);
  }
  // run
  if (policy === undefined || !policy.enabled) throw new OperatorError('not_ready', 'Automatic execution is not enabled; run enable first. Nothing was started.');
  if (!policyRunnable(policy)) {
    throw new OperatorError('not_ready', 'The last enable or disable did not complete; run it again. Nothing was started.');
  }
  const claude = await claudeInstallation();
  if (claude.executable !== policy.claude.executable || claude.version !== policy.claude.version) {
    throw new OperatorError('not_ready', `The installed Claude Code (${claude.version}) is not the one opted in (${policy.claude.version}); run enable again to confirm it. Nothing was started.`);
  }
  const selfHosting = () => state.selfHostingGrant();
  const base = managedExecutionService(mediatorRoot, claude, policy.claude.executable, selfHosting);
  const supervisor = await Supervisor.start({
    mediatorRoot,
    stateHome: defaultStateHome(),
    service: supervisorService(mediatorRoot, policy.claude.executable, base, selfHosting),
    log: (line) => console.log(`sf009-supervisor: ${line}`),
  });
  const stop = () => void supervisor.stop();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log(`sf009-supervisor: running (policy epoch ${policy.epoch}); Ctrl+C stops it and ends an active session.`);
  try {
    await supervisor.run();
  } finally {
    await supervisor.close();
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Only the adapter's own messages are printed; others may carry host paths.
    console.error(`sf009-executor: ${isCodedError(error) ? `${error.code}: ${error.message}` : `unexpected ${(error as Error).name ?? 'error'}`}`);
    process.exitCode = 1;
  },
);
