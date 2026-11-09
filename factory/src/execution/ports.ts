// The narrow ports of the job lifecycle's parts: each part takes only the ports whose
// members it uses, and the parts it calls as interfaces of just those methods, declared next to it.
// One object implements every port (execution/core.ts); src/execution.ts builds it and wires the
// parts.
//
// Which part uses which port:
// - status: JobStorePort, LivePort, SettingsPort.
// - start: JobStorePort, LockPort, RunnerPort, SettingsPort.
// - turns, reviews, control: JobStorePort, LockPort, LivePort, RunnerPort, SettingsPort, StopPort.
// - mr: JobStorePort, LockPort, LivePort, RunnerPort, NoticePort, SettingsPort, StopPort.
// - handover: JobStorePort, LockPort, SettingsPort.
import type { Config } from '../config.js';
import type { Job, JobAction, JobState, JobStore } from '../jobs.js';
import type { Workspace } from '../registry.js';
import type { Runners } from '../runner.js';
import type { Live, RunningReview } from './shared.js';

// The jobs on disk, and every state change after the first.
export interface JobStorePort {
  readonly jobs: JobStore;
  // The job; refused for an invalid ticket (invalid_ticket) and for no job (job_not_found).
  job(workspace: string, ticket: string): Promise<Job>;
  // Every state change after the first: refused (illegal_transition) before anything is written
  // unless JOB_TRANSITIONS allows it.
  transition(job: Job, to: JobState, action: JobAction, error?: { code: string; message: string }, lines?: string[]): Promise<Job>;
}

// The operation lock, the per-workspace Git lock, and the /proc the sandbox's config lock check scans.
export interface LockPort {
  locked<T>(work: () => Promise<T>): Promise<T>;
  gitLocked<T>(workspace: string, work: () => Promise<T>): Promise<T>;
  // undefined: the real /proc.
  readonly lockProc: string | undefined;
}

// The live Implementer sessions and the running reviews of this process, by
// "<workspace>/<ticket>", the live events of a running review, and the step after a session ended.
export interface LivePort {
  readonly live: Map<string, Live>;
  readonly reviews: Map<string, RunningReview>;
  appendLive(job: Job, type: 'review_message' | 'gate_event', raw: unknown, reviewer?: string): Promise<void>;
  afterSession(job: Job, iteration?: number): Promise<void>;
}

// sf serve's runners, and runner mode's one job.
export interface RunnerPort {
  // sf serve's runners; throws in runner mode.
  serveRunners(): Runners;
  // Runner mode's job; throws in sf serve.
  runnerJob(): { workspace: string; ticket: string };
  // undefined in runner mode.
  readonly runners: Runners | undefined;
}

// A change of the job's merge request outside a state change, for the listeners.
export interface NoticePort {
  announce(job: Job, lines: string[]): void;
}

// The config, the Handbook's text, the workspaces by name and the run queue's limit.
export interface SettingsPort {
  readonly config: Config;
  readonly handbook: string;
  readonly resolve: (name: string) => Promise<Workspace>;
  // undefined: config.maxJobs.
  readonly maxRunning: (() => Promise<number>) | undefined;
}

// Runner mode: once stop() was called, nothing new starts.
export interface StopPort {
  isStopping(): boolean;
  setStopping(): void;
}
