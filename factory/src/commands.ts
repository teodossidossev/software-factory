// The commands that go to sf serve over its socket, in one table (sf coordinator's, sf norms's and sf pins's
// entries are written in src/coordinator.ts, src/norms.ts and src/pins.ts and spread into it): for each, its name, its
// arguments and flags as the help shows them, its help description, whether it answers while sf
// update drains or builds, and the call it makes in sf serve. The CLI (src/cli.ts) builds its help
// lines, its argument check and its socket call from it; sf serve's socket handler
// (src/ipc-handlers.ts) looks the command up in it, checks the arguments with the same checkArgs,
// applies the update gate and calls run. The CLI shows the answer with answerLines, at the end.
import { parseArgs } from 'node:util';
import type { Digests } from './digest-run.js';
import { COORDINATOR_ANSWERS, COORDINATOR_COMMANDS } from './coordinator.js';
import { FactoryError } from './errors.js';
import type { Execution } from './execution.js';
import type { OpenRequest, ReviewThread } from './forge-comments.js';
import { type Decision, DECISIONS } from './ledger.js';
import { localTime } from './local-time.js';
import { NORMS_ANSWERS, NORMS_COMMANDS } from './norms.js';
import { PINS_ANSWERS, PINS_COMMANDS } from './pins.js';
import { MAX_RUNNING, MIN_RUNNING, ON_LIMIT_RULES, type QueueView, type RunQueue } from './queue.js';
import { WORKSPACE_NAME_DESCRIPTION, WORKSPACE_NAME_PATTERN } from './registry.js';
import { ROLES } from './skill-roles.js';
import { type SkillsView, skillsLines, skillsView, switchSkill } from './skills.js';
import { stateDir } from './config.js';
import type { TaskChecks } from './task-check.js';
import { TICKET_DESCRIPTION, TICKET_PATTERN } from './task-file.js';

// A wrong command line: exit 2 from the CLI (with the help), bad_request from the socket.
export class UsageError extends FactoryError {
  constructor(message: string) {
    super('bad_request', message);
    this.name = 'UsageError';
  }
}

// What a command reaches in sf serve.
export interface Serve {
  execution: Execution;
  queue: RunQueue;
  checks: TaskChecks;
  digests: Digests;
  // The port the MCP endpoint bound; undefined until it listens.
  mcpPort(): number | undefined;
}

export type Flags = Readonly<Record<string, string | boolean | undefined>>;

export interface Command {
  // The words after sf ('accept', 'queue add'); on the socket joined by '-' ('queue-add').
  name: string;
  // The positional arguments as the help writes them: <workspace>, [workspace] and <ticket> are
  // checked as names, <N> as a whole number, <x> is any word, a|b one of the words, [x] may be left out,
  // <x...> and [x...] take the rest.
  args: readonly string[];
  // '--as-is' (boolean) or '--at N' (a whole number), each optional.
  flags?: readonly string[];
  // The help's description; none for the requests no CLI command sends (sf info's ping, the tests' hooks).
  description?: string;
  // Answers while sf update drains or builds: pause (the update's own tool), mr status
  // (it starts nothing) and the reads.
  openWhileUpdating?: true;
  // Answered only with SF_TEST_HOOKS=on.
  testOnly?: true;
  // A check of the arguments beyond their words (sf pins resolve's id): the UsageError's message, or undefined.
  refuse?(args: readonly string[]): string | undefined;
  // The call in sf serve, with the checked arguments.
  run(serve: Serve, args: readonly string[], flags: Flags): Promise<unknown>;
}

