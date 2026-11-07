// The sf command: `sf serve`, `sf up` (serve, the tunnel and the browser), `sf workspace
// add|list|remove`, `sf start|say|review|retry|approve|pause|resume|restart|abort|reset`,
// `sf handover|takeback|handed-done` (SF-073) and
// `sf mr create|merge|status` and `sf queue list|add|remove|move|limit|hold|release` (SF-071)
// and `sf queue on-limit` (SF-072) and `sf queue force` (SF-086)
// (through the socket of sf serve),
// `sf status|watch|dashboard` (reading the state directory directly), `sf check-task` (the Task
// check of SF-054, run here and stored in the state directory), `sf rules` (the coding rules of
// SF-059, read here), `sf notify-test`, `sf info`, `sf metrics` (the gate's cost and yield, SF-092,
// reading the state directory directly), `sf smoke` (the live smoke test of SF-090,
// src/live-smoke.ts: its own sf processes on a throwaway repository and state)
// and `sf run`, the job's runner that sf serve starts (SF-042, src/runner.ts), and `sf digest
// [--now]` (the morning digest of SF-103, through the socket of sf serve), `sf service` (sf serve
// as a systemd user service, SF-101, src/service.ts) and `sf update` (the install updated, drained
// first, SF-101, src/update.ts).
// Exit codes: 0 ok, 1 error, 2 usage.
import { type ChildProcess, spawn } from 'node:child_process';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { open, readFile, realpath } from 'node:fs/promises';
import { addAttachment, checkSize, removeAttachment } from './attachments.js';
import { openInBrowser } from './browser.js';
import { envFilePath, gateConfig, gateLevelSetting, handoffSetting, loadConfig, loadEnvFile, rulesMaxBytes, stateDir } from './config.js';
import { Digests } from './digest-run.js';
import { DigestSchedule } from './digest-schedule.js';
import { DEFAULT_DASHBOARD_PORT, dashboardUrl, readToken, removeToken, type RunningDashboard, startDashboard } from './dashboard.js';
import { FactoryError } from './errors.js';
import { Execution, type StateListener } from './execution.js';
import { forgeSettings, withoutHostTokens } from './forge.js';
import { codexVersion } from './gate.js';
import { existsSync } from 'node:fs';
import { writeFileAtomic } from './atomic.js';
import { callSocket, listenSocket, socketPath } from './ipc.js';
import { type Job, type JobState, JobStore } from './jobs.js';
import { localTime } from './local-time.js';
import { collectMetrics, metricsLines } from './metrics.js';
import { MAX_RUNNING, MIN_RUNNING, ON_LIMIT_RULES, QueueStore, type QueueView, RunQueue } from './queue.js';
import { followJobs, runJob } from './runner.js';
import { jobNotification, notifyConfig, notifyTaskCheck, sendNotification, stateNotifier } from './notify.js';
import { configDir, HANDOFF_MODES, ignoredWorkCheckouts, isHandoffMode, isWorkspaceColor, loadRegistry, resolveWorkspace, saveRegistry, verifyCheckout, WORKSPACE_COLORS, workspaceColor, WORKSPACE_NAME_DESCRIPTION, WORKSPACE_NAME_PATTERN, type WorkspaceEntry } from './registry.js';
import {
  ensureMcpToken, keepProfilePrivate, loadHandbook, mcpBaseUrl, mcpUrl, packageVersion, PortInUseError, probeMcp, profileHasUrl, readMcpToken, redactMcpToken, requireMcpToken,
  replaceMcpToken, rewriteProfileUrl, SERVER_NAME, startServer, TOKEN_LABEL,
} from './server.js';
import { Setup } from './setup.js';
import { handoverLines, limitLine, type StatusRow, statusRows } from './status.js';
import { fileSummaryLines } from './patch.js';
import { prepareTaskChecksDir } from './sandbox-denials.js';
import { CheckStore, checkLines, checkSettings, refuseDraft, runTaskCheck, TaskChecks } from './task-check.js';
import { AutoChecks, planCheck } from './task-check-auto.js';
import { TicketHistory } from './ticket-history.js';
import { parseFrontMatter, readTask, TASK_DIR, TICKET_DESCRIPTION, TICKET_PATTERN } from './task-file.js';
import { gitToplevel, runGit } from './git.js';
import { resolveTarget } from './mr.js';
import { collectRules, readJobRulesList, rulesLines } from './rules-docs.js';
import { turnLimitLine } from './turn-limit.js';
import { watchEvents } from './watch.js';
import { DEFAULT_BUDGET_USD, DEFAULT_TIMEOUT_MIN, positiveDecimal, runSmoke } from './live-smoke.js';
import { serviceCommand, updateService } from './service.js';
import { checkStateVersion } from './state-version.js';
import {
  MARKER_POLL_MS, markerAtServeStart, markerLines, MarkerWatch, putMarkerBack, readSkippedChecks, recordSkippedCheck, refuseWhileUpdating, removeSkippedChecks, runCommand, runUpdate, updateMarked,
} from './update.js';

