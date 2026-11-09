// What sf serve repairs by itself, and the bounds that keep a repair from looping. The health
// monitor's recover option: a down check with a recovery action starts an attempt and shows
// recovering until a pass returns ok (the attempt succeeded) or 3 passes go by without ok (it
// failed). At most 3 attempts per check in a rolling hour; at the cap the check shows down with
// "recovery failed 3 times: <last error>" until the hour frees an attempt. recovering is never
// notified, so the cap's down is the one notification; every attempt writes one log line (check,
// action, result). The actions: the tunnel's restart (src/tunnel.ts), only for a tunnel sf serve
// started. Sandbox leftovers are reaped right before each sandboxes check instead, so a pid two
// checks find did outlive a reap; with SF_HEALTH=off there is no monitor, nothing is recovered and
// the reaper runs on its own timer.
import { type HealthCheck, type HealthDeps, type HealthId, HealthMonitor, type HealthMonitorOptions } from './health.js';
import { type OrphanWatch, reapOrphanedSandboxes, REAP_EVERY_MS } from './sandbox-reaper.js';
import type { TunnelChild } from './tunnel.js';

// An attempt fails after this many passes without ok.
export const RECOVERY_PASSES = 3;
// At most this many attempts per check in RECOVERY_WINDOW_MS.
export const RECOVERY_MAX_ATTEMPTS = 3;
export const RECOVERY_WINDOW_MS = 60 * 60_000;

export interface RecoveryAction {
  // What an attempt does, for its log line and the check's detail.
  action: string;
  // Whether the check can be recovered now.
  applies(): boolean;
  // Added to the check's detail while an attempt runs and while the check is ok within the hour of
  // its last attempt.
  note?: string;
  // The repair; a rejection is the attempt's error.
  run(): Promise<void>;
}

interface Attempt {
  passes: number;
  error: string | undefined;
}

interface CheckState {
  // The attempts' start times within the window.
  attempts: number[];
  current: Attempt | undefined;
  lastError: string | undefined;
}

export interface RecoveryOptions {
  actions: Partial<Record<HealthId, RecoveryAction>>;
  now?: () => number;
  // One line per attempt; default console.error.
  log?: (line: string) => void;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The attempts of each check with an action; review() is the monitor's recover option.
export class Recovery {
  readonly #actions: Partial<Record<HealthId, RecoveryAction>>;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  readonly #states = new Map<HealthId, CheckState>();

  constructor(options: RecoveryOptions) {
    this.#actions = options.actions;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((line) => console.error(line));
  }

  // A pass's results as they are shown: each check with an action reviewed; never throws.
  review(results: HealthCheck[]): HealthCheck[] {
    return results.map((result) => {
      const action = this.#actions[result.id];
      try {
        return action === undefined ? result : this.#reviewOne(result, action);
      } catch (error) {
        this.#log(`health recovery: ${result.id}: ${message(error)}`);
        return result;
      }
    });
  }

  #reviewOne(result: HealthCheck, action: RecoveryAction): HealthCheck {
    const now = this.#now();
    const state = this.#states.get(result.id) ?? { attempts: [], current: undefined, lastError: undefined };
    this.#states.set(result.id, state);
    state.attempts = state.attempts.filter((at) => now - at < RECOVERY_WINDOW_MS);
    const attempt = state.current;
    if (attempt !== undefined) {
      if (result.status === 'ok' || result.status === 'off') {
        state.current = undefined;
        this.#log(`health recovery: ${result.id}: ${action.action}: ${result.status === 'ok' ? 'succeeded' : 'ended, the check is off'}`);
        return this.#noted(result, action, state);
      }
      attempt.passes += 1;
      if (attempt.passes < RECOVERY_PASSES) {
        return this.#recovering(result, action, state);
      }
      state.current = undefined;
      state.lastError = attempt.error ?? result.detail;
      this.#log(`health recovery: ${result.id}: ${action.action}: failed: ${state.lastError}`);
    }
    if (result.status !== 'down') {
      return this.#noted(result, action, state);
    }
    if (!action.applies()) {
      return result;
    }
    if (state.attempts.length >= RECOVERY_MAX_ATTEMPTS) {
      return { ...result, detail: `recovery failed ${RECOVERY_MAX_ATTEMPTS} times: ${state.lastError ?? result.detail}` };
    }
    const started: Attempt = { passes: 0, error: undefined };
    state.current = started;
    state.attempts.push(now);
    action.run().catch((error: unknown) => {
      started.error = message(error);
    });
    return this.#recovering(result, action, state);
  }

