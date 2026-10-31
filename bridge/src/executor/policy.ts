// SF-009 executor policy: the operator's one-time, local opt-in to automatic launches. It lives
// in the private state directory next to the SF-007 operator state
// (${XDG_STATE_HOME:-~/.local/state}/software-factory/executor, 0700, outside the mediator), so
// neither the bridge, ChatGPT nor OpenClaw can write it:
//
//   policy.json                      enabled flag, epoch, salt, the verified Claude Code executable,
//                                    the allowlisted apps (each bound to its repository's real path
//                                    by sha256, permission mode auto, isolation), protected checkouts
//   consumed/<authorization_id>      an authorization used once (exclusive create): the tuple it is
//                                    bound to and the one SF-007 approval id that may carry it. A
//                                    reservation, never evidence of an approval by itself (Review 01)
//   refused/<authorization_id>       an authorization whose approval step failed: never retried
//   supervisor/execution.lock        the one running supervisor (pid, start time, boot id)
//   self-hosting.json                the operator's separate self-hosting opt-in (below), if given
//
// Only the `enable`/`disable` commands of executor/main.ts, run by the operator, write it. Every
// change raises the epoch, so authorizations issued before it no longer match. For ChatGPT, the
// commands also publish a non-secret view per app (factory-data/apps/<app>/executor-policy.json):
// enabled, epoch, permission mode and an opaque repository identity, a salted sha256 of the real
// path that cannot be reversed or guessed without the private salt.
//
// Isolation (Review 01, R1-3). Nothing here, in Claude Code's auto mode or in the --disallowedTools
// rules is an OS sandbox: a session runs as the operator and can reach every file, credential,
// checkout and network endpoint the operator can. The turn-end checks detect some effects after
// they happened. So no app is enabled for production automatic execution: the only supported
// isolation is "disposable_pilot", the operator's explicit declaration at enable time that the
// repository is a disposable checkout and the host session exposes no real credentials and no
// other writable checkout. An app without it (also any policy written before Review 01) is refused
// with unsupported_isolation. A verified sandbox would be a new isolation value; none exists yet.
//
// Self-hosting (operator-controlled, unconfined). A second, separate opt-in lets exactly one app
// work on the Software Factory checkout itself (its main checkout, beside the operator's own
// uncommitted work), with isolation "self_hosting_unconfined". It is not a disposable pilot and
// not a sandbox: the value says so. The opt-in is its own private record (self-hosting.json),
// bound to the app id and to the sha256 of the checkout's real path; `enable --self-hosting`
// writes it with the policy entry, `disable` removes it. Only with it does loadAppConfig accept
// the mediator as APP_REPO (app-config.ts); ancestors and descendants of the mediator stay
// refused. The job's baseline of the existing uncommitted work (service.ts, prepare) replaces the
// clean-repository requirement for this app only.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, open, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import * as z from 'zod/v4';
import { loadAppConfig, type SelfHostingGrant } from '../execution/app-config.js';
import { acquireLock } from '../execution/process-identity.js';
import { APPS_PATH, ID_PATTERN, SHA256_PATTERN } from '../factory-jobs.js';
import { OperatorError, privateDirectory, readPrivate, writePrivate } from '../operator/store.js';
import { POLICY_VIEW_FILE, type PolicyView } from './records.js';

export const POLICY_SCHEMA = 'software-factory.executor-policy/v1';

