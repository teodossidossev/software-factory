// SF-010: the independent review coordinator.
//
// Event-driven: it reacts to file-system notifications of new review-ready events, delegation
// changes and managed.json changes of delegated jobs (fs.watch), and reconciles everything once at
// start (restart recovery). Notifications are hints only: duplicate, missed or out-of-order ones
// are harmless, because every step re-reads durable state and is keyed by the event's stable id. A
// slow backstop pass (default 15 min) recovers notifications the kernel dropped; it is not the trigger.
//
// Authority. It reviews only jobs with the operator's private delegation and a provider the
// operator opted in to (records.ts). It never launches Claude, takes the session gate, compacts or
// resets a session, authorizes a job, accepts a result or runs Git. It delivers findings only by
// writing the same bound review request the bridge writes for factory_submit_review
// (ExecutionGateway.submitAutonomousReview), with its provenance; the supervisor then applies every
// existing check (current iteration, snapshot and artifact hashes, tree fingerprint, quiescence,
// idle gate, session and context binding, the delegation again) and is the only one that sends.
//
// Durable order of one review (jobs/<app>/<job>.json, records.ts REVIEW_STATES): the attempt is
// counted before the provider is called; findings are recorded before they are submitted; the
// review id is derived from the event id. So a crash never resets a budget and never sends a review
// twice: a restart finds `submitting` (submits the same content under the same id: a replay at
// most) or `submitted` (only observes what the supervisor recorded). A provider call interrupted by
// a crash may have run without its result being kept: provider execution is at-least-once within
// the attempt budget, not exactly-once.
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { FactoryJobError, FactoryJobs, jobFileExists, APPS_PATH } from '../factory-jobs.js';
import { ExecutionGateway } from '../executor/gateway.js';
import { checkJobDirectory, readManaged, reviewFile, type ManagedRecord } from '../executor/records.js';
import { delegationRefusal, reconcileJobEvent } from './events.js';
import { buildReviewInput, type ReviewInput } from './input.js';
import { findingText, validateResponse, type ReviewProvider } from './provider.js';
import { ENDED_JOB_STATES, JOB_STATE_SCHEMA, MAX_REVIEW_ENTRIES, MAX_SUBMISSION_BYTES, OPEN_REVIEW_STATES, ReviewerError, reviewIdOf, sha256, type ReviewDelegation, type ReviewEntry, type ReviewerJobState, type ReviewReadyEvent, type ReviewState } from './records.js';
import { ReviewerState } from './store.js';

const RETRY_BACKOFF_MS = 250;
const RETRY_BACKOFF_MAX_MS = 10_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const asCode = (text: string | null | undefined, fallback: string): string => (text ?? fallback).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || fallback;

export interface CoordinatorOptions {
  mediatorRoot: string;
  stateHome: string;
  // The providers this process can run. Production registers none (main.ts).
  providers: readonly ReviewProvider[];
  now?: () => Date;
  // Recovery pass for dropped notifications (default 15 min); not the trigger.
  backstopMs?: number;
  // Coalesces a burst of notifications (default 25 ms).
  settleMs?: number;
  log?: (line: string) => void;
  // Test seams only (fault injection): after an attempt was counted and before the provider runs;
  // before a review request is written; after it was written and before that is recorded.
  afterAttemptRecorded?: (eventId: string) => Promise<void>;
  beforeSubmit?: (eventId: string) => Promise<void>;
  afterSubmit?: (eventId: string) => Promise<void>;
}

type Seams = 'afterAttemptRecorded' | 'beforeSubmit' | 'afterSubmit' | 'log';

export class ReviewCoordinator {
  readonly #options: Required<Omit<CoordinatorOptions, Seams>> & Pick<CoordinatorOptions, Seams>;
  readonly #jobs: FactoryJobs;
  readonly #gateway: ExecutionGateway;
  readonly #providers: Map<string, ReviewProvider>;
  #state!: ReviewerState;
  #release: (() => Promise<void>) | undefined;
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #queue = new Set<string>();
  #fullPass = false;
  #pumping: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #backstop: NodeJS.Timeout | undefined;
  #stopped = false;
  readonly #chains = new Map<string, Promise<void>>();