export const COMMANDS = {
  start: {
    name: 'start', args: ['<workspace>', '<ticket>'],
    description: 'Start the job for .software-factory/<ticket>.md in a worktree of its own',
    run: (s, [w = '', t = '']) => s.execution.start(w, t),
  },
  // sf queue: the run queue of sf serve.
  queueList: {
    name: 'queue list', args: [], openWhileUpdating: true,
    description: 'The run queue: the limit of jobs at once, the running count, held or not (by hand, or by a job parked on a usage limit), the rule at a limit\'s reset, and the queued tickets in order with what each waits for, and the starts that failed',
    run: (s) => s.queue.view(),
  },
  queueAdd: {
    name: 'queue add', args: ['<workspace>', '<ticket>'], flags: ['--at N'],
    description: 'Queue a planned ticket at position N (1-based; default: the end); sf serve starts it by itself when a slot is free, its lands_after tickets are merged and the Task check of its current Task file is ready',
    run: (s, [w = '', t = ''], { at }) => s.queue.add(w, t, typeof at === 'string' ? Number(at) : undefined),
  },
  queueRemove: {
    name: 'queue remove', args: ['<workspace>', '<ticket>'],
    description: 'Take a ticket out of the queue',
    run: (s, [w = '', t = '']) => s.queue.remove(w, t),
  },
  queueMove: {
    name: 'queue move', args: ['<workspace>', '<ticket>', '<N>'],
    description: 'Move a queued ticket to position N',
    run: (s, [w = '', t = '', n = '']) => s.queue.move(w, t, Number(n)),
  },
  queueLimit: {
    name: 'queue limit', args: ['<N>'],
    description: `Run up to N jobs at once (${MIN_RUNNING}-${MAX_RUNNING}, every workspace; default SF_MAX_JOBS); gates only the queue's own starts, a start by hand always goes`,
    run: (s, [n = '']) => s.queue.limit(Number(n)),
  },
  queueHold: {
    name: 'queue hold', args: ['[reason...]'],
    description: 'Hold the queue: it starts nothing until sf queue release',
    run: (s, words) => s.queue.hold(words.join(' ')),
  },
  queueRelease: {
    name: 'queue release', args: [],
    description: 'Release a held queue (a job parked on a usage limit still holds it until it goes on)',
    run: (s) => s.queue.release(),
  },
  queueOnLimit: {
    name: 'queue on-limit', args: [ON_LIMIT_RULES.join('|')],
    description: 'What happens when a usage limit resets: resume the parked jobs, then start queued tickets again (default); resume them and hold the queue; or hold the queue and let you resume them',
    run: (s, [rule = '']) => s.queue.rule(rule),
  },
  queueForce: {
    name: 'queue force', args: ['<workspace>', '<ticket>'],
    description: 'Start anyway: the queued ticket starts whatever its Task check says, until it leaves the queue',
    run: (s, [w = '', t = '']) => s.queue.force(w, t),
  },
  say: {
    name: 'say', args: ['<workspace>', '<ticket>', '<message...>'],
    description: 'Send a message into the job\'s Implementer session; on a handed-over job: Ask for changes (your checkout\'s edits go back into the job first)',
    run: (s, [w = '', t = '', ...words]) => s.execution.say(w, t, words.join(' ')),
  },
  review: {
    name: 'review', args: ['<workspace>', '<ticket>'],
    description: 'Retry a failed Claude review (needs_human with review_failed) of the last iteration',
    run: (s, [w = '', t = '']) => s.execution.retryReview(w, t),
  },
  retry: {
    name: 'retry', args: ['<workspace>', '<ticket>'],
    description: 'Retry a transient MR preparation failure (fetch_failed, mr_serve_restarted, mr_interrupted, mr_commit_failed, mr_rebase_failed, mr_failed) or a stop of the guard (guard_hit, guard_terms_invalid, guard_failed) or a test command that could not run (tests_unavailable) without a new review; on mr_push_failed: push again',
    run: (s, [w = '', t = '']) => s.execution.retryMr(w, t),
  },
  accept: {
    name: 'accept', args: ['<workspace>', '<ticket>'],
    description: 'Accept a clean Claude review over a stopped gate (needs_human with gate_rounds, gate_budget or gate_failed) or a ledger stop (review_churn, review_disputed) or the Fix round limit (iteration_limit) or the workspace\'s tests (tests_failed, tests_unavailable: without passing tests) and prepare the MR; on simplify_offered: skip the suggestions (listed in the MR text)',
    run: (s, [w = '', t = '']) => s.execution.acceptGate(w, t),
  },
  simplify: {
    name: 'simplify', args: ['<workspace>', '<ticket>'],
    description: 'Apply the simplification pass\'s suggestions (needs_human with simplify_offered): one Fix section "Simplify", reviewed as usual; sf accept skips them',
    run: (s, [w = '', t = '']) => s.execution.simplify(w, t),
  },
  settle: {
    name: 'settle', args: ['<workspace>', '<ticket>', '<id>', DECISIONS.join('|'), '[note...]'],
    description: 'Settle an escalated or contested finding of the ledger (needs_human): accept the risk, or the Implementer must fix it; the job goes on once nothing is left to settle',
    run: (s, [w = '', t = '', id = '', decision = '', ...note]) => s.execution.settle(w, t, id, decision as Decision, note.join(' ')),
  },
  approve: {
    name: 'approve', args: ['<workspace>', '<ticket>'], flags: ['--as-is'],
    description: 'Push the branch prepared at Clean; --as-is pushes it even if its tip was edited by hand',
    run: (s, [w = '', t = ''], flags) => s.execution.approve(w, t, flags['as-is'] === true),
  },
  // sf mr create|merge|status, and the reads list and comments.
  mrCreate: {
    name: 'mr create', args: ['<workspace>', '<ticket>'],
    description: 'Open the merge request of a pushed job on GitHub or GitLab (or reuse the open one); from ready_for_human_review: approve, then open it',
    run: (s, [w = '', t = '']) => s.execution.createMergeRequest(w, t),
  },
  mrMerge: {
    name: 'mr merge', args: ['<workspace>', '<ticket>'],
    description: 'Merge the job\'s open merge request through the host\'s API; refused with the host\'s reason when it cannot be merged',
    run: (s, [w = '', t = '']) => s.execution.mergeMergeRequest(w, t),
  },
  mrStatus: {
    name: 'mr status', args: ['<workspace>', '<ticket>'], openWhileUpdating: true,
    description: 'The merge request\'s state on the host: open, merged or closed, mergeable or not, the checks; without a record, the open one of the job\'s branch is found and recorded',
    run: (s, [w = '', t = '']) => s.execution.mergeRequestStatus(w, t),
  },
  mrList: {
    name: 'mr list', args: ['<workspace>'], openWhileUpdating: true,
    description: 'The open merge requests of the workspace\'s origin, newest update first (at most 50); nothing is written to the host',
    run: async (s, [w = '']) => ({ merge_requests: await s.execution.openMergeRequests(w) }),
  },
  mrComments: {
    name: 'mr comments', args: ['<workspace>', '<N>'], openWhileUpdating: true,
    description: 'The review threads of merge request N of the workspace\'s origin, oldest first; nothing is written to the host',
    run: async (s, [w = '', n = '']) => ({ threads: await s.execution.mergeRequestThreads(w, Number(n)) }),
  },
  // sf pause, resume and restart.
  pause: {
    name: 'pause', args: ['<workspace>', '<ticket>'], openWhileUpdating: true,
    description: 'Pause a working job or one awaiting review: the turn, review or gate stops at once; worktree, branch, session and history stay',
    run: (s, [w = '', t = '']) => s.execution.pause(w, t),
  },
  resume: {
    name: 'resume', args: ['<workspace>', '<ticket>', '[message...]'],
    description: 'Go on with a paused job, or one waiting for a usage limit (now, before the reset), where it stopped (the turn with the message, or "Continue where you stopped."; an interrupted review or gate runs again); a Task file changed meanwhile is handed on with its diff',
    run: (s, [w = '', t = '', ...words]) => s.execution.resumePaused(w, t, words.join(' ')),
  },
  restart: {
    name: 'restart', args: ['<workspace>', '<ticket>'], flags: ['--keep-files'],
    description: 'Start the ticket again from its current Task file on a fresh worktree and branch (paused, waiting_limit, aborted, failed or needs_human); the old job is archived, its branch deleted only without commits and never pushed; --keep-files copies the old worktree\'s changed and new files in first',
    run: (s, [w = '', t = ''], flags) => s.execution.restart(w, t, flags['keep-files'] === true),
  },
  // sf handover, takeback and handed-done.
  handover: {
    name: 'handover', args: ['<workspace>', '<ticket>'],
    description: 'Hand over to my checkout: the job\'s branch in the workspace\'s checkout at its base, the job\'s changes as Local Changes, the commit message prefilled (ready_for_human_review; automatic with hand-over on: the workspace\'s handoff, else SF_HANDOFF=checkout)',
    run: (s, [w = '', t = '']) => s.execution.handover(w, t),
  },
  takeback: {
    name: 'takeback', args: ['<workspace>', '<ticket>'],
    description: 'Take it back: the branch back from your checkout into the job (handed_over), only while your checkout is as the factory left it',
    run: (s, [w = '', t = '']) => s.execution.takeback(w, t),
  },
  handedDone: {
    name: 'handed-done', args: ['<workspace>', '<ticket>'], flags: ['--merged'],
    description: 'I opened the MR myself: the job is pushed once origin has the branch with your changes (handed_over); --merged (Merged — archive): you merged the changes (any way, the branch may be gone): the job (handed_over or pushed) is marked merged and archived without asking origin',
    run: (s, [w = '', t = ''], flags) => (flags.merged === true ? s.execution.markMerged(w, t) : s.execution.handedDone(w, t)),
  },
  abort: {
    name: 'abort', args: ['<workspace>', '<ticket>'], flags: ['--discard'],
    description: 'End the job; the worktree stays (its path is printed); --discard removes the worktree and the branch',
    run: (s, [w = '', t = ''], flags) => s.execution.abort(w, t, flags.discard === true),
  },
  reset: {
    name: 'reset', args: ['<workspace>', '<ticket>'],
    description: 'End the session, remove the worktree and archive the job; the branch is untouched',
    run: (s, [w = '', t = '']) => s.execution.reset(w, t),
  },
  // sf skills: the installed skills and each agent role's choice (src/skills.ts, src/skill-roles.ts).
  skills: {
    name: 'skills', args: [], openWhileUpdating: true,
    description: `The installed skills (~/.agents/skills): source, updated, description and, per agent role (${ROLES.join(', ')}), on or -; then the chosen ones that are not installed`,
    run: async () => skillsView(stateDir()),
  },
  skillsSet: {
    name: 'skills set', args: ['<role>', '<skill>', 'on|off'],
    description: 'Switch an installed skill on or off for an agent role, one choice shared by all workspaces; jobs started afterwards use it, a running job keeps its own',
    run: (_s, [role = '', skill = '', on = '']) => switchSkill(stateDir(), role, skill, on === 'on'),
  },
  // sf coordinator: the dashboard's Coordinator card (src/coordinator.ts); each write tells the pages.
  ...COORDINATOR_COMMANDS,
  ...NORMS_COMMANDS, // sf norms: the norms in force, norms.json read at each call (src/norms.ts).
  ...PINS_COMMANDS, // sf pins: the dashboard's pins, pins.json (src/pins.ts).

  // The requests of sf's own steps, no command of their own.
  // sf info: whether sf serve answers; sf service install: which process does.
  ping: { name: 'ping', args: [], openWhileUpdating: true, run: async () => ({ pid: process.pid }) },
  // sf update's drain: the Task checks and the hand-over operations running here now.
  serveBusy: {
    name: 'serve-busy', args: [], openWhileUpdating: true,
    run: async (s) => ({ checks: s.checks.running(), handovers: s.execution.handoversRunning() }),
  },
  // sf digest --now and sf digest.
  digestRun: {
    name: 'digest-run', args: [],
    run: async (s) => {
      const { id, path, cost_usd } = await s.digests.run('manual');
      return { id, path, cost_usd };
    },
  },
  digestLatest: {
    name: 'digest-latest', args: [], openWhileUpdating: true,
    run: async (s) => {
      const latest = await s.digests.latest();
      return latest === undefined ? { digest: null } : { digest: latest.id, period: latest.period, counts: latest.counts, error: latest.error };
    },
  },
  // sf mcp-url with SF_PORT=0: the port the MCP endpoint bound.
  mcpPort: {
    name: 'mcp-port', args: [], openWhileUpdating: true,
    run: async (s) => {
      const port = s.mcpPort();
      if (port === undefined) {
        throw new FactoryError('serve_starting', 'sf serve has not opened its MCP endpoint yet.');
      }
      return { port };
    },
  },
  // Tests only: check, and a reviewer's verdict without a review session, so the end-to-end tests
  // drive the cycle step by step.
  check: {
    name: 'check', args: ['<workspace>', '<ticket>', '[offset]', '[max_bytes]'], openWhileUpdating: true, testOnly: true,
    run: (s, [w = '', t = '', ...page]) => {
      const [offset, maxBytes] = page.map(Number);
      return s.execution.check(w, t, offset, maxBytes);
    },
  },
  fix: {
    name: 'fix', args: ['<workspace>', '<ticket>', '<content>'], testOnly: true,
    run: (s, [w = '', t = '', content = '']) => s.execution.requestFix(w, t, content),
  },
  clean: {
    name: 'clean', args: ['<workspace>', '<ticket>', '[sensitive...]'], testOnly: true,
    run: (s, [w = '', t = '', ...sensitive]) => s.execution.markClean(w, t, sensitive),
  },
} satisfies Record<string, Command>;

