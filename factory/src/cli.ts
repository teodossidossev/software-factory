// The sf command. The commands that go to sf serve over its socket (start, say, the queue, the
// merge request, pause, ...) are the table of src/commands.ts: checked, sent and shown here by it.
// The others run here: `sf serve`, `sf up` (serve, the tunnel and the browser), `sf workspace
// add|list|remove`, `sf status|watch|dashboard` (reading the state directory directly), `sf
// check-task` (a Task check, run here and stored in the state directory), `sf rules`
// (the coding rules, read here), `sf notify-test`, `sf info`, `sf metrics` (the gate's
// cost and yield, reading the state directory directly), `sf smoke` (the live smoke test,
// src/live-smoke.ts: its own sf processes on a throwaway repository and state) and `sf
// run`, the job's runner that sf serve starts (src/runner.ts), and `sf digest [--now]`
// (the morning digest, through the socket of sf serve), `sf service` (sf serve as a systemd user
// service, src/service.ts) and `sf update` (the install updated, drained first, src/update.ts) and
// `sf guard` (the guard, src/guard.ts: run here, no sf serve needed; `sf guard install-hook` writes the pre-push hook)
// and `sf planner setup` (a workspace's planning copy for Claude Code, src/planning-copy.ts: no sf serve needed).
// Exit codes: 0 ok, 1 error, 2 usage.
import { spawn } from 'node:child_process';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { open, readFile, realpath } from 'node:fs/promises';
import { addAttachment, checkSize, removeAttachment } from './attachments.js';
import { openInBrowser } from './browser.js';
import { type Config, DEFAULT_TEST_TIMEOUT_MS, envFilePath, gateConfig, gateLevelSetting, handoffSetting, healthSetting, keepAwakeSetting, loadConfig, loadEnvFile, planningDir, rulesMaxBytes, stateDir, tunnelSetting } from './config.js';
import { DigestStore, Digests } from './digest-run.js';
import { DigestSchedule } from './digest-schedule.js';
import {
  checkDashboardPorts, DEFAULT_DASHBOARD_PORT, DEFAULT_DASHBOARD_REMOTE_PORT, dashboardRemoteLogins, dashboardRemoteOrigins, dashboardUrl, readToken, remoteDashboardUrls, removeToken,
  type RunningDashboard, startDashboard,
} from './dashboard.js';
import { FactoryError } from './errors.js';
import { currentExplanation, Explainer, explanationLines } from './explain.js';
import { Execution, type ExecutionOptions, MERGED_EVERY_MS, MERGED_FIRST_MS, type Retired, type StateListener } from './execution.js';
import { checkForgeToken, chooseForge, forgeSettings } from './forge.js';
import { codexVersion } from './gate.js';
import { checkTerms, commitsToCheck, type CommitSpec, type GuardHit, hitReport, installHook, scanBranch, scanChange, scanCommits, scanMrText, worktreeTree } from './guard.js';
import { existsSync } from 'node:fs';
import { writeFileAtomic } from './atomic.js';
import { callSocket, listenSocket, socketPath } from './ipc.js';
import { type Job, type JobState, JobStore } from './jobs.js';
import { localTime } from './local-time.js';
import { collectMetrics, metricsLines } from './metrics.js';
import { QueueStore, RunQueue } from './queue.js';
import { followJobs, lockPath, runJob } from './runner.js';
import { applyNetDefaults } from './net-defaults.js';
import { notifyConfig, notifyTaskCheck, sendNotification, stateNotifier, testNotification } from './notify.js';
import {
  checkLabel, configDir, HANDOFF_MODES, ignoredWorkCheckouts, isHandoffMode, isNotifyMode, isWorkspaceColor, loadRegistry, resolveWorkspace, saveRegistry, setWorkspaceAutoPlanner, setWorkspaceNotify, verifyCheckout,
  WORKSPACE_COLORS, workspaceColor, type WorkspaceEntry, workspaceNotify, workspaceNotifyMode,
} from './registry.js';
import {
  ensureMcpToken, keepProfilePrivate, loadHandbook, mcpBaseUrl, mcpUrl, packageVersion, probeMcp, profileHasUrl, readMcpToken, redactMcpToken, requireMcpToken,
  replaceMcpToken, rewriteProfileUrl, SERVER_NAME, startServer, TOKEN_LABEL,
} from './server.js';
import { Setup } from './setup.js';
import { handoverLines, limitLine, type StatusRow, statusRows } from './status.js';
import { fileSummaryLines } from './patch.js';
import { prepareTaskChecksDir } from './sandbox-denials.js';
import { planWarning, serveSkills } from './skills.js';
import { factoryRoots, OrphanWatch, reapOrphanedSandboxes } from './sandbox-reaper.js';
import { reapThenScan, upkeep } from './recovery.js';
import { KEEP_AWAKE_COMMAND, KEEP_AWAKE_EVERY_MS, KeepAwake } from './keep-awake.js';
import { TunnelChild, tunnelHealthAddress, tunnelProfile, tunnelScript } from './tunnel.js';
import {
  fetchText, forgeTargets, freeSpace, type HealthDeps, healthExitCode, healthLines, httpAnswers, type QueueFacts, runChecks, runCheckCommand,
} from './health.js';
import { liveOwner } from './pid-lock.js';
import { type CheckRecord, CheckStore, checkLines, checkSettings, recordVerdict, refuseDraft, runTaskCheck, TaskChecks } from './task-check.js';
import { AutoChecks, planCheck } from './task-check-auto.js';
import { TicketHistory } from './ticket-history.js';
import { parseFrontMatter, readTask, TASK_DIR, TICKET_DESCRIPTION, TICKET_PATTERN } from './task-file.js';
import { type TestHooks, testHooks } from './test-hooks.js';
import { gitToplevel, runGit } from './git.js';
import { originUrl, resolveTarget } from './mr.js';
import { taskStartBranch } from './continues.js';
import { collectRules, readJobRulesList, rulesLines } from './rules-docs.js';
import { turnLimitLine } from './turn-limit.js';
import { watchEvents } from './watch.js';
import { DEFAULT_BUDGET_USD, DEFAULT_TIMEOUT_MIN, positiveDecimal, runSmoke } from './live-smoke.js';
import { INSTALLED_SF, serviceCommand, updateService } from './service.js';
import { isPlannerWaiting, PLANNER_USAGE, plannerCommand, plannerWaitingCommand } from './planning-copy.js';
import { plannerSession, startPlanner, stopPlanner } from './planner-session.js';
import { prototypesRoot } from './prototypes.js';
import { watchdog } from './watchdog.js';
import { checkStateVersion } from './state-version.js';
import { answerLines, checkArgs, checkJob, checkName, cliCommand, type Command, COMMANDS, socketName, UsageError, usageLines } from './commands.js';
import { socketHandler } from './ipc-handlers.js';
import { endRequestWaits } from './coordinator.js';
import {
  MARKER_POLL_MS, markerAtServeStart, markerLines, MarkerWatch, putMarkerBack, readSkippedChecks, recordSkippedCheck, refuseWhileUpdating, removeSkippedChecks, runCommand, runUpdate, updateMarked,
} from './update.js';

