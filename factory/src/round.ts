// The review round of an iteration. On a job with the Claude review whose gate runs on the
// iteration, the round is joint: the Claude review and the Codex gate review it at the same time,
// and their fix items make one Fix section. Without the Claude review the gate is the round's only
// reviewer; with the gate off, skipped by the iteration's gate level or held by SF_GATE_MAX_TOKENS,
// the Claude review is. This module is pure: who still runs in a round, the order in which the
// reviewers' ends apply, and the merge of two verdicts' items into one Fix. The Execution
// (src/execution/reviews.ts) runs the sessions, keeps their records and acts on the outcome.
import { GATE_REVIEWER } from './gate.js';
import type { GateRecord, ReviewRecord } from './jobs.js';
import { applyVerdict, type Applied, factoryKey, FACTORY_PROBLEMS, type FixItem, type LedgerEntry, roundProgress, type RoundProgress, SEVERITY_RANK as RANK } from './ledger.js';
import { decide, fixContent, jointFixContent, oneLine, REVIEWER, type ReviewItem, type Severity } from './review.js';
import type { UsageLimit } from './usage-limit.js';

// Where the gate stands in a round: the only reviewer (a job without the Claude review), joint
// with the Claude review, held by SF_GATE_MAX_TOKENS (budget: the Claude review runs alone, and its
// clean verdict ends in gate_budget), or off (the gate off or skipped: the Claude review decides).
export type GatePlace = 'only' | 'joint' | 'budget' | 'off';

// The gate's place in the round of a job's iteration. levelRuns: the gate on and run by the
// iteration's gate level; stored: a gate verdict of the iteration is kept. At SF_GATE_MAX_TOKENS no
// gate starts, but a kept verdict still counts.
export function gatePlace(input: { claudeReview: boolean; levelRuns: boolean; stored: boolean; tokens: number; maxTokens: number }): GatePlace {
  if (!input.claudeReview) {
    return 'only';
  }
  if (!input.levelRuns) {
    return 'off';
  }
  return input.stored || input.tokens < input.maxTokens ? 'joint' : 'budget';
}

// Who still runs in a round: each reviewer of it without a stored verdict (a stored failure
// counts as none).
export function roundRuns(place: GatePlace, stored: { claude: boolean; gate: boolean }): { claude: boolean; gate: boolean } {
  return { claude: place !== 'only' && !stored.claude, gate: (place === 'only' || place === 'joint') && !stored.gate };
}

// The job's error when the gate runs have used SF_GATE_MAX_TOKENS before a gate starts.
export function budgetMessage(tokens: number, maxTokens: number): string {
  return `The gate runs of this job used ${tokens} tokens, the limit of SF_GATE_MAX_TOKENS (${maxTokens}); the user decides how to go on.`;
}

// The stop at SF_GATE_MAX_ROUNDS: stalled the gate's fix rounds without progress since its
// first fix, this one included; max SF_GATE_MAX_ROUNDS; round the judgement of this round; the
// reviewers' summaries.
export function gateRoundsMessage(stalled: number, max: number, round: RoundProgress, claude: string, codex: string): string {
  const message = `The gate's fix rounds without progress since its first fix reached ${stalled}, the limit of SF_GATE_MAX_ROUNDS (${max}); the fix was not applied. Open blocker or major findings: ${round.open} (${round.raised} raised by the last review, ${round.reopened} of them reopened; ${round.open - round.raised} carried from earlier rounds). Claude: ${oneLine(claude)} Codex: ${oneLine(codex)}`;
  return message.slice(0, 2000);
}

// How a reviewer's session of this round ended, besides its record: the usage limit it hit or the
// code of its failure (a refusal, gate_sandbox_unavailable).
export interface SessionEnd {
  limit?: UsageLimit;
  code?: string;
}

// What a reviewer brings to the end of a round: its record of the iteration (undefined when it has
// none), the factory's items for the marked paths its verdict does not accept, and how its session
// ended when it ran in this round.
export interface ReviewerEnd<R> extends SessionEnd {
  record: R | undefined;
  extra: ReviewItem[];
}