// The table in order: the help lists the commands in it.
export const COMMAND_LIST: readonly Command[] = Object.values(COMMANDS);

// The command's name on the socket.
export const socketName = (command: Command): string => command.name.replaceAll(' ', '-');

// The commands of the CLI: those with a description.
const CLI_COMMANDS = COMMAND_LIST.filter((command) => command.description !== undefined);

// The arguments and flags as the help writes them: '<workspace> <ticket> [--as-is]'.
function argumentText(command: Command): string {
  return [...command.args, ...(command.flags ?? []).map((flag) => `[${flag}]`)].join(' ');
}

// The command's help line: 'sf accept <workspace> <ticket>', its description from column 56.
export function usageLine(command: Command): string {
  const text = argumentText(command);
  return `${`  sf ${command.name}${text === '' ? '' : ` ${text}`}`.padEnd(54)}  ${command.description ?? ''}`;
}

// The help lines of the CLI's commands, in the table's order.
export const usageLines = (): string[] => CLI_COMMANDS.map(usageLine);

// The one message of a wrong argument count (or a word not among a|b): 'accept needs <workspace> <ticket>.'
export function usageMessage(command: Command): string {
  const text = argumentText(command);
  return text === '' ? `${command.name} takes no arguments.` : `${command.name} needs ${text}.`;
}

