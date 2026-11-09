// The morning digest's timer in sf serve: a check at start and every 60 s. Each check
// rereads workspaces.json and starts the scheduled digest when now is past today's `at` (local time;
// on a weekday when weekdays_only), at least one workspace has track or my_work on, and no scheduled
// digest started today. A machine that slept through `at`, or an sf serve started later, is covered
// by the same rule. A manual run does not count: the scheduled one still runs.
import { configDir as defaultConfigDir, digestSettings, loadRegistry, type Registry, workspaceDigest } from './registry.js';

export const TICK_MS = 60_000;

// What the timer needs of the digests (src/digest-run.ts Digests).
export interface ScheduledDigests {
  readonly running: boolean;
  scheduledSince(since: Date): Promise<boolean>;
  start(trigger: 'scheduled'): unknown;
}

export interface DigestScheduleOptions {
  digests: ScheduledDigests;
  configDir?: string;
  now?: () => Date;
  intervalMs?: number;
}

const localKey = (date: Date): string => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;

// Whether a scheduled digest is on at all: at least one workspace follows (track or my_work).
export function digestFollowed(registry: Registry): boolean {
  return Object.values(registry.workspaces).some((entry) => workspaceDigest(entry).track || workspaceDigest(entry).my_work);
}

// Today's `at` of the scheduled digest, local time.
export function digestTime(registry: Registry, now: Date): Date {
  const [hours, minutes] = digestSettings(registry).at.split(':').map(Number) as [number, number];
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
}

// Whether the scheduled digest is due by the clock and the settings: past today's `at`, on a
// weekday when weekdays_only, with a workspace that follows.
export function dueByClock(registry: Registry, now: Date): boolean {
  if (!digestFollowed(registry)) {
    return false;
  }
  if (digestSettings(registry).weekdays_only && (now.getDay() === 0 || now.getDay() === 6)) {
    return false;
  }
  return now.getTime() >= digestTime(registry, now).getTime();
}

export class DigestSchedule {
  readonly #digests: ScheduledDigests;
  readonly #configDir: string;
  readonly #now: () => Date;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #ticking = false;
  // The local day of the last scheduled start, so a run that ended without a record is not
  // started again every minute of that day.
  #started: string | null = null;

  constructor(options: DigestScheduleOptions) {
    this.#digests = options.digests;
    this.#configDir = options.configDir ?? defaultConfigDir();
    this.#now = options.now ?? (() => new Date());
    this.#intervalMs = options.intervalMs ?? TICK_MS;
  }

  // One check; true when it started the scheduled digest. Never throws.
  async tick(): Promise<boolean> {
    if (this.#ticking) {
      return false;
    }
    this.#ticking = true;
    try {
      const now = this.#now();
      const registry = await loadRegistry(this.#configDir);
      if (!dueByClock(registry, now) || this.#started === localKey(now) || this.#digests.running) {
        return false;
      }
      if (await this.#digests.scheduledSince(new Date(now.getFullYear(), now.getMonth(), now.getDate()))) {
        return false;
      }
      this.#digests.start('scheduled');
      this.#started = localKey(now);
      return true;
    } catch (error) {
      console.error(error);
      return false;
    } finally {
      this.#ticking = false;
    }
  }

  // The check now, then every interval.
  start(): void {
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
    this.#timer.unref();
  }

  close(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