  #recovering(result: HealthCheck, action: RecoveryAction, state: CheckState): HealthCheck {
    const note = action.note === undefined ? '' : `; ${action.note}`;
    return { ...result, status: 'recovering', detail: `${result.detail}; recovering: ${action.action} (attempt ${state.attempts.length} of ${RECOVERY_MAX_ATTEMPTS} this hour)${note}` };
  }

  // An ok result with the action's note while an attempt is within the hour.
  #noted(result: HealthCheck, action: RecoveryAction, state: CheckState): HealthCheck {
    return result.status === 'ok' && action.note !== undefined && state.attempts.length > 0 ? { ...result, detail: `${result.detail}; ${action.note}` } : result;
  }
}

// The tunnel check's recovery: sf serve's own tunnel restarted.
export function tunnelRecovery(tunnel: TunnelChild): RecoveryAction {
  return {
    action: 'restart the tunnel',
    applies: () => tunnel.owned,
    note: 'the tunnel restarted: in ChatGPT, refresh the plugin and start a new chat if it still fails',
    run: () => tunnel.restart(),
  };
}

// The sandboxes check's source: the reaper, then a fresh scan.
export function reapThenScan(watch: Pick<OrphanWatch, 'scan'>, reap: () => Promise<unknown>): () => Promise<{ found: number; persisting: number[] }> {
  return async () => {
    await reap();
    return watch.scan();
  };
}

export interface UpkeepOptions {
  // SF_HEALTH.
  health: boolean;
  deps: Omit<HealthDeps, 'sandboxes'>;
  watch: Pick<OrphanWatch, 'scan'>;
  roots: () => readonly string[];
  // sf serve's tunnel; undefined when it runs none.
  tunnel: TunnelChild | undefined;
  monitor?: Omit<HealthMonitorOptions, 'recover'>;
  reap?: (roots: readonly string[]) => Promise<unknown>;
  reapEveryMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

export interface Upkeep {
  // The health monitor; undefined with SF_HEALTH=off.
  monitor: HealthMonitor | undefined;
  start(): void;
  close(): void;
}

// sf serve's upkeep: with SF_HEALTH on, the health monitor with the tunnel's recovery and the reaper
// before each sandboxes check; off, the reaper every REAP_EVERY_MS and nothing recovered.
export function upkeep(options: UpkeepOptions): Upkeep {
  const reap = (): Promise<unknown> => (options.reap ?? reapOrphanedSandboxes)(options.roots());
  if (!options.health) {
    let timer: NodeJS.Timeout | undefined;
    return {
      monitor: undefined,
      start() {
        timer = setInterval(() => void reap(), options.reapEveryMs ?? REAP_EVERY_MS);
        timer.unref();
      },
      close: () => clearInterval(timer),
    };
  }
  const recovery = new Recovery({
    actions: options.tunnel === undefined ? {} : { tunnel: tunnelRecovery(options.tunnel) },
    ...(options.log !== undefined ? { log: options.log } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const monitor = new HealthMonitor({ ...options.deps, sandboxes: reapThenScan(options.watch, reap) }, { ...options.monitor, recover: (results) => recovery.review(results) });
  return { monitor, start: () => monitor.start(), close: () => monitor.close() };
}