export interface RoundInput {
  place: GatePlace;
  ledger: LedgerEntry[];
  iteration: number;
  // Absent for 'only'.
  claude?: ReviewerEnd<ReviewRecord>;
  // Present for 'only' and 'joint'.
  gate?: ReviewerEnd<GateRecord>;
  // The job's gate_fixes: the gate fixes written so far.
  gateFixes: number;
  // The job's least_open.
  least: number | undefined;
  // The job's gate_stalled: its counted gate fix rounds without progress.
  gateStalled: number;
  gateTokens: number;
  maxRounds: number;
  maxTokens: number;
}

// The outcome of a round, and the items each reviewer's verdict dropped (they reopened an accepted
// risk), for its record. A stop writes its ledger when it has one; a fix counts for gate_fixes when
// the gate's verdict is a fix, and, after the gate's first fix, for gate_stalled when the round made
// no progress (progress: the judgement of the round's ledger, roundProgress). The gate's limit counts
// its fix rounds without progress after its first fix.
export type RoundOutcome = { dropped: { claude?: ReviewItem[]; gate?: ReviewItem[] } } & (
  | { kind: 'park'; step: 'review' | 'gate'; limit: UsageLimit }
  | { kind: 'stop'; code: string; message: string; ledger?: LedgerEntry[] }
  | { kind: 'fix'; content: string; ledger: LedgerEntry[]; gateFix: boolean; progress: RoundProgress }
  | { kind: 'clean'; ledger: LedgerEntry[]; accepted: string[] }
);

type Stop = { code: string; message: string };
type Verdicted<R> = Extract<R, { verdict: 'clean' | 'fix' }>;
function verdictIn<R extends ReviewRecord | GateRecord>(record: R | undefined): record is Verdicted<R> {
  return record !== undefined && 'verdict' in record;
}

const higher = (a: Severity, b: Severity): Severity => (RANK[b] > RANK[a] ? b : a);
const CLAUDE = 'Claude';
const CODEX = 'Codex';
const BOTH = `${CLAUDE} and ${CODEX}`;
const NAMES: Record<string, string> = { [REVIEWER]: CLAUDE, [GATE_REVIEWER]: CODEX, user: 'the user' };

// The round's outcome, in this order: Claude's usage limit (park at review), failure or refusal
// (review_failed, the refusal's code); the gate's usage limit (park at gate), failure (gate_failed,
// gate_sandbox_unavailable) or tokens over SF_GATE_MAX_TOKENS (gate_budget); a ledger stop; Clean;
// the gate's fix rounds without progress after its first fix (gate_rounds); else one Fix section.
// A Claude verdict that is a fix as decide reads it wins over a gate that failed or would stop the
// job: its Fix section is made as Claude's alone.
export function roundOutcome(input: RoundInput): RoundOutcome {
  const { claude, gate } = input;
  const none = { dropped: {} };
  if (claude !== undefined) {
    if (claude.limit !== undefined) {
      return { kind: 'park', step: 'review', limit: claude.limit, ...none };
    }
    if (!verdictIn(claude.record)) {
      return { kind: 'stop', code: claude.code ?? 'review_failed', message: claude.record?.error ?? 'The Claude review left no verdict.', ...none };
    }
  }
  let gateStop: Stop | undefined;
  if (gate !== undefined) {
    if (gate.limit !== undefined) {
      return { kind: 'park', step: 'gate', limit: gate.limit, ...none };
    }
    if (!verdictIn(gate.record)) {
      gateStop = { code: gate.code ?? 'gate_failed', message: gate.record?.error ?? 'The gate left no verdict.' };
    } else if (input.gateTokens > input.maxTokens) {
      gateStop = {
        code: 'gate_budget',
        message: `The gate runs of this job used ${input.gateTokens} tokens, over the limit of SF_GATE_MAX_TOKENS (${input.maxTokens}); the gate's verdict (${gate.record.verdict}) was not applied.`,
      };
    }
  }
  if (claude === undefined) {
    return gateStop !== undefined ? { kind: 'stop', ...gateStop, ...none } : gateAlone(input, gate!.record as Verdicted<GateRecord>, gate!.extra);
  }
  const review = claude.record as Verdicted<ReviewRecord>;
  if (gate === undefined || gateStop !== undefined) {
    return claudeAlone(input, review, claude.extra, gateStop);
  }
  return joint(input, review, claude.extra, gate.record as Verdicted<GateRecord>, gate.extra);
}

