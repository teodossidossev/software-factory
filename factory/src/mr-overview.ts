// The overview of one open merge request for the dashboard's Merge requests page: whether it is
// ready to merge and why not, how far its source is behind its target, its pipeline, SonarQube's
// verdict when it found a problem, and how many human and bot comments it has. Built from two reads
// of the host through the forge client of src/forge.ts (status and threads, GET only); nothing is
// written to the host. Also the pure rules the host reads use: the pipeline in four words (the
// status of src/forge.ts), which author is a bot and which comment is SonarQube's
// (src/forge-comments.ts). This module imports only types, so it stays below both.
import type { Forge, MergeRequestStatus } from './forge.js';
import type { ReviewComment, ReviewThread } from './forge-comments.js';

// The pipeline (GitLab) or the check runs (GitHub) of a merge request: state in four words, text the
// host's own word (GitLab) or the checks' summary (GitHub), url an http(s) page of it or null.
export interface PipelineSummary {
  state: 'passed' | 'failed' | 'running' | 'other';
  text: string;
  url: string | null;
}

// The URL when it is an http(s) one, else null: no other scheme reaches a link on the page.
export const httpUrl = (value: unknown): string | null => {
  const protocol = typeof value === 'string' ? URL.parse(value)?.protocol : undefined;
  return protocol === 'http:' || protocol === 'https:' ? value as string : null;
};

// A whole number from 0, else undefined.
export const countOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

// A GitLab pipeline's status in four words (the ones still to finish are running), its page when
// http(s).
const GITLAB_RUNNING = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled']);
export function gitlabPipeline(status: string, url: unknown): PipelineSummary {
  const state = status === 'success' ? 'passed' : status === 'failed' ? 'failed' : GITLAB_RUNNING.has(status) ? 'running' : 'other';
  return { state, text: status, url: httpUrl(url) };
}