  private constructor(options: CoordinatorOptions) {
    this.#options = { now: () => new Date(), backstopMs: 15 * 60_000, settleMs: 25, ...options };
    this.#jobs = new FactoryJobs(options.mediatorRoot);
    this.#gateway = new ExecutionGateway(this.#jobs, options.mediatorRoot, () => this.#options.now());
    this.#providers = new Map(options.providers.map((provider) => [provider.id, provider]));
  }

  // One coordinator per user (lock). Refuses unless the operator opted in to a provider this process has.
  static async start(options: CoordinatorOptions): Promise<ReviewCoordinator> {
    const coordinator = new ReviewCoordinator(options);
    // Checked read-only first: a refused start creates no state.
    const optIn = await (await ReviewerState.openExisting(options.stateHome, options.mediatorRoot)).providerOptIn();
    if (optIn === undefined || !coordinator.#providers.has(optIn.provider)) {
      throw new ReviewerError('provider_unavailable', optIn === undefined ? 'No review provider is enabled (provider opt-in missing). Nothing was started.' : `The enabled provider ${optIn.provider} is not available in this build. Nothing was started.`);
    }
    coordinator.#state = await ReviewerState.open(options.stateHome, options.mediatorRoot);
    coordinator.#release = await coordinator.#state.coordinatorLock();
    return coordinator;
  }

  get state(): ReviewerState {
    return this.#state;
  }