// The gate as the job's only reviewer: its verdict decides; a fix counts for gate_fixes, and after
// the gate's first fix for gate_stalled when the round made no progress, but never stops the job.
function gateAlone(input: RoundInput, gate: Verdicted<GateRecord>, extra: ReviewItem[]): RoundOutcome {
  const applied = applyVerdict({ ledger: input.ledger, items: gate.items, extra, reviewer: GATE_REVIEWER, iteration: input.iteration, decides: true });
  const dropped = { gate: applied.dropped };
  return applied.kind === 'stop'
    ? { kind: 'stop', code: applied.code, message: applied.message, ledger: applied.ledger, dropped }
    : applied.kind === 'fix'
      ? { kind: 'fix', content: fixContent(gate.summary, applied.items, CODEX), ledger: applied.ledger, gateFix: true, progress: roundProgress(input.ledger, applied.ledger, input.least), dropped }
      : { kind: 'clean', ledger: applied.ledger, accepted: gate.accepted_sensitive, dropped };
}

// The Claude review without the gate's verdict: the gate off or skipped (Claude decides), held by
// SF_GATE_MAX_TOKENS (a clean verdict ends in gate_budget), or failed (gateStop: a clean verdict
// stops the job with it, a fix is the next Fix section and the gate runs again in the next round).
function claudeAlone(input: RoundInput, review: Verdicted<ReviewRecord>, extra: ReviewItem[], gateStop: Stop | undefined): RoundOutcome {
  const applied = applyVerdict({ ledger: input.ledger, items: review.items, extra, reviewer: REVIEWER, iteration: input.iteration, decides: input.place === 'off' });
  const dropped = { claude: applied.dropped };
  // Beside a failed gate only Claude's own fix (decide) goes on; open entries alone do not.
  if (applied.kind === 'fix' && (gateStop === undefined || decide(review, extra).verdict === 'fix')) {
    return { kind: 'fix', content: fixContent(review.summary, applied.items), ledger: applied.ledger, gateFix: false, progress: roundProgress(input.ledger, applied.ledger, input.least), dropped };
  }
  if (gateStop !== undefined) {
    return { kind: 'stop', ...gateStop, dropped };
  }
  if (applied.kind === 'stop') {
    return { kind: 'stop', code: applied.code, message: applied.message, ledger: applied.ledger, dropped };
  }
  if (input.place === 'budget') {
    return { kind: 'stop', code: 'gate_budget', message: budgetMessage(input.gateTokens, input.maxTokens), ledger: applied.ledger, dropped };
  }
  return { kind: 'clean', ledger: applied.ledger, accepted: review.accepted_sensitive, dropped };
}

// The key two items share when uniqueNits compares them: path and problem, each on one line.
const textKey = (item: { path: string; problem: string }): string => `${oneLine(item.path)}\n${oneLine(item.problem)}`;
const reopened = (item: ReviewItem): string => item.reopens?.trim() ?? '';

// Whether a gate item is a Claude item: the same path and problem, or the same ledger entry the
// Claude item reopens (by its id, or by the entry's path and problem).
function sameItem(claude: ReviewItem, gate: ReviewItem, ledger: LedgerEntry[]): boolean {
  if (textKey(claude) === textKey(gate)) {
    return true;
  }
  const id = reopened(claude);
  if (id === '') {
    return false;
  }
  const entry = ledger.find((candidate) => candidate.id === id);
  return reopened(gate) === id || (entry !== undefined && textKey(entry) === textKey(gate));
}