const DEFAULT_PORT = 8787;
const USAGE = `Usage:
  sf serve                                              Serve the MCP tools on 127.0.0.1:\${SF_PORT:-${DEFAULT_PORT}}/mcp/<token> and the dashboard; the token (mcp-token in the state directory) is made on the first start; with SF_TUNNEL=auto (the default) and a tunnel profile, the ChatGPT tunnel (scripts/sf-tunnel.sh run) as its child, restarted by the health checks
  sf mcp-url [--header|--rotate|--port]                 Print the MCP URL with its token, for an MCP client (claude mcp add --transport http software-factory <url>); --header: the URL without it and the Authorization header; --rotate: a new token (sf serve takes it at once; restart the tunnel); --port: the port only
  sf mcp-url --write-profile|--check-profile <file>     The tunnel's steps (scripts/sf-tunnel.sh): set the profile's MCP url line to the URL with the token, or check that it is (exit 1 when not)
  sf mcp-url --redact|--probe                           The tunnel's steps: copy stdin to stdout with the token shown as <token>; send an MCP initialize with the token (exit 0 answers, 1 refused, 2 not reachable)
  sf up [--no-open] [--no-tunnel]                       sf serve (with its tunnel; --no-tunnel: SF_TUNNEL=off) in one terminal, and open the dashboard; Ctrl+C stops both
  sf dashboard [--open] [--rotate]                      Print the dashboard URL; --open also opens it (xdg-open); --rotate removes the token so the next sf serve makes a new one
  sf workspace add <name> --read <path> [--handoff checkout|off] [--color <name>] [--label <text>]  Register a workspace: the local checkout (every job works in a worktree of it); --handoff: its own hand-over setting, over SF_HANDOFF; --color: its colour on the board (blue, teal, green, olive, orange, red, purple or grey; default: by its name); --label: what its cards on the dashboard show instead of its name (one line, at most 24 characters; "" removes it). Again with the same path: changes the --handoff, --color and --label given
  sf workspace list                                     List registered workspaces, their hand-over setting and colour, their label when they have one, their notify setting when it is not full, and auto-planner: on when it is on
  sf workspace notify <name> full|brief|off             How much the notifications of the workspace's jobs and Task checks tell: full (the default); brief, ntfy gets the title and one line (the workspace and an error's code; a plan not ready keeps its counts; the desktop stays full); off, none. Applies to the next notification
  sf workspace auto-planner <name> on|off               Whether New ticket on the dashboard, for Claude Code, starts the ticket's planner session once its images are stored (as Create & plan); off (the default) leaves the start to you
  sf workspace remove <name>                            Unregister a workspace
  sf check-task <workspace> <ticket>                    Check the Task file before Start: a read-only Claude session reads it and the repository, and prints its paraphrase, its findings by severity and its verdict (stored by the Task file's sha256; it only advises). sf serve checks a written Task file by itself 60 s after its last change (SF_TASK_CHECK_AUTO)
  sf rules <workspace> [ticket]                         List the coding rules the agents would be given (AGENTS.md and the Markdown files it links to, the user's rules files): paths, sources, sizes and the files left out, without their text; a started job's stored list, else read at the Task file's base, else at the checkout's HEAD
  sf attach <workspace> <ticket> <file> [name]          Attach an image (PNG, JPEG, WebP or GIF by its bytes, at most 5 MB, 10 per ticket) to the ticket: .software-factory/<ticket>/<name> next to its Task file; name: default the next number (1.png, 2.png, ...); refused while a job of the ticket runs (paused aside); no sf serve needed
  sf attach <workspace> <ticket> --remove <name>        Remove an image of the ticket, under the same guard
${usageLines().join('\n')}
  sf status [<workspace> <ticket>]                      Show one job or all jobs: state, iterations, estimated cost, elapsed time; both show the dashboard's full URL once sf serve made its token
  sf watch <workspace> <ticket> [--once]                Show the session live (Ctrl+C stops)
  sf digest [--now]                                     The morning digest of the followed workspaces (sf serve makes one at each of digest.times in workspaces.json, up to 4 a day): without --now, the latest digest's period and counts; --now makes one at once and prints the path of its record and its cost
  sf explain <workspace> <ticket>                       The plain explanation of the job's current stop (sf serve writes one for each needs_human stop; explain in workspaces.json): the headline, the explanation, the choices and the recommendation; no sf serve needed, no model call
  sf notify-test                                        Send a test notification on every channel
  sf info                                               Version, directories, settings, whether sf serve and the tunnel run, workspaces, jobs
  sf health [--json | --notify [--force]]               The health checks, computed here once without sf serve (MCP endpoint, tunnel, the tunnel's sf build, jobs, run queue, remote dashboard, logins, disk, sandbox leftovers, digest): one row each; --json the list; exit 0 all ok or off, 3 any recovering, 1 any down. --notify: the watchdog the service's timer runs: only the MCP endpoint and the service's systemd state, one notification when sf serve stops answering and one when it answers again; --force (the alert unit) sends the down one anyway; exit 1 only when the notification could not be sent
  sf guard <workspace> [<rev> | <a>..<b>] [--remote <name>] [--branch <name>] [--mr <ticket>] [--worktree <ticket>] [--history]  The guard: check what a push of <rev> (default HEAD) to --remote (default origin) would publish, the commits of a range, or with --history every commit reachable from <rev>: messages, added lines and new file paths (never authors or committers); --branch adds a branch name, --mr a job's MR text and branch, --worktree a job's uncommitted change. Secrets in every workspace, the names of your other workspaces in one with "guard": true; prints each hit with its matched text (never a secret's); exit 0 no hits, 1 hits or an error; no sf serve needed
  sf guard install-hook <workspace>                     Write the guard's pre-push hook into the workspace's checkout (core.hooksPath followed); rewrites its own hook, never another
  sf metrics [<workspace>] [--since YYYY-MM-DD] [--json]  The Codex gate per job, current and archived: gate levels per iteration (F full, L light, l light skipped, - none, · no decision, ? unreadable), runs, tokens, items by outcome and the yield (fixed over all items), then the totals; no sf serve needed
  sf smoke [--keep] [--timeout-min N] [--budget-usd N]  The live smoke test: one tiny real job (Claude Code, Codex, Git) from Task check to push, on a throwaway repository with a local bare remote, its own sf serve and state in one temporary directory (never yours); prints a pass/fail table. Models: SF_SMOKE_MODEL (default haiku), SF_SMOKE_CODEX_MODEL (default: Codex's); budget: --timeout-min (default ${DEFAULT_TIMEOUT_MIN}) and --budget-usd (default ${DEFAULT_BUDGET_USD}), positive numbers; --keep keeps the directory
  sf run <workspace> <ticket>                           The job's runner: its turns, reviews and gate, detached from sf serve (sf serve starts it; one per job)
  sf service install|uninstall|status                   sf serve as a systemd user service (software-factory.service in ~/.config/systemd/user, KillMode=process: running jobs outlive a stop or restart) with its watchdog (a timer that runs sf health --notify every five minutes, and an alert unit when systemd gives up restarting it); install writes and enables them (refused while an sf serve started by hand answers); logs: journalctl --user -u software-factory
${PLANNER_USAGE.join('\n')}
  sf update [--check|--abandon] [--no-smoke]            Update the factory's Git install to origin/main: drains first (pauses the running jobs, waits for their runners to end), pulls, npm ci when the lockfile changed, builds and typechecks, restarts the service, resumes the jobs it paused and runs sf smoke; a failed step rolls back to the start commit. --check: how far behind, changes nothing; --abandon: remove the updating marker of an interrupted update and resume its jobs

Notes:
  EST_USD: an estimate of the API-equivalent price, not a charge (the session usually runs on your Claude plan):
           cost_usd of the published iterations summed, four decimals; 0.0000 before the first one, unknown when one has no usable cost.
           A running iteration or MR preparation adds nothing until its iteration is published.
  SINCE:   the last state change in local time (the stored times are UTC).
  ELAPSED: wall-clock time since the job was created, waiting included; stops at the last state change once pushed, aborted or failed.
  dashboard --open: Linux with xdg-open; waits for the launcher at most 10 s; on a launcher failure exits 1 and leaves the printed URL to open by hand.
  check-task: exits 0 when the check ran (ready or not ready), 1 when it failed; SF_TASK_CHECK_MAX_TURNS (default 30) and SF_REVIEW_MODEL apply. It runs in its own process, outside SF_TASK_CHECK_PARALLEL.
Exit codes: 0 ok, 1 error, 2 usage.`;

