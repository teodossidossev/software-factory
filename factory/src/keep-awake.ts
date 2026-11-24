// The laptop stays awake while a job runs: sf serve holds a systemd idle and lid-switch inhibitor
// (systemd-inhibit --what=idle:handle-lid-switch --mode=block sh -c 'read _') as its child while any
// job of any workspace runs (runningJobs of src/jobs.ts), and ends it when none runs any more or
// sf serve stops. One child at most. The child's stdin is a pipe from sf serve: when sf serve dies,
// even by SIGKILL, the pipe closes, `read _` ends and the inhibitor with it. Idle and the lid switch
// are inhibited, sleep is not: a closed lid keeps the jobs running, and a suspend the user chooses
// (the desktop's Suspend, systemctl suspend) still suspends. A missing command, or a child that exits
// with an error by itself (polkit refusing the lock, say), is one log line; nothing more is tried
// until sf serve restarts.
import { type ChildProcess, spawn } from 'node:child_process';
import { type Job, runningJobs } from './jobs.js';

// How often sf serve looks at its jobs.
export const KEEP_AWAKE_EVERY_MS = 30_000;
export const KEEP_AWAKE_COMMAND = 'systemd-inhibit';

export interface KeepAwakeOptions {
  intervalMs: number;
  // Every job of every workspace; the running ones keep the laptop awake.
  jobs(): Promise<Job[]>;
  // systemd-inhibit, or a fake one in the tests.
  command: string;
  // Where the start and end lines go; default console.log (the service log).
  log?: (line: string) => void;
}

const jobsRunning = (count: number): string => `${count} ${count === 1 ? 'job' : 'jobs'} running`;
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// sf serve's idle and lid-switch inhibitor: start() once, stop() when sf serve stops.
export class KeepAwake {
  readonly #options: KeepAwakeOptions;
  readonly #log: (line: string) => void;
  // The inhibitor, from its start until its exit (also while it is ending): never two.
  #child: ChildProcess | undefined;
  // The children this one is ending: their exit is no failure.
  readonly #ending = new WeakSet<ChildProcess>();
  #timer: NodeJS.Timeout | undefined;
  #checking = false;
  #stopped = false;
  // A missing command or a child that failed: nothing more until sf serve restarts.
  #disabled = false;

  constructor(options: KeepAwakeOptions) {
    this.#options = options;
    this.#log = options.log ?? ((line) => console.log(line));
  }

  // Checks now, then every interval.
  start(): void {
    void this.check();
    this.#timer = setInterval(() => void this.check(), this.#options.intervalMs);
    this.#timer.unref();
  }

  // Starts the inhibitor while a job runs and none holds, ends it when no job runs, and also when
  // the jobs cannot be listed (never held past the last job unseen). A check while another one
  // lists the jobs does nothing.
  async check(): Promise<void> {
    if (this.#checking || this.#stopped || this.#disabled) {
      return;
    }
    this.#checking = true;
    try {
      let running: number;
      try {
        running = runningJobs(await this.#options.jobs()).length;
      } catch (error) {
        this.#log(`keep-awake: the jobs could not be listed: ${message(error)}`);
        running = 0;
      }
      if (this.#stopped || this.#disabled) {
        return;
      }
      if (running > 0 && this.#child === undefined) {
        this.#begin(running);
      } else if (running === 0 && this.#child !== undefined) {
        this.#end(this.#child, 'no job running');
      }
    } finally {
      this.#checking = false;
    }
  }

  // Whether the inhibitor runs (also while it is ending).
  get holding(): boolean {
    return this.#child !== undefined;
  }

  // Ends the inhibitor and the checks; for good.
  stop(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
    if (this.#child !== undefined) {
      this.#end(this.#child, 'sf serve stops');
    }
  }

  // The count in --why is the one at the start: the inhibitor is not restarted when it changes.
  #begin(running: number): void {
    const why = jobsRunning(running);
    const child = spawn(this.#options.command, ['--what=idle:handle-lid-switch', '--who=Software Factory', `--why=${why}`, '--mode=block', 'sh', '-c', 'read _'], {
      // Its own group: a Ctrl+C of sf up reaches sf serve, which ends it, not the child itself.
      stdio: ['pipe', 'ignore', 'inherit'], detached: true,
    });
    this.#child = child;
    // Logged once it runs: a command that cannot start logs only why.
    child.once('spawn', () => this.#log(`keeping the laptop awake: ${why}`));
    // A child that ended meanwhile may refuse what is still written or closed.
    child.stdin?.on('error', () => undefined);
    child.on('error', (error: NodeJS.ErrnoException) => {
      // Never started (no pid): no exit follows.
      if (child.pid === undefined) {
        this.#release(child);
        this.#disable(error.code === 'ENOENT' ? `${this.#options.command} not found` : `${this.#options.command} did not start: ${error.message}`);
      } else {
        this.#log(`keep-awake: ${error.message}`);
      }
    });
    child.once('exit', (code, signal) => {
      this.#release(child);
      if (this.#ending.has(child)) {
        return;
      }
      if (code !== 0 || signal !== null) {
        this.#disable(`${this.#options.command} exited with ${signal ?? `code ${code}`}`);
      } else {
        // Ended by itself without an error: the next check starts another while a job runs.
        this.#log(`letting the laptop sleep: ${this.#options.command} ended`);
      }
    });
  }

  // The child is no longer held, when it was the one held.
  #release(child: ChildProcess): void {
    if (this.#child === child) {
      this.#child = undefined;
    }
  }

  // One line, then nothing more until sf serve restarts.
  #disable(reason: string): void {
    if (!this.#disabled) {
      this.#disabled = true;
      this.#log(`keep-awake: off until sf serve restarts (${reason})`);
    }
  }

  #end(child: ChildProcess, reason: string): void {
    if (this.#ending.has(child)) {
      return;
    }
    this.#ending.add(child);
    this.#log(`letting the laptop sleep: ${reason}`);
    // The pipe's end ends `read _`, and with it the inhibitor; SIGTERM in case it waits otherwise.
    child.stdin?.end();
    child.kill('SIGTERM');
  }
}