const rest = (token: string): boolean => token.endsWith('...>') || token.endsWith('...]');
const optional = (token: string): boolean => token.startsWith('[');

// Whether the count fits and every a|b word is one of its words.
function fits(tokens: readonly string[], args: readonly string[]): boolean {
  const required = tokens.filter((token) => !optional(token)).length;
  const most = tokens.some(rest) ? Infinity : tokens.length;
  return args.length >= required && args.length <= most
    && tokens.every((token, index) => !token.includes('|') || index >= args.length || token.split('|').includes(args[index]!));
}

export function checkName(name: string | undefined): string {
  if (name === undefined) {
    throw new UsageError('a workspace name is required.');
  }
  if (!WORKSPACE_NAME_PATTERN.test(name)) {
    throw new FactoryError('invalid_name', `workspace name must be ${WORKSPACE_NAME_DESCRIPTION}.`);
  }
  return name;
}

function checkTicket(ticket: string): string {
  if (!TICKET_PATTERN.test(ticket)) {
    throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}.`);
  }
  return ticket;
}

// The <workspace> <ticket> of a command that stays in the CLI.
export function checkJob(args: readonly string[], command: string): [string, string] {
  const [workspace, ticket] = args;
  if (workspace === undefined || ticket === undefined) {
    throw new UsageError(`${command} needs <workspace> <ticket>.`);
  }
  return [checkName(workspace), checkTicket(ticket)];
}

// A 1-based position or a limit as typed: digits only.
function wholeNumber(value: string, what: string): void {
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`${what} must be a whole number.`);
  }
}

// The one argument check of the CLI and of sf serve's socket handler: the flags parsed, the count
// (and the a|b words), the flags' values, then each argument from left to right. A wrong count or
// flag is a UsageError; a wrong name is invalid_name or invalid_ticket.
export function checkArgs(command: Command, argv: readonly string[]): { args: string[]; flags: Flags } {
  let args = [...argv];
  let flags: Flags = {};
  const flagSpecs = (command.flags ?? []).map((spec) => {
    const [flag = '', value] = spec.split(' ');
    return { name: flag.slice(2), flag, value };
  });
  if (flagSpecs.length > 0) {
    const options = Object.fromEntries(flagSpecs.map(({ name, value }) => [name, { type: value === undefined ? 'boolean' as const : 'string' as const }]));
    try {
      ({ positionals: args, values: flags } = parseArgs({ args, allowPositionals: true, strict: true, options }));
    } catch (error) {
      // parseArgs reports an unknown or malformed flag with an ERR_PARSE_ARGS_* code.
      throw (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS') === true ? new UsageError((error as Error).message) : error;
    }
  }
  if (!fits(command.args, args)) {
    throw new UsageError(usageMessage(command));
  }
  for (const { name, flag, value } of flagSpecs) {
    const given = flags[name];
    if (value !== undefined && typeof given === 'string') {
      wholeNumber(given, flag);
    }
  }
  command.args.forEach((token, index) => {
    const arg = args[index];
    if (arg === undefined) {
      return;
    }
    if (token === '<workspace>' || token === '[workspace]') {
      checkName(arg);
    } else if (token === '<ticket>') {
      checkTicket(arg);
    } else if (token === '<N>') {
      wholeNumber(arg, 'N');
    }
  });
  const refusal = command.refuse?.(args);
  if (refusal !== undefined) {
    throw new UsageError(refusal);
  }
  return { args, flags };
}

// The CLI's command of argv, with the arguments after its name; undefined when argv names none.
// A group (queue, mr) without one of its words is a UsageError.
export function cliCommand(argv: readonly string[]): { command: Command; args: string[] } | undefined {
  const [first, second] = argv;
  const group = CLI_COMMANDS.filter((command) => command.name.split(' ')[0] === first);
  if (group.length === 0) {
    return undefined;
  }
  // A word of its own wins over the group's command (sf skills set over sf skills).
  const single = group.find((command) => command.name === first && !group.some((sub) => sub.name === `${first} ${second}`));
  if (single !== undefined) {
    return { command: single, args: argv.slice(1) };
  }
  const sub = group.find((command) => command.name === `${first} ${second}`);
  if (sub === undefined) {
    const words = group.map((command) => command.name.slice(`${first} `.length));
    throw new UsageError(second === undefined ? `${first} needs ${words.slice(0, -1).join(', ')} or ${words.at(-1)}.` : `unknown ${first} command "${second}".`);
  }
  return { command: sub, args: argv.slice(2) };
}

// sf serve's command of a socket request; undefined for an unknown one.
export function socketCommand(name: string): Command | undefined {
  return COMMAND_LIST.find((command) => socketName(command) === name);
}

// ------------------------------------------------------------------ the CLI's output

export type Result = Record<string, unknown>;
export interface Answer {
  lines: string[];
  // sf exits 1.
  failed: boolean;
}

// The answer as key: value lines, objects as JSON.
function resultLines(result: Result): string[] {
  const show = (value: unknown): string => (typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value));
  return Object.entries(result).map(([key, value]) => `${key}: ${show(value)}`);
}

// sf queue list: the limit, the running count, held or not, the entries in order with what each
// waits for, the next one to start and the starts that failed.
function queueLines(view: QueueView): string[] {
  const ref = (row: { workspace: string; ticket: string }): string => `${row.workspace}/${row.ticket}`;
  const lines = [
    `limit: ${view.max_running} job${view.max_running === 1 ? '' : 's'} at once`,
    `running: ${view.running}`,
    `held: ${view.held ? `yes${view.hold_reason !== null ? ` (${view.hold_reason})` : ''}` : 'no'}`,
    // The limit hold: parked jobs hold the queue, whatever the hold by hand.
    ...(view.limit_hold !== null ? [`usage limit: ${view.limit_hold.parked} parked job${view.limit_hold.parked === 1 ? ' holds' : 's hold'} the queue${view.limit_hold.resets_at !== null ? `, resets at ${localTime(view.limit_hold.resets_at)}` : ''}`] : []),
    `on limit reset: ${view.on_limit}`,
    `next: ${view.next !== null ? ref(view.next) : 'nothing ready'}`,
  ];
  lines.push(view.entries.length === 0 ? 'queue: empty' : 'queue:');
  for (const entry of view.entries) {
    const waits = entry.waits_for.map((dep) => `${ref(dep)} (${dep.state})`).join(', ');
    const plan = entry.force ? '  forced (Start anyway)' : entry.plan_reason !== null ? `  ${entry.plan_reason}` : '';
    // The next try of a start that could not fetch, HH:MM of the local time.
    const retry = entry.retry !== null ? `  start failed (${entry.retry.code}); next try ${localTime(entry.retry.at)?.slice(11, 16) ?? entry.retry.at}` : '';
    lines.push(`  ${entry.position}. ${ref(entry)}${waits !== '' ? `  waits for ${waits}` : ''}${retry}${plan}`);
  }
  if (view.errors.length > 0) {
    lines.push('start failed:');
    for (const error of view.errors) {
      lines.push(`  ${ref(error)}  ${error.code}: ${error.message}`);
    }
  }
  return lines;
}

const NO_MR_LINK = 'No merge request link: the origin URL could not be parsed. Open the merge request for the branch above.';

// sf approve: exit 1 unless pushed.
function approved(result: Result): Answer {
  const failed = result.state === 'needs_human' || (result.state === 'handed_over' && result.error !== undefined);
  const noLink = result.state === 'pushed' && result.link === undefined;
  return {
    lines: [...resultLines(result), ...(failed ? ['The push failed; fix it and run sf approve again.'] : noLink ? [NO_MR_LINK] : [])],
    failed: result.state !== 'pushed',
  };
}

// sf retry: MR preparation again, shown as sf review shows its outcome; on mr_push_failed
// the push again, shown and ended as sf approve (exit 1 unless pushed).
function retried(result: Result): Answer {
  const lines = resultLines(result);
  if ('iteration' in result) {
    return { lines, failed: false };
  }
  if (result.state !== 'pushed') {
    return { lines: [...lines, 'The push failed; fix it and run sf retry again.'], failed: true };
  }
  return { lines: [...lines, ...(result.link === undefined ? [NO_MR_LINK] : [])], failed: false };
}

// sf mr create|merge|status: exit 1 when the push or the merge request failed.
function mergeRequestShown(command: Command, result: Result): Answer {
  const mr = result.mr as { number: number; url: string; state: string; reused?: boolean; merge_commit?: string | null } | undefined;
  const error = result.error as { code: string; message: string } | undefined;
  const lines: string[] = [`state: ${String(result.state)}`, `branch: ${String(result.branch)}`];
  if (command === COMMANDS.mrCreate) {
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
  } else if (command === COMMANDS.mrMerge && mr !== undefined) {
    lines.push(`merge request: #${mr.number} merged`, ...(typeof mr.merge_commit === 'string' ? [`merge commit: ${mr.merge_commit}`] : []), `url: ${mr.url}`);
  } else if (command === COMMANDS.mrStatus) {
    // A job without a record, looked up by its branch: how many open ones, or none.
    const found = result.found as { count: number } | undefined;
    if (found !== undefined) {
      lines.push(found.count === 0 ? `No open merge request for branch ${String(result.branch)}.`
        : `Found by branch ${String(result.branch)}${found.count > 1 ? ` (newest of ${found.count} open)` : ''}`);
    }
    const status = result.status as { number: number; url: string; state: string; draft: boolean; mergeable: boolean | null; reason?: string; checks?: string; merge_commit?: string } | undefined;
    lines.push(...(status === undefined ? [] : [
      `merge request: #${status.number} ${status.state}${status.draft ? ' (draft)' : ''}`,
      `url: ${status.url}`,
      ...(status.state === 'open' ? [`mergeable: ${status.mergeable === null ? 'not known yet' : status.mergeable ? 'yes' : 'no'}`] : []),
      ...(status.reason !== undefined && status.state === 'open' ? [`reason: ${status.reason}`] : []),
      ...(status.checks !== undefined ? [`checks: ${status.checks}`] : []),
      ...(status.merge_commit !== undefined ? [`merge commit: ${status.merge_commit}`] : []),
    ]));
  }
  return { lines, failed: error !== undefined };
}