function parsePort(name: 'SF_PORT' | 'SF_DASHBOARD_PORT' | 'SF_DASHBOARD_REMOTE_PORT', fallback: number): number {
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

// options.tunnel: sf up --no-tunnel's off, over SF_TUNNEL.
async function serve(options: { tunnel?: 'off' } = {}): Promise<{ dashboard: URL | undefined }> {
  const port = parsePort('SF_PORT', DEFAULT_PORT);
  const dashboardPort = parsePort('SF_DASHBOARD_PORT', DEFAULT_DASHBOARD_PORT);
  // SF_DASHBOARD_REMOTE_ORIGINS: an invalid value stops the start; not read with the dashboard off.
  const remoteOrigins = dashboardOn() ? dashboardRemoteOrigins() : [];
  // With them: the remote listener's port and the logins it serves, checked before anything starts.
  const remoteLogins = dashboardRemoteLogins(remoteOrigins);
  const remotePort = remoteOrigins.length > 0 ? parsePort('SF_DASHBOARD_REMOTE_PORT', DEFAULT_DASHBOARD_REMOTE_PORT) : DEFAULT_DASHBOARD_REMOTE_PORT;
  if (remoteOrigins.length > 0) {
    checkDashboardPorts(dashboardPort, remotePort);
  }
  const config = loadConfig();
  // SF_HEALTH, SF_TUNNEL and SF_KEEP_AWAKE: an invalid value stops the start here.
  const healthOn = healthSetting();
  const keepAwakeOn = keepAwakeSetting();
  const tunnelOn = tunnelSetting() === 'auto' && options.tunnel !== 'off';
  const handbook = await serveSkills(config.stateDir).then(() => loadHandbook());
  if (planWarning(handbook) !== undefined) {
    console.error(planWarning(handbook));
  }
  // Fail at startup on an invalid registry rather than on the first tool call.
  const registry = await loadRegistry();
  const ignored = ignoredWorkCheckouts(registry);
  if (ignored.length > 0) {
    console.error(`warning: the work_checkout of workspace(s) ${ignored.join(', ')} is ignored: every job works in a worktree of the checkout.`);
  }
  // The Task checks' parent directory, which every other session denies: made here; an unsafe
  // one (a link, another owner) is one warning, and every Task check then fails with task_check_dir_unsafe.
  await prepareTaskChecksDir().catch((error: unknown) => console.error(`warning: ${error instanceof Error ? error.message : String(error)}`));
  // The run queue: an invalid queue.json fails here, as an invalid registry does.
  const queueStore = new QueueStore(config.stateDir, config.maxJobs);
  await queueStore.read();
  const jobs = new JobStore(config.stateDir);
  // Each notification reads the workspace's notify setting from the registry.
  const notify = stateNotifier(notifyConfig(), jobs, workspaceNotifyMode);
  // The dashboard starts after recovery; until then its listener is a no-op. So does the run queue's scheduler.
  let dashboard: RunningDashboard | undefined;
  let scheduling = false;
  const reschedule = (job: Job, from: JobState | null): void => {
    if (scheduling && from !== job.state) {
      void runQueue.schedule();
    }
  };
  // A job of the ticket that runs (non-terminal, not paused) cancels its automatic Task checks.
  let autoChecks: AutoChecks | undefined;
  const onStateChange: StateListener = (job, from, lines) => {
    autoChecks?.jobChanged(job);
    notify(job, from, lines);
    dashboard?.onStateChange(job, from);
    reschedule(job, from);
  };
  const tests = testHooks();
  // The Archive of a job whose Task file is active archives the Task file too, through Setup (below).
  const archiveTicket = async (workspace: string, ticket: string): Promise<Retired | undefined> => (await setup.archiveTicket(workspace, ticket)).retired;
  const execution = new Execution(config, (name) => resolveWorkspace(name), onStateChange, handbook.text, { ...executionOptions(config, tests), archiveTicket });
  // The tickets' history: New ticket and Save (Setup) and write_task (the MCP server) record the Task file's writes.
  const history = new TicketHistory(config.stateDir);
  // The start screen of the dashboard: the registry and the Task files, under the Execution's lock. A finished
  // job leaves with its Task file through the lock's scope, in the ticket action's acquisition.
  const setup = new Setup({ configDir: configDir(), jobs, exclusive: (work) => execution.exclusive(work), history, handoffDefault: config.handoff });
  // The morning digest: one a day by the timer, Generate now on the dashboard, sf digest
  // --now through the socket; a scheduled one is notified with its counts.
  const digests = new Digests({
    stateDir: config.stateDir, configDir: configDir(), claudePath: config.claudePath,
    notify: (notification) => sendNotification(notification, notifyConfig()),
  });
  const digestSchedule = new DigestSchedule({ digests, configDir: configDir() });
  // The plain explanation of each stop: the job follower starts one when a job reaches a
  // new needs_human stop, the start one for each stopped job without; the open pages get it.
  const explainer = new Explainer({ jobs, configDir: configDir(), claudePath: config.claudePath, onWritten: (workspace, ticket) => dashboard?.refreshJob(workspace, ticket) });
  // The run queue's scheduler: a pass after recovery, on every job state change (sf serve's own and the
  // runners', below), on every change of the queue; a pass that changed something refreshes every page.
  // At a usage limit's reset it resumes the parked jobs (or marks them, under wait) and sends one
  // notification. With the automatic checks the queue starts a ticket only when its plan is ready or
  // forced, and a ticket added without a check, or found without one once nothing else holds it,
  // gets one.
  const runQueue = new RunQueue(queueStore, execution, setup, jobs, {
    onChange: () => dashboard?.refreshSetup(),
    notify: (notification) => sendNotification(notification, notifyConfig()),
    planCheck: (workspace, ticket) => planCheck(checks, autoChecks, workspace, ticket),
    onAdded: (workspace, ticket) => void autoChecks?.triggerIfUnchecked(workspace, ticket),
    onUnchecked: (workspace, ticket) => void autoChecks?.triggerIfUnchecked(workspace, ticket),
    // The updating marker: no start and no limit reset while sf update drains or builds.
    updating: () => updateMarked(config.stateDir),
    // A ticket queued by itself (auto_queue) is recorded in its history.
    history,
  });
  // A ready check, automatic or the dashboard's Check, puts its ticket in the queue in a workspace
  // with auto_queue (addByItself).
  const queueByItself = (workspace: string, ticket: string, record: CheckRecord): void => {
    void runQueue.addByItself(workspace, ticket, record.sha256).catch((error: unknown) => console.error(error));
  };
  // The Task checks: started from the dashboard, read by the Context owner's task_check; an ended
  // check reaches every page.
  // A check's worktree shares the checkout's Git directory: when the last check of the workspace
  // ended, the config lock its sandbox left goes unless a job runs there.
  const checks: TaskChecks = new TaskChecks({
    ...checkSettings(config, configDir()), resolve: (name) => resolveWorkspace(name),
    onSettled: (workspace, ticket, settled) => {
      dashboard?.refreshSetup();
      if (!checks.runningIn(workspace)) {
        void execution.afterTaskCheck(workspace, ticket);
      }
      // The dashboard's Check that ended ready queues as an automatic one does (onReady).
      if (!settled.auto && settled.record !== undefined && recordVerdict(settled.record) === 'ready') {
        queueByItself(workspace, ticket, settled.record);
      }
      // A queued ticket may be ready after this check.
      void runQueue.schedule();
    },
  });
  // The automatic Task checks, unless SF_TASK_CHECK_AUTO=off: write_task, the watcher of every
  // workspace's .software-factory folder, the run queue and its re-check sweep trigger them; a check
  // that ends not ready or failed is notified like a job, except as task-check-auto.ts says.
  if (config.taskCheckAuto) {
    autoChecks = new AutoChecks({
      checks, jobs, resolve: (name) => resolveWorkspace(name), parallel: config.taskCheckParallel,
      queued: async () => (await queueStore.read()).entries.map((entry) => ({ ...entry, force: entry.force === true })),
      // A test hook: a shorter time from the last trigger to the check.
      ...(tests.taskCheckDelayMs !== undefined ? { delayMs: tests.taskCheckDelayMs } : {}),
      workspaces: async () => Object.entries((await loadRegistry()).workspaces).map(([name, entry]) => ({ name, workCheckout: entry.read_checkout })),
      onCheckEnded: (record) => {
        dashboard?.refreshSetup();
        void notifyTaskCheck(record, notifyConfig(), workspaceNotifyMode);
      },
      onReady: queueByItself,
      // The updating marker: a check due meanwhile is recorded for the catch-up.
      update: { updating: () => updateMarked(config.stateDir), skipped: (workspace, ticket) => recordSkippedCheck(config.stateDir, { workspace, ticket }) },
    });
  }
  // The port the MCP endpoint bound, once it listens (SF_PORT=0: any free port).
  let boundMcpPort: number | undefined;
  // The socket first: it refuses a second sf serve on the same state before recovery touches it.
  const socket = await listenSocket(config.stateDir, socketHandler({
    execution, queue: runQueue, checks, digests, mcpPort: () => boundMcpPort,
    stateDir: config.stateDir, testHooks: tests, onQueueChange: () => dashboard?.refreshSetup(), onCoordinatorChange: () => dashboard?.coordinatorChanged(),
  }));
  let server;
  // The updating marker at the start: the jobs of a finished (restart_pending) or dead
  // (draining) update to resume, the marker removed already; or a marker that stays, under which
  // recovery repairs the states but starts no runner.
  // A start that fails after it took the marker puts it back, so the next sf serve resumes the jobs.
  let atStart: Awaited<ReturnType<typeof markerAtServeStart>> | undefined;
  try {
    // The state format: a newer one is refused (state_too_new) before anything reads it.
    await checkStateVersion(config.stateDir);
    // The MCP token: made on the first start; an invalid file stops the start.
    const narrowed = await ensureMcpToken(config.stateDir);
    if (narrowed !== undefined) {
      console.error(`warning: ${narrowed}`);
    }
    atStart = await markerAtServeStart(config.stateDir);
    await execution.recover({ startRunners: !atStart.gated });
    // A note suggest_changes stored reaches the open pages of its job, as the Explainer's onWritten does.
    server = await startServer(port, config.stateDir, handbook, await packageVersion(), execution, checks, history, runQueue, autoChecks, (workspace, ticket) => dashboard?.refreshJob(workspace, ticket));
    boundMcpPort = server.port;
  } catch (error) {
    await putMarkerBack(config.stateDir, atStart?.taken).catch((putError: unknown) => console.error(putError));
    await socket.close();
    throw error;
  }
  // The tunnel with SF_TUNNEL=auto and a tunnel profile: started once serve answers, below.
  const tunnel = tunnelOn && existsSync(tunnelProfile()) ? new TunnelChild({
    script: tunnelScript(), stateDir: config.stateDir, address: tunnelHealthAddress(), token: () => readMcpToken(config.stateDir),
  }) : undefined;
  // The health checks, unless SF_HEALTH=off (src/recovery.ts): every CHECK_EVERY_MS (logins
  // hourly), the traffic light of the dashboard, one notification when a check turns down or is ok
  // again, the tunnel's recovery and the sandbox reaper before each sandboxes check.
  const upkept = upkeep({
    health: healthOn, tunnel, roots: () => factoryRoots(config), watch: new OrphanWatch(() => factoryRoots(config)),
    deps: healthDeps(config, {
      mcp: async () => ({ port: boundMcpPort, token: await readMcpToken(config.stateDir).catch(() => undefined) }),
      queue: async () => ({ view: await runQueue.view(), lastStart: (await queueStore.read()).last_start, newestJob: newestJob(await jobs.list()) }),
      digests: digests.store,
    }),
    monitor: { onChange: () => dashboard?.healthChanged(), notify: (notification) => sendNotification(notification, notifyConfig()) },
  });
  const healthMonitor = upkept.monitor;
  try {
    if (dashboardOn()) {
      // The ticket page's planner session (src/planner-session.ts), with this service's environment and folders.
      const sessionDeps = { env: process.env, stateDir: config.stateDir, configDir: configDir() };
      // The planners' prototypes the ticket page links (src/prototypes.ts), in this service's planning folder.
      let prototypes: string | undefined;
      try {
        prototypes = prototypesRoot(planningDir());
      } catch (error) {
        console.error(`warning: ${error instanceof Error ? error.message : String(error)} The dashboard shows no prototypes.`);
      }
      // The dashboard's actions (DashboardActions: start, approve, abort, say, retryReview,
      // acceptGate and archiveFinished) run on the same Execution as the socket commands.
      dashboard = await startDashboard(dashboardPort, config.stateDir, jobs, execution, setup, {
        gate: config.gate.on, checks, queue: runQueue, onWorkspacesChanged: () => void autoChecks?.rereadWorkspaces(), digests, remoteOrigins, remoteLogins, remotePort,
        planner: { start: (w, t) => startPlanner(w, t, sessionDeps), session: (w, t) => plannerSession(w, t, sessionDeps), stop: (w, t) => stopPlanner(w, t, sessionDeps) },
        ...(healthMonitor !== undefined ? { health: healthMonitor } : {}),
        ...(prototypes !== undefined ? { prototypes } : {}),
      });
    } else {
      await removeToken(config.stateDir);
    }
  } catch (error) {
    await putMarkerBack(config.stateDir, atStart.taken).catch((putError: unknown) => console.error(putError));
    await Promise.all([server.close(), socket.close()]);
    throw error;
  }
  // No token in the output: the service's journal keeps it. sf dashboard prints the URL.
  console.log(dashboard !== undefined
    ? `${SERVER_NAME} dashboard http://127.0.0.1:${dashboard.url.port}/d/${TOKEN_LABEL}/ (sf dashboard prints the full URL)`
    : `${SERVER_NAME} dashboard off (SF_DASHBOARD=off)`);
  if (dashboard?.remotePort !== undefined) {
    console.log(`${SERVER_NAME} dashboard remote listener 127.0.0.1:${dashboard.remotePort}`);
  }
  for (const remote of remoteOrigins) {
    console.log(`${SERVER_NAME} dashboard through Tailscale ${remote}/d/${TOKEN_LABEL}/`);
  }
  if (!config.gate.on && config.gate.missing === true) {
    console.log(`gate: off (${config.gate.reason}); the Claude review decides`);
  }
  console.log(`${SERVER_NAME} listening on ${mcpUrl(server.port)}`);
  console.log(`${SERVER_NAME} socket ${socket.path}`);
  // The runners write the state of their jobs; the dashboard hears of it from disk. A job that left working,
  // awaiting_review or preparing_mr may free a hand-over that met the sandbox's config lock, and so may sf
  // serve's start. The run queue hears of both: a runner's job that reached ready_for_human_review frees a slot.
  const followed = followJobs(jobs, (job, from) => {
    autoChecks?.jobChanged(job);
    explainer.jobChanged(job);
    dashboard?.onStateChange(job, from);
    execution.afterJobChange(job, from).catch((error: unknown) => console.error(error));
    reschedule(job, from);
  });
  execution.handOverLocked().catch((error: unknown) => console.error(error));
  scheduling = true;
  void runQueue.schedule();
  await autoChecks?.start();
  digestSchedule.start();
  // The updating marker while sf serve runs: its poll; the catch-up once the marker is gone
  // (what the gates held back), the resume of the jobs of an update that finished or died.
  const catchUp = async (): Promise<void> => {
    await execution.ensureResumable().catch((error: unknown) => console.error(error));
    await runQueue.schedule();
    await execution.handOverLocked().catch((error: unknown) => console.error(error));
    for (const { workspace, ticket } of await readSkippedChecks(config.stateDir)) {
      await autoChecks?.triggerIfUnchecked(workspace, ticket);
    }
    await removeSkippedChecks(config.stateDir);
  };
  const markerWatch = new MarkerWatch(config.stateDir, atStart.gated, {
    resume: ({ workspace, ticket }) => execution.resumePaused(workspace, ticket),
    catchUp,
  }, tests.markerPollMs ?? MARKER_POLL_MS);
  if (atStart.resume !== undefined) {
    markerWatch.finish(atStart.resume).catch((error: unknown) => console.error(error)).finally(() => markerWatch.start());
  } else {
    markerWatch.start();
  }
  explainer.start().catch((error: unknown) => console.error(error));
  // The pass of merged jobs: a minute after the start, then every 10 minutes; the archived jobs leave every page.
  const archiveMerged = (): void => void execution.archiveMergedJobs().then((done) => done.forEach((job) => dashboard?.onStateChange(job, job.state)), (error: unknown) => console.error(error));
  const mergedTimers = [setTimeout(archiveMerged, MERGED_FIRST_MS).unref(), setInterval(archiveMerged, MERGED_EVERY_MS).unref()];
  // The laptop stays awake while a job runs (src/keep-awake.ts), unless SF_KEEP_AWAKE=off.
  const keepAwake = keepAwakeOn ? new KeepAwake({ intervalMs: KEEP_AWAKE_EVERY_MS, jobs: () => jobs.list(), command: KEEP_AWAKE_COMMAND }) : undefined;
  keepAwake?.start();
  // The tunnel's check needs the factory to answer, so it starts here; its group ends with sf serve.
  if (tunnel !== undefined) {
    process.once('exit', () => tunnel.stopNow());
    await tunnel.start();
  } else {
    console.log(`tunnel: not started (${tunnelOn ? `no tunnel profile: ${tunnelProfile()}` : options.tunnel === 'off' ? '--no-tunnel' : 'SF_TUNNEL=off'})`);
  }
  // The sessions' Bash sandboxes left over: before each sandboxes check, or every REAP_EVERY_MS with SF_HEALTH=off.
  upkept.start();

  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`${SERVER_NAME} received ${signal}, shutting down`);
    followed.close();
    markerWatch.close();
    runQueue.close();
    autoChecks?.close();
    digestSchedule.close();
    explainer.close();
    upkept.close();
    keepAwake?.stop();
    mergedTimers.forEach((timer) => clearTimeout(timer));
    // The waits of sf coordinator wait-request end first: their open connections would hold the socket's close.
    endRequestWaits();
    Promise.all([server.close(), socket.close(), dashboard?.close(), tunnel?.stop()]).then(
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

// `sf up`: sf serve in this process (the tunnel is its child), the dashboard in the browser.
async function up(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { 'no-open': { type: 'boolean' }, 'no-tunnel': { type: 'boolean' } } });
  if (positionals.length !== 0) {
    throw new UsageError('up takes no arguments (only --no-open and --no-tunnel).');
  }
  // The tunnel is serve's (SF_TUNNEL); --no-tunnel is SF_TUNNEL=off.
  const { dashboard } = await serve(values['no-tunnel'] === true ? { tunnel: 'off' } : {});
  if (values['no-open'] === true || dashboard === undefined) {
    return;
  }
  try {
    // The real URL, in this process only: serve printed it with <token>.
    await openInBrowser(dashboard.href);
  } catch (error) {
    // The launcher's "open the URL above by hand" does not hold: the line above has <token>.
    const reason = (error instanceof Error ? error.message : String(error)).replace(/; open the URL above by hand\.$/, '');
    console.error(`sf: ${reason}; run sf dashboard for the URL and open it by hand.`);
  }
}

