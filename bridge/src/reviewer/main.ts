// Operator CLI of the SF-010 review coordinator (scripts/sf010-reviewer.sh):
//
//   status [--app <id>] [--job <id>]                 read-only: provider opt-in, coordinator, delegations,
//                                                    budgets and review states (creates nothing)
//   dry-run --app <id> --job <id>                    read-only: what a coordinator would do now for the job
//                                                    (creates nothing, calls no provider, sends nothing)
//   provider-enable --provider <id> [--yes]          the operator's provider opt-in; refused for a provider
//                                                    this build does not have (this build has none)
//   delegate --app <id> --job <id> --provider <id> --max-attempts <n> --max-reviews <n> --max-minutes <n>
//            --max-input-kib <n> --attempt-timeout-s <n> --expires-minutes <n> [--yes]
//                                                    the per-job review delegation with finite limits, for a
//                                                    live managed job only (never a historical one)
//   revoke --app <id> --job <id>                     revokes that delegation (permanent)
//   run                                              the coordinator in the foreground; refused unless a
//                                                    provider is enabled that this build has (none)
//
// Real operation is disabled: no real ReviewProvider is registered (PROVIDERS is empty), so
// provider-enable and run refuse. Nothing here installs or starts a service, contacts a model API
// or changes the supervisor, the bridge or a policy.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { FactoryJobs } from '../factory-jobs.js';
import { checkJobDirectory, readManaged } from '../executor/records.js';
import { defaultStateHome } from '../operator/store.js';
import { ReviewCoordinator } from './coordinator.js';
import type { ReviewProvider } from './provider.js';
import { DELEGATION_SCHEMA, ENDED_JOB_STATES, LIMIT_CEILINGS, PROVIDER_OPT_IN_SCHEMA, ReviewerError, type ReviewLimits } from './records.js';
import { dryRun, reviewerStatus } from './status.js';
import { ReviewerState } from './store.js';

// The real providers this build can run: none. A future adapter (a model API, OpenClaw) is added
// here only with its own review and activation decision.
export const PROVIDERS: readonly ReviewProvider[] = [];

const MEDIATOR_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const USAGE =
  'usage: sf010-reviewer <status [--app <id>] [--job <id>] | dry-run --app <id> --job <id> | provider-enable --provider <id> [--yes] | ' +
  'delegate --app <id> --job <id> --provider <id> --max-attempts <n> --max-reviews <n> --max-minutes <n> --max-input-kib <n> --attempt-timeout-s <n> --expires-minutes <n> [--yes] | ' +
  'revoke --app <id> --job <id> | run>';
const VALUE_FLAGS = ['--app', '--job', '--provider', '--max-attempts', '--max-reviews', '--max-minutes', '--max-input-kib', '--attempt-timeout-s', '--expires-minutes'] as const;

export interface CliEnv {
  mediatorRoot: string;
  stateHome: string;
  providers: readonly ReviewProvider[];
  now: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
  confirm: (question: string) => Promise<boolean>;
}

function parse(rest: string[]): { values: Map<string, string>; yes: boolean } | undefined {
  const values = new Map<string, string>();
  let yes = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    if (flag === '--yes') {
      yes = true;
    } else if ((VALUE_FLAGS as readonly string[]).includes(flag) && rest[index + 1] !== undefined && !values.has(flag)) {
      values.set(flag, rest[index + 1]!);
      index += 1;
    } else {
      return undefined;
    }
  }
  return { values, yes };
}

const integer = (value: string | undefined, flag: string, min: number, max: number): number => {
  const number = value === undefined || !/^\d{1,9}$/.test(value) ? Number.NaN : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ReviewerError('invalid_input', `${flag} must be an integer from ${min} to ${max}.`);
  }
  return number;
};