  #log(line: string): void {
    this.#options.log?.(line);
  }

  // ---- event loop ----

  // Reconciles everything, then follows notifications until stop().
  async run(): Promise<void> {
    this.#watch(this.#state.dir, true, (name) => {
      const parts = name.split(/[\\/]/);
      if (parts[0] === 'events' && parts.length >= 3) {
        this.notify(parts[1], parts[2]);
      } else if (parts[0] === 'delegations' || parts[0] === 'revoked' || parts[0] === 'provider.json') {
        this.notify();
      }
    });
    this.notify();
    this.#backstop = setInterval(() => this.notify(), this.#options.backstopMs);
    this.#backstop.unref();
    while (!this.#stopped) {
      await sleep(50);
    }
    await this.#pumping;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#backstop);
    clearTimeout(this.#timer);
    for (const watcher of this.#watchers.values()) {
      watcher.close();
    }
    this.#watchers.clear();
    await this.#pumping;
  }

  async close(): Promise<void> {
    await this.stop();
    await this.#release?.();
    this.#release = undefined;
  }

  // A hint that something may have changed: one job, or (no arguments) everything delegated.
  notify(appId?: string, jobId?: string): void {
    if (this.#stopped) {
      return;
    }
    if (appId === undefined || jobId === undefined) {
      this.#fullPass = true;
    } else {
      this.#queue.add(`${appId}/${jobId}`);
    }
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#pumping ??= this.#pump().finally(() => {
        this.#pumping = undefined;
        if ((this.#queue.size > 0 || this.#fullPass) && !this.#stopped) {
          this.notify();
        }
      });
    }, this.#options.settleMs);
  }

  async #pump(): Promise<void> {
    while (!this.#stopped && (this.#fullPass || this.#queue.size > 0)) {
      if (this.#fullPass) {
        this.#fullPass = false;
        await this.reconcile();
        continue;
      }
      const key = this.#queue.values().next().value!;
      this.#queue.delete(key);
      const [appId, jobId] = key.split('/') as [string, string];
      await this.processJob(appId, jobId);
    }
  }

  #watch(path: string, recursive: boolean, onChange: (name: string) => void): void {
    if (this.#watchers.has(path) || this.#stopped) {
      return;
    }
    try {
      const watcher = watch(path, { recursive, persistent: false }, (_type, name) => onChange(name === null ? '' : String(name)));
      watcher.on('error', () => {
        watcher.close();
        this.#watchers.delete(path);
        this.notify();
      });
      this.#watchers.set(path, watcher);
    } catch {
      // Not watchable now (e.g. missing): the reconciliation passes still cover it.
    }
  }

  // Restart reconciliation, bounded: every delegated job (store bounds), nothing else.
  async reconcile(): Promise<{ jobs: number; complete: boolean }> {
    const { jobs, complete } = await this.#state.delegatedJobs().catch(() => ({ jobs: [], complete: false }));
    if (!complete) {
      this.#log('RECONCILE INCOMPLETE: the delegation listing hit a bound or could not be read');
    }
    for (const { appId, jobId } of jobs) {
      if (this.#stopped) {
        break;
      }
      this.#watch(join(this.#options.mediatorRoot, APPS_PATH, appId, 'jobs', jobId), false, (name) => {
        if (!name.startsWith('.')) {
          this.notify(appId, jobId);
        }
      });
      await this.processJob(appId, jobId);
    }
    return { jobs: jobs.length, complete };
  }

  // ---- one job ----

  // Serialized per job within this coordinator (other coordinators are excluded by the lock).
  async processJob(appId: string, jobId: string): Promise<void> {
    const key = `${appId}/${jobId}`;
    const previous = this.#chains.get(key) ?? Promise.resolve();
    const current = previous.then(() => this.#processJob(appId, jobId));
    this.#chains.set(key, current);
    try {
      await current;
    } finally {
      if (this.#chains.get(key) === current) {
        this.#chains.delete(key);
      }
    }
  }

  async #processJob(appId: string, jobId: string): Promise<void> {
    try {
      const delegation = await this.#state.delegation(appId, jobId);
      if (delegation === undefined) {
        return;
      }
      const managed = await this.#managed(appId, jobId);
      if (managed === undefined) {
        return;
      }
      if ((await delegationRefusal(this.#state, appId, jobId, { authorizationId: managed.authorization_id }, this.#options.now())) === null) {
        // Recovery of a missed event; whatever it finds, the recorded events are still advanced.
        await reconcileJobEvent(this.#state, this.#jobs, appId, jobId, this.#options.now()).catch((error: unknown) => {
          this.#log(`${appId}/${jobId}: event reconciliation failed (${(error as { code?: string }).code ?? 'error'})`);
        });
      }
      const { events, invalid } = await this.#state.events(appId, jobId);
      if (invalid > 0) {
        this.#log(`${appId}/${jobId}: ${invalid} unreadable review-ready event file(s) ignored`);
      }
      for (const event of events) {
        await this.#advance(event, delegation);
      }
      await this.#expireCleanVerdicts(appId, jobId, delegation, events);
    } catch (error) {
      this.#log(`${appId}/${jobId}: ${(error as { code?: string }).code ?? 'error'}: ${error instanceof FactoryJobError || (error as Error).name === 'ReviewerError' ? (error as Error).message : 'unexpected error'}`);
    }
  }

  async #managed(appId: string, jobId: string): Promise<ManagedRecord | undefined> {
    return this.#jobs
      .withJob(appId, jobId, false, async (job) => {
        await checkJobDirectory(job);
        return readManaged(job);
      })
      .catch(() => undefined);
  }

  // The entry of one event, changed by update under the per-job state lock.
  async #update(event: ReviewReadyEvent, delegation: ReviewDelegation, update: (entry: ReviewEntry, job: ReviewerJobState) => { entry: Partial<ReviewEntry>; usage?: Partial<ReviewerJobState['usage']> } | undefined): Promise<ReviewEntry | undefined> {
    const at = this.#options.now().toISOString();
    const next = await this.#state.updateJobState(event.app_id, event.job_id, (current) => {
      // A new delegation (after a revocation) starts new budgets; earlier entries stay as they are.
      const job: ReviewerJobState =
        current !== undefined && current.delegation_id === delegation.delegation_id
          ? current
          : { schema: JOB_STATE_SCHEMA, app_id: event.app_id, job_id: event.job_id, delegation_id: delegation.delegation_id, usage: { attempts: 0, reviews: 0 }, reviews: current?.reviews ?? [], revision: current?.revision ?? 0, updated_at: at };
      let entry = job.reviews.find((review) => review.event_id === event.event_id);
      const fresh = entry === undefined;
      entry ??= {
        event_id: event.event_id,
        review_id: reviewIdOf(event.event_id),
        delegation_id: delegation.delegation_id,
        provider: delegation.provider,
        iteration_id: event.iteration_id,
        snapshot_sha256: event.snapshot_sha256,
        session_id: null,
        context_epoch: null,
        state: 'pending',
        code: null,
        attempts: 0,
        input_sha256: null,
        submission: null,
        submission_sha256: null,
        created_at: at,
        updated_at: at,
      };
      const change = update(entry, job);
      if (change === undefined && !fresh && job === current) {
        return undefined;
      }
      const merged = { ...entry, ...(change?.entry ?? {}), updated_at: at };
      // Finding bodies are kept only while submitting (bounded state); afterwards only their sha256.
      const changed = merged.state !== 'submitting' && merged.submission !== null ? { ...merged, submission: null, submission_sha256: merged.submission.sha256 } : merged;
      const reviews = fresh ? [...job.reviews, changed].slice(-MAX_REVIEW_ENTRIES) : job.reviews.map((review) => (review.event_id === event.event_id ? changed : review));
      return { ...job, usage: { ...job.usage, ...(change?.usage ?? {}) }, reviews, updated_at: at };
    });
    return next?.reviews.find((review) => review.event_id === event.event_id);
  }

  async #finish(event: ReviewReadyEvent, delegation: ReviewDelegation, state: ReviewState, code: string | null): Promise<void> {
    await this.#update(event, delegation, () => ({ entry: { state, code } }));
    this.#log(`${event.app_id}/${event.job_id} ${event.iteration_id}: ${state}${code ? ` (${code})` : ''}`);
  }

  async #advance(event: ReviewReadyEvent, delegation: ReviewDelegation): Promise<void> {
    for (let step = 0; step < 50 && !this.#stopped; step += 1) {
      const entry = await this.#update(event, delegation, () => undefined);
      if (entry === undefined || !OPEN_REVIEW_STATES.includes(entry.state)) {
        return;
      }
      if (entry.state === 'submitted') {
        await this.#observe(event, delegation, entry);
        return;
      }
      if (entry.delegation_id !== delegation.delegation_id) {
        // The grant changed (revoked and delegated again). Recorded findings belong to the old grant
        // and its provider: never relabelled or replayed under the new one. A request already
        // written is only observed. An entry without a recorded result starts under the new grant.
        if (entry.state === 'submitting') {
          if (await this.#written(event, entry)) {
            await this.#update(event, delegation, () => ({ entry: { state: 'submitted' } }));
            continue;
          }
          await this.#finish(event, delegation, 'delegation_invalid', 'delegation_replaced');
          return;
        }
        await this.#update(event, delegation, () => ({ entry: { state: 'pending', delegation_id: delegation.delegation_id, provider: delegation.provider } }));
        continue;
      }
      if (entry.state === 'submitting') {
        if (!(await this.#submit(event, delegation, entry))) {
          return;
        }
        continue;
      }
      // pending, or provider_running left by a crash (that attempt stays counted).
      if (!(await this.#attempt(event, delegation, entry))) {
        return;
      }
    }
  }

  // One provider attempt. False when the entry should not be advanced further now.
  async #attempt(event: ReviewReadyEvent, delegation: ReviewDelegation, entry: ReviewEntry): Promise<boolean> {
    const managed = await this.#managed(event.app_id, event.job_id);
    const refusal = await delegationRefusal(this.#state, event.app_id, event.job_id, { delegationId: delegation.delegation_id, authorizationId: managed?.authorization_id ?? '' }, this.#options.now());
    if (refusal !== null) {
      await this.#finish(event, delegation, refusal.code === 'elapsed_limit' ? 'elapsed_limit' : 'delegation_invalid', refusal.code);
      return false;
    }
    const provider = this.#providers.get(delegation.provider);
    if (provider === undefined) {
      await this.#finish(event, delegation, 'delegation_invalid', 'provider_unavailable');
      return false;
    }
    const job = (await this.#state.jobState(event.app_id, event.job_id))!;
    if (job.usage.reviews >= delegation.limits.max_reviews) {
      await this.#finish(event, delegation, 'review_limit', 'review_limit');
      return false;
    }
    if (job.usage.attempts >= delegation.limits.max_attempts) {
      await this.#finish(event, delegation, 'attempts_exhausted', entry.code ?? 'attempt_limit');
      return false;
    }
    const built = await buildReviewInput(this.#jobs, event, delegation.limits.max_input_bytes).catch((): Awaited<ReturnType<typeof buildReviewInput>> => ({ ok: false, disposition: 'blocked', code: 'input_unreadable' }));
    if (!built.ok) {
      if (built.disposition === 'wait') {
        if (entry.state === 'provider_running') {
          await this.#update(event, delegation, () => ({ entry: { state: 'pending', code: built.code } }));
        }
        return false;
      }
      const state: ReviewState = built.disposition === 'superseded' ? 'superseded' : built.disposition === 'job_ended' ? 'job_ended' : 'input_blocked';
      await this.#finish(event, delegation, state, built.code);
      return false;
    }
    const input = built.input;
    // Counted before the call: a crash after this point has spent the attempt.
    await this.#update(event, delegation, (current, state) => ({
      entry: { state: 'provider_running', attempts: current.attempts + 1, input_sha256: input.input_sha256, session_id: input.session_id, context_epoch: input.context_epoch },
      usage: { attempts: state.usage.attempts + 1 },
    }));
    await this.#options.afterAttemptRecorded?.(event.event_id);
    const remaining = Date.parse(delegation.created_at) + delegation.limits.max_elapsed_ms - this.#options.now().getTime();
    const raw = await this.#call(provider, input, Math.max(1, Math.min(delegation.limits.attempt_timeout_ms, remaining)));
    const validated = 'error' in raw ? ({ ok: false, code: raw.error } as const) : validateResponse(raw.value, input);
    if (!validated.ok || validated.response.outcome === 'error') {
      const code = validated.ok ? asCode(validated.response.outcome === 'error' ? validated.response.code : null, 'provider_error') : validated.code;
      const retryable = !validated.ok || (validated.response.outcome === 'error' && validated.response.retryable);
      await this.#update(event, delegation, () => ({ entry: retryable ? { state: 'pending', code } : { state: 'provider_failed', code } }));
      this.#log(`${event.app_id}/${event.job_id} ${event.iteration_id}: attempt failed (${code})`);
      if (retryable) {
        // Bounded exponential backoff between retries, so a failing provider cannot burn the budget in one burst.
        await sleep(Math.min(RETRY_BACKOFF_MS * 2 ** (entry.attempts), RETRY_BACKOFF_MAX_MS));
      }
      return retryable;
    }
    const response = validated.response;
    if (response.outcome === 'refusal') {
      await this.#finish(event, delegation, 'provider_refused', asCode(response.code, 'provider_refused'));
      return false;
    }
    // The verdict is only for the input it was made on: that input must still be the current one.
    const again = await buildReviewInput(this.#jobs, event, delegation.limits.max_input_bytes).catch(() => undefined);
    if (again === undefined || !again.ok || again.input.input_sha256 !== input.input_sha256) {
      if (again !== undefined && !again.ok && again.disposition === 'wait') {
        await this.#update(event, delegation, () => ({ entry: { state: 'pending', code: again.code } }));
        return false;
      }
      await this.#finish(event, delegation, again !== undefined && !again.ok && again.disposition === 'job_ended' ? 'job_ended' : 'superseded', again === undefined || again.ok ? 'input_changed' : again.code);
      return false;
    }
    if (response.outcome === 'clean') {
      // Like a delivery: the delegation must still cover the verdict when it is recorded.
      const late = await delegationRefusal(this.#state, event.app_id, event.job_id, { delegationId: delegation.delegation_id, authorizationId: managed?.authorization_id ?? '' }, this.#options.now());
      if (late !== null) {
        await this.#finish(event, delegation, late.code === 'elapsed_limit' ? 'elapsed_limit' : 'delegation_invalid', late.code);
        return false;
      }
      await this.#update(event, delegation, (_entry, state) => ({ entry: { state: 'clean_awaiting_acceptance', code: null }, usage: { reviews: state.usage.reviews + 1 } }));
      this.#log(`${event.app_id}/${event.job_id} ${event.iteration_id}: clean verdict for snapshot ${event.snapshot_sha256}; awaiting the operator's acceptance`);
      return false;
    }
    const findings = response.findings.map((finding) => ({ text: findingText(finding) }));
    const summary = response.summary;
    if (Buffer.byteLength(JSON.stringify([summary, findings])) > MAX_SUBMISSION_BYTES) {
      // Valid but too large to record and replay safely: a coded outcome, nothing submitted.
      await this.#finish(event, delegation, 'provider_failed', 'provider_output_too_large');
      return false;
    }
    await this.#update(event, delegation, (_entry, state) => ({
      entry: { state: 'submitting', code: null, submission: { summary, findings, sha256: sha256(JSON.stringify([summary, findings])) } },
      usage: { reviews: state.usage.reviews + 1 },
    }));
    return true;
  }

  async #call(provider: ReviewProvider, input: ReviewInput, timeoutMs: number): Promise<{ value: unknown } | { error: string }> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ error: string }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ error: 'provider_timeout' });
      }, timeoutMs);
    });
    try {
      return await Promise.race([provider.review(input, controller.signal).then((value) => ({ value }), () => ({ error: 'provider_failed' })), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Submits the recorded findings once, under the event's review id, after revalidating the
  // delegation and the exact input. True when the entry advanced (submitted).
  async #submit(event: ReviewReadyEvent, delegation: ReviewDelegation, entry: ReviewEntry): Promise<boolean> {
    const submission = entry.submission;
    if (submission === null || entry.input_sha256 === null || entry.session_id === null || entry.context_epoch === null) {
      await this.#finish(event, delegation, 'input_blocked', 'submission_missing');
      return false;
    }
    // Already written (a crash after the write, or a concurrent coordinator): never written again.
    if (await this.#written(event, entry)) {
      await this.#update(event, delegation, () => ({ entry: { state: 'submitted' } }));
      return true;
    }
    await this.#options.beforeSubmit?.(event.event_id);
    const managed = await this.#managed(event.app_id, event.job_id);
    const refusal = await delegationRefusal(this.#state, event.app_id, event.job_id, { delegationId: delegation.delegation_id, authorizationId: managed?.authorization_id ?? '' }, this.#options.now());
    if (refusal !== null) {
      await this.#finish(event, delegation, refusal.code === 'elapsed_limit' ? 'elapsed_limit' : 'delegation_invalid', refusal.code);
      return false;
    }
    const again = await buildReviewInput(this.#jobs, event, delegation.limits.max_input_bytes).catch(() => undefined);
    if (again === undefined || !again.ok || again.input.input_sha256 !== entry.input_sha256) {
      if (again !== undefined && !again.ok && again.disposition === 'wait') {
        return false;
      }
      await this.#finish(event, delegation, again !== undefined && !again.ok && again.disposition === 'job_ended' ? 'job_ended' : 'superseded', again === undefined || again.ok ? 'input_changed' : again.code);
      return false;
    }
    try {
      await this.#gateway.submitAutonomousReview(
        { app_id: event.app_id, job_id: event.job_id, iteration_id: event.iteration_id, snapshot_sha256: event.snapshot_sha256, review_id: entry.review_id, summary: submission.summary, findings: submission.findings },
        { kind: 'autonomous_reviewer', event_id: event.event_id, delegation_id: entry.delegation_id, provider: entry.provider, session_id: entry.session_id, context_epoch: entry.context_epoch },
      );
    } catch (error) {
      const message = (error as Error).message ?? '';
      const code = (error as { code?: string }).code;
      if (code === 'too_large') {
        await this.#finish(event, delegation, 'provider_failed', 'request_too_large');
      } else if (code === 'conflict' && message.includes('still pending')) {
        await this.#finish(event, delegation, 'competing_review', 'competing_review_pending');
      } else if (code === 'conflict' || code === 'sha256_mismatch') {
        const reason = /^(session_replaced|context_changed)/.exec(message)?.[1] ?? (message.includes('not the current iteration') ? 'stale_iteration' : 'review_conflict');
        await this.#finish(event, delegation, 'superseded', reason);
      } else {
        // Not written (the bridge writes completely or not at all): stays submitting for the next pass.
        this.#log(`${event.app_id}/${event.job_id} ${event.iteration_id}: submission failed (${code ?? 'error'}); kept for the next pass`);
      }
      return false;
    }
    await this.#options.afterSubmit?.(event.event_id);
    await this.#update(event, delegation, () => ({ entry: { state: 'submitted', code: null } }));
    return true;
  }

  // A clean verdict is bound to its snapshot: once that snapshot is no longer the current ready
  // iteration (a later review, a conflict, the job ended), the verdict is superseded.
  async #expireCleanVerdicts(appId: string, jobId: string, delegation: ReviewDelegation, events: ReviewReadyEvent[]): Promise<void> {
    const job = await this.#state.jobState(appId, jobId);
    const managed = await this.#managed(appId, jobId);
    const current = managed?.iterations.find((entry) => entry.id === managed.current_iteration);
    for (const entry of job?.reviews ?? []) {
      const event = events.find((value) => value.event_id === entry.event_id);
      const stillCurrent = current !== undefined && current.id === entry.iteration_id && current.state === 'ready_for_review' && current.snapshot?.sha256 === entry.snapshot_sha256;
      if (entry.state === 'clean_awaiting_acceptance' && event !== undefined && managed !== undefined && !stillCurrent && managed.state !== 'approved' && managed.state !== 'closed') {
        await this.#finish(event, delegation, 'superseded', 'clean_superseded');
      }
    }
  }

  // Whether the entry's review request exists in the job directory or the supervisor handled it.
  async #written(event: ReviewReadyEvent, entry: ReviewEntry): Promise<boolean> {
    return this.#jobs.withJob(event.app_id, event.job_id, false, async (job) => {
      const managed = await readManaged(job);
      return (await jobFileExists(job, reviewFile(entry.review_id))) || managed?.reviews.some((review) => review.review_id === entry.review_id) === true;
    });
  }

  // What the supervisor recorded for the submitted review. Never resends.
  async #observe(event: ReviewReadyEvent, delegation: ReviewDelegation, entry: ReviewEntry): Promise<void> {
    const managed = await this.#managed(event.app_id, event.job_id);
    const recorded = managed?.reviews.find((review) => review.review_id === entry.review_id);
    if (recorded?.outcome === 'delivered') {
      await this.#finish(event, delegation, 'delivered', null);
    } else if (recorded?.outcome === 'rejected') {
      await this.#finish(event, delegation, 'rejected', asCode(recorded.reason, 'rejected'));
    } else if (recorded?.outcome === 'unconfirmed') {
      await this.#finish(event, delegation, 'unconfirmed', asCode(recorded.reason, 'unconfirmed'));
    } else if (recorded === undefined && managed !== undefined && ENDED_JOB_STATES.includes(managed.state)) {
      await this.#finish(event, delegation, 'job_ended', `job_${managed.state}`);
    }
    // sending, or not yet picked up: the supervisor decides; the next notification observes it.
  }
}