// The hand-over setting that decides for a workspace's jobs: its own handoff, else
// SF_HANDOFF with this shell's value (sf serve reads its own environment).
function handoffLabel(entry: WorkspaceEntry): string {
  if (entry.handoff !== undefined) {
    return `${entry.handoff} (this workspace)`;
  }
  try {
    return `${handoffSetting()} (SF_HANDOFF)`;
  } catch { // an invalid SF_HANDOFF: the row says so
    return 'SF_HANDOFF (invalid)';
  }
}

// The workspace's colour on the board: its own, else the one its name picks.
function colorLabel(name: string, entry: WorkspaceEntry): string {
  return entry.color !== undefined ? entry.color : `${workspaceColor(name)} (by its name)`;
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
    options: command === 'add' ? { read: { type: 'string' }, work: { type: 'string' }, handoff: { type: 'string' }, color: { type: 'string' }, label: { type: 'string' } } : {},
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
      // The label only when it has one, the notify setting only when it is not the default, and
      // auto-planner only when it is on.
      const notify = workspaceNotify(entry);
      const label = entry.label !== undefined ? `\n  label: ${entry.label}` : '';
      const autoPlanner = entry.auto_planner === true ? '\n  auto-planner: on' : '';
      console.log(`${name}\n  checkout: ${entry.read_checkout}\n  hand-over: ${handoffLabel(entry)}\n  colour: ${colorLabel(name, entry)}${label}${notify !== 'full' ? `\n  notify: ${notify}` : ''}${autoPlanner}`);
    }
    return;
  }
  // sf workspace notify <name> full|brief|off: full removes the key (the default).
  if (command === 'notify') {
    if (positionals.length > 2) {
      throw new UsageError(`unexpected argument "${positionals[2]}".`);
    }
    const [name, notify] = [checkName(positionals[0]), positionals[1]];
    if (!isNotifyMode(notify)) {
      throw new UsageError(notify === undefined ? 'workspace notify needs <name> full|brief|off.' : `notify must be full, brief or off, got "${notify}".`);
    }
    await setWorkspaceNotify(name, notify);
    console.log(`Workspace "${name}" notifies ${notify}.`);
    return;
  }
  // sf workspace auto-planner <name> on|off: off removes the key (the default).
  if (command === 'auto-planner') {
    if (positionals.length > 2) {
      throw new UsageError(`unexpected argument "${positionals[2]}".`);
    }
    const [name, value] = [checkName(positionals[0]), positionals[1]];
    if (value !== 'on' && value !== 'off') {
      throw new UsageError(value === undefined ? 'workspace auto-planner needs <name> on|off.' : `auto-planner must be on or off, got "${value}".`);
    }
    await setWorkspaceAutoPlanner(name, value === 'on');
    console.log(value === 'on'
      ? `Workspace "${name}" starts the Claude Code planner of each ticket created on the dashboard by itself.`
      : `Workspace "${name}" starts no planner by itself.`);
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
      throw new FactoryError('work_checkout_retired', '--work is not supported: every job works in a worktree of the checkout.');
    }
    const handoff = values.handoff;
    if (handoff !== undefined && !isHandoffMode(handoff)) {
      throw new UsageError(`--handoff must be ${HANDOFF_MODES.join(' or ')}, got "${String(handoff)}".`);
    }
    const color = values.color;
    if (color !== undefined && !isWorkspaceColor(color)) {
      throw new UsageError(`--color must be one of ${WORKSPACE_COLORS.join(', ')}, got "${String(color)}".`);
    }
    // --label "" removes the label, a text sets it, no --label keeps it.
    const labelGiven = typeof values.label === 'string';
    const label = typeof values.label === 'string' ? checkLabel(values.label) : undefined;
    const registry = await loadRegistry();
    const real = await checkout(read, '--read');
    // Registered: the same checkout with --handoff, --color or --label changes those, the rest stays.
    const existing = Object.hasOwn(registry.workspaces, name) ? registry.workspaces[name] : undefined;
    if (existing !== undefined && (existing.read_checkout !== real || (handoff === undefined && color === undefined && !labelGiven))) {
      throw new FactoryError('workspace_exists', `workspace "${name}" is already registered; remove it first, or give the same --read with --handoff, --color or --label to change those.`);
    }
    const { label: oldLabel, ...others } = existing ?? {};
    const kept = labelGiven ? label : oldLabel;
    const entry: WorkspaceEntry = { ...others, read_checkout: real, ...(handoff !== undefined ? { handoff } : {}), ...(color !== undefined ? { color } : {}), ...(kept !== undefined ? { label: kept } : {}) };
    registry.workspaces[name] = entry;
    await saveRegistry(registry);
    console.log(`${existing === undefined ? 'Registered' : 'Updated'} workspace "${name}" (checkout: ${entry.read_checkout}; hand-over: ${handoffLabel(entry)}; colour: ${colorLabel(name, entry)}${entry.label !== undefined ? `; label: ${entry.label}` : ''}).`);
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

// The result of a socket command of sf serve; a refusal throws its code and message.
async function request(command: string, args: string[]): Promise<Record<string, unknown>> {
  const response = await callSocket(stateDir(), { command, args });
  if (!response.ok) {
    throw new FactoryError(response.error.code, response.error.message);
  }
  return response.result as Record<string, unknown>;
}

