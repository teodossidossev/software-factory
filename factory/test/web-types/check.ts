// The page's payload types (web/types.d.ts) checked against the server's (SF-186). Compiled only by
// tsconfig.web-types.json (npm run typecheck), never run: the page's types are global names, the
// server's come in by namespaced type imports, so the two never clash.
//
// Each entry of Checks is named after the page type it checks and reads the server's type from the
// value the page receives it in: a route function's (awaited) return type, or a field or element of
// it. An object type passes when the server's type is assignable to the page's and the page claims
// no key the server lacks, at any depth (Copy); a string union passes when both are the same union
// (Same). A failure fails `npm run typecheck` with the page type's name and what differs.
//
// test/web-types.test.ts reads this file as text: every top-level type of web/types.d.ts is a key
// of Checks or is named in PAGE_ONLY or KNOWN_DRIFT.
/// <reference path="../../web/types.d.ts" />
import type * as Changes from '../../src/changes.js';
import type * as Coordinator from '../../src/coordinator.js';
import type * as CoordinatorSkills from '../../src/coordinator-skills.js';
import type * as Dashboard from '../../src/dashboard.js';
import type * as DashboardReads from '../../src/dashboard-reads.js';
import type * as JobStream from '../../src/job-stream.js';
import type * as Pins from '../../src/pins.js';
import type * as Prototypes from '../../src/prototypes.js';
import type * as ReviewJob from '../../src/review-job.js';
import type * as SkillRoles from '../../src/skill-roles.js';
import type * as Skills from '../../src/skills.js';
import type * as Stats from '../../src/stats.js';
import type * as TicketHistory from '../../src/ticket-history.js';

// The page types with no server value to check against, each with why.
export const PAGE_ONLY = [
  ['QueuedRow', 'a TicketRow the page has found in the run queue (queue_position not null); the server sends TicketRow'],
  ['ActionResult', 'the POST routes answer a different result per action (POST_ROUTES call: Promise<unknown>); no single server type'],
] as const;

// The fields the server types unknown and the page reads as a narrower type, each with why. Only a
// field named here is narrowed (Narrow): its server type is taken as the page's for the
// assignability check, and its key is still checked. A server unknown the page reads as anything
// narrower and that is not listed here fails its check.
export const NARROWED = [
  ['JobStop.items', 'stopOf sends unknown[]: the suggestions, the ledger entries or the gate items, by the stop code'],
] as const;

// The page types that differ from the server's and cannot be corrected without a change to the page
// code (web/*.ts): not checked until a follow-up ticket, each with the difference.
export const KNOWN_DRIFT = [] as const;

// --- How a page type is compared with the server's.

// The keys of every member of a union.
type KeysOf<T> = T extends unknown ? keyof T : never;
// The type of the key K in the members of S that have it.
type At<S, K> = S extends unknown ? (K extends keyof S ? S[K] : never) : never;
// The members of the server's S that a member P of a page union stands for: those assignable to it
// (a discriminated union's member of the same tag), else every object member of S.
type Matching<P, S> = [Extract<S, P>] extends [never] ? Extract<S, object> : Extract<S, P>;
// The element type of the arrays of S.
type ElementOf<S> = S extends readonly (infer E)[] ? E : never;

// The paths the page type P claims and the server's S does not hold, at any depth: through arrays,
// nullable fields and the members of unions, a key the server lacks, types any (which every check
// would pass) or types unknown where the page reads something narrower (a field not in NARROWED),
// and a NARROWED field the server does not type unknown (NotUnknown).
// A page index signature (Record<string, …>) claims no key, nor does a key typed undefined
// (`verdict?: undefined`: the key is absent from that member).
type Unheld<P, S, Path extends string> = IsAny<S> extends true
  ? `${Path} (any on the server)`
  : [S] extends [NotUnknown]
    ? `${Path} (in NARROWED, but not unknown or unknown[] on the server)`
  : unknown extends S
    ? (unknown extends P ? never : `${Path} (unknown on the server, not in NARROWED)`)
    : P extends readonly (infer PE)[]
      ? Unheld<PE, ElementOf<S>, `${Path}[]`>
      : P extends object
        ? {
          [K in keyof P & string]-?: string extends K
            ? never
            : [P[K]] extends [undefined]
              ? never
              : K extends KeysOf<Matching<P, S>>
                ? Unheld<P[K], At<Matching<P, S>, K>, `${Path}.${K}`>
                : `${Path}.${K}`;
        }[keyof P & string]
        : never;

