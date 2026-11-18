// The chains of parts of the dashboard's tickets payload: the Task files of one workspace with the
// same part_of and a slice (src/task-file.ts taskSlice), each part with its number and its state.
// Not the builds_on chain of a Task check (src/builds-on.ts).
import { sitsOnPart } from './builds-on.js';
import { type Job, TERMINAL_STATES } from './jobs.js';
import type { DependencyRow, DependencyState } from './setup.js';
import { taskSlice, type TicketRef } from './task-file.js';

// merged: merged into its base; submitted: pushed, not merged; ready: waits for the user's review
// with its change on its base; on_part: waits for the user's review, still on the part it builds on;
// stopped: needs the user or paused; working: any other live job; planned: no live job, not pushed.
export const CHAIN_STATES = ['merged', 'submitted', 'ready', 'on_part', 'stopped', 'working', 'planned'] as const;
export type ChainState = (typeof CHAIN_STATES)[number];
export interface ChainPart { ticket: string; n: number; base: string; state: ChainState }
export interface ChainRow { workspace: string; ticket: string; count: number; parts: ChainPart[] }
// A Task file as Setup reads it: its workspace's name, its ticket, its front matter, the ticket's
// job (undefined without one) and whether it was read from the archive.
export interface ChainFile { name: string; ticket: string; fields: Map<string, string>; job: Job | undefined; archived: boolean }

// The state of a part without a live job, from the dependency rule (src/setup.ts DependencyState).
const RULE_STATES: Record<DependencyState, ChainState> = { merged: 'merged', pushed: 'submitted', running: 'working', planned: 'planned', missing: 'planned' };

// The state of a part with a live job.
function liveState(job: Job): ChainState {
  switch (job.state) {
    case 'ready_for_human_review':
    case 'handed_over':
      return sitsOnPart(job) ? 'on_part' : 'ready';
    case 'needs_human':
    case 'paused':
      return 'stopped';
    default:
      return 'working';
  }
}

// The chains of the files, sorted by workspace then main ticket, each with its parts sorted by
// number then ticket; only the chains with an active file among their parts or as their main ticket.
// states: the dependency rule, asked once with the parts that have no live job (never with none).
export async function chainRows(files: ChainFile[], states: (refs: TicketRef[]) => Promise<DependencyRow[]>): Promise<ChainRow[]> {
  const key = (workspace: string, ticket: string): string => `${workspace}/${ticket}`;
  const active = new Set(files.filter((file) => !file.archived).map((file) => key(file.name, file.ticket)));
  // The groups by workspace and part_of, each with its parts (file, n, M of its slice).
  const groups = new Map<string, { workspace: string; ticket: string; parts: Array<{ file: ChainFile; n: number; of: number }> }>();
  for (const file of files) {
    const { part_of: partOf, slice } = taskSlice(file.fields);
    if ((file.archived && active.has(key(file.name, file.ticket))) || partOf === undefined || slice === undefined) {
      continue;
    }
    const group = groups.get(key(file.name, partOf)) ?? { workspace: file.name, ticket: partOf, parts: [] };
    group.parts.push({ file, n: slice.n, of: slice.of });
    groups.set(key(file.name, partOf), group);
  }
  const kept = [...groups.values()].filter((group) => active.has(key(group.workspace, group.ticket)) || group.parts.some(({ file }) => !file.archived));
  const live = (job: Job | undefined): job is Job => job !== undefined && !TERMINAL_STATES.includes(job.state);
  const refs = kept.flatMap((group) => group.parts.filter(({ file }) => !live(file.job)).map(({ file }) => ({ workspace: file.name, ticket: file.ticket })));
  const rule = new Map((refs.length > 0 ? await states(refs) : []).map((row) => [key(row.workspace, row.ticket), RULE_STATES[row.state]]));
  const rows = kept.map(({ workspace, ticket, parts }): ChainRow => ({
    workspace,
    ticket,
    count: Math.max(...parts.map(({ of }) => of)),
    parts: [...parts].sort((a, b) => a.n - b.n || compare(a.file.ticket, b.file.ticket)).map(({ file, n }) => ({
      ticket: file.ticket, n, base: file.fields.get('base') ?? '',
      state: live(file.job) ? liveState(file.job) : rule.get(key(file.name, file.ticket)) ?? 'planned',
    })),
  }));
  return rows.sort((a, b) => compare(a.workspace, b.workspace) || compare(a.ticket, b.ticket));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
