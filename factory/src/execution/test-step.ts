// MR preparation's test step: the run of the workspace's test command on the job's worktree, in the
// sandbox built from the job's path denials, registered as the job's running review, and its end
// under the lock (a pass goes on through the caller's passed; a failure is a Tests Fix; the bound or
// a run that could not happen stops the job).
import { DEFAULT_TEST_TIMEOUT_MS } from '../config.js';
import { FactoryError } from '../errors.js';
import { type Job, now } from '../jobs.js';
import type { Workspace } from '../registry.js';
import { pathDenials } from '../sandbox-denials.js';
import { failureText, inlineCommand, runTestCommand, TEST_FIX_ROUNDS, testsFixContent, TESTS_FAILED, type TestsRecord, type TestsResult, TESTS_UNAVAILABLE } from '../test-command.js';
import type { JobStorePort, LivePort, LockPort, RunnerPort, SettingsPort, StopPort } from './ports.js';
import { TESTS_RUNNER, testsEvent } from './events.js';
import type { FixOptions, RunningReview } from './shared.js';

// What the end of a test run needs of the preparation that started it: mr_attempts before it
// (a stop or a Tests Fix writes it back), and what follows a pass, under the lock.
export interface TestsContext {
  attempts: number;
  passed: (job: Job, workspace: Workspace) => void | Promise<void>;
}

// What TestStep uses: MrPart's ports, and the Tests Fix (TurnsPart's fix, reached late).
export interface TestStepPorts {
  store: JobStorePort;
  locks: LockPort;
  sessions: LivePort;
  runner: RunnerPort;
  settings: SettingsPort;
  stop: StopPort;
  fix: (current: Job, content: string, options: FixOptions) => Promise<unknown>;
}

// The title of the Fix section of a failed test run: ## Fix N: Tests.
const TESTS_TITLE = 'Tests';

// A command in a stop's message: inline code, cut to 200 characters.
function commandInMessage(command: string): string {
  return inlineCommand(command.length > 200 ? `${command.slice(0, 199)}…` : command);
}

// The stop of a test run that could not happen (tests_unavailable): its reason first, on a line of
// its own (the dashboard's sentence quotes the first line).
function unavailableMessage(record: TestsRecord, iteration: number): string {
  return `${record.reason ?? 'the command could not run'}.\nThe workspace's test command ${commandInMessage(record.command)} could not run on iteration ${iteration}. Fix it on this machine and run sf retry, or accept the iteration without tests (sf accept).`;
}

// The stop at the bound of the Tests Fix rounds (tests_failed): the command and how it ended.
function failedMessage(record: TestsRecord, iteration: number): string {
  return `The workspace's tests still fail after ${TEST_FIX_ROUNDS} Tests Fix rounds: ${commandInMessage(record.command)} (${failureText(record)}) on iteration ${iteration}. Accept the iteration without passing tests (sf accept), or tell the Implementer what to do (sf say).`;
}

export class TestStep {
  readonly #ports: TestStepPorts;
  // The job store, held apart so every state change of the step is written as
  // this.#store.transition, the call form factory/test/transitions.test.ts finds.
  readonly #store: JobStorePort;

  constructor(ports: TestStepPorts) {
    this.#ports = ports;
    this.#store = ports.store;
  }

  // Whether the test step of the job's iteration is done: its record passed, or the user accepted
  // it without passing tests. A record that cannot be read counts as none: the tests run again.
  async settled(job: Job): Promise<boolean> {
    const record = await this.#store.jobs.readTests(job.workspace, job.ticket, job.iteration).catch((error: unknown) => (console.error(error), undefined));
    return record?.outcome === 'passed' || record?.outcome === 'accepted_failing';
  }

  // Starts the run of the workspace's test command on the job's worktree, registered as the
  // job's running review, so abort and stop() cancel it and the runner waits for it. It runs outside
  // the lock; its end applies under it (#tested). Only under the lock, in the runner.
  start(job: Job, workspace: Workspace, command: string, context: TestsContext): void {
    const { runner, stop, sessions } = this.#ports;
    runner.runnerJob();
    if (stop.isStopping()) {
      throw new FactoryError('runner_stopping', 'The runner of the job is stopping; no test run starts.');
    }
    const key = `${job.workspace}/${job.ticket}`;
    sessions.reviews.get(key)?.controller.abort();
    const running: RunningReview = { reviewer: TESTS_RUNNER, iteration: job.iteration, controller: new AbortController() };
    sessions.reviews.set(key, running);
    this.#run(job, workspace, command, running, context).catch((error: unknown) => console.error(error));
  }