// Whether T is any.
type IsAny<T> = 0 extends 1 & T ? true : false;

// The page's object type P against the server's S: true, or what differs.
type Copy<P, S> = [Unheld<P, S, ''>] extends [never]
  ? ([S] extends [P] ? true : 'the server type is not assignable to it')
  : `page keys the server lacks or types any or unknown: ${Unheld<P, S, ''>}`;

// The page's string union P against the server's S: both ways.
type Same<P, S> = IsAny<S> extends true ? 'the server type is any' : [P] extends [S] ? ([S] extends [P] ? true : 'it lacks server members') : 'it has members the server lacks';

// Whether the server's T is unknown or an array of unknown, the only types NARROWED may narrow.
type UnknownOrArray<T> = IsAny<T> extends true ? false
  : unknown extends T ? true
    : [T] extends [readonly (infer E)[]] ? (unknown extends E ? (IsAny<E> extends true ? false : true) : false) : false;

// What Narrow puts in a NARROWED field the server types as something else: Unheld names its path.
interface NotUnknown {
  readonly 'in NARROWED, but not unknown on the server': true;
}

// The server's object S with its field K typed as the page type's (P[K]) when NARROWED lists
// "<Name>.<K>" and the server types it unknown or unknown[]; a listed field of any other server
// type becomes NotUnknown, which fails the check naming it; an unlisted field stays as it is, so an
// unknown there fails the check too.
type Narrow<S, P, Name extends string, K extends keyof S & keyof P & string> =
  `${Name}.${K}` extends (typeof NARROWED)[number][0]
    ? Omit<S, K> & { [F in K]: UnknownOrArray<S[K]> extends true ? P[K] : NotUnknown }
    : S;

// --- The server's values.

type ServerJobs = Awaited<ReturnType<typeof Dashboard.jobsPayload>>;
// A job of the jobs payload, its stop's items as the page reads them (NARROWED: JobStop.items).
type ServerJobStop = Narrow<NonNullable<ServerJobs['jobs'][number]['stop']>, JobStop, 'JobStop', 'items'>;
type ServerJobRow = Omit<ServerJobs['jobs'][number], 'stop'> & { stop: ServerJobStop | null };
// A NARROWED field the server types as something other than unknown fails its check: here the stop's
// items retyped to string[].
// @ts-expect-error the check fails naming .items (in NARROWED, but not unknown or unknown[] on the server)
export const narrowedNotUnknown: Copy<JobStop, Narrow<{ items: string[]; saves_lines: number | null }, JobStop, 'JobStop', 'items'>> = true;
type ServerDetail = Awaited<ReturnType<typeof Dashboard.jobDetail>>;
type ServerIteration = ServerDetail['iterations'][number];
type ServerReview = NonNullable<ServerIteration['review']>;
type ServerSimplify = NonNullable<ServerIteration['simplify']>;
type ServerActions = Dashboard.DashboardActions;
type ServerMrView = NonNullable<Awaited<ReturnType<ServerActions['mergeRequestView']>>>;
type ServerCheckView = Awaited<ReturnType<Dashboard.DashboardChecks['view']>>;
type ServerTickets = Awaited<ReturnType<typeof Dashboard.ticketsPayload>>;
type ServerTicketRow = ServerTickets['tickets'][number];
type ServerTicketEntry = Awaited<ReturnType<typeof Dashboard.ticketEntry>>;
type ServerWorkspaces = Awaited<ReturnType<typeof Dashboard.workspacesPayload>>;
type ServerPlan = ReturnType<typeof Dashboard.planOf>;
type ServerStreamEntry = Awaited<ReturnType<typeof JobStream.lineEntries>>[number];
type ServerDigests = Awaited<ReturnType<Dashboard.DashboardDigests['list']>>;
type ServerDigest = NonNullable<Awaited<ReturnType<Dashboard.DashboardDigests['read']>>>;
type ServerDigestWorkspace = ServerDigest['workspaces'][number];
type ServerDigestGit = NonNullable<ServerDigestWorkspace['git']>;
type ServerDigestOutput = NonNullable<ServerDigest['output']>;
type ServerStats = Awaited<ReturnType<Stats.Stats['compute']>>;

