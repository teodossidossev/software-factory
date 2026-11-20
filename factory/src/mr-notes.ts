// The factory's notes for the user about a job's MR text: the nits not applied, the simplifications
// the user skipped, the review findings not fixed and an Accept over a stop. The Merge request screen
// shows them under the text (mr-view); they never go into the MR text, the commit or the merge request.
import { claudeReviews, type Job, type JobStore } from './jobs.js';
import { type LedgerEntry, notFixed, notFixedLine } from './ledger.js';
import { itemLine, oneLine, type ReviewItem, uniqueNits } from './review.js';
import { ACCEPTED_HEADING, FINDINGS_HEADING, NITS_HEADING, SIMPLIFY_HEADING } from './rules.js';
import { type Suggestion, suggestionLine } from './simplify.js';

export type NotesStore = Pick<JobStore, 'readReview' | 'readGate' | 'readLedger' | 'readGateOverride' | 'readSimplify'>;

// The notes as Markdown: up to four subsections in the order Nits, Simplifications, Findings,
// Accepted, each its heading and its lines, separated by one blank line; '' when none has a line.
export async function mrNotes(jobs: NotesStore, job: Job): Promise<string> {
  const ledger = await jobs.readLedger(job.workspace, job.ticket);
  const sections: Array<[string, string[]]> = [
    [NITS_HEADING, (await nitsAtClean(jobs, job)).map((item) => `- ${itemLine(item)}`)],
    [SIMPLIFY_HEADING, (await skippedSuggestions(jobs, job)).map((item) => `- ${suggestionLine(item)}`)],
    [FINDINGS_HEADING, notFixed(ledger).map(notFixedLine)],
    [ACCEPTED_HEADING, await acceptedLines(jobs, job, ledger)],
  ];
  return sections.filter(([, lines]) => lines.length > 0).map(([heading, lines]) => [heading, ...lines].join('\n')).join('\n\n');
}

// The nits of the job's last iteration: those of its Claude review and of its gate, deduplicated
// by path and problem; the iteration that reaches Clean leaves them unapplied. Without the Claude
// review the gate's alone.
async function nitsAtClean(jobs: NotesStore, job: Job): Promise<ReviewItem[]> {
  const { workspace, ticket, iteration } = job;
  const records = [claudeReviews(job) ? await jobs.readReview(workspace, ticket, iteration) : undefined, await jobs.readGate(workspace, ticket, iteration)];
  return uniqueNits(records.flatMap((record) => (record !== undefined && 'items' in record ? [record] : [])));
}

// The suggestions the user skipped: those of the newest simplify.json, from the job's iteration
// down, when sf accept marked it skipped_at. A Simplify, or an answer by sf say, leaves none.
async function skippedSuggestions(jobs: NotesStore, job: Job): Promise<Suggestion[]> {
  for (let number = job.iteration; number >= 1; number -= 1) {
    const record = await jobs.readSimplify(job.workspace, job.ticket, number);
    if (record !== undefined) {
      return 'suggestions' in record && record.skipped_at !== undefined ? record.suggestions : [];
    }
  }
  return [];
}

// The user's Accept over a stop of the job's iteration, for a job without the Claude review or at
// the Fix round limit: its gate override's code, with the Claude review off after gate_failed or
// gate_budget the note that no reviewer passed the iteration, then what went unapplied (the gate's
// error, or one line per item, the ledger entries already listed as not fixed aside). None without
// such an override (an Accept over the gate of a job with the Claude review).
async function acceptedLines(jobs: NotesStore, job: Job, ledger: LedgerEntry[]): Promise<string[]> {
  const override = await jobs.readGateOverride(job.workspace, job.ticket, job.iteration);
  if (override === undefined || (claudeReviews(job) && override.code !== 'iteration_limit')) {
    return [];
  }
  const lines = [`- The user accepted iteration ${job.iteration} over ${override.code}.`];
  if (!claudeReviews(job) && (override.code === 'gate_failed' || override.code === 'gate_budget')) {
    lines.push(`- No reviewer passed iteration ${job.iteration}.`);
  }
  if (typeof override.unapplied === 'string') {
    return [...lines, `- The gate failed: ${oneLine(override.unapplied)}`];
  }
  const listed = new Set(notFixed(ledger).map((entry) => entry.id));
  const unapplied = override.unapplied.filter((item) => item.id === undefined || !listed.has(item.id));
  return [...lines, ...unapplied.map((item) => `- ${item.id !== undefined ? `${item.id} ` : ''}${itemLine(item)}`)];
}