// sf mr list: one line per open merge request.
function openRequestLines(result: Result): string[] {
  const requests = result.merge_requests as OpenRequest[];
  return requests.length === 0 ? ['No open merge requests.'] : requests.map((mr) => `!${mr.number}  ${mr.source} → ${mr.target}  ${mr.author}  ${mr.title}`);
}

// A thread's place: path:line, the path alone, or general for a comment on no file.
const threadPlace = (thread: ReviewThread): string => (thread.path === null ? 'general' : thread.line === null ? thread.path : `${thread.path}:${thread.line}`);

// sf mr comments: each thread's place (path:line or general) and whether it is resolved, then
// each comment's author and time, and its body indented.
function threadLines(result: Result): string[] {
  const threads = result.threads as ReviewThread[];
  if (threads.length === 0) {
    return ['No review comments.'];
  }
  return threads.flatMap((thread, index) => [
    ...(index > 0 ? [''] : []),
    `${threadPlace(thread)}${thread.resolved === null ? '' : thread.resolved ? '  resolved' : '  open'}`,
    ...thread.comments.flatMap((comment) => [`  ${comment.author}${comment.created_at !== '' ? `  ${comment.created_at}` : ''}`, ...comment.body.split('\n').map((line) => `    ${line}`.trimEnd())]),
  ]);
}