const policySchema = z.strictObject({
  schema: z.literal(POLICY_SCHEMA),
  enabled: z.boolean(),
  epoch: z.number().int().min(1),
  salt: z.string().regex(/^[0-9a-f]{64}$/),
  claude: z.strictObject({ executable: z.string().refine(isAbsolute, 'must be absolute'), version: z.string().min(1).max(64) }),
  apps: z.record(
    z.string().regex(ID_PATTERN),
    z.strictObject({
      app_repo_sha256: z.string().regex(SHA256_PATTERN),
      permission_mode: z.literal('auto'),
      enabled_at: z.iso.datetime(),
      // The operator's declaration: a disposable pilot, or self-hosting (see the header).
      isolation: z.enum(['disposable_pilot', 'self_hosting_unconfined']).optional(),
    }),
  ),
  // Other checkouts that must stay untouched: checked (HEAD, index, Git control files, working
  // tree) at launch and at every turn boundary. A change stops the session for inspection.
  protected_paths: z.array(z.string().refine(isAbsolute, 'must be absolute')).max(20),
  updated_at: z.iso.datetime(),
  // The completed-transaction binding of enable and disable: false while a policy change is being
  // published (written first, before its public views and grant), true once all of it was
  // written. Absent in policies written before this field existed: those count as completed.
  committed: z.boolean().optional(),
});
export type ExecutorPolicy = z.infer<typeof policySchema>;
// Whether launches may run under this policy: enabled, and its last change completed. A change
// that failed part-way (a view or the grant could not be written) is never runnable.
export const policyRunnable = (policy: ExecutorPolicy | undefined): boolean => policy !== undefined && policy.enabled && policy.committed !== false;
export const ISOLATIONS = ['none', 'disposable_pilot', 'self_hosting_unconfined'] as const;
export type Isolation = (typeof ISOLATIONS)[number];
// The isolations a launch may run under. Neither is a sandbox; both are operator declarations.
export const RUNNABLE_ISOLATIONS: readonly Isolation[] = ['disposable_pilot', 'self_hosting_unconfined'];
// The isolation an allowlisted app runs under; absent (a policy before Review 01) is none.
export const appIsolation = (app: ExecutorPolicy['apps'][string] | undefined): Isolation => app?.isolation ?? 'none';

// The use of one authorization (consumed/<authorization_id>). Written once, before the SF-007
// approval is created, so a restart finds the approval by its id and verifies it.
export const authorizationUseSchema = z.strictObject({
  schema: z.literal('software-factory.authorization-use/v1'),
  authorization_id: z.uuid(),
  approval_id: z.uuid(),
  app_id: z.string().regex(ID_PATTERN),
  job_id: z.string().regex(ID_PATTERN),
  request_id: z.uuid(),
  instruction_sha256: z.string().regex(SHA256_PATTERN),
  app_repo_sha256: z.string().regex(SHA256_PATTERN),
  at: z.iso.datetime(),
});
export type AuthorizationUse = z.infer<typeof authorizationUseSchema>;
const refusalSchema = z.strictObject({
  schema: z.literal('software-factory.authorization-refusal/v1'),
  authorization_id: z.uuid(),
  code: z.string().max(64),
  at: z.iso.datetime(),
});
export type AuthorizationRefusal = z.infer<typeof refusalSchema>;

// The separate self-hosting opt-in (see the header). Written only by `enable --self-hosting`.
export const SELF_HOSTING_SCHEMA = 'software-factory.self-hosting/v1';
const selfHostingSchema = z.strictObject({
  schema: z.literal(SELF_HOSTING_SCHEMA),
  app_id: z.string().regex(ID_PATTERN),
  // sha256 of the real path of the Software Factory checkout the opt-in names (repoSha256).
  repo_sha256: z.string().regex(SHA256_PATTERN),
  // What the operator declared: sessions run unconfined, as the operator, in this checkout.
  declaration: z.literal('operator_controlled_unconfined'),
  enabled_at: z.iso.datetime(),
});
export type SelfHosting = z.infer<typeof selfHostingSchema>;
const SELF_HOSTING_FILE = 'self-hosting.json';

export const executorDirectory = (stateHome: string): string => join(stateHome, 'software-factory', 'executor');
export const repoSha256 = (repo: string): string => createHash('sha256').update(repo).digest('hex');
export const repoIdentity = (salt: string, repo: string): string => createHash('sha256').update(`sf009-repo\0${salt}\0${repo}`).digest('hex');

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// The apps without the self-hosting entries that the grant does not name (stale ones: the opt-in
// record was withdrawn or belongs to another app), and the ids of those removed.
function withoutStaleSelfHosting(apps: ExecutorPolicy['apps'], grant: SelfHostingGrant | undefined): { apps: ExecutorPolicy['apps']; stale: string[] } {
  const kept: ExecutorPolicy['apps'] = {};
  const stale: string[] = [];
  for (const [appId, app] of Object.entries(apps)) {
    if (appIsolation(app) === 'self_hosting_unconfined' && (grant === undefined || grant.appId !== appId || grant.repoSha256 !== app.app_repo_sha256)) {
      stale.push(appId);
    } else {
      kept[appId] = app;
    }
  }
  return { apps: kept, stale };
}

