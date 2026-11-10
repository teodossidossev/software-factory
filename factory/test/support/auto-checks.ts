// The fakes of the automatic Task checks' tests: a clock the test moves and TaskChecks as
// AutoChecks sees it.
import { FactoryError } from '../../src/errors.js';
import { type CheckObserver, type CheckRecord, CheckStore } from '../../src/task-check.js';
import type { AutoCheckRunner, AutoTimers } from '../../src/task-check-auto.js';

// A clock the test moves: timers fire in their order when advance passes them.
export class FakeClock implements AutoTimers {
  now = 0;
  #next = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.now + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.#timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) {
        break;
      }
      this.#timers.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = target;
  }
}

// TaskChecks as AutoChecks sees it: a check runs until the test ends it, with a record (stored) or
// without; an automatic one ends at once, storing nothing, when its signal aborts.
export class FakeRunner implements AutoCheckRunner {
  readonly store: CheckStore;
  // Every start, "auto <key>" or "manual <key>", in order.
  readonly starts: string[] = [];
  readonly #running = new Map<string, { signal: AbortSignal | undefined; finish: (record: CheckRecord | undefined) => void }>();
  readonly #observers: CheckObserver[] = [];

  constructor(stateDir: string) {
    this.store = new CheckStore(stateDir);
  }

  observe(observer: CheckObserver): void {
    this.#observers.push(observer);
  }

  isRunning(workspace: string, ticket: string): boolean {
    return this.#running.has(`${workspace}/${ticket}`);
  }

  runningCount(): number {
    return this.#running.size;
  }

  aborted(workspace: string, ticket: string): boolean {
    return this.#running.get(`${workspace}/${ticket}`)?.signal?.aborted === true;
  }

  async startAuto(workspace: string, ticket: string, signal: AbortSignal): Promise<{ started: true; sha256: string; ended: Promise<CheckRecord | undefined> }> {
    const ended = this.#begin(workspace, ticket, signal);
    signal.addEventListener('abort', () => void this.end(workspace, ticket), { once: true });
    return { started: true, sha256: '', ended };
  }

  manual(workspace: string, ticket: string): void {
    for (const observer of this.#observers) {
      observer.manualStart?.(workspace, ticket);
    }
    void this.#begin(workspace, ticket, undefined);
  }

  #begin(workspace: string, ticket: string, signal: AbortSignal | undefined): Promise<CheckRecord | undefined> {
    const key = `${workspace}/${ticket}`;
    if (this.#running.has(key)) {
      throw new FactoryError('check_running', `A Task check of ${key} is already running.`);
    }
    this.starts.push(`${signal === undefined ? 'manual' : 'auto'} ${key}`);
    return new Promise((resolve) => this.#running.set(key, { signal, finish: resolve }));
  }

  // Ends the ticket's check: the record is stored unless the run was cancelled.
  async end(workspace: string, ticket: string, record?: CheckRecord): Promise<void> {
    const key = `${workspace}/${ticket}`;
    const run = this.#running.get(key);
    if (run === undefined) {
      return;
    }
    const stored = record !== undefined && run.signal?.aborted !== true ? record : undefined;
    if (stored !== undefined) {
      await this.store.write(stored);
    }
    this.#running.delete(key);
    run.finish(stored);
    for (const observer of this.#observers) {
      observer.ended?.(workspace, ticket);
    }
  }
}