export async function cli(argv: string[], env: CliEnv): Promise<number> {
  const [command, ...rest] = argv;
  const parsed = parse(rest);
  if (command === undefined || parsed === undefined || !['status', 'dry-run', 'provider-enable', 'delegate', 'revoke', 'run'].includes(command)) {
    env.err(USAGE);
    return 2;
  }
  const { values, yes } = parsed;
  const app = values.get('--app');
  const job = values.get('--job');
  try {
    if (command === 'status') {
      env.out(JSON.stringify(await reviewerStatus(env.stateHome, env.mediatorRoot, env.now(), { ...(app ? { app } : {}), ...(job ? { job } : {}) }), null, 2));
      return 0;
    }
    if (command === 'dry-run') {
      if (app === undefined || job === undefined) {
        env.err(USAGE);
        return 2;
      }
      env.out(JSON.stringify(await dryRun(env.stateHome, env.mediatorRoot, app, job, env.providers.map((provider) => provider.id), env.now()), null, 2));
      return 0;
    }
    if (command === 'provider-enable') {
      const provider = values.get('--provider');
      if (provider === undefined) {
        env.err(USAGE);
        return 2;
      }
      if (!env.providers.some((entry) => entry.id === provider)) {
        throw new ReviewerError('provider_unavailable', `This build has no review provider ${provider}; nothing was enabled. Real autonomous review is not available.`);
      }
      if (!yes && !(await env.confirm(`Enable review provider ${provider} for delegated jobs? [y/N] `))) {
        env.err('Not confirmed; nothing was changed.');
        return 1;
      }
      const state = await ReviewerState.open(env.stateHome, env.mediatorRoot);
      await state.setProviderOptIn({ schema: PROVIDER_OPT_IN_SCHEMA, provider, enabled_at: env.now().toISOString(), issuer: 'operator:sf010-reviewer provider-enable' });
      env.out(`Review provider ${provider} enabled. No job is reviewed without its own delegation.`);
      return 0;
    }
    if (command === 'delegate') {
      const provider = values.get('--provider');
      if (app === undefined || job === undefined || provider === undefined) {
        env.err(USAGE);
        return 2;
      }
      const limits: ReviewLimits = {
        max_attempts: integer(values.get('--max-attempts'), '--max-attempts', 1, LIMIT_CEILINGS.max_attempts),
        max_reviews: integer(values.get('--max-reviews'), '--max-reviews', 1, LIMIT_CEILINGS.max_reviews),
        max_elapsed_ms: integer(values.get('--max-minutes'), '--max-minutes', 1, LIMIT_CEILINGS.max_elapsed_ms / 60_000) * 60_000,
        max_input_bytes: integer(values.get('--max-input-kib'), '--max-input-kib', 1, LIMIT_CEILINGS.max_input_bytes / 1024) * 1024,
        attempt_timeout_ms: integer(values.get('--attempt-timeout-s'), '--attempt-timeout-s', 1, LIMIT_CEILINGS.attempt_timeout_ms / 1000) * 1000,
      };
      const expiresMinutes = integer(values.get('--expires-minutes'), '--expires-minutes', 1, 24 * 60);
      // Only a live managed job: a historical (ended) job is never delegated.
      const managed = await new FactoryJobs(env.mediatorRoot).withJob(app, job, false, async (dir) => {
        await checkJobDirectory(dir);
        return readManaged(dir);
      });
      if (managed === undefined || ENDED_JOB_STATES.includes(managed.state)) {
        throw new ReviewerError('conflict', `${app}/${job} is ${managed?.state ?? 'not a managed job'}; only a live managed job can be delegated for review.`);
      }
      if (!yes && !(await env.confirm(`Delegate autonomous review of ${app}/${job} to provider ${provider} (at most ${limits.max_reviews} review(s), ${limits.max_attempts} attempt(s))? [y/N] `))) {
        env.err('Not confirmed; nothing was changed.');
        return 1;
      }
      const now = env.now();
      const state = await ReviewerState.open(env.stateHome, env.mediatorRoot);
      const delegationId = randomUUID();
      await state.createDelegation({
        schema: DELEGATION_SCHEMA,
        delegation_id: delegationId,
        app_id: app,
        job_id: job,
        authorization_id: managed.authorization_id,
        provider,
        limits,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + expiresMinutes * 60_000).toISOString(),
        issuer: 'operator:sf010-reviewer delegate',
      });
      env.out(`Delegation ${delegationId} recorded for ${app}/${job}. It authorizes review only, never execution or acceptance.`);
      return 0;
    }
    if (command === 'revoke') {
      if (app === undefined || job === undefined) {
        env.err(USAGE);
        return 2;
      }
      const state = await ReviewerState.open(env.stateHome, env.mediatorRoot);
      const delegation = await state.delegation(app, job);
      if (delegation === undefined) {
        throw new ReviewerError('not_found', `${app}/${job} has no review delegation.`);
      }
      const revoked = await state.revoke(delegation.delegation_id);
      env.out(revoked ? `Delegation ${delegation.delegation_id} revoked.` : `Delegation ${delegation.delegation_id} was already revoked.`);
      return 0;
    }
    // run
    const coordinator = await ReviewCoordinator.start({ mediatorRoot: env.mediatorRoot, stateHome: env.stateHome, providers: env.providers, log: env.err });
    const stop = () => void coordinator.stop();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await coordinator.run();
    await coordinator.close();
    return 0;
  } catch (error) {
    const code = (error as { code?: string }).code;
    const known = error instanceof ReviewerError || ['not_found', 'app_not_found', 'invalid_record', 'forbidden_path', 'conflict', 'unsafe_state', 'invalid_id', 'locked'].includes(code ?? '');
    env.err(`error ${code ?? 'unknown'}: ${known ? (error as Error).message : 'unexpected error'}`);
    return 1;
  }
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.exitCode = await cli(process.argv.slice(2), {
      mediatorRoot: MEDIATOR_ROOT,
      stateHome: defaultStateHome(),
      providers: PROVIDERS,
      now: () => new Date(),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      confirm: async (question) => process.stdin.isTTY === true && /^y(es)?$/i.test((await rl.question(question)).trim()),
    });
  } finally {
    rl.close();
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