export class ExecutorState {
  readonly dir: string;
  readonly #mediatorRoot: string;

  private constructor(dir: string, mediatorRoot: string) {
    this.dir = dir;
    this.#mediatorRoot = mediatorRoot;
  }

  // Opens (creating if needed) the private executor directory; it must not lie inside the mediator.
  static async open(stateHome: string, mediatorRoot: string): Promise<ExecutorState> {
    if (!isAbsolute(stateHome)) throw new OperatorError('unsafe_state', 'The state home must be an absolute path.');
    await mkdir(stateHome, { recursive: true, mode: 0o700 });
    const real = await realpath(stateHome);
    const dir = executorDirectory(real);
    const mediator = await realpath(mediatorRoot);
    if (inside(mediator, dir) || inside(dir, mediator)) {
      throw new OperatorError('unsafe_state', 'The executor state directory must be outside the Software Factory repository.');
    }
    for (const path of [join(real, 'software-factory'), dir, join(dir, 'consumed'), join(dir, 'refused'), join(dir, 'supervisor')]) {
      await privateDirectory(path, true);
    }
    return new ExecutorState(dir, mediator);
  }

  // The same directory for reading only (the observer): nothing is created. A missing directory
  // reads as no state; an existing one must still be private.
  static async openExisting(stateHome: string, mediatorRoot: string): Promise<ExecutorState> {
    if (!isAbsolute(stateHome)) {
      throw new OperatorError('unsafe_state', 'The state home must be an absolute path.');
    }
    const real = await realpath(stateHome).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return stateHome;
      }
      throw error;
    });
    const dir = executorDirectory(real);
    const mediator = await realpath(mediatorRoot);
    if (inside(mediator, dir) || inside(dir, mediator)) {
      throw new OperatorError('unsafe_state', 'The executor state directory must be outside the Software Factory repository.');
    }
    for (const path of [join(real, 'software-factory'), dir]) {
      await privateDirectory(path, false).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }
    return new ExecutorState(dir, mediator);
  }

  async policy(): Promise<ExecutorPolicy | undefined> {
    return readPrivate(join(this.dir, 'policy.json'), policySchema);
  }

  async selfHosting(): Promise<SelfHosting | undefined> {
    return readPrivate(join(this.dir, SELF_HOSTING_FILE), selfHostingSchema);
  }

  // The self-hosting opt-in as loadAppConfig takes it, or undefined.
  async selfHostingGrant(): Promise<SelfHostingGrant | undefined> {
    const record = await this.selfHosting();
    return record === undefined ? undefined : { appId: record.app_id, repoSha256: record.repo_sha256 };
  }

  // The one-time opt-in for one app: binds its current repository and the verified executable.
  // Only a disposable pilot, or the self-hosting app (the mediator checkout itself, with its own
  // opt-in record), can be enabled: no enforceable sandbox exists for anything else.
  async enable(appId: string, claude: ExecutorPolicy['claude'], protectedPaths: string[] = [], now = new Date(), isolation: Isolation = 'none'): Promise<ExecutorPolicy> {
    if (isolation === 'none') {
      throw new OperatorError(
        'unsupported_isolation',
        'Production automatic execution is not supported: no enforceable OS sandbox confines the session (files, credentials, Git, network). Only a disposable pilot app (--disposable-pilot) or the self-hosting app (--self-hosting) can be enabled. Nothing was enabled.',
      );
    }
    const existing = await this.selfHosting();
    let grant: SelfHostingGrant | undefined;
    if (isolation === 'self_hosting_unconfined') {
      if (existing !== undefined && existing.app_id !== appId) {
        throw new OperatorError('conflict', `Self-hosting is already enabled for ${existing.app_id}; disable it first. Nothing was enabled.`);
      }
      grant = { appId, repoSha256: repoSha256(this.#mediatorRoot) };
    } else if (existing?.app_id === appId) {
      throw new OperatorError('conflict', `${appId} is the self-hosting app; disable it before enabling it another way. Nothing was enabled.`);
    }
    const config = await loadAppConfig(this.#mediatorRoot, appId, grant);
    if (isolation === 'self_hosting_unconfined' && config.selfHosted !== true) {
      throw new OperatorError('unsafe_state', `--self-hosting is only for an app whose APP_REPO is this Software Factory checkout; ${appId} names another repository. Nothing was enabled.`);
    }
    const current = await this.policy();
    const realProtected = await Promise.all(protectedPaths.map((path) => realpath(path)));
    for (const path of realProtected) {
      if (inside(path, config.repo) || inside(config.repo, path)) {
        throw new OperatorError('unsafe_state', 'A protected path overlaps the application repository.');
      }
    }
    // The grant in effect afterwards: the new one, or the existing one (another app's).
    const effective = grant ?? (existing === undefined ? undefined : { appId: existing.app_id, repoSha256: existing.repo_sha256 });
    const { apps, stale } = withoutStaleSelfHosting({ ...(current?.apps ?? {}), [appId]: { app_repo_sha256: repoSha256(config.repo), permission_mode: 'auto', enabled_at: now.toISOString(), isolation } }, effective);
    const next: ExecutorPolicy = {
      schema: POLICY_SCHEMA,
      enabled: true,
      epoch: (current?.epoch ?? 0) + 1,
      salt: current?.salt ?? randomBytes(32).toString('hex'),
      claude,
      apps,
      protected_paths: [...new Set([...(current?.protected_paths ?? []), ...realProtected])],
      updated_at: now.toISOString(),
    };
    // An existing grant that names no matching entry any more (stale) goes with that entry.
    const orphaned = grant === undefined && effective !== undefined && next.apps[effective.appId]?.app_repo_sha256 !== effective.repoSha256;
    // Every public view is computed before anything is written: a failure changes nothing.
    const views = await this.#views(next, orphaned ? undefined : effective, stale);
    const replacement: SelfHosting | undefined =
      grant === undefined ? undefined : { schema: SELF_HOSTING_SCHEMA, app_id: appId, repo_sha256: grant.repoSha256, declaration: 'operator_controlled_unconfined', enabled_at: now.toISOString() };
    // A grant that is replaced or withdrawn is invalidated before anything is persisted.
    await this.#commit(next, views, grant !== undefined || orphaned, replacement);
    return next;
  }

  // Withdraws one app, or the whole opt-in. Running sessions are not touched; nothing new launches.
  // The self-hosting opt-in goes with its app (or with everything), before the policy changes.
  async disable(appId: string | undefined, now = new Date()): Promise<ExecutorPolicy | undefined> {
    // An unreadable opt-in record is removed too: withdrawing never keeps a grant it cannot read.
    const selfHosting = await this.selfHosting().then((record) => record ?? null, () => undefined);
    const removeGrant = appId === undefined || selfHosting === undefined || selfHosting?.app_id === appId;
    const removeGrantFile = () => rm(join(this.dir, SELF_HOSTING_FILE), { force: true });
    const current = await this.policy();
    if (current === undefined) {
      if (removeGrant) {
        await removeGrantFile();
      }
      return undefined;
    }
    const remaining = removeGrant || selfHosting === null ? undefined : { appId: selfHosting.app_id, repoSha256: selfHosting.repo_sha256 };
    const kept = { ...current.apps };
    if (appId !== undefined) {
      delete kept[appId];
    }
    // A self-hosting entry whose opt-in record is gone is withdrawn with it, never left behind.
    const { apps, stale } = withoutStaleSelfHosting(kept, remaining);
    const next: ExecutorPolicy = { ...current, enabled: appId === undefined ? false : current.enabled, apps, epoch: current.epoch + 1, updated_at: now.toISOString() };
    const withdrawn = [...(appId === undefined ? Object.keys(current.apps) : [appId]), ...stale];
    // The views first (a failure changes nothing); a withdrawn grant goes before the policy.
    const views = await this.#views(next, remaining, withdrawn);
    await this.#commit(next, views, removeGrant, undefined);
    return next;
  }

  // Persists a policy change as one completed transaction:
  //   1. the grant being replaced or withdrawn is removed (invalidate);
  //   2. policy.json is written with committed: false: from here on, until step 5, nothing is
  //      runnable (policyRunnable), whatever was published already;
  //   3. every public view is written;
  //   4. the replacement grant, if any, is written;
  //   5. policy.json is written again with committed: true.
  // A failure in steps 2 to 5 is reported and leaves the new epoch uncommitted (and the replaced
  // grant gone): nothing launches until enable or disable runs again and completes. Validation
  // and view computation happen before step 1, so their failures change nothing.
  async #commit(policy: ExecutorPolicy, views: PolicyView[], invalidateGrant: boolean, replacement: SelfHosting | undefined): Promise<void> {
    const pending = policySchema.parse({ ...policy, committed: false });
    const completed = policySchema.parse({ ...policy, committed: true });
    const record = replacement === undefined ? undefined : selfHostingSchema.parse(replacement);
    if (invalidateGrant) {
      await rm(join(this.dir, SELF_HOSTING_FILE), { force: true });
    }
    await writePrivate(this.dir, 'policy.json', pending, 'replace');
    for (const view of views) {
      await writePrivate(join(this.#mediatorRoot, APPS_PATH, view.app_id), POLICY_VIEW_FILE, view, 'replace');
    }
    if (record !== undefined) {
      await writePrivate(this.dir, SELF_HOSTING_FILE, record, 'replace');
    }
    await writePrivate(this.dir, 'policy.json', completed, 'replace');
  }

  // The public views of every allowlisted and every withdrawn app, under the given grant.
  async #views(policy: ExecutorPolicy, grant: SelfHostingGrant | undefined, withdrawn: string[]): Promise<PolicyView[]> {
    const views: PolicyView[] = [];
    for (const appId of new Set([...Object.keys(policy.apps), ...withdrawn])) {
      views.push(await this.#view(policy, appId, grant));
    }
    return views;
  }

  // The public, non-secret view for one app (read by the bridge, shown to ChatGPT).
  async #view(policy: ExecutorPolicy, appId: string, grant: SelfHostingGrant | undefined): Promise<PolicyView> {
    const app = policy.apps[appId];
    let identity: string | null = null;
    if (policy.enabled && app !== undefined) {
      const config = await loadAppConfig(this.#mediatorRoot, appId, grant);
      identity = repoIdentity(policy.salt, config.repo);
    }
    return {
      schema: 'software-factory.executor-policy-view/v1',
      app_id: appId,
      enabled: policy.enabled && app !== undefined,
      policy_epoch: policy.epoch,
      repo_identity: identity,
      permission_mode: 'auto',
      isolation: appIsolation(app),
      updated_at: policy.updated_at,
    };
  }

  // Marks an authorization used for one approval id; false when it already was (exclusive create,
  // never removed). The winner's record is what use() returns to every later reader.
  async consume(use: AuthorizationUse): Promise<boolean> {
    return this.#createOnce('consumed', authorizationUseSchema.parse(use).authorization_id, use);
  }

  // The recorded use, or undefined. A record that is not a valid use (e.g. a marker written before
  // Review 01, which named no approval) throws invalid_record: the caller fails closed.
  async use(authorizationId: string): Promise<AuthorizationUse | undefined> {
    return readPrivate(join(this.dir, 'consumed', authorizationId), authorizationUseSchema);
  }

  // Records that the approval step of this authorization failed; it is never retried.
  async refuse(authorizationId: string, code: string, now = new Date()): Promise<void> {
    await this.#createOnce('refused', authorizationId, refusalSchema.parse({ schema: 'software-factory.authorization-refusal/v1', authorization_id: authorizationId, code: code.slice(0, 64), at: now.toISOString() }));
  }

  async refused(authorizationId: string): Promise<AuthorizationRefusal | undefined> {
    return readPrivate(join(this.dir, 'refused', authorizationId), refusalSchema);
  }

  async #createOnce(kind: 'consumed' | 'refused', authorizationId: string, content: unknown): Promise<boolean> {
    if (!z.uuid().safeParse(authorizationId).success) throw new OperatorError('invalid_id', 'An authorization id must be a UUID.');
    const dir = join(this.dir, kind);
    const temp = join(dir, `.${authorizationId}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(content)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temp, join(dir, authorizationId));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    } finally {
      await rm(temp, { force: true });
    }
  }

  // The single-supervisor lock: a second supervisor of this user fails with "locked".
  async supervisorLock(): Promise<() => Promise<void>> {
    return acquireLock(join(this.dir, 'supervisor'), 'Software Factory supervisor');
  }
}

