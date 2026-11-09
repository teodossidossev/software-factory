// The turn limit of an Implementer turn: when a turn ends at maxTurns (SF_MAX_TURNS),
// the factory goes on by itself, at most SF_TURN_LIMIT_CONTINUES times per chain of turns, while
// the turn made progress: the worktree changed during it and it was not repeating one tool call.
// Otherwise the job stops with a plain sentence. The session driver (src/session.ts) counts the
// chain; this module judges a turn and words the outcome. The worktree state is the Patch's view
// (src/patch.ts, patchDigest): the changed paths and a hash of the whole patch, never the one cut
// for display, taken at the start of every turn.
import { type Job, TERMINAL_STATES } from './jobs.js';
import { patchDigest } from './patch.js';
import type { ToolCall } from './session.js';

// The continuation sent into the same session.
export const CONTINUE_PROMPT = 'You reached the turn limit of this turn. Continue where you stopped; do not redo finished work.';
// The repetition test: among the last REPEAT_WINDOW tool calls, one call (same tool, same input)
// more than MAX_REPEATS times.
export const REPEAT_WINDOW = 20;
export const MAX_REPEATS = 3;
const INPUT_CHARS = 120;

// What the worktree holds against the base: its changed paths, sorted, and the sha256 of the whole patch.
export interface WorktreeState {
  paths: string[];
  hash: string;
}

export function worktreeState(cwd: string, baseCommit: string): Promise<WorktreeState> {
  return patchDigest(cwd, baseCommit);
}

// Whether the worktree changed between the two states; undefined when either is unknown (Git
// failed), which counts as no progress.
export function worktreeChanged(start: WorktreeState | undefined, end: WorktreeState | undefined): boolean | undefined {
  if (start === undefined || end === undefined) {
    return undefined;
  }
  return start.hash !== end.hash || start.paths.length !== end.paths.length || start.paths.some((path, index) => path !== end.paths[index]);
}

function callKey(call: ToolCall): string {
  return `${call.name} ${JSON.stringify(call.input ?? {})}`;
}

// The call made more than MAX_REPEATS times among the last REPEAT_WINDOW calls, as "<tool> <input>"
// (the input cut short); undefined when the turn was not repeating itself.
export function repeatedCall(calls: readonly ToolCall[]): string | undefined {
  const counts = new Map<string, number>();
  for (const call of calls.slice(-REPEAT_WINDOW)) {
    const key = callKey(call);
    const count = (counts.get(key) ?? 0) + 1;
    if (count > MAX_REPEATS) {
      return key.length > INPUT_CHARS ? `${key.slice(0, INPUT_CHARS - 1)}…` : key;
    }
    counts.set(key, count);
  }
  return undefined;
}

export interface LimitInput {
  // maxTurns of the turn (SF_MAX_TURNS).
  maxTurns: number;
  // Whether the worktree changed during the turn; undefined when it could not be read.
  changed: boolean | undefined;
  calls: readonly ToolCall[];
  // Continuations already sent in this chain, and how many the chain may have.
  continued: number;
  allowed: number;
}

export type LimitDecision = { continue: true } | { continue: false; message: string };

// Go on (progress, and a continuation left) or stop with the sentence of why not.
export function limitDecision(turn: LimitInput): LimitDecision {
  const steps = `The Implementer used all ${turn.maxTurns} steps of this turn`;
  const repeating = repeatedCall(turn.calls);
  if (repeating !== undefined || turn.changed !== true) {
    const unchanged = turn.changed === true ? '' : turn.changed === false ? ' without changing files' : ' and its changes to the files could not be read';
    const loop = repeating !== undefined ? ` and was repeating \`${repeating.replace(/`/g, "'")}\`` : '';
    return { continue: false, message: `${steps}${unchanged}${loop}.` };
  }
  if (turn.continued >= turn.allowed) {
    const times = turn.continued + 1;
    const inARow = times === 1 ? '' : times === 2 ? ' twice in a row' : ` ${times} times in a row`;
    return { continue: false, message: `${steps}${inARow}; it may need a smaller task or a higher SF_MAX_TURNS.` };
  }
  return { continue: true };
}

// The one line of a job whose current chain went on by itself after a turn limit, for sf status,
// the notifications and the board; undefined without one, once the job has ended, and when the
// chain stopped at a later turn limit (its max_turns error says so).
export function turnLimitLine(job: Pick<Job, 'state' | 'turn_limit' | 'error'>): string | undefined {
  if (job.turn_limit === undefined || TERMINAL_STATES.includes(job.state) || job.error?.code === 'max_turns') {
    return undefined;
  }
  const { continued, allowed } = job.turn_limit;
  return `The Implementer reached the turn limit while making progress; the factory went on by itself (${continued} of ${Math.max(continued, allowed)}).`;
}