// A command of the table (src/commands.ts): its arguments checked here, then sent as typed to sf
// serve, which checks them again with the same checkArgs; the answer printed.
async function viaServer(command: Command, args: string[]): Promise<void> {
  const { flags } = checkArgs(command, args);
  const { lines, failed, exitCode } = answerLines(command, await request(socketName(command), args), flags);
  console.log(lines.join('\n'));
  if (failed) {
    process.exitCode = exitCode ?? 1;
  }
}

// What every Execution of sf serve, its runners and sf check-task is given: the /proc of a
// test hook (TestHooks.procDir) for the sandbox's config lock check, the real one without
// it; and the run queue's limit for its own starts, max_running of queue.json read at each.
function executionOptions(config: Config, hooks: TestHooks): ExecutionOptions {
  return {
    ...(hooks.procDir !== undefined ? { lockProc: hooks.procDir } : {}),
    maxRunning: async () => (await new QueueStore(config.stateDir, config.maxJobs).read()).max_running,
  };
}

// `sf run <workspace> <ticket>`: the job's runner, started detached by sf serve. Runs the
// queued requests, the turns, the reviews and the gate of the job, notifies like sf serve, and
// ends when nothing is left to run; runner_running when the job has a runner already.
async function run(args: string[]): Promise<void> {
  if (args.length !== 2) {
    throw new UsageError('run needs <workspace> <ticket>.');
  }
  const [workspace, ticket] = checkJob(args, 'run');
  const config = loadConfig();
  // The state format: a runner refuses a newer one (state_too_new).
  await checkStateVersion(config.stateDir);
  const handbook = await loadHandbook();
  const jobs = new JobStore(config.stateDir);
  if ((await jobs.read(workspace, ticket)) === undefined) {
    throw new FactoryError('job_not_found', `There is no job for ${workspace}/${ticket}.`);
  }
  const notify = stateNotifier(notifyConfig(), jobs, workspaceNotifyMode);
  const sending = new Set<Promise<void>>();
  const onStateChange: StateListener = (job, from, lines) => {
    const sent = notify(job, from, lines);
    sending.add(sent);
    void sent.finally(() => sending.delete(sent));
  };
  const execution = new Execution(config, (name) => resolveWorkspace(name), onStateChange, handbook.text, { runner: { workspace, ticket }, ...executionOptions(config, testHooks()) });
  console.log(`${new Date().toISOString()} runner ${process.pid} for ${workspace}/${ticket} started`);
  await runJob(jobs.dir(workspace, ticket), execution, { settle: async () => void (await Promise.allSettled([...sending])) });
  console.log(`${new Date().toISOString()} runner ${process.pid} for ${workspace}/${ticket} ended`);
}

// sf rules <workspace> [ticket]: the coding rules that would be given, without their text. A
// ticket whose job has its rules stored: the job's own list (rules.json), as its prompts carry them;
// a job with a base commit and nothing stored: none (it started without them). Else read at the
// Task file's base or continues (fetched as Start does), at the checkout's HEAD without a ticket.
async function rules(args: string[]): Promise<void> {
  if (args.length < 1 || args.length > 2) {
    throw new UsageError('rules needs <workspace> [ticket].');
  }
  const name = checkName(args[0]);
  const ticket = args.length === 2 ? checkJob(args, 'rules')[1] : undefined;
  const maxBytes = rulesMaxBytes();
  const workspace = await resolveWorkspace(name);
  const checkout = workspace.workCheckout;
  let commit: string;
  if (ticket === undefined) {
    const head = await runGit(checkout, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (head.code !== 0) {
      throw new FactoryError('base_not_found', `The checkout of ${name} has no HEAD commit.`);
    }
    commit = head.stdout.toString('utf8').trim();
  } else {
    const jobs = new JobStore(stateDir());
    const job = await jobs.read(name, ticket);
    if (job?.base_commit != null) {
      const stored = await readJobRulesList(jobs.dir(name, ticket));
      if (stored !== undefined) {
        console.log([...rulesLines(name, stored), "Stored at the job's Start: the rules its prompts carry."].join('\n'));
      } else if (job.error?.code === 'rules_failed') {
        console.log(`The job of ${name}/${ticket} failed at Start: ${job.error.message}`);
      } else {
        console.log(`The job of ${name}/${ticket} has no stored rules (it started before rules were stored): its prompts carry no <rules> block.`);
      }
      return;
    }
    const base = taskStartBranch(parseFrontMatter(await readTask(workspace, ticket)));
    if (base === '' || base.startsWith('-') || (await runGit(checkout, ['check-ref-format', '--branch', base])).code !== 0) {
      throw new FactoryError('base_not_found', `The base "${base}" is not a valid branch name.`);
    }
    commit = (await resolveTarget(checkout, base)).commit;
  }
  const { list } = await collectRules(checkout, commit, { workspace: name, skip: workspace.rulesSkip ?? [], configDir: configDir(), maxBytes });
  console.log(rulesLines(name, list).join('\n'));
}

// sf check-task <workspace> <ticket>: one Task check in this process, without sf serve;
// the record goes to the state directory, as from the dashboard's Check.
async function checkTask(args: string[]): Promise<void> {
  if (args.length !== 2) {
    throw new UsageError('check-task needs <workspace> <ticket>.');
  }
  const [name, ticket] = checkJob(args, 'check-task');
  const config = loadConfig();
  // It runs in this process, past sf serve's gates.
  refuseWhileUpdating(config.stateDir);
  const workspace = await resolveWorkspace(name);
  const task = await readTask(workspace, ticket);
  refuseDraft(ticket, task);
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  console.error(`Checking ${TASK_DIR}/${ticket}.md of ${name}: a read-only Claude session reads it and the repository; this takes a few minutes.`);
  const record = await runTaskCheck(workspace, ticket, task, { ...checkSettings(config, configDir()), signal: abort.signal });
  const path = await new CheckStore(config.stateDir).write(record);
  console.log([...checkLines(record), '', `stored: ${path}`].join('\n'));
  // The check's worktree shared the checkout's Git directory: the config lock its sandbox left
  // goes as after a check of sf serve's, unless a job of the workspace runs.
  await new Execution(config, (workspaceName) => resolveWorkspace(workspaceName), undefined, undefined, executionOptions(config, testHooks())).afterTaskCheck(name, ticket);
  if (record.status === 'failed') {
    process.exitCode = 1;
  }
}

// sf smoke [--keep] [--timeout-min N] [--budget-usd N]: the options checked here, the run
// in src/live-smoke.ts. Returns the exit code: 0 when every step passed, 1 otherwise.
async function smoke(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, strict: true,
    options: { keep: { type: 'boolean' }, 'timeout-min': { type: 'string' }, 'budget-usd': { type: 'string' } },
  });
  if (positionals.length !== 0) {
    throw new UsageError('smoke takes no arguments (only --keep, --timeout-min N and --budget-usd N).');
  }
  const decimal = (name: 'timeout-min' | 'budget-usd', fallback: number): number => {
    const raw = values[name];
    if (raw === undefined) {
      return fallback;
    }
    const value = positiveDecimal(raw);
    if (value === undefined) {
      throw new UsageError(`--${name} must be a positive number (for example 0.05), got "${raw}".`);
    }
    return value;
  };
  const timeoutMin = decimal('timeout-min', DEFAULT_TIMEOUT_MIN);
  const budgetUsd = decimal('budget-usd', DEFAULT_BUDGET_USD);
  return runSmoke({ keep: values.keep === true, timeoutMin, budgetUsd });
}

// sf digest [--now], through the socket of sf serve.
async function digest(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { now: { type: 'boolean' } } });
  if (positionals.length > 0) {
    throw new UsageError('digest takes no arguments but --now.');
  }
  if (values.now === true) {
    const result = await request(socketName(COMMANDS.digestRun), []);
    console.log(`digest: ${String(result.path)}\ncost: ${typeof result.cost_usd === 'number' ? `$${result.cost_usd.toFixed(4)}` : 'unknown'}`);
    return;
  }
  const result = await request(socketName(COMMANDS.digestLatest), []);
  if (result.digest === null) {
    console.log('No digest yet: sf digest --now makes one.');
    return;
  }
  const period = result.period as { from: string; to: string };
  const counts = result.counts as { landed: number; live_branches: number; impact: number };
  console.log([
    `digest: ${String(result.digest)}`,
    `period: ${localTime(period.from) ?? period.from} to ${localTime(period.to) ?? period.to}`,
    `landed: ${counts.landed}`, `live branches: ${counts.live_branches}`, `mine need attention: ${counts.impact}`,
    ...(typeof result.error === 'string' ? [`model: failed (${result.error}); the Git data is shown`] : []),
  ].join('\n'));
}

// sf explain <workspace> <ticket>: read from the state directory, without sf serve or a model call.
async function explain(args: string[]): Promise<void> {
  if (args.length !== 2) {
    throw new UsageError('explain needs <workspace> <ticket>.');
  }
  const [workspace, ticket] = checkJob(args, 'explain');
  const jobs = new JobStore(stateDir());
  const job = await jobs.read(workspace, ticket);
  if (job === undefined) {
    throw new FactoryError('job_not_found', `There is no job for ${workspace}/${ticket}.`);
  }
  console.log(explanationLines(await currentExplanation(jobs, job)).join('\n'));
}