// The shared items of two verdicts, found before either pass: each gate item that is a Claude item
// is dropped, and the Claude item (a copy) takes the higher of the two severities. original maps a
// copy back to the item of review.json; gateBlocking holds the copies the gate raised as a blocker
// or major.
export function shareItems(claude: ReviewItem[], gate: ReviewItem[], ledger: LedgerEntry[]): {
  claude: ReviewItem[]; gate: ReviewItem[]; shared: Set<ReviewItem>; gateBlocking: Set<ReviewItem>; original: Map<ReviewItem, ReviewItem>;
} {
  const copies = claude.map((item) => ({ ...item }));
  const original = new Map<ReviewItem, ReviewItem>(copies.map((copy, index) => [copy, claude[index]!]));
  const shared = new Set<ReviewItem>();
  const gateBlocking = new Set<ReviewItem>();
  const rest: ReviewItem[] = [];
  for (const item of gate) {
    const twin = copies.find((copy) => sameItem(copy, item, ledger));
    if (twin === undefined) {
      rest.push(item);
      continue;
    }
    twin.severity = higher(twin.severity, item.severity);
    // The entry the gate's item reopens stays reopened, once, through Claude's.
    if (reopened(twin) === '' && reopened(item) !== '') {
      twin.reopens = item.reopens;
    }
    shared.add(twin);
    if (item.severity !== 'nit') {
      gateBlocking.add(twin);
    }
  }
  return { claude: copies, gate: rest, shared, gateBlocking, original };
}

// A joint round: the shared items merged first (shareItems), then Claude's verdict through the
// ledger, then the gate's on the ledger that left. Both decide (settle earlier rounds' open entries)
// only when both are clean as decide reads them. A marked path one reviewer does not accept stays a
// fix item, and its entry open, though the other accepts it (keep). A ledger stop of either stops
// the job, Claude's first (the gate's items then get no entry); a gate stop gives way to Claude's
// own fix, and otherwise writes no id or ask of a Claude pass that made no Fix section. The gate's
// verdict is a fix when its own pass is, or a shared item it raised blocks.
function joint(input: RoundInput, review: Verdicted<ReviewRecord>, claudeExtra: ReviewItem[], gate: Verdicted<GateRecord>, gateExtra: ReviewItem[]): RoundOutcome {
  const { ledger, iteration } = input;
  const claudeFix = decide(review, claudeExtra).verdict === 'fix';
  const decides = !claudeFix && decide(gate, gateExtra).verdict === 'clean';
  const items = shareItems(review.items, gate.items, ledger);
  const claudeKeys = new Set(claudeExtra.map(factoryKey));
  const gateKeys = new Set(gateExtra.map(factoryKey));
  const first = applyVerdict({ ledger, items: items.claude, extra: claudeExtra, reviewer: REVIEWER, iteration, decides, keep: gateKeys });
  const dropped: RoundOutcome['dropped'] = { claude: first.dropped.map((item) => items.original.get(item) ?? item) };
  if (first.kind === 'stop') {
    return { kind: 'stop', code: first.code, message: first.message, ledger: first.ledger, dropped };
  }
  const second = applyVerdict({ ledger: first.ledger, items: items.gate, extra: gateExtra, reviewer: GATE_REVIEWER, iteration, decides, keep: claudeKeys });
  dropped.gate = second.dropped;
  // When the gate's side would stop the job, Claude's own fix (decide, not one made by a shared
  // item or carried entries) wins, as Claude alone makes it: its own items, without the merge.
  const alone = (): RoundOutcome | undefined => {
    const own = claudeFix ? applyVerdict({ ledger, items: review.items, extra: claudeExtra, reviewer: REVIEWER, iteration, decides: false, keep: gateKeys }) : undefined;
    return own?.kind === 'fix'
      ? { kind: 'fix', content: fixContent(review.summary, own.items), ledger: own.ledger, gateFix: false, progress: roundProgress(ledger, own.ledger, input.least), dropped: { claude: own.dropped, gate: second.dropped } }
      : undefined;
  };
  if (second.kind === 'stop') {
    // A Claude pass that made no Fix section leaves no id and no ask: the gate's stop then reads
    // against the ledger as the round found it.
    const stop = first.kind === 'fix' ? applyVerdict({ ledger, items: items.gate, extra: gateExtra, reviewer: GATE_REVIEWER, iteration, decides, keep: claudeKeys }) : second;
    return alone() ?? (stop.kind === 'stop'
      ? { kind: 'stop', code: stop.code, message: stop.message, ledger: stop.ledger, dropped }
      : { kind: 'stop', code: second.code, message: second.message, dropped });
  }
  // A gate fix always comes with a pass that is a fix, so a clean round never meets the gate's limit.
  if (first.kind !== 'fix' && second.kind !== 'fix') {
    return { kind: 'clean', ledger: second.ledger, accepted: [...new Set([...review.accepted_sensitive, ...gate.accepted_sensitive])], dropped };
  }
  const gateFix = second.kind === 'fix' || [...items.gateBlocking].some((item) => !first.dropped.includes(item));
  // Who raised an item in this round; none for an entry carried over.
  const raisedBy = (fixItem: FixItem, name: string, inputs: ReviewItem[]): string[] => {
    if (items.shared.has(fixItem.item)) {
      return [CLAUDE, CODEX];
    }
    if (FACTORY_PROBLEMS.includes(fixItem.item.problem)) {
      const key = factoryKey(fixItem.item);
      return [...(claudeKeys.has(key) ? [CLAUDE] : []), ...(gateKeys.has(key) ? [CODEX] : [])];
    }
    return inputs.includes(fixItem.item) ? [name] : [];
  };
  const merged = mergeFixItems([[first, CLAUDE, items.claude], [second, CODEX, items.gate]], raisedBy, second.ledger);
  // Judged on the merged ledger, the one the Fix section is judged on for SF_MAX_ITERATIONS, so the
  // gate's fix rounds without progress are a part of the job's. The gate's first fix never counts;
  // the gate fix of the round that reaches SF_GATE_MAX_ROUNDS is not applied.
  const progress = roundProgress(ledger, merged.ledger, input.least);
  if (gateFix && !progress.progress && input.gateFixes > 0 && input.gateStalled + 1 >= input.maxRounds) {
    const message = gateRoundsMessage(input.gateStalled + 1, input.maxRounds, progress, review.summary, gate.summary);
    return alone() ?? { kind: 'stop', code: 'gate_rounds', message, dropped };
  }
  return { kind: 'fix', content: jointFixContent(review.summary, gate.summary, merged.items), ledger: merged.ledger, gateFix, progress, dropped };
}

