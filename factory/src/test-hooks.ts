// The test hooks: the settings only the factory's own tests set, read here and nowhere
// else, once per process. Every hook is off unless SF_TEST_HOOKS=on; production code takes them
// from the TestHooks object it is given. SF_TEST_TIMEOUT_MS, SF_TEST_CONCURRENCY and SF_TEST_NICE
// are real settings, not hooks (src/config.ts, src/run-tests.ts).
export interface TestHooks {
  // The socket's test-only commands (check, fix, clean; src/commands.ts testOnly) answer.
  readonly socketCommands: boolean;
  // SF_TEST_TASK_CHECK_DELAY_MS: a shorter time from the last trigger to an automatic Task check;
  // undefined: the factory's own.
  readonly taskCheckDelayMs: number | undefined;
  // SF_TEST_MARKER_POLL_MS: a shorter poll of the updating marker; undefined: the
  // factory's own.
  readonly markerPollMs: number | undefined;
  // SF_TEST_PROC_DIR: a /proc of the test's own that the sandbox's config lock check
  // scans instead of the real one, so that the machine's other processes cannot keep a test's
  // lock; sf run inherits it with the environment. undefined: the real /proc.
  readonly procDir: string | undefined;
}

const wholeNumber = (raw: string | undefined): number | undefined => (raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined);

// The hooks of an environment: all off unless SF_TEST_HOOKS=on; a delay that is not a whole number
// and an empty directory count as unset.
export function readTestHooks(env: NodeJS.ProcessEnv): TestHooks {
  const on = env.SF_TEST_HOOKS === 'on';
  const procDir = env.SF_TEST_PROC_DIR;
  return Object.freeze({
    socketCommands: on,
    taskCheckDelayMs: on ? wholeNumber(env.SF_TEST_TASK_CHECK_DELAY_MS) : undefined,
    markerPollMs: on ? wholeNumber(env.SF_TEST_MARKER_POLL_MS) : undefined,
    procDir: on && procDir !== undefined && procDir !== '' ? procDir : undefined,
  });
}

let processHooks: TestHooks | undefined;

// This process's hooks, read from its environment on the first call.
export function testHooks(): TestHooks {
  processHooks ??= readTestHooks(process.env);
  return processHooks;
}