async function notifyTest(args: string[]): Promise<void> {
  if (args.length !== 0) {
    throw new UsageError('notify-test takes no arguments.');
  }
  const results = await sendNotification(testNotification(new Date().toISOString()), notifyConfig());
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
  const port = await mcpPort().catch((error: unknown) => {
    if (error instanceof FactoryError && error.code === 'mcp_port_unknown') {
      return undefined;
    }
    throw error;
  });
  row('mcp', port === undefined ? 'any free port (SF_PORT=0): sf mcp-url shows the URL while sf serve runs' : `${mcpUrl(port)} (planning tools, loopback only; the URL with the token: sf mcp-url)`);
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
  // The gate level, whatever the gate's state.
  try {
    row('gate level', gateLevelSetting());
  } catch (error) {
    row('gate level', `invalid: ${(error as Error).message}`);
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
    await callSocket(state, { command: socketName(COMMANDS.ping), args: [] });
    row('serve', `running (${socketPath(state)})`);
  } catch { // no socket or no answer: sf serve is not running
    row('serve', 'not running (npm run serve)');
  }
  const health = tunnelHealthAddress();
  try {
    const reply = await fetch(`http://${health}/readyz`, { signal: AbortSignal.timeout(1500) });
    row('tunnel', `${reply.ok ? 'ready' : `answers ${reply.status}`} (http://${health}/readyz)`);
  } catch { // refused or timed out: the tunnel is not running
    row('tunnel', 'not running (npm run tunnel)');
  }

  const registry = await loadRegistry();
  const names = Object.keys(registry.workspaces).sort();
  row('workspaces', names.length === 0 ? 'none (sf workspace add <name> --read <path>)' : '');
  for (const name of names) {
    const entry = registry.workspaces[name]!;
    lines.push(`  ${name}: ${entry.read_checkout} (hand-over: ${handoffLabel(entry)})`);
  }
  console.log(lines.join('\n'));

  const jobs = new JobStore(state);
  const all = await jobs.list();
  console.log(`\njobs${all.length === 0 ? ': none' : ''}`);
  if (all.length > 0) {
    console.log(table(await statusRows(jobs, all, new Date())));
  }
}

// The Claude CLI the factory runs (for the logins check): SF_CLAUDE, else the Agent SDK's own
// binary for this platform, else claude on PATH.
function claudeExecutable(config: Config): string {
  if (config.claudePath !== undefined) {
    return config.claudePath;
  }
  try {
    return createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
  } catch { // no SDK binary for this platform: claude on PATH
    return 'claude';
  }
}

// What sf serve and sf health each read differently; each adds its own orphan scans (sandboxes).
type HealthSources = Pick<HealthDeps, 'mcp' | 'queue' | 'digests'>;

// The checks' dependencies, the same for sf serve and sf health but for sources.
function healthDeps(config: Config, sources: HealthSources): Omit<HealthDeps, 'sandboxes'> {
  const jobs = new JobStore(config.stateDir);
  return {
    ...sources,
    now: () => new Date(),
    probe: (port, token) => probeMcp(port, token),
    tunnelProfile: tunnelProfile(),
    tunnelAddress: tunnelHealthAddress(),
    fetch: fetchText,
    packageRoot: PACKAGE_ROOT,
    tunnelScript: tunnelScript(),
    jobs: {
      jobs, testTimeoutMs: config.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
      runnerAlive: async (job) => (await liveOwner(lockPath(jobs.dir(job.workspace, job.ticket)))) !== undefined,
    },
    remote: () => {
      const origins = dashboardOn() ? dashboardRemoteOrigins() : [];
      return { origins, port: origins.length > 0 ? parsePort('SF_DASHBOARD_REMOTE_PORT', DEFAULT_DASHBOARD_REMOTE_PORT) : DEFAULT_DASHBOARD_REMOTE_PORT };
    },
    answers: httpAnswers,
    run: runCheckCommand,
    logins: {
      claudePath: claudeExecutable(config),
      // The Codex CLI only when the gate runs it.
      codexPath: config.gate.on ? config.gate.codexPath : undefined,
      forgeTargets: async () => forgeTargets(await loadRegistry(), originUrl, (origin) => chooseForge(origin, config.forge)),
      checkToken: (target) => checkForgeToken(target),
    },
    diskPaths: [config.stateDir, config.worktreeRoot],
    freeSpace,
    configDir: configDir(),
  };
}

// The newest job's creation time (a start by hand counts as a start for the queue check).
function newestJob(all: Job[]): string | undefined {
  return all.map((job) => job.created_at).sort().at(-1);
}

// The run queue as sf health sees it: a read-only RunQueue of its own, the plan checks as stored.
async function localQueueFacts(config: Config): Promise<QueueFacts> {
  const store = new QueueStore(config.stateDir, config.maxJobs);
  const jobs = new JobStore(config.stateDir);
  const refused = (): Promise<never> => Promise.reject(new FactoryError('read_only', 'sf health changes nothing.'));
  const setup = new Setup({ configDir: configDir(), jobs, exclusive: refused });
  const checks = new TaskChecks({ ...checkSettings(config, configDir()), resolve: (name) => resolveWorkspace(name) });
  const queue = new RunQueue(store, { start: refused, fetchBase: refused, limitReset: refused }, setup, jobs, {
    planCheck: (workspace, ticket) => planCheck(checks, undefined, workspace, ticket),
  });
  return { view: await queue.view(), lastStart: (await store.read()).last_start, newestJob: newestJob(await jobs.list()) };
}

// `sf health [--json]`: the checks computed here once, without asking sf serve; the orphan scan
// twice 10 s apart with the reaper between them. Returns the exit code: 0 all ok or off, 3 any
// recovering and none down, 1 any down. --notify: the watchdog (src/watchdog.ts), the MCP row only.
async function health(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { json: { type: 'boolean' }, notify: { type: 'boolean' }, force: { type: 'boolean' } } });
  if (positionals.length !== 0 || (values.force === true && values.notify !== true) || (values.notify === true && values.json === true)) {
    throw new UsageError('health takes no arguments (only --json, or --notify [--force]).');
  }
  const config = loadConfig();
  const watch = new OrphanWatch(() => factoryRoots(config));
  const deps: HealthDeps = {
    ...healthDeps(config, {
      mcp: async () => ({ port: await mcpPort().catch(() => undefined), token: await readMcpToken(config.stateDir).catch(() => undefined) }),
      queue: () => localQueueFacts(config),
      digests: new DigestStore(config.stateDir),
    }),
    // The reaper between the two scans, as sf serve before each check.
    sandboxes: async () => {
      await watch.scan();
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return reapThenScan(watch, () => reapOrphanedSandboxes(factoryRoots(config)))();
    },
  };
  if (values.notify === true) {
    return watchdog({ stateDir: config.stateDir, force: values.force === true, check: async () => (await runChecks(deps, ['mcp']))[0]! });
  }
  const checks = await runChecks(deps);
  console.log(values.json === true ? JSON.stringify(checks, null, 2) : healthLines(checks).join('\n'));
  return healthExitCode(checks);
}

function table(rows: StatusRow[]): string {
  const cells = [
    ['WORKSPACE', 'TICKET', 'STATE', 'ITER', 'BRANCH', 'SINCE', 'EST_USD', 'ELAPSED', 'ERROR'],
    ...rows.map(({ job, cost, elapsed, since }) => [job.workspace, job.ticket, job.state, String(job.iteration), job.branch, since, cost, elapsed, job.error?.code ?? '']),
  ];
  const widths = cells[0]!.map((_, column) => Math.max(...cells.map((row) => row[column]!.length)));
  return cells.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd()).join('\n');
}

// The dashboard's full URL for sf status (sf serve prints it with <token>), or undefined with
// the dashboard off, before the first sf serve, or when the token file or SF_DASHBOARD_PORT is unusable.
async function dashboardStatusUrl(): Promise<string | undefined> {
  if (!dashboardOn()) {
    return undefined;
  }
  try {
    const token = await readToken(stateDir());
    return token === undefined ? undefined : dashboardUrl(parsePort('SF_DASHBOARD_PORT', DEFAULT_DASHBOARD_PORT), token).href;
  } catch { // an unreadable token file or a bad SF_DASHBOARD_PORT: no URL to show
    return undefined;
  }
}

async function status(args: string[]): Promise<void> {
  const jobs = new JobStore(stateDir());
  // One clock reading for every row.
  const now = new Date();
  // The updating marker, its phase, and what to do when the update was interrupted.
  const update = await markerLines(stateDir());
  if (args.length === 0) {
    if (update.length > 0) {
      console.log(`${update.join('\n')}\n`);
    }
    const all = await jobs.list();
    console.log(all.length === 0 ? 'No jobs.' : table(await statusRows(jobs, all, now)));
    // The jobs whose Implementer went on by itself after a turn limit, one line each.
    // And the jobs parked on a usage limit, with the provider and the reset.
    const turnLimits = all.flatMap((job) => [turnLimitLine(job), limitLine(job)].flatMap((line) => (line === undefined ? [] : [`${job.workspace}/${job.ticket}: ${line}`])));
    if (turnLimits.length > 0) {
      console.log(`\n${turnLimits.join('\n')}`);
    }
    const dashboard = await dashboardStatusUrl();
    if (dashboard !== undefined) {
      console.log(`\ndashboard: ${dashboard}`);
    }
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
  if (update.length > 0) {
    console.log(`${update.join('\n')}\n`);
  }
  console.log(table(await statusRows(jobs, [job], now)));
  if (job.error !== undefined) {
    console.log(`\n${job.error.code}: ${job.error.message}`);
  }
  const turnLimit = turnLimitLine(job);
  if (turnLimit !== undefined) {
    console.log(`\n${turnLimit}`);
  }
  // A job parked on a usage limit.
  const limit = limitLine(job);
  if (limit !== undefined) {
    console.log(`\n${limit}`);
  }
  // The job in the user's checkout, or why it is not.
  const handover = handoverLines(job, (await jobs.readMrText(workspace, ticket))?.split(/\r?\n/)[0]);
  if (handover.length > 0) {
    console.log(`\n${handover.join('\n')}`);
  }
  if (job.worktree !== null) {
    console.log(`\nworktree: ${job.worktree}`);
  }
  // The dashboard's full URL, as for all jobs; before the marked paths, which end the output.
  const dashboard = await dashboardStatusUrl();
  if (dashboard !== undefined) {
    console.log(`${job.worktree !== null ? '' : '\n'}dashboard: ${dashboard}`);
  }
  // The marked paths (sensitive, outside the Task's scope, deleted) of the last published iteration.
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

// sf attach: the attachments module's rules on the files directly, without sf serve.
async function attach(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { remove: { type: 'string' } } });
  if (values.remove !== undefined ? positionals.length !== 2 : positionals.length < 3 || positionals.length > 4) {
    throw new UsageError('attach needs <workspace> <ticket> <file> [name], or <workspace> <ticket> --remove <name>.');
  }
  const [name, ticket] = checkJob(positionals, 'attach');
  // It changes the ticket's files in this process, past sf serve's gates.
  refuseWhileUpdating(stateDir());
  const workspace = await resolveWorkspace(name);
  const jobs = new JobStore(stateDir());
  if (values.remove !== undefined) {
    const removed = await removeAttachment(workspace, ticket, values.remove, jobs);
    console.log(`Removed ${TASK_DIR}/${ticket}/${removed.name}.`);
    return;
  }
  const path = positionals[2]!;
  let data: Buffer;
  const handle = await open(path, 'r').catch((error: NodeJS.ErrnoException) => {
    throw new FactoryError('file_unreadable', `${basename(path)} cannot be read (${error.code ?? 'error'}).`);
  });
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new FactoryError('file_unreadable', `${basename(path)} is not a regular file.`);
    }
    // Never read more than the limit allows: a larger file is refused unread.
    checkSize(stats.size);
    data = await handle.readFile();
  } finally {
    await handle.close();
  }
  const added = await addAttachment(workspace, ticket, data, jobs, positionals[3]);
  console.log(`Attached ${TASK_DIR}/${ticket}/${added.name} (${added.type}, ${added.bytes} bytes).`);
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
  const remoteOrigins = dashboardRemoteOrigins();
  const token = await readToken(stateDir());
  if (token === undefined) {
    throw new FactoryError('no_dashboard_token', 'There is no dashboard token: sf serve has not started with the dashboard on this state directory.');
  }
  const url = dashboardUrl(port, token).href;
  console.log(url);
  for (const remote of remoteDashboardUrls(remoteOrigins, token)) {
    console.log(`Through Tailscale: ${remote.href}`);
  }
  console.log('The token stays the same across sf serve starts; sf dashboard --rotate makes the next start pick a new one.');
  if (values.open === true) {
    // The URL is printed first so it can be opened by hand when the launcher fails.
    await openInBrowser(url);
  }
}