// The payloads startDashboard builds in place, from the server types of their parts: api/jobs and
// the stream's jobs events add remote to jobsPayload (jobsOf, sendChange); the stream's tickets
// event adds changed to ticketsPayload (sendChange); a page of the Stream (streamPage), the
// entries event (its line and lineEntries) and the planned ticket page (ticketPage).
type ServerJobsPayload = { jobs: ServerJobRow[]; remote: boolean };
type ServerTicketsPayload = ServerTickets & { changed?: Array<{ workspace: string; ticket: string }> };
type ServerStreamPage = { entries: ServerStreamEntry[]; next: number; end: boolean };
type ServerStreamLine = { line: number; entries: Awaited<ReturnType<typeof JobStream.lineEntries>> };
type ServerTicketPage = {
  ticket: ServerTicketEntry;
  task: Pick<Awaited<ReturnType<Dashboard.DashboardSetup['taskFile']>>, 'text' | 'sha256'>;
  plan: ServerPlan;
  check: ServerCheckView | null;
  check_rounds: number;
  check_usd: number;
  check_usd_complete: boolean;
  history: Awaited<ReturnType<TicketHistory.TicketHistory['timeline']>>;
  queue: null;
  planner_session: ReturnType<typeof Dashboard.plannerSessionView>;
  prototypes: Prototypes.PrototypeEntry[];
};

// --- The checks: one per page type, named after it.