// The Fix items of both passes as one list, Claude's first: an id both give is one item with the
// higher severity (its ledger entry too), each item tagged with who raised it in this round, or
// with the ledger reviewer of an entry carried over.
function mergeFixItems(
  passes: Array<[Applied, string, ReviewItem[]]>, raisedBy: (fixItem: FixItem, name: string, inputs: ReviewItem[]) => string[], ledger: LedgerEntry[],
): { items: FixItem[]; ledger: LedgerEntry[] } {
  const byId = new Map<string, { fixItem: FixItem; raised: Set<string> }>();
  for (const [applied, name, inputs] of passes) {
    for (const fixItem of applied.kind === 'fix' ? applied.items : []) {
      const found = byId.get(fixItem.id);
      const raised = raisedBy(fixItem, name, inputs);
      if (found === undefined) {
        byId.set(fixItem.id, { fixItem, raised: new Set(raised) });
        continue;
      }
      raised.forEach((who) => found.raised.add(who));
      const severity = higher(found.fixItem.item.severity, fixItem.item.severity);
      found.fixItem = { ...found.fixItem, item: { ...found.fixItem.item, severity } };
    }
  }
  const severities = new Map([...byId].map(([id, { fixItem }]) => [id, fixItem.item.severity]));
  const items = [...byId.values()].map(({ fixItem, raised }) => {
    const entry = ledger.find((candidate) => candidate.id === fixItem.id);
    const by = raised.size > 0 ? (raised.size > 1 ? BOTH : [...raised][0]!) : (NAMES[entry?.reviewer ?? ''] ?? entry?.reviewer);
    return by === undefined ? fixItem : { ...fixItem, by };
  });
  const merged = ledger.map((entry) => {
    const severity = severities.get(entry.id);
    return severity !== undefined && RANK[severity] > RANK[entry.severity] ? { ...entry, severity } : entry;
  });
  return { items, ledger: merged };
}