// `sf mcp-url`: the MCP URL with its token for an MCP client, the rotation, and the
// tunnel script's steps that need the token. The token is read from the state directory here and
// is never on a command line; every line but the URL itself and --header shows it as <token>.
const MCP_URL_OPTIONS = ['header', 'rotate', 'port', 'redact', 'probe', 'write-profile', 'check-profile'] as const;

async function mcpUrlCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, strict: true,
    options: {
      header: { type: 'boolean' }, rotate: { type: 'boolean' }, port: { type: 'boolean' }, redact: { type: 'boolean' }, probe: { type: 'boolean' },
      'write-profile': { type: 'string' }, 'check-profile': { type: 'string' },
    },
  });
  const chosen = MCP_URL_OPTIONS.filter((option) => values[option] !== undefined);
  if (positionals.length !== 0 || chosen.length > 1) {
    throw new UsageError(`mcp-url takes no arguments and one option at most: ${MCP_URL_OPTIONS.map((option) => `--${option}`).join(', ')}.`);
  }
  const state = stateDir();
  if (values.port === true) {
    console.log(String(await mcpPort()));
    return;
  }
  if (values.rotate === true) {
    await replaceMcpToken(state);
    console.log('MCP token rotated: a running sf serve answers only the new one from its next request.');
    console.log('Restart the tunnel (restart sf serve, which restarts its own; with SF_TUNNEL=off, npm run tunnel again), and give other MCP clients the new URL from sf mcp-url.');
    return;
  }
  if (values.redact === true) {
    // The filter outlives the tunnel client it reads: a missing token file still hides any token after /mcp/.
    await redactStream(await readMcpToken(state).catch(() => undefined));
    return;
  }
  const token = await requireMcpToken(state);
  if (values.probe === true) {
    await probe(token);
    return;
  }
  const port = await mcpPort();
  const writeProfile = values['write-profile'];
  if (writeProfile !== undefined) {
    // The file a link points at, so the link stays.
    const target = await realpath(writeProfile);
    // The file 0600 and the profile directory 0700, whether or not the URL changes (R4).
    const narrowed = await keepProfilePrivate(target, dirname(resolve(writeProfile)), true);
    const { text, changed } = rewriteProfileUrl(await readFile(target, 'utf8'), mcpUrl(port, token));
    if (changed) {
      await writeFileAtomic(target, Buffer.from(text, 'utf8'), 0o600);
    }
    console.log([`profile MCP url ${changed ? 'set to' : 'is'} ${mcpUrl(port)}`, ...narrowed].join('; '));
    return;
  }
  const checkProfile = values['check-profile'];
  if (checkProfile !== undefined) {
    await keepProfilePrivate(await realpath(checkProfile), dirname(resolve(checkProfile)), false);
    if (!profileHasUrl(await readFile(checkProfile, 'utf8'), mcpUrl(port, token))) {
      throw new FactoryError('profile_mcp_url_mismatch', `profile MCP url is not the factory's URL (/mcp/${TOKEN_LABEL})`);
    }
    return;
  }
  if (values.header === true) {
    console.log(mcpBaseUrl(port));
    console.log(`Authorization: Bearer ${token}`);
    return;
  }
  console.log(mcpUrl(port, token));
}

// The port of the MCP endpoint: SF_PORT, or with SF_PORT=0 (any free port) the one the
// running sf serve bound, asked on its socket; mcp_port_unknown when none answers.
async function mcpPort(): Promise<number> {
  const configured = parsePort('SF_PORT', DEFAULT_PORT);
  if (configured !== 0) {
    return configured;
  }
  const response = await callSocket(stateDir(), { command: socketName(COMMANDS.mcpPort), args: [] }).catch(() => undefined);
  const bound = response?.ok === true ? (response.result as { port?: unknown }).port : undefined;
  if (typeof bound !== 'number' || !Number.isInteger(bound) || bound < 1 || bound > 65535) {
    throw new FactoryError(
      'mcp_port_unknown',
      'SF_PORT is 0 (any free port), so the MCP port is the one the running sf serve bound, and no sf serve answers on this state directory (mcp_port_unknown): start sf serve, or set SF_PORT.',
    );
  }
  return bound;
}

// sf mcp-url --probe: exit 0 when the factory answers the token, 1 when it refuses it (or answers
// something else), 2 when nothing answers (a port that is not known included).
async function probe(token: string): Promise<void> {
  let port: number;
  try {
    port = await mcpPort();
  } catch (error) {
    if (!(error instanceof FactoryError) || error.code !== 'mcp_port_unknown') {
      throw error;
    }
    console.error('factory not reachable: SF_PORT is 0 (any free port) and no sf serve answers on this state directory');
    process.exitCode = 2;
    return;
  }
  const outcome = await probeMcp(port, token);
  if (outcome.result === 'answers') {
    console.log(`factory answers at ${mcpUrl(port)}`);
  } else if (outcome.result === 'refused') {
    console.error(`the factory refused the token at ${mcpUrl(port)}`);
    process.exitCode = 1;
  } else if (outcome.result === 'unreachable') {
    console.error(`factory not reachable at ${mcpUrl(port)}`);
    process.exitCode = 2;
  } else {
    console.error(`the factory at ${mcpUrl(port)} answered HTTP ${outcome.status} without an MCP result`);
    process.exitCode = 1;
  }
}

// sf mcp-url --redact: stdin to stdout, the token shown as <token>. Ignores SIGINT and SIGTERM
// and ends at the end of its input, so the tunnel client's last lines come through. Bytes pass
// as latin1 unchanged; the end of a chunk that may begin a token waits for the next one.
async function redactStream(token: string | undefined): Promise<void> {
  process.on('SIGINT', () => undefined);
  process.on('SIGTERM', () => undefined);
  // A reader that went away ends the filter.
  process.stdout.on('error', () => process.exit(0));
  const hold = `/mcp/`.length + 64;
  const write = async (text: string): Promise<void> => {
    if (text !== '' && !process.stdout.write(Buffer.from(text, 'latin1'))) {
      await new Promise((resolve) => process.stdout.once('drain', resolve));
    }
  };
  process.stdin.setEncoding('latin1');
  let pending = '';
  for await (const chunk of process.stdin as AsyncIterable<string>) {
    pending = redactMcpToken(pending + chunk, token);
    const keep = Math.max(pending.lastIndexOf('\n') + 1, pending.length - hold);
    await write(pending.slice(0, keep));
    pending = pending.slice(keep);
  }
  await write(redactMcpToken(pending, token));
}