export interface Checks {
  JobState: Same<JobState, ServerJobRow['state']>;
  OnLimitRule: Same<OnLimitRule, NonNullable<ServerTickets['queue']>['on_limit']>;
  HandoffMode: Same<HandoffMode, ServerWorkspaces['handoff_default']>;
  PauseStep: Same<PauseStep, NonNullable<NonNullable<ServerJobRow['paused']>['step']>>;
  StopKind: Same<StopKind, NonNullable<ServerJobRow['stop_kind']>>;
  StopGroup: Same<StopGroup, NonNullable<ServerJobRow['stop_group']>>;
  JobSummary: Copy<JobSummary, ServerDetail['job']>;
  JobPlanner: Copy<JobPlanner, ServerDetail['job']['planner']>;
  JobRow: Copy<JobRow, ServerJobRow>;
  JobMr: Copy<JobMr, NonNullable<ServerJobRow['mr']>>;
  ProgressPhase: Same<ProgressPhase, NonNullable<ServerJobRow['progress']>['phase']>;
  JobProgress: Copy<JobProgress, NonNullable<ServerJobRow['progress']>>;
  ShownAction: Copy<ShownAction, ServerJobRow['actions'][number]>;
  JobsPayload: Copy<JobsPayload, ServerJobsPayload>;
  JobStop: Copy<JobStop, ServerJobStop>;
  ReviewItem: Copy<ReviewItem, Exclude<ServerReview, { error: string }>['items'][number]>;
  ReviewRecord: Copy<ReviewRecord, ServerReview>;
  GateRecord: Copy<GateRecord, NonNullable<ServerIteration['gate']>>;
  GateOverride: Copy<GateOverride, NonNullable<ServerIteration['gate_override']>>;
  Suggestion: Copy<Suggestion, Exclude<ServerSimplify, { error: string }>['suggestions'][number]>;
  SimplifyRecord: Copy<SimplifyRecord, ServerSimplify>;
  IterationRow: Copy<IterationRow, ServerIteration>;
  LedgerEntry: Copy<LedgerEntry, ServerDetail['ledger'][number]>;
  ExplanationRecord: Copy<ExplanationRecord, NonNullable<ServerDetail['explanation']>>;
  JobDetail: Copy<JobDetail, ServerDetail>;
  MergeRequestStatus: Copy<MergeRequestStatus, NonNullable<Awaited<ReturnType<ServerActions['mergeRequestStatus']>>['status']>>;
  CheckOutput: Copy<CheckOutput, NonNullable<NonNullable<ServerCheckView['check']>['output']>>;
  CheckView: Copy<CheckView, ServerCheckView>;
  ChangesIndex: Copy<ChangesIndex, Awaited<ReturnType<Changes.Changes['index']>>>;
  ListedFile: Copy<ListedFile, NonNullable<Awaited<ReturnType<Changes.Changes['files']>>>['files'][number]>;
  ChangesList: Copy<ChangesList, NonNullable<Awaited<ReturnType<Changes.Changes['files']>>>>;
  FileVersion: Copy<FileVersion, NonNullable<Awaited<ReturnType<Changes.Changes['file']>>>>;
  MrView: Copy<MrView, ServerMrView>;
  MrProblem: Copy<MrProblem, ServerMrView['problems'][number]>;
  StreamWho: Same<StreamWho, ServerStreamEntry['who']>;
  StreamItem: Copy<StreamItem, NonNullable<Extract<ServerStreamEntry, { t: 'verdict' }>['items']>[number]>;
  StreamEntry: Copy<StreamEntry, ServerStreamEntry>;
  StreamPage: Copy<StreamPage, ServerStreamPage>;
  StreamLine: Copy<StreamLine, ServerStreamLine>;
  TicketEntry: Copy<TicketEntry, ServerTicketEntry>;
  TicketRow: Copy<TicketRow, ServerTicketRow>;
  TicketOwner: Same<TicketOwner, ServerTicketEntry['owner']>;
  CheckSummary: Copy<CheckSummary, NonNullable<ServerTicketRow['check']>>;
  DependencyState: Same<DependencyState, ServerTicketRow['lands_after'][number]['state']>;
  DependencyRow: Copy<DependencyRow, ServerTicketRow['lands_after'][number]>;
  JobDependencies: Copy<JobDependencies, ServerTickets['job_lands_after'][number]>;
  ArchivedRow: Copy<ArchivedRow, ServerTickets['archived'][number]>;
  WorkspaceRow: Copy<WorkspaceRow, ServerWorkspaces['workspaces'][number]>;
  QueueView: Copy<QueueView, NonNullable<ServerTickets['queue']>>;
  DigestSettings: Copy<DigestSettings, ServerWorkspaces['digest']>;
  WorkspacesPayload: Copy<WorkspacesPayload, ServerWorkspaces>;
  TicketsPayload: Copy<TicketsPayload, ServerTicketsPayload>;
  TicketPage: Copy<TicketPage, ServerTicketPage>;
  TicketPlan: Copy<TicketPlan, ServerPlan>;
  PlanDependency: Copy<PlanDependency, ServerPlan['waits_for'][number]>;
  PlannerSessionView: Copy<PlannerSessionView, NonNullable<ReturnType<typeof Dashboard.plannerSessionView>>>;
  PrototypeEntry: Copy<PrototypeEntry, Prototypes.PrototypeEntry>;
  DigestList: Copy<DigestList, ServerDigests>;
  DigestSummary: Copy<DigestSummary, ServerDigests['digests'][number]>;
  DigestRecord: Copy<DigestRecord, ServerDigest>;
  DigestWorkspace: Copy<DigestWorkspace, ServerDigestWorkspace>;
  DigestGit: Copy<DigestGit, ServerDigestGit>;
  DigestLanded: Copy<DigestLanded, ServerDigestGit['landed'][number]>;
  DigestBranch: Copy<DigestBranch, ServerDigestGit['branches'][number]>;
  DigestDailySource: Copy<DigestDailySource, ServerDigest['daily_sources'][number]>;
  DigestOutput: Copy<DigestOutput, ServerDigestOutput>;
  DigestCross: Copy<DigestCross, ServerDigestOutput['cross_repo'][number]>;
  DigestDaily: Copy<DigestDaily, ServerDigestOutput['dailies'][number]>;
  DigestText: Copy<DigestText, ServerDigestOutput['repos'][number]['headline']>;
  DigestInProgress: Copy<DigestInProgress, ServerDigest['in_progress'][number]>;
  StatsRole: Same<StatsRole, ServerStats['roles'][number]['role']>;
  StatsCostRole: Same<StatsCostRole, keyof ServerStats['days_rows'][number]['cost']>;
  StatsFindings: Copy<StatsFindings, ServerStats['stages'][number]['findings']>;
  StatsClaudeTokens: Copy<StatsClaudeTokens, Exclude<NonNullable<ServerStats['roles'][number]['tokens']>, ServerStats['totals']['codex_tokens']>>;
  StatsGateTokens: Copy<StatsGateTokens, ServerStats['totals']['codex_tokens']>;
  StatsDayRow: Copy<StatsDayRow, ServerStats['days_rows'][number]>;
  StatsRoleRow: Copy<StatsRoleRow, ServerStats['roles'][number]>;
  StatsWorkspaceRow: Copy<StatsWorkspaceRow, ServerStats['by_workspace'][number]>;
  StatsStageRow: Copy<StatsStageRow, ServerStats['stages'][number]>;
  StatsSecondOpinion: Copy<StatsSecondOpinion, ServerStats['second_opinion']['codex_after_claude']>;
  StatsArmRow: Copy<StatsArmRow, ServerStats['arms'][number]>;
  StatsJobRow: Copy<StatsJobRow, ServerStats['jobs'][number]>;
  StatsTarget: Copy<StatsTarget, NonNullable<ServerStats['warnings'][number]['target']>>;
  StatsPayload: Copy<StatsPayload, ServerStats>;
  HealthStatus: Same<HealthStatus, ReturnType<Dashboard.DashboardHealth['list']>[number]['status']>;
  HealthCheck: Copy<HealthCheck, ReturnType<Dashboard.DashboardHealth['list']>[number]>;
  OpenMergeRequest: Copy<OpenMergeRequest, Awaited<ReturnType<ServerActions['openMergeRequests']>>[number]>;
  ReviewThread: Copy<ReviewThread, Awaited<ReturnType<ServerActions['mergeRequestThreads']>>[number]>;
  MergeRequestOverview: Copy<MergeRequestOverview, Awaited<ReturnType<ServerActions['mergeRequestOverview']>>>;
  ReviewJobResult: Copy<ReviewJobResult, Awaited<ReturnType<typeof ReviewJob.createReviewJob>>>;
  SkillRole: Same<SkillRole, SkillRoles.Role>;
  SkillRow: Copy<SkillRow, Skills.InstalledSkill>;
  SkillsPayload: Copy<SkillsPayload, ReturnType<typeof Skills.skillsForClients>>;
  CoordinatorOverride: Same<CoordinatorOverride, CoordinatorSkills.SkillOverride>;
  CoordinatorColumn: Copy<CoordinatorColumn, CoordinatorSkills.CoordinatorColumn>;
  SkillText: Copy<SkillText, Awaited<ReturnType<typeof Skills.skillText>>>;
  CoordinatorQuestion: Copy<CoordinatorQuestion, Coordinator.CoordinatorQuestion>;
  CoordinatorState: Copy<CoordinatorState, Awaited<ReturnType<typeof DashboardReads.coordinatorView>>>;
  Pin: Copy<Pin, Pins.Pin>;
  PinsView: Copy<PinsView, Awaited<ReturnType<typeof Pins.readPins>>>;
}

// true when every check passes, else each failure as "<page type>: <what differs>".
type Verdict<F> = [F] extends [never] ? true : F;

// Fails to compile unless every check passes; the error names each failure.
export const allPass: Verdict<{ [K in keyof Checks]: Checks[K] extends true ? never : `${K}: ${Checks[K] & string}` }[keyof Checks]> = true;
