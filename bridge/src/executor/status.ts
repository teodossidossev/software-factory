// Read-only operator view of SF-009 execution (`sf009-executor status` and `watch`): for each job,
// the repository it really works in (the real path, and whether that is this Software Factory
// checkout), the app and job, the processes by identity (the supervisor and the Claude process:
// pid, start time, alive or not), the current iteration, the last activity and what the job waits
// for. A job's repository is shown only when it is verified against what the job was authorized
// for (the repository sha256 of its consumed authorization, or the salted repo_identity): after
// APP_REPO changes, the new registration is never presented as the job's repository. Discovery
// issues and unreadable records are reported with their codes, never dropped. It reads the
// private policy and self-hosting opt-in, managed.json and execution.json, the
// supervisor lock and heartbeat, and the modification time of the session's Claude Code
// transcript. It writes nothing, takes no lock and signals nothing. Host paths appear only here,
// in the operator's own terminal; nothing of it reaches ChatGPT or the mediator.
import { readlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { loadAppConfig, type SelfHostingGrant } from '../execution/app-config.js';
import { MEDIATOR_STATE_DIR } from '../execution/git-state.js';
import { isAlive, lockHolder, type ProcessIdentity } from '../execution/process-identity.js';
import { EXECUTION_FILE } from '../execution/service.js';
import { findTranscript } from '../execution/transcript.js';
import { APPS_PATH, FactoryJobs, readJobFile } from '../factory-jobs.js';
import { appIsolation, policyRunnable, repoIdentity, repoSha256, type ExecutorPolicy, type ExecutorState, type Isolation } from './policy.js';
import {
  AUTHORIZATION_FILE,
  authorizationSchema,
  HEARTBEAT_FILE,
  HEARTBEAT_INTERVAL_MS,
  heartbeatSchema,
  listIds,
  listingIssue,
  MAX_SCAN_ISSUES,
  readManaged,
  readRecord,
  readTrustedFile,
  SCAN_LIMITS,
  type Authorization,
  type Heartbeat,
  type ManagedRecord,
} from './records.js';

// Jobs in these states have (or are about to have) a live session, or wait for the supervisor.
const ACTIVE_STATES = ['queued', 'launching', 'running', 'awaiting_review', 'needs_operator', 'approved'];
const MAX_EXECUTION_BYTES = 1024 * 1024;
// Only what the view needs from execution.json (any SF-006 format): the session's identity.
const executionSessionSchema = z.object({
  session: z.object({ id: z.string(), pid: z.number().int().optional(), pid_start: z.string().optional(), boot_id: z.string().optional() }).nullable().optional(),
});

export interface ProcessView {
  pid: number;
  start: string;
  alive: boolean;
}

export interface JobView {
  app_id: string;
  job_id: string;
  // managed.json state, "authorized" when the supervisor has not recorded the job yet, or
  // "unreadable" when its records cannot be read (read_error says why).
  state: string;
  read_error: string | null;
  // The job's repository (real path) only when verified against its binding, else null.
  repository: string | null;
  // verified: the path matches the repository the job was authorized for; mismatch: APP_REPO
  // now names another repository; unverifiable: no binding to check, or no registration.
  repository_binding: 'verified' | 'mismatch' | 'unverifiable';
  repository_note: string;
  // Where APP_REPO points now when that is not the job's repository (shown as such), else null.
  registered_now: string | null;
  isolation: Isolation;
  iteration: { id: string; state: string; trigger: string; count: number } | null;
  claude: { session_id: string; process: ProcessView | null; sessions: number } | null;
  // The session the supervisor manages now (managed.json), else null: the observer follows only it.
  managed_session_id: string | null;
  last_activity: { at: string; what: string } | null;
  last_event: { at: string; event: string; detail: string | null } | null;
  waiting: string;
}

export interface StatusReport {
  at: string;
  // runnable: enabled and its last change completed (policyRunnable).
  policy: { enabled: boolean; runnable: boolean; epoch: number; claude: string } | null;
  self_hosting: { app_id: string; enabled_at: string } | null;
  supervisor: { process: ProcessView | null; heartbeat: { state: Heartbeat['state']; updated_at: string; fresh: boolean } | null };
  // complete: every apps and jobs directory was listed and every job's records were read.
  discovery: { complete: boolean; issues: DiscoveryIssue[]; more_issues: boolean };
  jobs: JobView[];
  // Finished jobs not shown (without --all).
  hidden: number;
}

// Why discovery is incomplete: a listing issue (records.ts codes) or a record that cannot be read
// (job_unreadable, with the read error's code).
export interface DiscoveryIssue {
  code: string;
  app_id: string | null;
  job_id: string | null;
  error: string | null;
}

export interface StatusOptions {
  mediatorRoot: string;
  state: ExecutorState;
  // Claude Code's transcript directory (last activity of the session).
  projectsDir: string;
  now?: () => Date;
  app?: string;
  job?: string;
  // Also finished jobs (otherwise only active ones, or the latest one when none is active).
  all?: boolean;
}

async function processView(identity: Partial<ProcessIdentity> | undefined): Promise<ProcessView | null> {
  if (identity?.pid === undefined || identity.pid_start === undefined) {
    return null;
  }
  return { pid: identity.pid, start: identity.pid_start, alive: await isAlive(identity) };
}

async function heartbeat(mediatorRoot: string): Promise<Heartbeat | undefined> {
  try {
    const buffer = await readTrustedFile(join(mediatorRoot, MEDIATOR_STATE_DIR, HEARTBEAT_FILE), HEARTBEAT_FILE, 64 * 1024);
    const parsed = buffer === undefined ? undefined : heartbeatSchema.safeParse(JSON.parse(buffer.toString('utf8')));
    return parsed?.success === true ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const since = (at: string, now: Date): string => {
  const seconds = Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 1000));
  if (seconds < 120) {
    return `${seconds} s ago`;
  }
  if (seconds < 7200) {
    return `${Math.round(seconds / 60)} min ago`;
  }
  return `${Math.round(seconds / 3600)} h ago`;
};

// What the job waits for, in the operator's words.
export function waitingReason(record: ManagedRecord | undefined, authorization: { expires_at: string } | undefined, supervisorOnline: boolean, now: Date): string {
  if (record === undefined) {
    if (authorization === undefined) {
      return 'nothing: the job is not authorized for automatic execution';
    }
    if (Date.parse(authorization.expires_at) <= now.getTime()) {
      return 'nothing: the authorization expired before the supervisor used it; authorize again';
    }
    return supervisorOnline ? "the supervisor's next pass (authorized, not yet checked)" : 'the supervisor: it is not running (start it with scripts/sf009-executor.sh run)';
  }
  const diagnostic = record.diagnostic;
  const iteration = record.current_iteration ?? 'the first iteration';
  // After the session ended or began to end, the job is not working, whatever its state still says.
  if (record.session.process === 'ending') {
    return `the Claude process to end: the session is shutting down (${diagnostic?.code ?? 'unknown'}); no exit observed yet`;
  }
  if (record.session.process === 'unconfirmed') {
    return `you: the Claude process was not shown to have ended (${diagnostic?.code ?? 'unknown'}); find and end it yourself, then inspect the repository`;
  }
  if (record.session.process === 'ended' && ACTIVE_STATES.includes(record.state)) {
    return `the supervisor to collect the session: its exit was observed (${diagnostic?.code ?? 'unknown'})`;
  }
  switch (record.state) {
    case 'queued':
      return `the session gate: ${diagnostic?.message ?? 'another Software Factory session holds it'}`;
    case 'launching':
      return 'the Claude Code session to start';
    case 'running':
      if (diagnostic?.code === 'snapshot_waiting') {
        return diagnostic.message;
      }
      return `Claude Code, working on ${iteration} (turn in progress)`;
    case 'awaiting_review': {
      const last = record.events.at(-1);
      const deferred = last !== undefined && ['handoff_deferred', 'boundary_waiting'].includes(last.event) ? ` (last: ${last.event}${last.detail ? ` ${last.detail}` : ''})` : '';
      return `your review or acceptance of ${iteration} in ChatGPT (factory_list_review_ready), or scripts/sf009-executor.sh accept${deferred}`;
    }
    case 'needs_operator':
      return `you: ${diagnostic === null ? 'see the job status' : `${diagnostic.code}: ${diagnostic.message}`}`;
    case 'approved':
      return 'the session to end and the accepted snapshot to be collected';
    default:
      return `nothing: the job is ${record.state}${diagnostic === null ? '' : ` (${diagnostic.code})`}`;
  }
}

function unreadableJob(appId: string, jobId: string, error: string, isolation: Isolation): JobView {
  return {
    app_id: appId,
    job_id: jobId,
    state: 'unreadable',
    read_error: error,
    repository: null,
    repository_binding: 'unverifiable',
    repository_note: 'unknown: the job\'s records cannot be read',
    registered_now: null,
    isolation,
    iteration: null,
    claude: null,
    managed_session_id: null,
    last_activity: null,
    last_event: null,
    waiting: `you: the job's records cannot be read (${error}); inspect its directory`,
  };
}

type RepositoryLocation = Pick<JobView, 'repository' | 'repository_binding' | 'repository_note' | 'registered_now'>;

// The job's repository, verified against its binding: the exact repository sha256 its consumed
// authorization was approved for, or else the salted repo_identity of its authorization. A
// mismatch (APP_REPO changed since) never shows the new registration as the job's repository; the
// working directory of the job's live Claude process is shown instead when it matches the binding.
async function jobRepository(
  options: StatusOptions,
  appId: string,
  grant: SelfHostingGrant | undefined,
  policy: ExecutorPolicy | undefined,
  authorization: Authorization | undefined,
  claudeProcess: ProcessView | null,
): Promise<RepositoryLocation> {
  let use;
  try {
    use = authorization === undefined ? undefined : await options.state.use(authorization.authorization_id);
  } catch (error) {
    // An unreadable use record is not replaced by a weaker check.
    return { repository: null, repository_binding: 'unverifiable', repository_note: `unknown: the authorization's use record cannot be read (${(error as { code?: string }).code ?? 'error'})`, registered_now: null };
  }
  const matches = (path: string): boolean | undefined => {
    if (use !== undefined) {
      return repoSha256(path) === use.app_repo_sha256;
    }
    if (authorization !== undefined && policy !== undefined) {
      return repoIdentity(policy.salt, path) === authorization.repo_identity;
    }
    return undefined;
  };
  const describe = (selfHosted: boolean): string =>
    selfHosted ? 'this Software Factory checkout (self-hosting, unconfined: no sandbox)' : 'a separate repository';
  let registered: { repo: string; selfHosted: boolean } | undefined;
  let registrationError: string | undefined;
  try {
    const config = await loadAppConfig(options.mediatorRoot, appId, grant);
    registered = { repo: config.repo, selfHosted: config.selfHosted === true };
  } catch (error) {
    registrationError = (error as { code?: string }).code ?? 'error';
  }
  if (registered !== undefined && matches(registered.repo) === true) {
    return { repository: registered.repo, repository_binding: 'verified', repository_note: describe(registered.selfHosted), registered_now: null };
  }
  const bound = matches(registered?.repo ?? '');
  if (bound === undefined) {
    return {
      repository: null,
      repository_binding: 'unverifiable',
      repository_note: registered === undefined ? `unknown: APP_REPO is not resolvable now (${registrationError})` : 'unknown: no authorization binding to verify the registration against',
      registered_now: registered?.repo ?? null,
    };
  }
  // The binding does not match the registration, or the registration cannot be resolved.
  const binding = registered === undefined ? 'unverifiable' : 'mismatch';
  if (claudeProcess?.alive === true) {
    const cwd = await readlink(`/proc/${claudeProcess.pid}/cwd`).catch(() => undefined);
    if (cwd !== undefined && matches(cwd) === true) {
      return {
        repository: cwd,
        repository_binding: binding,
        repository_note: `the working directory of the job's live Claude process, which matches its authorization; APP_REPO ${registered === undefined ? `is not resolvable now (${registrationError})` : 'now names another repository'}`,
        registered_now: registered?.repo ?? null,
      };
    }
  }
  return {
    repository: null,
    repository_binding: binding,
    repository_note:
      registered === undefined
        ? `unknown: APP_REPO is not resolvable now (${registrationError}), and the job's repository is recorded only by its sha256`
        : 'unknown: APP_REPO now names another repository than the one this job was authorized for (recorded only by its sha256)',
    registered_now: registered?.repo ?? null,
  };
}

export async function readStatus(options: StatusOptions): Promise<StatusReport> {
  const now = (options.now ?? (() => new Date()))();
  // Unreadable private records are reported as discovery issues, never shown as absent.
  const privateIssues: DiscoveryIssue[] = [];
  const readPrivateRecord = async <T>(read: () => Promise<T | undefined>, code: string): Promise<T | undefined> => {
    try {
      return await read();
    } catch (error) {
      privateIssues.push({ code, app_id: null, job_id: null, error: (error as { code?: string }).code ?? 'error' });
      return undefined;
    }
  };
  const policy = await readPrivateRecord(() => options.state.policy(), 'policy_unreadable');
  const selfHosting = await readPrivateRecord(() => options.state.selfHosting(), 'self_hosting_unreadable');
  const grant = selfHosting === undefined ? undefined : { appId: selfHosting.app_id, repoSha256: selfHosting.repo_sha256 };
  const beat = await heartbeat(options.mediatorRoot);
  const fresh = beat !== undefined && beat.state === 'running' && now.getTime() - Date.parse(beat.updated_at) <= 3 * HEARTBEAT_INTERVAL_MS;
  const supervisor = await processView(await lockHolder(join(options.state.dir, 'supervisor')).catch(() => undefined));
  const online = fresh && supervisor?.alive === true;
  const jobs = new FactoryJobs(options.mediatorRoot);
  const found: Array<{ view: JobView; updated: string; active: boolean }> = [];
  const issues: DiscoveryIssue[] = [...privateIssues];
  let moreIssues = false;
  const issue = (entry: DiscoveryIssue): void => {
    if (issues.length < MAX_SCAN_ISSUES) {
      issues.push(entry);
    } else {
      moreIssues = true;
    }
  };
  let apps = [options.app ?? ''];
  if (options.app === undefined) {
    const listing = await listIds(join(options.mediatorRoot, APPS_PATH), SCAN_LIMITS.apps);
    if (listing.issue !== null) {
      issue({ code: listingIssue('apps', listing.issue), app_id: null, job_id: null, error: null });
    }
    apps = listing.names;
  }
  for (const appId of apps) {
    let jobIds = [options.job ?? ''];
    if (options.job === undefined) {
      const listing = await listIds(join(options.mediatorRoot, APPS_PATH, appId, 'jobs'), SCAN_LIMITS.jobs);
      if (listing.issue !== null) {
        issue({ code: listingIssue('jobs', listing.issue), app_id: appId, job_id: null, error: null });
      }
      jobIds = listing.names;
    }
    for (const jobId of jobIds) {
      const errorCode = (error: unknown): string => (error as { code?: string }).code ?? 'error';
      let read: { record: ManagedRecord | undefined; authorization: Authorization | undefined; execution: Buffer | undefined };
      try {
        read = await jobs.withJob(appId, jobId, false, async (job) => ({
          record: await readManaged(job),
          authorization: await readRecord(job, AUTHORIZATION_FILE, authorizationSchema),
          execution: await readJobFile(job, EXECUTION_FILE, MAX_EXECUTION_BYTES),
        }));
      } catch (error) {
        // A job whose records cannot be read is reported and shown, never skipped silently. A job
        // asked for by name that does not exist is simply not there; one that vanished between
        // listing and reading is an enumeration race.
        if (['not_found', 'app_not_found'].includes(errorCode(error))) {
          if (options.job === undefined) {
            issue({ code: 'enumeration_race', app_id: appId, job_id: jobId, error: null });
          }
          continue;
        }
        issue({ code: 'job_unreadable', app_id: appId, job_id: jobId, error: errorCode(error) });
        found.push({ updated: now.toISOString(), active: true, view: unreadableJob(appId, jobId, errorCode(error), appIsolation(policy?.apps[appId])) });
        continue;
      }
      if (read.record === undefined && read.authorization === undefined) {
        continue;
      }
      const { record, authorization } = read;
      let session: z.infer<typeof executionSessionSchema>['session'];
      if (read.execution !== undefined) {
        let parsed;
        try {
          parsed = executionSessionSchema.safeParse(JSON.parse(read.execution.toString('utf8')));
        } catch {
          parsed = undefined;
        }
        if (parsed?.success === true) {
          session = parsed.data.session;
        } else {
          issue({ code: 'execution_unreadable', app_id: appId, job_id: jobId, error: 'invalid_record' });
        }
      }
      const sessionId = record?.session.current_session_id ?? session?.id ?? null;
      // The current process's identity is in execution.json (the claimed one, or the latest after a reset).
      const claudeProcess = await processView(session ?? undefined);
      const claude = sessionId === null ? null : { session_id: sessionId, process: claudeProcess, sessions: Math.max(1, record?.session.lineage.length ?? 1) };
      const location = await jobRepository(options, appId, grant, policy, authorization, claudeProcess);
      const current = record?.iterations.find((entry) => entry.id === record.current_iteration);
      const activity: Array<{ at: string; what: string }> = [];
      if (record !== undefined) {
        activity.push({ at: record.updated_at, what: 'job record updated' });
      }
      // Transcripts are looked for only in the verified repository of the job.
      if (location.repository !== null && sessionId !== null) {
        const transcript = await findTranscript(options.projectsDir, location.repository, sessionId).catch(() => undefined);
        const modified = transcript === undefined ? undefined : await stat(transcript).catch(() => undefined);
        if (modified !== undefined) {
          activity.push({ at: modified.mtime.toISOString(), what: 'Claude Code wrote to its session transcript' });
        }
      }
      const last = record?.events.at(-1);
      found.push({
        updated: record?.updated_at ?? authorization!.issued_at,
        active: record === undefined ? authorization !== undefined && Date.parse(authorization.expires_at) > now.getTime() : ACTIVE_STATES.includes(record.state),
        view: {
          app_id: appId,
          job_id: jobId,
          state: record?.state ?? 'authorized',
          read_error: null,
          ...location,
          isolation: appIsolation(policy?.apps[appId]),
          iteration: current === undefined ? null : { id: current.id, state: current.state, trigger: current.trigger, count: record!.iterations.length },
          claude,
          managed_session_id: record?.session.current_session_id ?? null,
          last_activity: activity.sort((a, b) => b.at.localeCompare(a.at))[0] ?? null,
          last_event: last === undefined ? null : { at: last.at, event: last.event, detail: last.detail },
          waiting: waitingReason(record, authorization, online, now),
        },
      });
    }
  }
  found.sort((a, b) => b.updated.localeCompare(a.updated));
  const explicit = options.all === true || options.job !== undefined;
  const active = found.filter((entry) => entry.active);
  const shown = explicit ? found : active.length > 0 ? active : found.slice(0, 1);
  return {
    at: now.toISOString(),
    policy: policy === undefined ? null : { enabled: policy.enabled, runnable: policyRunnable(policy), epoch: policy.epoch, claude: policy.claude.version },
    self_hosting: selfHosting === undefined ? null : { app_id: selfHosting.app_id, enabled_at: selfHosting.enabled_at },
    supervisor: { process: supervisor, heartbeat: beat === undefined ? null : { state: beat.state, updated_at: beat.updated_at, fresh } },
    discovery: { complete: issues.length === 0 && !moreIssues, issues, more_issues: moreIssues },
    jobs: shown.map((entry) => entry.view),
    hidden: found.length - shown.length,
  };
}

const describeProcess = (process: ProcessView | null): string =>
  process === null ? 'unknown (no recorded identity)' : `pid ${process.pid} (start ${process.start}), ${process.alive ? 'alive' : 'not running'}`;

export function renderStatus(report: StatusReport, now = new Date(report.at)): string {
  const lines: string[] = [`Software Factory execution status at ${report.at}`];
  const beat = report.supervisor.heartbeat;
  const online = report.supervisor.process?.alive === true && beat?.fresh === true;
  lines.push(
    `Supervisor:   ${online ? 'running' : 'not running'}; process ${describeProcess(report.supervisor.process)}; heartbeat ${beat === null ? 'none' : `${beat.state}, ${since(beat.updated_at, now)}`}`,
  );
  lines.push(report.policy === null ? 'Policy:       no opt-in' : `Policy:       ${report.policy.enabled ? 'enabled' : 'disabled'}${report.policy.enabled && !report.policy.runnable ? ' (last change incomplete: not runnable)' : ''}, epoch ${report.policy.epoch}, Claude Code ${report.policy.claude}`);
  lines.push(
    report.self_hosting === null
      ? 'Self-hosting: not enabled'
      : `Self-hosting: enabled for ${report.self_hosting.app_id} since ${report.self_hosting.enabled_at} (operator-controlled, unconfined: no sandbox)`,
  );
  const discovery = report.discovery;
  lines.push(
    discovery.complete
      ? 'Discovery:    complete'
      : `Discovery:    INCOMPLETE: ${discovery.issues.map((entry) => `${entry.code}${entry.app_id ? ` ${entry.app_id}` : ''}${entry.job_id ? `/${entry.job_id}` : ''}${entry.error ? ` (${entry.error})` : ''}`).join(', ')}${discovery.more_issues ? ', more' : ''}`,
  );
  if (report.jobs.length === 0) {
    lines.push('', discovery.complete ? 'No authorized or managed jobs.' : 'No authorized or managed jobs found, but discovery was incomplete: jobs may be missing (see above).');
  }
  for (const job of report.jobs) {
    const row = (label: string, value: string) => lines.push(`  ${label.padEnd(14)} ${value}`);
    lines.push('', `app ${job.app_id} / job ${job.job_id}`);
    row('repository', job.repository === null ? job.repository_note : `${job.repository} (${job.repository_note})`);
    if (job.registered_now !== null && job.repository_binding !== 'verified') {
      row('registered now', `${job.registered_now} (NOT verified as this job's repository: ${job.repository_binding})`);
    }
    if (job.read_error !== null) {
      row('read error', job.read_error);
    }
    row('isolation', job.isolation);
    row('state', job.state);
    row('iteration', job.iteration === null ? '-' : `${job.iteration.id} (${job.iteration.state}, ${job.iteration.trigger}); ${job.iteration.count} so far`);
    row('claude', job.claude === null ? 'no session yet' : `session ${job.claude.session_id}${job.claude.sessions > 1 ? ` (${job.claude.sessions} processes in its lineage)` : ''}; ${describeProcess(job.claude.process)}`);
    row('last activity', job.last_activity === null ? '-' : `${since(job.last_activity.at, now)}: ${job.last_activity.what}`);
    row('last event', job.last_event === null ? '-' : `${since(job.last_event.at, now)}: ${job.last_event.event}${job.last_event.detail ? ` ${job.last_event.detail}` : ''}`);
    row('waiting for', job.waiting);
  }
  if (report.hidden > 0) {
    lines.push('', `${report.hidden} finished job(s) not shown (--all shows them).`);
  }
  return `${lines.join('\n')}\n`;
}