// sf guard: the guard's check of a workspace's commits, branch name, MR text or worktree,
// run here; every hit printed with its matched text (a secret's never). Exit 1 on hits. Also
// sf guard install-hook <workspace>: the pre-push hook.
async function guard(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, strict: true,
    options: { remote: { type: 'string' }, branch: { type: 'string' }, mr: { type: 'string' }, worktree: { type: 'string' }, history: { type: 'boolean' } },
  });
  if (positionals.length === 2 && positionals[0] === 'install-hook') {
    if (Object.keys(values).length > 0) {
      throw new UsageError('guard install-hook takes only <workspace>.');
    }
    const name = positionals[1]!;
    checkName(name);
    const workspace = await resolveWorkspace(name);
    const written = await installHook(workspace.workCheckout, workspace.name, INSTALLED_SF);
    console.log(`${written.replaced ? 'Rewrote' : 'Wrote'} ${written.path}.`);
    return;
  }
  if (positionals.length < 1 || positionals.length > 2) {
    throw new UsageError('guard needs <workspace> [<rev> | <a>..<b>], or install-hook <workspace>.');
  }
  const [name, rev] = positionals as [string, string | undefined];
  checkName(name);
  const ticketOf = (option: 'mr' | 'worktree'): string | undefined => {
    const ticket = values[option];
    if (ticket !== undefined && !TICKET_PATTERN.test(ticket)) {
      throw new UsageError(`--${option} must be a ticket: ${TICKET_DESCRIPTION}.`);
    }
    return ticket;
  };
  const mrTicket = ticketOf('mr');
  const worktreeTicket = ticketOf('worktree');
  const range = rev !== undefined && rev.includes('..');
  if (range && values.history === true) {
    throw new UsageError('guard: --history takes a revision, not a range.');
  }
  if (range && values.remote !== undefined) {
    throw new UsageError('guard: --remote takes a revision, not a range.');
  }
  const workspace = await resolveWorkspace(name);
  const guarded = workspace.guard === true;
  if (!guarded) {
    console.error(`sf guard: workspace "${name}" is not guarded ("guard": true in workspaces.json); only secrets are checked.`);
  }
  const { terms, warnings } = await checkTerms({ workspace, guarded, configDir: configDir(), stateDir: stateDir(), envFile: envFilePath() });
  for (const warning of warnings) {
    console.error(`sf guard: warning: ${warning}`);
  }
  const checkout = workspace.workCheckout;
  const spec: CommitSpec = range
    ? { range: rev! }
    : values.history === true ? { rev: rev ?? 'HEAD', history: true } : { rev: rev ?? 'HEAD', remote: values.remote ?? 'origin', history: false };
  const commits = await commitsToCheck(checkout, spec);
  const hits: GuardHit[] = await scanCommits(checkout, commits, terms);
  const jobs = new JobStore(stateDir());
  const jobOf = async (ticket: string): Promise<Job> => {
    const job = await jobs.read(name, ticket);
    if (job === undefined) {
      throw new FactoryError('job_not_found', `No job ${name}/${ticket}.`);
    }
    return job;
  };
  let branch = values.branch;
  if (mrTicket !== undefined) {
    const job = await jobOf(mrTicket);
    const text = await jobs.readMrText(name, mrTicket);
    if (text === undefined) {
      throw new FactoryError('mr_text_missing', `The job ${name}/${mrTicket} has no MR text.`);
    }
    hits.push(...scanMrText(text, terms));
    branch ??= job.branch;
  }
  if (branch !== undefined) {
    hits.push(...scanBranch(branch, terms));
  }
  if (worktreeTicket !== undefined) {
    const job = await jobOf(worktreeTicket);
    if (job.worktree === null || job.base_commit === null || !existsSync(job.worktree)) {
      throw new FactoryError('worktree_missing', `The job ${name}/${worktreeTicket} has no worktree to check.`);
    }
    hits.push(...(await scanChange(job.worktree, job.base_commit, await worktreeTree(job.worktree, job.base_commit), terms)));
  }
  for (const hit of hits) {
    console.log(hitReport(hit, terms));
  }
  if (hits.length > 0) {
    console.log(`${hits.length} hits in ${commits.length} commits.`);
    process.exitCode = 1;
    return;
  }
  console.log(`No hits in ${commits.length} commits.`);
}

// `sf metrics`: the gate's runs, tokens, items and yield per job and in total.
async function metrics(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { since: { type: 'string' }, json: { type: 'boolean' } } });
  if (positionals.length > 1) {
    throw new UsageError(`unexpected argument "${positionals[1]}".`);
  }
  const since = values.since;
  if (since !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(since)) || new Date(since).toISOString().slice(0, 10) !== since)) {
    throw new UsageError(`--since must be a date YYYY-MM-DD, got "${since}".`);
  }
  const result = await collectMetrics(new JobStore(stateDir()), { workspace: positionals[0], since });
  console.log(values.json === true ? JSON.stringify(result, null, 2) : metricsLines(result).join('\n'));
}

// Whether an sf serve answers on the state directory's socket.
async function serveAnswers(): Promise<boolean> {
  try {
    return (await callSocket(stateDir(), { command: socketName(COMMANDS.ping), args: [] })).ok;
  } catch { // no socket or no answer: no sf serve answers
    return false;
  }
}

// The pid the answering sf serve reports in its ping; none when nothing answers, it
// refuses, or it names no pid (the ping of an sf serve built without the pid field).
async function servePid(): Promise<number | undefined> {
  try {
    const response = await callSocket(stateDir(), { command: socketName(COMMANDS.ping), args: [] });
    const pid = response.ok ? (response.result as { pid?: unknown } | null)?.pid : undefined;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch { // no socket or no answer: no pid to report
    return undefined;
  }
}

// The Task checks and hand-overs running inside the answering sf serve, one line each, in the
// texts of sf update's drain (sf service install refuses a restart while any runs).
async function serveBusy(): Promise<string[]> {
  const response = await callSocket(stateDir(), { command: 'serve-busy', args: [] });
  if (!response.ok) {
    throw new FactoryError(response.error.code, response.error.message);
  }
  const result = (response.result ?? {}) as { checks?: Array<{ workspace: string; ticket: string }>; handovers?: Array<{ workspace: string; ticket: string; step: string }> };
  return [
    ...(result.checks ?? []).map((check) => `the Task check of ${check.workspace}/${check.ticket}`),
    ...(result.handovers ?? []).map((handover) => `the ${handover.step} of ${handover.workspace}/${handover.ticket}`),
  ];
}

// The environment of the shell that ran sf, without what auth.env added, for sf service.
function shellEnv(fromEnvFile: readonly string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !fromEnvFile.includes(name)));
}

// sf service install|uninstall|status.
async function service(args: string[], fromEnvFile: readonly string[]): Promise<void> {
  const [command] = args;
  if (args.length !== 1 || (command !== 'install' && command !== 'uninstall' && command !== 'status')) {
    throw new UsageError('service needs install, uninstall or status.');
  }
  await serviceCommand(command, { env: shellEnv(fromEnvFile), fromEnvFile, serveAnswers, servePid, serveBusy });
}

// This package's root (factory/): dist/src/cli.js is two levels below it.
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// sf update [--check|--abandon] [--no-smoke]: the install is the Git top level of this
// package's root; npm runs in the package.
async function update(args: string[], fromEnvFile: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { check: { type: 'boolean' }, abandon: { type: 'boolean' }, 'no-smoke': { type: 'boolean' } } });
  if (positionals.length !== 0 || (values.check === true && values.abandon === true)) {
    throw new UsageError('update takes no arguments, and --check or --abandon at most (with --no-smoke).');
  }
  const install = await gitToplevel(PACKAGE_ROOT);
  if (install === undefined) {
    throw new FactoryError('install_not_git', 'install_not_git: this factory is not in a Git clone; sf update updates a Git install only.');
  }
  const packageDir = relative(install, await realpath(PACKAGE_ROOT));
  const state = stateDir();
  const sf = join(install, packageDir, 'bin', 'sf');
  process.exitCode = await runUpdate({
    stateDir: state, install, packageDir,
    mode: values.check === true ? 'check' : values.abandon === true ? 'abandon' : 'update',
    smoke: values['no-smoke'] !== true,
    server: { answers: serveAnswers, request: (command, commandArgs) => callSocket(state, { command, args: commandArgs }) },
    service: updateService({ env: shellEnv(fromEnvFile), serveAnswers }),
    npm: (npmArgs, cwd) => runCommand('npm', npmArgs, cwd),
    // The new code's smoke, in a process of its own.
    runSmoke: () => new Promise((resolve) => {
      const child = spawn(sf, ['smoke'], { stdio: 'inherit' });
      child.once('error', (error) => {
        console.error(`sf: sf smoke could not start: ${error.message}`);
        resolve(false);
      });
      child.once('close', (code) => resolve(code === 0));
    }),
    print: (line) => console.log(line),
  });
}

// The environment file as every command reads it, for sf guard: a file that cannot be read
// or parsed is the guard's fail-closed guard_failed, naming the file only (parseEnvFile's message
// quotes the line, which may hold a secret).
function guardEnvFile(): string[] {
  try {
    return loadEnvFile();
  } catch { // unreadable or malformed: guard_failed naming the file only, as parseEnvFile's message quotes the line
    throw new FactoryError('guard_failed', `${basename(envFilePath() ?? 'auth.env')} could not be read for the secret check.`);
  }
}

async function main(argv: string[]): Promise<void> {
  applyNetDefaults(); // before any connection: a longer connect attempt (src/net-defaults.ts)
  const [command, ...rest] = argv;
  // The planning copy's hook never fails the planner's session: an environment file that cannot be
  // read or parsed is one stderr line (naming the file only) and exit 0.
  if (command === 'planner' && isPlannerWaiting(rest)) {
    await plannerWaitingCommand(rest, () => {
      try {
        loadEnvFile();
      } catch { // unreadable or malformed: named by the file only, as parseEnvFile's message quotes the line
        throw new Error(`${basename(envFilePath() ?? 'auth.env')} could not be read.`);
      }
      return { env: process.env, configDir: configDir() };
    });
    return;
  }
  // SF_* settings from the environment file (auth.env), for every command alike; sf guard's own
  // failure never quotes the file's line.
  const fromEnvFile = command === 'guard' ? guardEnvFile() : loadEnvFile();
  if (command === 'service') {
    await service(rest, fromEnvFile);
    return;
  }
  if (command === 'update') {
    await update(rest, fromEnvFile);
    return;
  }
  if (command === 'planner') {
    await plannerCommand(rest, { env: process.env, stateDir: stateDir(), configDir: configDir(), mcpPort, print: (line) => console.log(line) });
    return;
  }
  // The commands of the table (src/commands.ts), sent to sf serve.
  const job = cliCommand(argv);
  if (job !== undefined) {
    await viaServer(job.command, job.args);
    return;
  }
  if (command === 'attach') {
    await attach(rest);
    return;
  }
  if (command === 'check-task') {
    await checkTask(rest);
    return;
  }
  if (command === 'rules') {
    await rules(rest);
    return;
  }
  if (command === 'notify-test') {
    await notifyTest(rest);
    return;
  }
  if (command === 'digest') {
    await digest(rest);
    return;
  }
  if (command === 'explain') {
    await explain(rest);
    return;
  }
  if (command === 'info') {
    await info(rest);
    return;
  }
  if (command === 'health') {
    // A request's keep-alive or a check's timer must not hold the exit.
    process.exit(await health(rest));
  }
  if (command === 'metrics') {
    await metrics(rest);
    return;
  }
  if (command === 'guard') {
    await guard(rest);
    return;
  }
  if (command === 'smoke') {
    // Its children are stopped and its directory gone; nothing is left to wait for.
    process.exit(await smoke(rest));
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
  if (command === 'mcp-url') {
    await mcpUrlCommand(rest);
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
  if (error instanceof FactoryError || (error instanceof Error && 'code' in error)) {
    console.error(`sf: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
