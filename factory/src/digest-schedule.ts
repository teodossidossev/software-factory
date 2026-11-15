// The morning digest's timer in sf serve: a check at start and every 60 s. Each check
// rereads workspaces.json and finds the due slot: the latest of today's `times` (local time) not
// after now, on a digest day (any day, or a weekday when weekdays_only), with at least one
// workspace on track or my_work. It starts the scheduled digest when there is one, no run is
// going, this timer did not start that slot, and no scheduled digest started at or after it. A
// machine that slept through several times, or an sf serve started later, runs once, for the
// latest time passed. A manual run does not count: the scheduled one still runs.
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

const pad = (value: number): string => String(value).padStart(2, '0');
// A slot's key: its local day and HH:MM.
const slotKey = (slot: Date): string => `${slot.getFullYear()}-${slot.getMonth() + 1}-${slot.getDate()} ${pad(slot.getHours())}:${pad(slot.getMinutes())}`;

// Whether a scheduled digest is on at all: at least one workspace follows (track or my_work).
export function digestFollowed(registry: Registry): boolean {
  return Object.values(registry.workspaces).some((entry) => workspaceDigest(entry).track || workspaceDigest(entry).my_work);
}

// The time of day HH:MM on the local day of date.
export function atTime(date: Date, time: string): Date {
  const [hours, minutes] = time.split(':').map(Number) as [number, number];
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes);
}

// The scheduled digest's due slot: on a digest day (any day, or a weekday with weekdays_only)
// with a workspace that follows, the latest of today's times that is not after now; else null.
export function dueSlot(registry: Registry, now: Date): Date | null {
  if (!digestFollowed(registry)) {
    return null;
  }
  const settings = digestSettings(registry);
  if (settings.weekdays_only && (now.getDay() === 0 || now.getDay() === 6)) {
    return null;
  }
  const passed = settings.times.map((time) => atTime(now, time)).filter((slot) => slot.getTime() <= now.getTime());
  return passed.at(-1) ?? null;
}

export class DigestSchedule {
  readonly #digests: ScheduledDigests;
  readonly #configDir: string;
  readonly #now: () => Date;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #ticking = false;
  // The slot of the last scheduled start (its local day and HH:MM), so a run that ended without a
  // record is not started again every minute until the next slot.
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
      const slot = dueSlot(registry, now);
      if (slot === null || this.#started === slotKey(slot) || this.#digests.running) {
        return false;
      }
      if (await this.#digests.scheduledSince(slot)) {
        return false;
      }
      this.#digests.start('scheduled');
      this.#started = slotKey(slot);
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