const DEFAULT_PORT = 8787;
const USAGE = `Usage:
  sf serve                                              Serve the MCP tools on 127.0.0.1:\${SF_PORT:-${DEFAULT_PORT}}/mcp/<token> and the dashboard; the token (mcp-token in the state directory) is made on the first start
  sf mcp-url [--header|--rotate|--port]                 Print the MCP URL with its token, for an MCP client (claude mcp add --transport http software-factory <url>); --header: the URL without it and the Authorization header; --rotate: a new token (sf serve takes it at once; restart the tunnel); --port: the port only
  sf mcp-url --write-profile|--check-profile <file>     The tunnel's steps (scripts/sf-tunnel.sh): set the profile's MCP url line to the URL with the token, or check that it is (exit 1 when not)
  sf mcp-url --redact|--probe                           The tunnel's steps: copy stdin to stdout with the token shown as <token>; send an MCP initialize with the token (exit 0 answers, 1 refused, 2 not reachable)
  sf up [--no-open] [--no-tunnel]                       sf serve plus the planning tunnel for ChatGPT (scripts/sf-tunnel.sh run) in one terminal, and open the dashboard; Ctrl+C stops both
  sf dashboard [--open] [--rotate]                      Print the dashboard URL; --open also opens it (xdg-open); --rotate removes the token so the next sf serve makes a new one
  sf workspace add <name> --read <path> [--handoff checkout|off] [--color <name>]  Register a workspace: the local checkout (every job works in a worktree of it); --handoff: its own hand-over setting, over SF_HANDOFF; --color: its colour on the board (blue, teal, green, olive, orange, red, purple or grey; default: by its name). Again with the same path: changes the --handoff and --color given
  sf workspace list                                     List registered workspaces, their hand-over setting and colour
  sf workspace remove <name>                            Unregister a workspace
  sf check-task <workspace> <ticket>                    Check the Task file before Start: a read-only Claude session reads it and the repository, and prints its paraphrase, its findings by severity and its verdict (stored by the Task file's sha256; it only advises). sf serve checks a written Task file by itself 60 s after its last change (SF_TASK_CHECK_AUTO)
  sf rules <workspace> [ticket]                         List the coding rules the agents would be given (AGENTS.md and the Markdown files it links to, the user's rules files): paths, sources, sizes and the files left out, without their text; a started job's stored list, else read at the Task file's base, else at the checkout's HEAD
  sf attach <workspace> <ticket> <file> [name]          Attach an image (PNG, JPEG, WebP or GIF by its bytes, at most 5 MB, 10 per ticket) to the ticket: .software-factory/<ticket>/<name> next to its Task file; name: default the next number (1.png, 2.png, ...); refused while a job of the ticket runs (paused aside); no sf serve needed
  sf attach <workspace> <ticket> --remove <name>        Remove an image of the ticket, under the same guard
  sf start <workspace> <ticket>                         Start the job for .software-factory/<ticket>.md in a worktree of its own
  sf queue list                                         The run queue: the limit of jobs at once, the running count, held or not (by hand, or by a job parked on a usage limit), the rule at a limit's reset, and the queued tickets in order with what each waits for, and the starts that failed
  sf queue add <workspace> <ticket> [--at N]            Queue a planned ticket at position N (1-based; default: the end); sf serve starts it by itself when a slot is free, its lands_after tickets are merged and the Task check of its current Task file is ready
  sf queue remove <workspace> <ticket>                  Take a ticket out of the queue
  sf queue move <workspace> <ticket> <N>                Move a queued ticket to position N
  sf queue limit <N>                                    Run up to N jobs at once (1-20, every workspace; default SF_MAX_JOBS); gates only the queue's own starts, a start by hand always goes
  sf queue hold [reason...]                             Hold the queue: it starts nothing until sf queue release
  sf queue release                                      Release a held queue (a job parked on a usage limit still holds it until it goes on)
  sf queue on-limit resume-then-queue|resume-only|wait  What happens when a usage limit resets: resume the parked jobs, then start queued tickets again (default); resume them and hold the queue; or hold the queue and let you resume them
  sf queue force <workspace> <ticket>                   Start anyway: the queued ticket starts whatever its Task check says, until it leaves the queue
  sf say <workspace> <ticket> <message...>              Send a message into the job's Implementer session; on a handed-over job: Ask for changes (your checkout's edits go back into the job first)
  sf review <workspace> <ticket>                        Retry a failed Claude review (needs_human with review_failed) of the last iteration
  sf retry <workspace> <ticket>                         Retry a transient MR preparation failure (fetch_failed, mr_serve_restarted, mr_interrupted, mr_commit_failed, mr_rebase_failed, mr_failed) without a new review; on mr_push_failed: push again
  sf accept <workspace> <ticket>                        Accept a clean Claude review over a stopped gate (needs_human with gate_rounds, gate_budget or gate_failed) or a ledger stop (review_churn, review_disputed) and prepare the MR; on simplify_offered: skip the suggestions (listed in the MR text)
  sf simplify <workspace> <ticket>                      Apply the simplification pass's suggestions (needs_human with simplify_offered): one Fix section "Simplify", reviewed as usual; sf accept skips them
  sf settle <workspace> <ticket> <id> accept|fix [note...]  Settle an escalated or contested finding of the ledger (needs_human): accept the risk, or the Implementer must fix it; the job goes on once nothing is left to settle
  sf status [<workspace> <ticket>]                      Show one job or all jobs: state, iterations, estimated cost, elapsed time
  sf watch <workspace> <ticket> [--once]                Show the session live (Ctrl+C stops)
  sf approve <workspace> <ticket> [--as-is]             Push the branch prepared at Clean; --as-is pushes it even if its tip was edited by hand
  sf mr create <workspace> <ticket>                     Open the merge request of a pushed job on GitHub or GitLab (or reuse the open one); from ready_for_human_review: approve, then open it
  sf mr merge <workspace> <ticket>                      Merge the job's open merge request through the host's API; refused with the host's reason when it cannot be merged
  sf mr status <workspace> <ticket>                     The merge request's state on the host: open, merged or closed, mergeable or not, the checks
  sf pause <workspace> <ticket>                         Pause a working job or one awaiting review: the turn, review or gate stops at once; worktree, branch, session and history stay
  sf resume <workspace> <ticket> [message...]           Go on with a paused job, or one waiting for a usage limit (now, before the reset), where it stopped (the turn with the message, or "Continue where you stopped."; an interrupted review or gate runs again); a Task file changed meanwhile is handed on with its diff
  sf restart <workspace> <ticket> [--keep-files]        Start the ticket again from its current Task file on a fresh worktree and branch (paused, waiting_limit, aborted, failed or needs_human); the old job is archived, its branch deleted only without commits and never pushed; --keep-files copies the old worktree's changed and new files in first
  sf handover <workspace> <ticket>                      Hand over to my checkout: the job's branch in the workspace's checkout at its base, the job's changes as Local Changes, the commit message prefilled (ready_for_human_review; automatic with hand-over on: the workspace's handoff, else SF_HANDOFF=checkout)
  sf takeback <workspace> <ticket>                      Take it back: the branch back from your checkout into the job (handed_over), only while your checkout is as the factory left it
  sf handed-done <workspace> <ticket>                   I opened the MR myself: the job is pushed once origin has the branch with your changes (handed_over)
  sf abort <workspace> <ticket> [--discard]             End the job; the worktree stays (its path is printed); --discard removes the worktree and the branch
  sf reset <workspace> <ticket>                         End the session, remove the worktree and archive the job; the branch is untouched
  sf digest [--now]                                     The morning digest of the followed workspaces (sf serve makes one a day at digest.at in workspaces.json): without --now, the latest digest's period and counts; --now makes one at once and prints the path of its record and its cost
  sf notify-test                                        Send a test notification on every channel
  sf info                                               Version, directories, settings, whether sf serve and the tunnel run, workspaces, jobs
  sf metrics [<workspace>] [--since YYYY-MM-DD] [--json]  The Codex gate per job, current and archived: gate levels per iteration (F full, L light, l light skipped, - none, · no decision, ? unreadable), runs, tokens, items by outcome and the yield (fixed over all items), then the totals; no sf serve needed
  sf smoke [--keep] [--timeout-min N] [--budget-usd N]  The live smoke test: one tiny real job (Claude Code, Codex, Git) from Task check to push, on a throwaway repository with a local bare remote, its own sf serve and state in one temporary directory (never yours); prints a pass/fail table. Models: SF_SMOKE_MODEL (default haiku), SF_SMOKE_CODEX_MODEL (default: Codex's); budget: --timeout-min (default ${DEFAULT_TIMEOUT_MIN}) and --budget-usd (default ${DEFAULT_BUDGET_USD}), positive numbers; --keep keeps the directory
  sf run <workspace> <ticket>                           The job's runner: its turns, reviews and gate, detached from sf serve (sf serve starts it; one per job)
  sf service install|uninstall|status                   sf serve as a systemd user service (software-factory.service in ~/.config/systemd/user, KillMode=process: running jobs outlive a stop or restart); install writes and enables it (refused while an sf serve started by hand answers); logs: journalctl --user -u software-factory
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

class UsageError extends Error {}

// The socket commands that still answer while the factory is being updated (SF-101): pause (the
// update's own tool), mr-status (it starts nothing) and the reads.
const OPEN_WHILE_UPDATING: ReadonlySet<string> = new Set(['ping', 'queue-list', 'serve-busy', 'digest-latest', 'mcp-port', 'pause', 'mr-status', 'check']);

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
  // The Task checks' parent directory (SF-100), which every other session denies: made now; an unsafe
  // one (a link, another owner) is one warning, and every Task check then fails with task_check_dir_unsafe.
  await prepareTaskChecksDir().catch((error: unknown) => console.error(`warning: ${error instanceof Error ? error.message : String(error)}`));
  // The run queue (SF-071): an invalid queue.json fails here, as an invalid registry does.
  const queueStore = new QueueStore(config.stateDir, config.maxJobs);
  await queueStore.read();
  const jobs = new JobStore(config.stateDir);
  const notify = stateNotifier(notifyConfig(), jobs);
  // The dashboard starts after recovery; until then its listener is a no-op. So does the run
  // queue's scheduler: its first pass runs once recovery is done.
  let dashboard: RunningDashboard | undefined;
  let scheduling = false;
  const reschedule = (job: Job, from: JobState | null): void => {
    if (scheduling && from !== job.state) {
      void runQueue.schedule();
    }
  };
  // A job of the ticket that runs (non-terminal, not paused) cancels its automatic Task checks
  // (SF-086): no check runs on a Task file a job is using.
  let autoChecks: AutoChecks | undefined;
  const onStateChange: StateListener = (job, from, lines) => {
    autoChecks?.jobChanged(job);
    notify(job, from, lines);
    dashboard?.onStateChange(job, from);
    reschedule(job, from);
  };
  const execution = new Execution(config, (name) => resolveWorkspace(name), onStateChange, handbook.text, testLockProc());
  // The tickets' history (SF-081): New ticket and Save (Setup) and write_task (the MCP server)
  // record the Task file's writes; Execution records its Fix sections itself.
  const history = new TicketHistory(config.stateDir);
  // The start screen of the dashboard: the registry and the Task files, under the Execution's lock.
  // A finished job leaves with its Task file through the lock's scope, in the same acquisition as
  // the ticket action's checks: it is archived and a kept worktree removed.
  const setup = new Setup({ configDir: configDir(), jobs, exclusive: (work) => execution.exclusive(work), history, handoffDefault: config.handoff });
  // The morning digest (SF-103): one a day by the timer, Generate now on the dashboard, sf digest
  // --now through the socket; a scheduled one is notified with its counts.
  const digests = new Digests({
    stateDir: config.stateDir, configDir: configDir(), claudePath: config.claudePath,
    notify: (notification) => sendNotification(notification, notifyConfig()),
  });
  const digestSchedule = new DigestSchedule({ digests, configDir: configDir() });
  // The run queue's scheduler: a pass after recovery, on every job state change (sf serve's own and
  // the runners', below), on every change of the queue; a pass that changed something refreshes
  // every page.
  // At a usage limit's reset (SF-072) it resumes the parked jobs (or marks them, under wait) and sends
  // one notification. With the automatic checks (SF-086) the queue starts a ticket only when its plan
  // is ready or forced, and a ticket added without a check gets one.
  const runQueue = new RunQueue(queueStore, execution, setup, jobs, {
    onChange: () => dashboard?.refreshSetup(),
    notify: (notification) => sendNotification(notification, notifyConfig()),
    planCheck: (workspace, ticket) => planCheck(checks, autoChecks, workspace, ticket),
    onAdded: (workspace, ticket) => void autoChecks?.triggerIfUnchecked(workspace, ticket),
    // The updating marker (SF-101): no start and no limit reset while sf update drains or builds.
    updating: () => updateMarked(config.stateDir),
  });
  // The Task checks (SF-054): started from the dashboard, read by the Context owner's task_check; an ended
  // check reaches every page.
  // A check's worktree shares the checkout's Git directory: when the last check of the workspace
  // ended, the config lock its sandbox left goes unless a job runs there (SF-085).
  const checks: TaskChecks = new TaskChecks({
    ...checkSettings(config, configDir()), resolve: (name) => resolveWorkspace(name),
    onSettled: (workspace, ticket) => {
      dashboard?.refreshSetup();
      if (!checks.runningIn(workspace)) {
        void execution.afterTaskCheck(workspace, ticket);
      }
      // A queued ticket may be ready now (SF-086).
      void runQueue.schedule();
    },
  });
  // The automatic Task checks (SF-086), unless SF_TASK_CHECK_AUTO=off: write_task, the watcher of
  // every workspace's .software-factory folder and the run queue trigger them; a check that ends not
  // ready or failed is notified like a job.
  if (config.taskCheckAuto) {
    const notifySettings = notifyConfig();
    // Tests only (SF_TEST_HOOKS=on): a shorter time from the last trigger to the check.
    const testDelay = process.env.SF_TEST_HOOKS === 'on' && /^\d+$/.test(process.env.SF_TEST_TASK_CHECK_DELAY_MS ?? '') ? Number(process.env.SF_TEST_TASK_CHECK_DELAY_MS) : undefined;
    autoChecks = new AutoChecks({
      checks, jobs, resolve: (name) => resolveWorkspace(name), parallel: config.taskCheckParallel,
      ...(testDelay !== undefined ? { delayMs: testDelay } : {}),
      workspaces: async () => Object.entries((await loadRegistry()).workspaces).map(([name, entry]) => ({ name, workCheckout: entry.read_checkout })),
      onCheckEnded: (record) => {
        dashboard?.refreshSetup();
        void notifyTaskCheck(record, notifySettings);
      },
      // The updating marker (SF-101): a check due meanwhile is recorded for the catch-up.
      update: { updating: () => updateMarked(config.stateDir), skipped: (workspace, ticket) => recordSkippedCheck(config.stateDir, { workspace, ticket }) },
    });
  }
  const testHooks = process.env.SF_TEST_HOOKS === 'on';
  // The port the MCP endpoint bound, once it listens (SF_PORT=0: any free port).
  let boundMcpPort: number | undefined;
  // The socket first: it refuses a second sf serve on the same state before recovery touches it.
  const socket = await listenSocket(config.stateDir, async ({ command, args }) => {
    // The updating marker's gate (SF-101): while sf update drains or builds, every command that
    // changes something is refused before it does; pause, mr-status and the reads still answer.
    if (!OPEN_WHILE_UPDATING.has(command)) {
      refuseWhileUpdating(config.stateDir);
    }
    // sf info: whether sf serve answers.
    if (command === 'ping') {
      return {};
    }
    // sf update's drain (SF-101): the Task checks and the hand-over operations running here now.
    if (command === 'serve-busy' && args.length === 0) {
      return { checks: checks.running(), handovers: execution.handoversRunning() };
    }
    // sf digest --now and sf digest (SF-103).
    if (command === 'digest-run' && args.length === 0) {
      const { id, path, cost_usd } = await digests.run('manual');
      return { id, path, cost_usd };
    }
    if (command === 'digest-latest' && args.length === 0) {
      const latest = await digests.latest();
      return latest === undefined ? { digest: null } : { digest: latest.id, period: latest.period, counts: latest.counts, error: latest.error };
    }
    // sf mcp-url with SF_PORT=0 (SF-099): the port the MCP endpoint bound.
    if (command === 'mcp-port') {
      if (boundMcpPort === undefined) {
        throw new FactoryError('serve_starting', 'sf serve has not opened its MCP endpoint yet.');
      }
      return { port: boundMcpPort };
    }
    if (command.startsWith('queue-')) {
      const result = await queueCommand(runQueue, command.slice('queue-'.length), args);
      if (command !== 'queue-list') {
        dashboard?.refreshSetup();
      }
      return result;
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
    if (command === 'retry' && words.length === 0) {
      return execution.retryMr(workspace, ticket);
    }
    if (command === 'accept' && words.length === 0) {
      return execution.acceptGate(workspace, ticket);
    }
    if (command === 'simplify' && words.length === 0) {
      return execution.simplify(workspace, ticket);
    }
    if (command === 'settle' && words.length >= 2 && (words[1] === 'accept' || words[1] === 'fix')) {
      return execution.settle(workspace, ticket, words[0]!, words[1], words.slice(2).join(' '));
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
    // sf pause, resume and restart (SF-067).
    if (command === 'pause' && words.length === 0) {
      return execution.pause(workspace, ticket);
    }
    if (command === 'resume') {
      return execution.resumePaused(workspace, ticket, words.join(' '));
    }
    if (command === 'restart' && (words.length === 0 || (words.length === 1 && words[0] === '--keep-files'))) {
      return execution.restart(workspace, ticket, words.length === 1);
    }
    // sf handover, takeback and handed-done (SF-073).
    if (command === 'handover' && words.length === 0) {
      return execution.handover(workspace, ticket);
    }
    if (command === 'takeback' && words.length === 0) {
      return execution.takeback(workspace, ticket);
    }
    if (command === 'handed-done' && words.length === 0) {
      return execution.handedDone(workspace, ticket);
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
  // The updating marker at the start (SF-101): the jobs of a finished (restart_pending) or dead
  // (draining) update to resume, the marker removed already; or a marker that stays, under which
  // recovery repairs the states but starts no runner.
  // A start that fails after it took the marker puts it back, so the next sf serve resumes the jobs.
  let atStart: Awaited<ReturnType<typeof markerAtServeStart>> | undefined;
  try {
    // The state format (SF-101): a newer one is refused (state_too_new) before anything reads it.
    await checkStateVersion(config.stateDir);
    // The MCP token (SF-099): made on the first start; an invalid file stops the start.
    const narrowed = await ensureMcpToken(config.stateDir);
    if (narrowed !== undefined) {
      console.error(`warning: ${narrowed}`);
    }
    atStart = await markerAtServeStart(config.stateDir);
    await execution.recover({ startRunners: !atStart.gated });
    server = await startServer(port, config.stateDir, handbook, await packageVersion(), execution, checks, history, runQueue, autoChecks);
    boundMcpPort = server.port;
  } catch (error) {
    await putMarkerBack(config.stateDir, atStart?.taken).catch((putError: unknown) => console.error(putError));
    await socket.close();
    throw error;
  }
  try {
    if (dashboardOn()) {
      // The dashboard's actions (DashboardActions: start, approve, abort, say, retryReview,
      // acceptGate and archiveFinished) run on the same Execution as the socket commands.
      dashboard = await startDashboard(dashboardPort, config.stateDir, jobs, execution, setup, {
        gate: config.gate.on, checks, queue: runQueue, onWorkspacesChanged: () => void autoChecks?.rereadWorkspaces(), digests,
      });
    } else {
      await removeToken(config.stateDir);
    }
  } catch (error) {
    await putMarkerBack(config.stateDir, atStart.taken).catch((putError: unknown) => console.error(putError));
    await Promise.all([server.close(), socket.close()]);
    throw error;
  }
  console.log(dashboard !== undefined ? `${SERVER_NAME} dashboard ${dashboard.url.href}` : `${SERVER_NAME} dashboard off (SF_DASHBOARD=off)`);
  if (!config.gate.on && config.gate.missing === true) {
    console.log(`gate: off (${config.gate.reason}); the Claude review decides`);
  }
  console.log(`${SERVER_NAME} listening on ${mcpUrl(server.port)}`);
  console.log(`${SERVER_NAME} socket ${socket.path}`);
  // The runners write the state of their jobs; the dashboard hears of it from disk (SF-042). A job
  // that left working, awaiting_review or preparing_mr may free a hand-over that met the sandbox's config lock
  // (SF-085), and so may sf serve's start.
  // The run queue hears of both: a runner's job that reached ready_for_human_review frees a slot.
  const followed = followJobs(jobs, (job, from) => {
    autoChecks?.jobChanged(job);
    dashboard?.onStateChange(job, from);
    execution.afterJobChange(job, from).catch((error: unknown) => console.error(error));
    reschedule(job, from);
  });
  execution.handOverLocked().catch((error: unknown) => console.error(error));
  scheduling = true;
  void runQueue.schedule();
  await autoChecks?.start();
  digestSchedule.start();
  // The updating marker while sf serve runs (SF-101): its poll; the catch-up once the marker is gone
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
  }, testHooks && /^\d+$/.test(process.env.SF_TEST_MARKER_POLL_MS ?? '') ? Number(process.env.SF_TEST_MARKER_POLL_MS) : MARKER_POLL_MS);
  if (atStart.resume !== undefined) {
    markerWatch.finish(atStart.resume).catch((error: unknown) => console.error(error)).finally(() => markerWatch.start());
  } else {
    markerWatch.start();
  }

  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`${SERVER_NAME} received ${signal}, shutting down`);
    hooks.beforeStop?.();
    followed.close();
    markerWatch.close();
    runQueue.close();
    autoChecks?.close();
    digestSchedule.close();
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

function startTunnel(token: string | undefined): Tunnel | undefined {
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
        console.error(`tunnel | ${redactMcpToken(line, token)}`);
      }
    });
    stream.on('end', () => {
      if (rest !== '') {
        console.error(`tunnel | ${redactMcpToken(rest, token)}`);
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
    // The tunnel's lines never show the MCP token (SF-099), which serve has made by now.
    tunnel = startTunnel(await readMcpToken(stateDir()).catch(() => undefined));
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

// The hand-over setting that decides for a workspace's jobs (SF-083): its own handoff, else
// SF_HANDOFF with this shell's value (sf serve reads its own environment).
function handoffLabel(entry: WorkspaceEntry): string {
  if (entry.handoff !== undefined) {
    return `${entry.handoff} (this workspace)`;
  }
  try {
    return `${handoffSetting()} (SF_HANDOFF)`;
  } catch {
    return 'SF_HANDOFF (invalid)';
  }
}

// The workspace's colour on the board (SF-084): its own, else the one its name picks.
function colorLabel(name: string, entry: WorkspaceEntry): string {
  return entry.color !== undefined ? entry.color : `${workspaceColor(name)} (by its name)`;
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
    options: command === 'add' ? { read: { type: 'string' }, work: { type: 'string' }, handoff: { type: 'string' }, color: { type: 'string' } } : {},
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
      console.log(`${name}\n  checkout: ${entry.read_checkout}\n  hand-over: ${handoffLabel(entry)}\n  colour: ${colorLabel(name, entry)}`);
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
    const handoff = values.handoff;
    if (handoff !== undefined && !isHandoffMode(handoff)) {
      throw new UsageError(`--handoff must be ${HANDOFF_MODES.join(' or ')}, got "${String(handoff)}".`);
    }
    const color = values.color;
    if (color !== undefined && !isWorkspaceColor(color)) {
      throw new UsageError(`--color must be one of ${WORKSPACE_COLORS.join(', ')}, got "${String(color)}".`);
    }
    const registry = await loadRegistry();
    const real = await checkout(read, '--read');
    // Registered: the same checkout with --handoff or --color changes those (SF-084), the rest stays.
    const existing = Object.hasOwn(registry.workspaces, name) ? registry.workspaces[name] : undefined;
    if (existing !== undefined && (existing.read_checkout !== real || (handoff === undefined && color === undefined))) {
      throw new FactoryError('workspace_exists', `workspace "${name}" is already registered; remove it first, or give the same --read with --handoff or --color to change those.`);
    }
    const entry: WorkspaceEntry = { ...existing, read_checkout: real, ...(handoff !== undefined ? { handoff } : {}), ...(color !== undefined ? { color } : {}) };
    registry.workspaces[name] = entry;
    await saveRegistry(registry);
    console.log(`${existing === undefined ? 'Registered' : 'Updated'} workspace "${name}" (checkout: ${entry.read_checkout}; hand-over: ${handoffLabel(entry)}; colour: ${colorLabel(name, entry)}).`);
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

// sf queue's socket commands (SF-071), run by sf serve's run queue.
function queueCommand(queue: RunQueue, command: string, args: string[]): Promise<unknown> {
  const [workspace = '', ticket = ''] = args;
  if (command === 'list' && args.length === 0) {
    return queue.view();
  }
  if (command === 'add' && (args.length === 2 || args.length === 3)) {
    return queue.add(workspace, ticket, args[2] === undefined ? undefined : Number(args[2]));
  }
  if (command === 'remove' && args.length === 2) {
    return queue.remove(workspace, ticket);
  }
  if (command === 'move' && args.length === 3) {
    return queue.move(workspace, ticket, Number(args[2]));
  }
  if (command === 'limit' && args.length === 1) {
    return queue.limit(Number(args[0]));
  }
  if (command === 'hold') {
    return queue.hold(args.join(' '));
  }
  if (command === 'release' && args.length === 0) {
    return queue.release();
  }
  if (command === 'on-limit' && args.length === 1) {
    return queue.rule(args[0]!);
  }
  if (command === 'force' && args.length === 2) {
    return queue.force(workspace, ticket);
  }
  return Promise.reject(new FactoryError('bad_request', `Unknown command "queue-${command}".`));
}

// sf queue list: the limit, the running count, held or not, the entries in order with what each
// waits for, the next one to start and the starts that failed.
function queueLines(view: QueueView): string[] {
  const ref = (row: { workspace: string; ticket: string }): string => `${row.workspace}/${row.ticket}`;
  const lines = [
    `limit: ${view.max_running} job${view.max_running === 1 ? '' : 's'} at once`,
    `running: ${view.running}`,
    `held: ${view.held ? `yes${view.hold_reason !== null ? ` (${view.hold_reason})` : ''}` : 'no'}`,
    // The limit hold (SF-072): parked jobs hold the queue, whatever the hold by hand.
    ...(view.limit_hold !== null ? [`usage limit: ${view.limit_hold.parked} parked job${view.limit_hold.parked === 1 ? ' holds' : 's hold'} the queue${view.limit_hold.resets_at !== null ? `, resets at ${localTime(view.limit_hold.resets_at)}` : ''}`] : []),
    `on limit reset: ${view.on_limit}`,
    `next: ${view.next !== null ? ref(view.next) : 'nothing ready'}`,
  ];
  lines.push(view.entries.length === 0 ? 'queue: empty' : 'queue:');
  for (const entry of view.entries) {
    const waits = entry.waits_for.map((dep) => `${ref(dep)} (${dep.state})`).join(', ');
    const plan = entry.force ? '  forced (Start anyway)' : entry.plan_reason !== null ? `  ${entry.plan_reason}` : '';
    lines.push(`  ${entry.position}. ${ref(entry)}${waits !== '' ? `  waits for ${waits}` : ''}${plan}`);
  }
  if (view.errors.length > 0) {
    lines.push('start failed:');
    for (const error of view.errors) {
      lines.push(`  ${ref(error)}  ${error.code}: ${error.message}`);
    }
  }
  return lines;
}

// A 1-based position or a limit as typed: digits only.
function wholeNumber(value: string | undefined, what: string): string {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new UsageError(`${what} must be a whole number.`);
  }
  return value;
}

// sf queue list|add|remove|move|limit|hold|release|on-limit|force: the arguments checked here, the change in sf serve.
async function queue(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === 'list') {
    if (rest.length !== 0) {
      throw new UsageError('queue list takes no arguments.');
    }
    console.log(queueLines((await request('queue-list', [])) as unknown as QueueView).join('\n'));
    return;
  }
  if (command === 'add') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, strict: true, options: { at: { type: 'string' } } });
    if (positionals.length !== 2) {
      throw new UsageError('queue add needs <workspace> <ticket> [--at N].');
    }
    const at = values.at === undefined ? [] : [wholeNumber(values.at, '--at')];
    await viaServer('queue-add', [...checkJob(positionals, 'queue add'), ...at]);
    return;
  }
  if (command === 'remove') {
    if (rest.length !== 2) {
      throw new UsageError('queue remove needs <workspace> <ticket>.');
    }
    await viaServer('queue-remove', checkJob(rest, 'queue remove'));
    return;
  }
  if (command === 'move') {
    if (rest.length !== 3) {
      throw new UsageError('queue move needs <workspace> <ticket> <N>.');
    }
    await viaServer('queue-move', [...checkJob(rest, 'queue move'), wholeNumber(rest[2], 'N')]);
    return;
  }
  if (command === 'limit') {
    if (rest.length !== 1) {
      throw new UsageError(`queue limit needs <N>, ${MIN_RUNNING} to ${MAX_RUNNING}.`);
    }
    await viaServer('queue-limit', [wholeNumber(rest[0], 'N')]);
    return;
  }
  if (command === 'hold') {
    await viaServer('queue-hold', rest);
    return;
  }
  if (command === 'release') {
    if (rest.length !== 0) {
      throw new UsageError('queue release takes no arguments.');
    }
    await viaServer('queue-release', []);
    return;
  }
  if (command === 'on-limit') {
    if (rest.length !== 1 || !(ON_LIMIT_RULES as readonly string[]).includes(rest[0]!)) {
      throw new UsageError(`queue on-limit needs one of ${ON_LIMIT_RULES.join(', ')}.`);
    }
    await viaServer('queue-on-limit', rest);
    return;
  }
  if (command === 'force') {
    if (rest.length !== 2) {
      throw new UsageError('queue force needs <workspace> <ticket>.');
    }
    await viaServer('queue-force', checkJob(rest, 'queue force'));
    return;
  }
  throw new UsageError(command === undefined ? 'a queue command is required.' : `unknown queue command "${command}".`);
}

async function approve(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { 'as-is': { type: 'boolean' } } });
  if (positionals.length !== 2) {
    throw new UsageError('approve needs <workspace> <ticket> [--as-is].');
  }
  const result = await viaServer('approve', [...checkJob(positionals, 'approve'), ...(values['as-is'] === true ? ['--as-is'] : [])]);
  if (result.state === 'needs_human' || (result.state === 'handed_over' && result.error !== undefined)) {
    console.log('The push failed; fix it and run sf approve again.');
  } else if (result.state === 'pushed' && result.link === undefined) {
    console.log('No merge request link: the origin URL could not be parsed. Open the merge request for the branch above.');
  }
  if (result.state !== 'pushed') {
    process.exitCode = 1;
  }
}

// sf retry (SF-087): MR preparation again, shown as sf review shows its outcome; on mr_push_failed
// the push again, shown and ended as sf approve (exit 1 unless pushed).
async function retry(args: string[]): Promise<void> {
  if (args.length !== 2) {
    throw new UsageError('retry needs <workspace> <ticket>.');
  }
  const result = await viaServer('retry', checkJob(args, 'retry'));
  if ('iteration' in result) {
    return;
  }
  if (result.state !== 'pushed') {
    console.log('The push failed; fix it and run sf retry again.');
    process.exitCode = 1;
  } else if (result.link === undefined) {
    console.log('No merge request link: the origin URL could not be parsed. Open the merge request for the branch above.');
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

// sf restart <workspace> <ticket> [--keep-files] (SF-067), through the socket of sf serve.
async function restart(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { 'keep-files': { type: 'boolean' } } });
  if (positionals.length !== 2) {
    throw new UsageError('restart needs <workspace> <ticket> [--keep-files].');
  }
  const result = await viaServer('restart', [...checkJob(positionals, 'restart'), ...(values['keep-files'] === true ? ['--keep-files'] : [])]);
  console.log(result.branch_deleted === null ? 'The old job is archived; it had no branch to delete.' : 'The old job is archived and its branch deleted (no commits, never pushed).');
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

// Tests only (SF_TEST_HOOKS=on, SF-105): SF_TEST_PROC_DIR, a /proc of the test's own that the
// sandbox's config lock check scans instead of the real one, so that the machine's other processes
// cannot keep a test's lock. sf serve, its runners (sf run inherits the environment) and sf
// check-task read it; without SF_TEST_HOOKS=on it is ignored.
function testLockProc(): { lockProc?: string } {
  const dir = process.env.SF_TEST_PROC_DIR;
  return process.env.SF_TEST_HOOKS === 'on' && dir !== undefined && dir !== '' ? { lockProc: dir } : {};
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
  // The state format (SF-101): a runner refuses a newer one (state_too_new).
  await checkStateVersion(config.stateDir);
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
  const execution = new Execution(config, (name) => resolveWorkspace(name), onStateChange, handbook.text, { runner: { workspace, ticket }, ...testLockProc() });
  console.log(`${new Date().toISOString()} runner ${process.pid} for ${workspace}/${ticket} started`);
  await runJob(jobs.dir(workspace, ticket), execution, { settle: async () => void (await Promise.allSettled([...sending])) });
  console.log(`${new Date().toISOString()} runner ${process.pid} for ${workspace}/${ticket} ended`);
}

// sf rules <workspace> [ticket] (SF-059): the coding rules that would be given, without their
// text. A ticket whose job has its rules stored: the job's own list (rules.json), as its prompts
// carry them; a job with a base commit and nothing stored: none (it started without them). Else
// read at the Task file's base (fetched as Start does), and at the checkout's HEAD without a ticket.
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
        console.log(`The job of ${name}/${ticket} has no stored rules (it started before SF-059): its prompts carry no <rules> block.`);
      }
      return;
    }
    const base = parseFrontMatter(await readTask(workspace, ticket))?.get('base') ?? '';
    if (base === '' || base.startsWith('-') || (await runGit(checkout, ['check-ref-format', '--branch', base])).code !== 0) {
      throw new FactoryError('base_not_found', `The base "${base}" is not a valid branch name.`);
    }
    commit = (await resolveTarget(checkout, base)).commit;
  }
  const { list } = await collectRules(checkout, commit, { workspace: name, skip: workspace.rulesSkip ?? [], configDir: configDir(), maxBytes });
  console.log(rulesLines(name, list).join('\n'));
}

// sf check-task <workspace> <ticket> (SF-054): one Task check in this process, without sf serve;
// the record goes to the state directory, as from the dashboard's Check.
async function checkTask(args: string[]): Promise<void> {
  if (args.length !== 2) {
    throw new UsageError('check-task needs <workspace> <ticket>.');
  }
  const [name, ticket] = checkJob(args, 'check-task');
  const config = loadConfig();
  // It runs in this process, past sf serve's gates (SF-101).
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
  // goes as after a check of sf serve's, unless a job of the workspace runs (SF-085).
  await new Execution(config, (workspaceName) => resolveWorkspace(workspaceName), undefined, undefined, testLockProc()).afterTaskCheck(name, ticket);
  if (record.status === 'failed') {
    process.exitCode = 1;
  }
}

// sf smoke [--keep] [--timeout-min N] [--budget-usd N] (SF-090): the options checked here, the run
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

// sf digest [--now] (SF-103), through the socket of sf serve.
async function digest(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { now: { type: 'boolean' } } });
  if (positionals.length > 0) {
    throw new UsageError('digest takes no arguments but --now.');
  }
  if (values.now === true) {
    const result = await request('digest-run', []);
    console.log(`digest: ${String(result.path)}\ncost: ${typeof result.cost_usd === 'number' ? `$${result.cost_usd.toFixed(4)}` : 'unknown'}`);
    return;
  }
  const result = await request('digest-latest', []);
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

async function notifyTest(args: string[]): Promise<void> {
  if (args.length !== 0) {
    throw new UsageError('notify-test takes no arguments.');
  }
  const now = new Date().toISOString();
  const job: Job = {
    workspace: 'test', ticket: 'SF-TEST', branch: 'SF-TEST-notification', base: 'main', base_commit: null, worktree: null, prepared_commit: null,
    target_commit: null, mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state: 'pushed', iteration: 0, session_id: null, mr: null, created_at: now, updated_at: now,
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
  // The gate level (SF-092), whatever the gate's state.
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
  // The updating marker (SF-101), its phase, and what to do when the update was interrupted.
  const update = await markerLines(stateDir());
  if (args.length === 0) {
    if (update.length > 0) {
      console.log(`${update.join('\n')}\n`);
    }
    const all = await jobs.list();
    console.log(all.length === 0 ? 'No jobs.' : table(await statusRows(jobs, all, now)));
    // The jobs whose Implementer went on by itself after a turn limit (SF-069), one line each.
    // And the jobs parked on a usage limit (SF-072), with the provider and the reset.
    const turnLimits = all.flatMap((job) => [turnLimitLine(job), limitLine(job)].flatMap((line) => (line === undefined ? [] : [`${job.workspace}/${job.ticket}: ${line}`])));
    if (turnLimits.length > 0) {
      console.log(`\n${turnLimits.join('\n')}`);
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
  // A job parked on a usage limit (SF-072).
  const limit = limitLine(job);
  if (limit !== undefined) {
    console.log(`\n${limit}`);
  }
  // The job in the user's checkout, or why it is not (SF-073).
  const handover = handoverLines(job, (await jobs.readMrText(workspace, ticket))?.split(/\r?\n/)[0]);
  if (handover.length > 0) {
    console.log(`\n${handover.join('\n')}`);
  }
  if (job.worktree !== null) {
    console.log(`\nworktree: ${job.worktree}`);
  }
  // The marked paths (sensitive, outside the Task's scope, deleted) of the last published
  // iteration (SF-024, SF-053).
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

// sf attach (SF-064): the attachments module's rules on the files directly, without sf serve.
async function attach(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { remove: { type: 'string' } } });
  if (values.remove !== undefined ? positionals.length !== 2 : positionals.length < 3 || positionals.length > 4) {
    throw new UsageError('attach needs <workspace> <ticket> <file> [name], or <workspace> <ticket> --remove <name>.');
  }
  const [name, ticket] = checkJob(positionals, 'attach');
  // It changes the ticket's files in this process, past sf serve's gates (SF-101).
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

// `sf mcp-url` (SF-099): the MCP URL with its token for an MCP client, the rotation, and the
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
    console.log('Restart the tunnel (npm run tunnel again, or sf up), and give other MCP clients the new URL from sf mcp-url.');
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

// The port of the MCP endpoint (SF-099): SF_PORT, or with SF_PORT=0 (any free port) the one the
// running sf serve bound, asked on its socket; mcp_port_unknown when none answers.
async function mcpPort(): Promise<number> {
  const configured = parsePort('SF_PORT', DEFAULT_PORT);
  if (configured !== 0) {
    return configured;
  }
  const response = await callSocket(stateDir(), { command: 'mcp-port', args: [] }).catch(() => undefined);
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

// `sf metrics` (SF-092): the gate's runs, tokens, items and yield per job and in total.
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
    return (await callSocket(stateDir(), { command: 'ping', args: [] })).ok;
  } catch {
    return false;
  }
}

// The environment of the shell that ran sf, without what auth.env added (SF-101: sf service).
function shellEnv(fromEnvFile: readonly string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !fromEnvFile.includes(name)));
}

// sf service install|uninstall|status (SF-101).
async function service(args: string[], fromEnvFile: readonly string[]): Promise<void> {
  const [command] = args;
  if (args.length !== 1 || (command !== 'install' && command !== 'uninstall' && command !== 'status')) {
    throw new UsageError('service needs install, uninstall or status.');
  }
  await serviceCommand(command, { env: shellEnv(fromEnvFile), fromEnvFile, serveAnswers });
}

// This package's root (factory/): dist/src/cli.js is two levels below it.
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// sf update [--check|--abandon] [--no-smoke] (SF-101): the install is the Git top level of this
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

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  // SF_* settings from the environment file (auth.env), for every command alike.
  const fromEnvFile = loadEnvFile();
  if (command === 'service') {
    await service(rest, fromEnvFile);
    return;
  }
  if (command === 'update') {
    await update(rest, fromEnvFile);
    return;
  }
  if (command === 'start') {
    if (rest.length !== 2) {
      throw new UsageError('start needs <workspace> <ticket>.');
    }
    await viaServer('start', checkJob(rest, 'start'));
    return;
  }
  if (command === 'queue') {
    await queue(rest);
    return;
  }
  if (command === 'attach') {
    await attach(rest);
    return;
  }
  if (command === 'review') {
    if (rest.length !== 2) {
      throw new UsageError('review needs <workspace> <ticket>.');
    }
    await viaServer('review', checkJob(rest, 'review'));
    return;
  }
  if (command === 'retry') {
    await retry(rest);
    return;
  }
  if (command === 'accept') {
    if (rest.length !== 2) {
      throw new UsageError('accept needs <workspace> <ticket>.');
    }
    await viaServer('accept', checkJob(rest, 'accept'));
    return;
  }
  if (command === 'simplify') {
    if (rest.length !== 2) {
      throw new UsageError('simplify needs <workspace> <ticket>.');
    }
    await viaServer('simplify', checkJob(rest, 'simplify'));
    return;
  }
  if (command === 'settle') {
    checkJob(rest, 'settle');
    if (rest.length < 4 || (rest[3] !== 'accept' && rest[3] !== 'fix')) {
      throw new UsageError('settle needs <workspace> <ticket> <id> accept|fix [note...].');
    }
    await viaServer('settle', rest);
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
  if (command === 'pause') {
    if (rest.length !== 2) {
      throw new UsageError('pause needs <workspace> <ticket>.');
    }
    await viaServer('pause', checkJob(rest, 'pause'));
    return;
  }
  if (command === 'resume') {
    if (rest.length < 2) {
      throw new UsageError('resume needs <workspace> <ticket> [message...].');
    }
    await viaServer('resume', [...checkJob(rest.slice(0, 2), 'resume'), ...rest.slice(2)]);
    return;
  }
  if (command === 'restart') {
    await restart(rest);
    return;
  }
  if (command === 'handover' || command === 'takeback' || command === 'handed-done') {
    if (rest.length !== 2) {
      throw new UsageError(`${command} needs <workspace> <ticket>.`);
    }
    await viaServer(command, checkJob(rest, command));
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
  if (command === 'info') {
    await info(rest);
    return;
  }
  if (command === 'metrics') {
    await metrics(rest);
    return;
  }
  if (command === 'smoke') {
    // Its children are stopped and its directory gone; nothing is left to wait for.
    process.exit(await smoke(rest));
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
  if (error instanceof PortInUseError) {
    console.error(`sf: ${error.message} Set SF_PORT to a free port.`);
  } else if (error instanceof FactoryError || (error instanceof Error && 'code' in error)) {
    console.error(`sf: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