// The answers the CLI shows in a way of their own; any other is its key: value lines.
const ANSWERS = new Map<Command, (result: Result, flags: Flags) => Answer>([
  [COMMANDS.queueList, (result) => ({ lines: queueLines(result as unknown as QueueView), failed: false })],
  [COMMANDS.approve, approved],
  [COMMANDS.retry, retried],
  [COMMANDS.mrCreate, (result) => mergeRequestShown(COMMANDS.mrCreate, result)],
  [COMMANDS.mrMerge, (result) => mergeRequestShown(COMMANDS.mrMerge, result)],
  [COMMANDS.mrStatus, (result) => mergeRequestShown(COMMANDS.mrStatus, result)],
  [COMMANDS.mrList, (result) => ({ lines: openRequestLines(result), failed: false })],
  [COMMANDS.mrComments, (result) => ({ lines: threadLines(result), failed: false })],
  [COMMANDS.skills, (result) => ({ lines: skillsLines(result as unknown as SkillsView), failed: false })],
  [COMMANDS.skillsSet, (result) => ({ lines: skillsLines(result as unknown as SkillsView), failed: false })],
  ...COORDINATOR_ANSWERS,
  ...NORMS_ANSWERS,
  ...PINS_ANSWERS,
  [COMMANDS.abort, (result, flags) => ({
    lines: [
      ...resultLines(result),
      ...(result.error === undefined && flags.discard !== true
        ? [result.worktree === null ? 'The branch is left as it is.' : `The branch and its worktree are left as they are: ${String(result.worktree)}`]
        : []),
    ],
    failed: result.error !== undefined,
  })],
  [COMMANDS.restart, (result) => ({
    lines: [...resultLines(result), result.branch_deleted === null ? 'The old job is archived; it had no branch to delete.' : 'The old job is archived and its branch deleted (no commits, never pushed).'],
    failed: false,
  })],
  [COMMANDS.reset, (result) => ({
    lines: [...resultLines(result), result.checkout === 'unavailable'
      ? 'The workspace is not registered (or its checkout is gone): only the job record was archived; nothing in Git was touched.'
      : 'The worktree is removed; the branch is untouched.'],
    failed: false,
  })],
]);

// How the CLI shows the answer of sf serve to the command: its lines, and whether sf exits 1.
export function answerLines(command: Command, result: Result, flags: Flags): Answer {
  return ANSWERS.get(command)?.(result, flags) ?? { lines: resultLines(result), failed: false };
}
