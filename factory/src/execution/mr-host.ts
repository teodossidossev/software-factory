// The reads of a job's merge request on the Git host, for sf mr status and the dashboard's Refresh
// MR status: the recorded one's state now (a merge or close done on the host is recorded), or, for a
// job without a record in MR_LOOKUP_STATES (the user pushed it and opened its merge request by hand),
// the open ones of its branch into its base; and whether the merge request actions are on
// for a workspace. Nothing here writes to the host: a read-only token is enough.
import { FactoryError } from '../errors.js';
import { chooseForge, type Forge, type ForgeKind } from '../forge.js';
import { pushedBranch } from '../continues.js';
import type { Job, JobMr } from '../jobs.js';
import { originUrl } from '../mr.js';
import { MR_LOOKUP_STATES } from '../stops.js';
import type { MrStatusOutcome } from './dto.js';
import type { JobStorePort, LockPort, SettingsPort } from './ports.js';

export interface MrHostPorts {
  store: JobStorePort;
  locks: LockPort;
  settings: SettingsPort;
  // The Forge of the job's workspace (MrPart's, refused when the recorded host is not the origin's).
  forge: (job: Job) => Promise<Forge>;
  // Appends the job's merge_request event.
  event: (job: Job, action: 'updated' | 'found') => Promise<void>;
}

export class MrHostReads {
  readonly #ports: MrHostPorts;

  constructor(ports: MrHostPorts) {
    this.#ports = ports;
  }

  // sf mr status: what the host says of the job's merge request now. A merge request the
  // host has merged or closed meanwhile (by hand) is recorded so; nobody is notified. Without a
  // record, in MR_LOOKUP_STATES, the job's branch is looked up.
  async status(workspaceName: string, ticket: string): Promise<MrStatusOutcome> {
    const { store, locks, forge, event } = this.#ports;
    const job = await store.job(workspaceName, ticket);
    if (job.mr === null && MR_LOOKUP_STATES.includes(job.state)) {
      return this.#find(job);
    }
    if (job.mr === null) {
      throw new FactoryError('invalid_state', `No merge request is recorded for ${workspaceName}/${ticket}; sf mr create opens one.`);
    }
    const number = job.mr.number;
    const status = await (await forge(job)).status(number);
    return locks.locked(async () => {
      const current = await store.job(workspaceName, ticket);
      if (current.mr === null || current.mr.number !== number || current.mr.state === status.state) {
        return { state: current.state, branch: current.branch, mr: current.mr ?? job.mr!, status };
      }
      const next: Job = { ...current, mr: { ...current.mr, state: status.state, ...(status.merge_commit !== undefined ? { merge_commit: status.merge_commit } : {}) } };
      await store.jobs.write(next);
      await event(next, 'updated');
      return { state: next.state, branch: next.branch, mr: next.mr!, status };
    });
  }

  // The open merge requests from the job's branch on origin into its base, with GET only: the newest
  // is recorded (a found event) and read as a recorded one; none records nothing. found counts them.
  async #find(job: Job): Promise<MrStatusOutcome> {
    const { store, locks, event } = this.#ports;
    const forge = await this.#ports.forge(job);
    const branch = pushedBranch(job);
    const open = await forge.findOpen(branch, job.base);
    const found = { count: open.length };
    if (open[0] === undefined) {
      return { state: job.state, branch, mr: null, found };
    }
    const status = await forge.status(open[0].number);
    return locks.locked(async () => {
      const current = await store.job(job.workspace, job.ticket);
      // Recorded meanwhile (sf mr create, another refresh): that record stays. A job that left the
      // lookup states meanwhile (aborted, taken back) gets no record.
      if (current.mr !== null || !MR_LOOKUP_STATES.includes(current.state)) {
        return { state: current.state, branch, mr: current.mr, ...(current.mr?.number === status.number ? { status } : {}), found };
      }
      const mr: JobMr = { host: forge.kind, number: status.number, url: status.url, state: status.state, ...(status.merge_commit !== undefined ? { merge_commit: status.merge_commit } : {}) };
      const next: Job = { ...current, mr };
      await store.jobs.write(next);
      await event(next, 'found');
      return { state: next.state, branch, mr, status, found };
    });
  }

  // Whether the merge request actions are on for a workspace: its host, or why they are off (the
  // variable missing, an origin on no supported host, the workspace gone). No request is sent.
  async host(workspaceName: string): Promise<{ host: ForgeKind | null; reason: string | null }> {
    const { settings } = this.#ports;
    let origin: string | undefined;
    try {
      origin = await originUrl((await settings.resolve(workspaceName)).workCheckout);
    } catch (error) {
      if (error instanceof FactoryError) {
        return { host: null, reason: error.message };
      }
      throw error;
    }
    const choice = chooseForge(origin, settings.config.forge);
    return choice.ok ? { host: choice.kind, reason: null } : { host: choice.kind, reason: choice.reason };
  }
}