// From GitHub's check runs: checks, "2 passed, 1 failed, 1 running", and the pipeline (any failed:
// failed, else any running: running, else any passed: passed, else other) whose page is the pull
// request's checks; nothing without a run.
export function checkSummary(runs: ReadonlyArray<Readonly<Record<string, unknown>>>, pullUrl: string): { checks: string; pipeline: PipelineSummary } | undefined {
  if (runs.length === 0) {
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const run of runs) {
    const word = run.status !== 'completed' ? 'running'
      : run.conclusion === 'success' ? 'passed'
        : run.conclusion === 'skipped' || run.conclusion === 'neutral' ? 'skipped'
          : 'failed';
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const checks = ['passed', 'failed', 'running', 'skipped'].filter((word) => counts.has(word)).map((word) => `${counts.get(word)} ${word}`).join(', ');
  const state = (['failed', 'running', 'passed'] as const).find((word) => counts.has(word)) ?? 'other';
  return { checks, pipeline: { state, text: checks, url: httpUrl(`${pullUrl}/checks`) } };
}

// SonarQube's verdict, only when it found a problem: the gate failed, or new issues (null: the
// comment gives no count); url the comment's link to the issues or the analysis (http(s) only).
export interface SonarSummary {
  gate_failed: boolean;
  new_issues: number | null;
  url: string | null;
}

// ready: null while the host has not decided; reasons: why not ready, the host's reason first;
// behind: the commits of the target the source lacks, null when the host does not say.
export interface MergeRequestOverview {
  number: number;
  ready: boolean | null;
  reasons: string[];
  behind: number | null;
  pipeline: PipelineSummary | null;
  sonar: SonarSummary | null;
  comments: { human: number; bot: number };
}

const BOT_WORD = /(^|[^a-z0-9])bot([^a-z0-9]|$)/i;
const SONAR = /sonar/i;
const QUALITY_GATE = /quality gate (passed|failed)/i;

// A bot author: flagged by the host (GitHub's user.type "Bot", GitLab's author.bot), a GitHub App's
// login ending in [bot], a name with the word bot in it (project_12_bot_ab12, ci-bot), or SonarQube's.
export function isBotAuthor(name: string, flagged: boolean): boolean {
  return flagged || name.toLowerCase().endsWith('[bot]') || BOT_WORD.test(name) || SONAR.test(name);
}

// A SonarQube comment: its quality gate's verdict, by a bot or naming SonarQube.
export function isSonarComment(body: string, botAuthor: boolean): boolean {
  return QUALITY_GATE.test(body) && (botAuthor || SONAR.test(body));
}

// A bot comment: a bot's, or SonarQube's whoever posted it.
export function isBotComment(name: string, flagged: boolean, body: string): boolean {
  const bot = isBotAuthor(name, flagged);
  return bot || isSonarComment(body, bot);
}

// The http(s) target of the first Markdown link whose text matches.
function linkOf(body: string, text: RegExp): string | null {
  for (const [, label = '', target] of body.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    const url = httpUrl(target);
    if (url !== null && text.test(label)) {
      return url;
    }
  }
  return null;
}

// What one SonarQube comment says: the gate's verdict, the new issues ("3 New issues", else the
// sum of the older "N Bugs", "N Vulnerabilities", "N Code Smells"), its link.
export function parseSonar(body: string): SonarSummary {
  const gate_failed = QUALITY_GATE.exec(body)?.[1]?.toLowerCase() === 'failed';
  const issues = /(\d+)\s+new\s+issues?/i.exec(body);
  let new_issues: number | null = issues === null ? null : Number(issues[1]);
  if (new_issues === null) {
    const older = [...body.matchAll(/(\d+)\s+(bugs?|vulnerabilit(?:y|ies)|code\s+smells?)\b/gi)];
    new_issues = older.length === 0 ? null : older.reduce((sum, match) => sum + Number(match[1]), 0);
  }
  return { gate_failed, new_issues, url: linkOf(body, /new\s+issues?/i) ?? linkOf(body, /analysis details/i) };
}

// SonarQube's verdict from the newest SonarQube comment of every thread, only when it found a
// problem; null without one, or for a passed gate without new issues.
export function sonarOf(threads: readonly ReviewThread[]): SonarSummary | null {
  let newest: ReviewComment | undefined;
  for (const comment of threads.flatMap((thread) => thread.comments)) {
    if (comment.bot && QUALITY_GATE.test(comment.body) && (newest === undefined || comment.created_at >= newest.created_at)) {
      newest = comment;
    }
  }
  if (newest === undefined) {
    return null;
  }
  const sonar = parseSonar(newest.body);
  return sonar.gate_failed || (sonar.new_issues ?? 0) >= 1 ? sonar : null;
}

// Why it is not ready: the host's reason, then conflicts, the draft and the commits behind when the
// reason does not say them already; each once.
export function reasonsOf(status: MergeRequestStatus): string[] {
  const reason = status.reason;
  const reasons = reason !== undefined ? [reason] : [];
  if (status.conflicts === true && !/conflict/i.test(reason ?? '')) {
    reasons.push('it has conflicts with the target branch');
  }
  if (status.draft && reason !== 'it is a draft') {
    reasons.push('it is a draft');
  }
  const behind = status.behind ?? 0;
  if (behind >= 1 && !/rebase|behind/i.test(reason ?? '')) {
    reasons.push(`it is ${behind} commit${behind === 1 ? '' : 's'} behind the target branch`);
  }
  return [...new Set(reasons)];
}

// The overview from the status and the threads of one merge request.
export function overviewOf(status: MergeRequestStatus, threads: readonly ReviewThread[]): MergeRequestOverview {
  const behind = status.behind ?? null;
  const ready = status.mergeable === false || (behind ?? 0) >= 1 ? false : status.mergeable === null ? null : true;
  const comments = threads.flatMap((thread) => thread.comments);
  const bot = comments.filter((comment) => comment.bot).length;
  return {
    number: status.number,
    ready,
    reasons: reasonsOf(status),
    behind,
    pipeline: status.pipeline ?? null,
    sonar: sonarOf(threads),
    comments: { human: comments.length - bot, bot },
  };
}

// The overview of merge request number: its status and its threads, read on the host (GET only).
export async function mergeRequestOverview(forge: Pick<Forge, 'status' | 'threads'>, number: number): Promise<MergeRequestOverview> {
  const [status, threads] = await Promise.all([forge.status(number), forge.threads(number)]);
  return overviewOf(status, threads);
}