  // The run itself: the tests_started event, the sandbox built from the job's path denials (session
  // job, as the Implementer's), the command, then its end under the lock, whatever fails.
  async #run(job: Job, workspace: Workspace, command: string, running: RunningReview, context: TestsContext): Promise<void> {
    const { locks, settings } = this.#ports;
    const run = now();
    let result: TestsResult;
    // An abort (stop() too) queues the run's end on the lock at once, so stop() waits for it.
    let ended: (value: TestsResult) => void = () => undefined;
    const end = new Promise<TestsResult>((resolve) => (ended = resolve));
    let queued: Promise<void> | undefined;
    running.controller.signal.addEventListener('abort', () => (queued = locks.locked(async () => this.#tested(job, running, run, await end, context))), { once: true });
    try {
      await this.#store.jobs.appendEvent(job.workspace, job.ticket, { ts: run, iteration: job.iteration, type: 'tests_started', run, command });
      const denials = await pathDenials({ session: 'job', workspace: job.workspace, checkout: workspace.workCheckout, worktree: job.worktree!, stateDir: settings.config.stateDir, worktreeRoot: settings.config.worktreeRoot });
      result = await runTestCommand({
        command, cwd: job.worktree!, hidden: denials.sandbox.denyRead, timeoutMs: settings.config.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS, signal: running.controller.signal,
      });
    } catch (error) {
      // The path denials could not be built (or the event written): no run without them.
      const at = now();
      const reason = `the sandbox could not be built: ${error instanceof FactoryError ? error.message : (error as Error).message}`.slice(0, 300);
      result = { aborted: false, record: { command, started_at: run, ended_at: at, duration_ms: Date.parse(at) - Date.parse(run), exit_code: null, timed_out: false, outcome: 'unavailable', reason, output: '', output_truncated: false } };
    }
    ended(result);
    await (queued ?? locks.locked(() => this.#tested(job, running, run, result, context)));
  }

  // The end of a test run. A cancelled one (abort, stop(); its result is aborted only then) leaves no
  // trace, but one that changed a watched path stops its job still in this step (tests_failed: no
  // turn starts on that worktree). Otherwise, for the job's step, the record and the tests event are
  // written; a pass goes on through the caller's passed; one that could not run stops the job
  // (tests_unavailable); a failure is a Tests Fix, or past TEST_FIX_ROUNDS a stop (tests_failed).
  async #tested(job: Job, running: RunningReview, run: string, result: TestsResult, context: TestsContext): Promise<void> {
    const { sessions, settings, fix } = this.#ports;
    const { workspace: name, ticket, iteration } = job;
    const key = `${name}/${ticket}`;
    const latest = result.aborted && result.changed !== undefined ? await this.#store.jobs.read(name, ticket) : undefined;
    if (latest?.created_at === job.created_at && latest.state === 'preparing_mr' && result.aborted) {
      // from: preparing_mr (the test step)
      await this.#store.transition({ ...latest, mr_attempts: context.attempts }, 'needs_human', 'tests', { code: TESTS_FAILED, message: `an aborted test run changed ${result.changed}` });
    }
    if (sessions.reviews.get(key) !== running || running.controller.signal.aborted || result.aborted) {
      return;
    }
    sessions.reviews.delete(key);
    const current = await this.#store.jobs.read(name, ticket);
    if (current === undefined || current.created_at !== job.created_at || current.state !== 'preparing_mr' || current.iteration !== iteration) {
      return;
    }
    const { record } = result;
    const back: Job = { ...current, mr_attempts: context.attempts };
    try {
      await this.#store.jobs.writeTests(name, ticket, iteration, record);
      await this.#store.jobs.appendEvent(name, ticket, testsEvent(iteration, run, record));
      if (record.outcome === 'passed') {
        await context.passed(current, sessions.live.get(key)?.workspace ?? (await settings.resolve(name)));
        return;
      }
      if (record.outcome === 'unavailable') {
        // from: preparing_mr (the test step)
        await this.#store.transition(back, 'needs_human', 'tests', { code: TESTS_UNAVAILABLE, message: unavailableMessage(record, iteration) });
        return;
      }
      const failed = await this.#store.jobs.failedTests(name, ticket);
      if (failed > TEST_FIX_ROUNDS) {
        // from: preparing_mr (the test step)
        await this.#store.transition(back, 'needs_human', 'tests', { code: TESTS_FAILED, message: failedMessage(record, iteration) });
        return;
      }
      await fix(back, testsFixContent(record), { title: TESTS_TITLE, fromTests: true });
    } catch (error) {
      console.error(error);
      const latest = await this.#store.jobs.read(name, ticket);
      if (latest?.state === 'preparing_mr') {
        // from: preparing_mr (the test step)
        await this.#store.transition({ ...latest, mr_attempts: context.attempts }, 'needs_human', 'tests', { code: 'mr_failed', message: `MR preparation failed inside the factory: ${(error as Error).message}`.slice(0, 1000) });
      }
    }
  }
}
