# SF-009 runbook: approve once in ChatGPT, review in ChatGPT

> **Current status (2026-10-29, job `sf009-context-continuity-20261029`).** Evidence matrix:
> `review/SF-009/context-continuity-20261029/EVIDENCE.md`.
> - **Active runtime:** the supervisor and the bridge run from the canonical `bridge/dist`
>   (built 2026-10-29 09:21 UTC) as transient systemd user units; no unit file is installed.
>   Policy epoch 5; `sf009-self-fix` is enabled for self-hosting on the main checkout
>   (`self_hosting_unconfined`, no sandbox). Real Claude Code 2.1.312 sessions run through it in
>   `--permission-mode auto`; since that activation, two self-hosted jobs were reviewed and accepted.
> - **Observer (updated 2026-10-31):** the read-only observer (`observe`) is in the canonical
>   `bridge/dist` and runs through `scripts/sf009-executor.sh observe` (below).
> - **Operator-supplied probe results:** sequential and overlap protocol probes PASS with Claude
>   Code 2.1.312 (`review/SF-009/INTEGRATION-20261029.md`).
> - **Real `compact`, verified once (2026-10-29, this job):** the supervisor recorded the
>   ChatGPT-requested compact `performed` (its condition: `compact_boundary` plus a completed
>   `result`), with the same session, process, launch claim and tree; ChatGPT then reviewed the
>   next correction, published as a normal snapshot from the same session.
> - **Real `reset`, verified once (2026-10-29, this job):** the supervisor recorded the
>   ChatGPT-requested reset `performed`: a new Claude process and a new session id in
>   `session_lineage`, under the same job and launch claim, with the tree unchanged; ChatGPT then
>   reviewed the next correction, published as a normal snapshot from the new session. The reset
>   gate hand-over stays non-atomic (design §5).
> - **UNVERIFIED:** that a real session reads the continuation note itself after a compact or a
>   reset (no independent evidence).
> - **Open:** OS isolation, the R3-5 approval ambiguity, a proactive ChatGPT trigger.
>
> The integration note of 2026-10-29 recorded host checks and runtime activation as pending;
> the runtime has since been activated as above. Sections below keep their original review
> snapshots and are historical.

*Original note (2026-10-27, historical; see the current status above):* **Nothing here is installed or enabled yet.** Every setup step below is a one-time operator decision. A real Claude run through this path needs a separate, operator-approved pilot first (see the report).

## Day to day, once set up

| Step | Before (SF-006/SF-007) | With SF-009 |
|---|---|---|
| Approve the job | In ChatGPT, then again in a terminal (`a` in the console) | **Once, in ChatGPT** (`factory_authorize_execution`) |
| Start Claude | Console or `prepare`/`run` per job | The supervisor starts it: one session, `--permission-mode auto` |
| Tool prompts | Answer each one | None: auto mode decides. Refusals are reported as `needs_operator` |
| Finish a round | `/exit`, then "Did /implement finish?" | Nothing: Claude's turn ends and a snapshot is published while the session stays alive |
| Review | Tell ChatGPT to read the exported files | Tell ChatGPT "review job X". It reads the snapshot and sends findings to the same session |
| Context | Not possible | ChatGPT asks for `compact` or `reset` at a review boundary |
| Close | Collect | Say "accept" in ChatGPT (`factory_accept_job`), or run `scripts/sf009-executor.sh accept --app <app> --job <job>` yourself. The supervisor ends the session and collects. Git stays yours |

**What stays manual:**
- telling ChatGPT to review: it cannot be woken by the supervisor (design §8);
- staging, committing and pushing;
- reacting to `needs_operator` and `needs_inspection`.

## One-time setup (operator decisions)

1. **Build:**

   ```bash
   (cd bridge && npm run build)
   ```

2. **Register the app** as in SF-006 (`factory-data/apps/<app>/.env`, `mkdir -m 700`). The app directory must not be writable by group or others.

3. **Opt in for that app, only if it is a disposable pilot:**

   ```bash
   scripts/sf009-executor.sh enable --app <app-id> --disposable-pilot [--protect /path/of/another/checkout]...
   ```

   **Production automatic execution is not supported** (Review 01): no OS sandbox confines the session, so `enable` without `--disposable-pilot` is refused (`unsupported_isolation`) and nothing is enabled. With it you declare that the app's repository is a disposable checkout and that the session, which runs as you, can reach no real credentials and no other writable checkout. Never declare a real application this way. A policy enabled before Review 01 has no such declaration: its jobs are refused until you run `enable --disposable-pilot` again (which raises the epoch).

   It shows what it allows and asks `y/N`. It binds:
   - the app's current repository (by sha256 of its real path);
   - the installed Claude Code (path and version);
   - optional protected checkouts, which are checked at every turn end.

   It publishes `factory-data/apps/<app>/executor-policy.json`, with no paths or salt. To withdraw: `disable --app <app-id>`, or `disable` for everything. Either raises the policy epoch, so earlier authorizations stop working.

4. **Run the supervisor,** either way:
   - **in a terminal:** `scripts/sf009-executor.sh run` (Ctrl+C stops it, and also ends an active session as `needs_inspection`);
   - **as a user service** (optional): `scripts/sf009-executor.sh render-unit <new-dir>` writes `sf009-supervisor.service`. Installing it (`~/.config/systemd/user/`, `systemctl --user enable --now …`) is your decision; this task did not do it.

**Checks before relying on it:**
- `scripts/sf009-executor.sh status` shows the opt-in and, per job, what runs where (below, "Watching a job");
- ChatGPT's `factory_execution_status` shows `supervisor.online: true` and `supervisor.scan.complete: true`;
- `status` lists the app with `isolation disposable_pilot`.

## Self-hosting: Software Factory working on this checkout

A separate, operator-controlled opt-in for one app whose `APP_REPO` is **this Software Factory checkout itself** (the main checkout you work in). It is not a disposable pilot and not a sandbox: the policy shows `isolation self_hosting_unconfined`. Every other app keeps the rules above.

**What it changes, and only for that app:**
- `APP_REPO` may be the mediator checkout (exactly its real path). A repository inside it or containing it stays refused.
- Your uncommitted work stays where it is. `prepare` records a **baseline** of it: the content sha256 of every path whose state differs from HEAD (tracked changes, staged additions, untracked files), privately in `factory-data/apps/<app>/.env.sf006-preexisting-<job>` (0600), bound by its sha256 in `execution.json`. Hashes only: nothing is copied, stashed, restored or committed.
- The launch requires HEAD, the index and every baseline path to be unchanged since `prepare` (`repo_changed` otherwise), and the baseline file to be the recorded one (`baseline_invalid`).
- Every snapshot and the final export leave unchanged existing work out of the diff. A header names how many paths existed, and which ones the session **changed** (their diff is against HEAD and includes your earlier work) or **reverted/removed** (`existing_work_removed`: the earlier content cannot be restored by Software Factory).
- The mediator's own state (`factory-data/`) is left out of the job's tree identity and exports; the session gets `Read/Edit/Write(factory-data/**)` deny rules on top of the usual ones (prefix rules: a shell can still reach it).
- Authorization binding, the one launch per job (`launch.claim`), the shared session gate, the snapshot integrity checks and the separate final acceptance are unchanged.

**Protected checkouts and the main checkout.** The policy's global `protected_paths` is never changed by self-hosting. If it names this checkout (for example `--protect <main-checkout>`, given when a pilot was enabled; `<main-checkout>` stands for the real path of this checkout, as `pwd -P` prints it at its root), the main checkout stays protected while any other app runs: a pilot that changes it still ends `protected_checkout_changed`. Only a verified self-hosted job is exempt, and only from its own repository: the entry whose path equals the job's verified `APP_REPO`, the session's repository and the resolved mediator root, all three exactly (no prefix, trailing-slash, ancestor or descendant match). The remaining entries are frozen when the session starts and exactly those are rechecked at every turn end, capture and handoff. Baseline, Git-control, snapshot and acceptance checks are unchanged; a Git operation in this checkout is still `git_operation_detected`.

**Activation guard for protected paths** (operator check around `enable --self-hosting`; the command itself only checks newly given `--protect` paths):
1. Before enabling, record the full list: `jq -c .protected_paths ~/.local/state/software-factory/executor/policy.json`.
2. Every entry is compared with the real path of this checkout (`<main-checkout>`: run `pwd -P` at the root of this checkout):
   - an entry **exactly equal** to it is permitted for this reviewed self-hosting case and **stays in the list** (it keeps protecting the main checkout from every other app);
   - any **other overlapping** entry (an ancestor of this checkout, a directory inside it, or a spelling that is not the exact real path) stops the activation: it would protect the self-hosted job's own repository under another name, and it is not exempt;
   - entries that do not overlap stay as they are.
3. After enabling, record the list again: it must be **identical** to step 1 (same entries, same order). Any difference stops the activation.
4. Do not pass `--protect` for this checkout to `enable --self-hosting`: it is refused (`A protected path overlaps the application repository`).

**Rules while it is enabled:**
- Do not edit this checkout while a job is authorized or running: your edits would count as the session's, or stop the launch.
- A job may change `bridge/src`, rebuild `bridge/dist` or run the tests. Nothing reloads the running supervisor or bridge: such changes take effect only when **you** restart them, after you reviewed and accepted the job.
- Staging, committing and pushing stay yours.

**Enable** (asks `y/N`; refused if `APP_REPO` is not this checkout, or another app holds self-hosting):

```bash
scripts/sf009-executor.sh enable --app <app-id> --self-hosting
```

It writes `~/.local/state/software-factory/executor/self-hosting.json` (the app id, the sha256 of this checkout's real path, the declaration `operator_controlled_unconfined`) and the policy entry, and raises the epoch. **Withdraw** with `disable --app <app-id>` (or `disable`): the opt-in record goes with the app. A self-hosting policy entry without its opt-in record is refused at launch (`self_hosting_not_enabled`).

## Watching a job

```bash
scripts/sf009-executor.sh status [--app <id>] [--job <id>] [--all]
scripts/sf009-executor.sh watch  [--app <id>] [--job <id>] [--all] [--interval <seconds>]
```

Read-only (no lock, no signal, no write). For the supervisor: running or not, its pid and start time from its lock, the heartbeat age. For each active job (or the latest one; `--all` for every job):

| Line | Shows |
|---|---|
| `Discovery` (header) | `complete`, or `INCOMPLETE` with coded issues (`jobs_not_directory`, `app_limit`, `enumeration_race`, `job_unreadable <app>/<job> (<code>)`, …). With incomplete discovery, "no jobs" is never claimed |
| `repository` | The job's repository, only when verified against what the job was authorized for (the repository sha256 of its consumed authorization, or its salted `repo_identity`), and whether it is this Software Factory checkout or a separate one. If `APP_REPO` changed since, the live Claude process's working directory is shown when it matches; otherwise the repository is `unknown` |
| `registered now` | Only on a mismatch: where `APP_REPO` points now, marked as **not** this job's repository |
| `read error` | Only for a job whose records cannot be read (`state unreadable`): the error code |
| `isolation` | `disposable_pilot`, `self_hosting_unconfined` or `none` |
| `state` | `managed.json` state, or `authorized` before the supervisor recorded the job |
| `iteration` | The current iteration, its state and trigger, how many so far |
| `claude` | The session id and the Claude process (pid, start time, alive or not) |
| `last activity` | The latest of: Claude Code writing its session transcript, the job record changing |
| `last event` | The last `managed.json` event and its detail |
| `waiting for` | What the job waits for: the gate, Claude, a stable boundary (`snapshot_waiting`), your review or acceptance, or you (`needs_operator` code and message) |

Host paths appear only in your terminal. `watch` refreshes every 2 s; Ctrl+C stops only the watch.

### Observing the Claude session

```bash
scripts/sf009-executor.sh observe --app <id> --job <id> [--once]
```

The observer is a separate, read-only Node process: using it needs no restart of the supervisor or the bridge, and it may run during a job. The earlier standalone validation build was removed on 2026-10-31 (job `sf010-repository-cleanup-20261031`); older review packages that name it are historical.

Shows what the job's managed Claude session is doing, in your terminal only. First a header: app and job, the job's repository (as `status` verifies it), the managed session id, the state and what the job waits for. Then the session's Claude Code transcript as readable text: `user:` and `assistant:` text, `tool call <name>: …` and `tool result: …` (`(error)` when the tool failed, `(subagent)` for subagent records); system, meta and thinking records are not shown. It prints the last 40 entries (from at most the last 512 KiB of the transcript) and then follows new records every 0.5 s. Each record is printed once, also when the transcript is re-read. `--once` prints the header and the history and exits. Exit status 1 means the job does not exist, or its repository is not verified.

- **Which transcript.** The transcript is read only in the repository verified against the job's authorization binding, under the session id that `managed.json` names as current. If `APP_REPO` now names another repository and the job's repository cannot be verified, the observer says so and reads nothing; the current registration is never used instead. After a context reset (a new managed session), whatever the previous session wrote last is printed, then a `==== the managed session changed (reset) ====` separator, and then the new session is followed. The transcript directory is `$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects` when that variable is not set. This is the same rule `status` uses, and Claude is not asked. So run the observer with the same `CLAUDE_CONFIG_DIR` as the supervisor; otherwise it reports "no transcript yet". A transcript larger than 256 MiB, which `status` does not look at, is still followed from its end.
- **Notices** (lines starting with `--`): no managed session yet; no transcript yet; transcript missing, unreadable (with its code), truncated or replaced (its last 512 KiB at most are read again; records already shown are not printed again); earlier content or entries not shown; a record longer than 1 MiB skipped; a line that is not JSON skipped; with `--once`, an incomplete last record not shown yet; changes of state, waiting reason or repository.
- **Bounded.** A text, tool input or tool result is clipped at 2000 characters, with `… [truncated: N more characters]`. Each poll reads at most 4 MiB, and an incomplete line waits until it is complete, so a partial UTF-8 sequence is never decoded. Output waits for its reader: while the terminal or pipe does not take it, nothing more is read (Ctrl+C still ends the observer). Terminal control characters from the transcript are printed as inert text: ESC as `^[`, other C0 controls in caret notation, C1 and bidirectional controls as `<U+XXXX>`.
- **Read-only.** The observer does not start or invoke Claude, send input, take the session gate or any lock, signal another process, or write or create anything (not even a missing state directory). Ctrl+C (or SIGTERM) stops only the observer: the session and the job are not affected. Nothing more is written to its output after that, it prints `stopped` on stderr, and the observer process ends within 2 s even when its output pipe is not being read (output not yet taken is dropped). A second Ctrl+C ends it at once. Transcript content stays in your terminal. Nothing of it reaches ChatGPT, the bridge or an MCP tool.

## What ChatGPT does (tools)

1. `factory_write_instruction`, then `factory_request_dispatch` → `accepted` (SF-005, unchanged).
2. `factory_execution_status` → `policy.repo_identity` and `policy.policy_epoch`.
3. **After you explicitly approve running the job:** `factory_authorize_execution`, with the request id, the sha256, `repo_identity`, `policy_epoch`, `permission_mode: "auto"` and a new `authorization_id`.
4. `factory_execution_status` until `awaiting_review` (or `needs_operator`, `blocked`, …). `authorized`/`pending_supervisor`/`scan_incomplete`/`queued` are never "started".
5. `factory_list_review_ready` → `factory_review_snapshot`; read the diff with `factory_read_file`. If the listing says `complete: false`, ready jobs may be missing from it.
6. `factory_submit_review` with findings, bound to `iteration_id` and `snapshot_sha256` → the next iteration.
7. Optionally `factory_manage_session_context` (`compact` or `reset`, with `current_session_id`). Real `compact` has been verified once (2026-10-29); real `reset` has been verified once (2026-10-29); see "Verifying compact and reset on a real session".
8. **After you explicitly accept:** `factory_accept_job` → `closed`.

### Verifying compact and reset on a real session

Only ChatGPT requests these, at a verified review boundary; the managed session never starts them. Check with `status --app <id> --job <id>` (and `observe`) and record the facts in the review package.

| Action | Verified only if |
|---|---|
| `compact` | the context request is `performed` after a `compact_boundary` and a completed `result`; the session id and Claude process are unchanged (no new lineage entry); the tree is unchanged; the next review reaches the same session and its correction is published as a normal snapshot |
| `reset` | the old process is confirmed ended and a new one started (other pid and start time); `session_lineage` lists both session ids under the same job and `launch.claim` (no new job, claim or authorization); the new process reported `permissionMode: auto` and completed its first `result`; the tree is unchanged; the next review reaches the new session and its correction is published |

The reset hand-over of the session gate is **not atomic** (design §5): another gated launch can take the gate in between (`reset_incomplete`, or a later `conflict`). On any failure, or doubt about ownership, publication or state, stop and inspect; do not retry around a guard.

## Statuses and what to do

| Status / code | Meaning | Do |
|---|---|---|
| `needs_operator`, supervisor offline | Authorized, but nothing runs it | Start the supervisor |
| `needs_operator`, not enabled | No opt-in for this app | `enable --app` (once) |
| `queued` / `session_busy` | Another Software Factory Claude session holds the gate | Wait; it launches while the authorization is valid (30 min) |
| `blocked` / `repo_dirty`, other preflight codes | A check failed; nothing was claimed | Fix it; it is retried while the authorization is valid |
| `blocked` / `authorization_expired`, `stale_policy`, `repo_mismatch` | The authorization cannot be used | ChatGPT authorizes again (new id) |
| `needs_operator` / `auto_mode_refused` | Auto mode refused actions (names listed); the work continued without them | Review; send findings or decide yourself |
| `running` / `snapshot_waiting` (Review 02) | Claude's turn ended, but a process of the session still runs, a background task is open, Claude still writes output, or the tree still changes. The message names counts and command names | Wait. Nothing is stopped for you; the snapshot is published once the boundary is quiet |
| `needs_operator` / `snapshot_failed` | No first snapshot of this iteration was published. Nothing was published and nothing was stopped. The message names the last reason (e.g. `1 process(es) (node) started by the session still running`). If it ends with `The supervisor publishes one snapshot of this iteration once the blocker is gone`, the bound on the wait (20 min) ran out and **initial publication recovery** is active (see below). Without that sentence the failure is permanent and is not retried: the boundary did not hold until publication, or the files could not be inspected or written | Find the process (`ps -eo pid,lstart,comm` and `grep -l SOFTWARE_FACTORY_MANAGED_SESSION /proc/*/environ`), decide yourself whether to stop it, or stop the supervisor. In recovery, that is all it takes: the snapshot follows. After a permanent failure, inspect and end the session |
| `needs_inspection` / `conflict` with reason `snapshot_artifact_invalid` (Review 02) | A review or acceptance named a snapshot whose diff or report no longer matches its sha256 (changed, replaced by a symlink, missing, or another file named) | Inspect the job directory; the request was not sent and nothing was accepted |
| `needs_operator` / `late_turn_refused` | After the snapshot was published, Claude answered again on its own and reported refused actions (listed in `blocked_actions`, inputs not echoed). That snapshot cannot be accepted (`late_refused_actions`) | Send a review; the next iteration gets a fresh snapshot |
| `needs_operator` / `late_turn_error` | After the snapshot was published, Claude reported a failed turn (result subtype only). That snapshot cannot be accepted | Send a review asking for a correction |
| review or acceptance pending while Claude is active | Claude produced output, a late turn end or an open task after the snapshot was published. The request is not rejected: the supervisor waits for a new quiet window (`boundary_requiesced` in the events), then handles it | Wait |
| `needs_operator` / `boundary_unstable` | Claude did not become quiet within the bound after publication (reason in the message); requests stay pending, and the supervisor keeps trying. This is re-quiescence of an already published snapshot, not initial publication recovery | Inspect the session's processes; stop the supervisor to end the session |
| review outcome `sending` / `unconfirmed` | `sending`: recorded, the message is being handed to Claude Code. `unconfirmed`: it was never acknowledged (the write failed, there was no echo within 60 s, the session ended or the supervisor restarted); it is never re-sent | For `unconfirmed`, inspect the job; the session has ended |
| `needs_inspection` / `turn_correlation_unavailable` or `review_not_delivered` | A review was not acknowledged in time, or could not be written; nothing was published from it | Inspect; a new job id continues the work |
| `session_ending` (status) | The session is shutting down, or its exit was observed and it is being collected. Requests are refused | Wait for the final state |
| `session_process: unconfirmed` | The shutdown finished without an observed exit: the process may still run. The diagnostic keeps the original cause and adds `session_not_ended` | Find and end the process yourself, then inspect the repository |
| `needs_operator` / `turn_correlation_unavailable` | This Claude Code did not acknowledge its first message (`--replay-user-messages`), so the answer to a review cannot be told from a late result. Reviews and compactions are refused | Accept the snapshot or end the session; check the Claude Code version |
| acceptance `late_result_during_acceptance` | A late result arrived while the acceptance was being recorded; it was withdrawn before anything was collected | Review the iteration again |
| `needs_operator` / `reset_incomplete` | The gate was taken between the end of the old process and the start of the new one | Request the reset again later |
| `needs_operator` / `supervisor_restarted` | A predecessor's session is still alive; it ends on its own (its input closed) | Wait; it is then collected for inspection, never relaunched |
| `failed` / `auto_mode_unavailable` | Claude Code did not run in auto mode (plan, model, settings or fast mode) | Fix that; use a new job id |
| `needs_inspection` / `git_operation_detected` | HEAD, index or Git control files changed | Inspect the repository yourself; nothing was repaired |
| `needs_inspection` / `conflict` | The tree changed while a review was pending; the review was not sent | Inspect; use a new job id |
| `needs_inspection` / `protected_checkout_changed` | A protected checkout changed | Inspect both checkouts |
| `blocked` / `repo_changed` (self-hosting) | Your existing work, HEAD or the index changed between `prepare` and the launch; nothing was claimed | Use a new job id once the checkout is as you want it |
| `blocked` / `baseline_invalid` | The private baseline of the existing work is missing or not the recorded one | Inspect `factory-data/apps/<app>/`; use a new job id |
| `blocked` / `self_hosting_not_enabled` | The app is allowlisted for self-hosting, but the separate opt-in record is missing | `enable --app <app> --self-hosting` again, then ChatGPT authorizes again |
| `needs_operator` / `existing_work_removed` | The session reverted or deleted paths that held your uncommitted work (named in the snapshot). Their earlier content was not copied | Inspect the checkout (your editor's local history, backups) before reviewing or accepting |
| `blocked` / `unsupported_isolation` | The app is not enabled as a disposable pilot (or the policy predates Review 01); nothing was consumed | Only for a disposable app: `enable --app <app> --disposable-pilot`, then ChatGPT authorizes again |
| `blocked` / `approval_interrupted` (Review 02) | An earlier approval step of this authorization did not complete (a crash, or a caught failure whose refusal could not be written). It is never resumed; a pending approval is withdrawn | ChatGPT authorizes again with a new id |
| `blocked` / `wrong_status`, `conflict`, `approval_*`, `invalid_record` | The SF-007 approval step failed (a console rejection, a pending console approval, a cancelled or expired approval, an unverifiable record). The authorization is used up (`refused/<id>`); nothing was launched | Resolve the cause in the console, then ChatGPT authorizes again with a new id |
| `scan_incomplete` | Authorized, but the supervisor's last discovery scan was incomplete (`supervisor.scan.issues`): the job may be outside what it sees | Fix the listed issue: unreadable or symlinked `factory-data/apps/<app>` or `jobs` directories, or too many apps/jobs (archive old job directories). The supervisor log says `SCAN INCOMPLETE` |
| `needs_inspection` / `acceptance_drift` | The repository changed between the final acceptance and the collection (a late or background write, a changed index or HEAD). The accepted snapshot is unchanged; the collected artifacts show what is there now | Compare `implementation.diff` with the accepted snapshot's diff; inspect the repository. It is not `completed` |
| `failed` / `auto_mode_unavailable` right after launch | Claude Code reported another permission mode in its first event and was stopped at once | Check plan, model, `disableAutoMode` and fast mode; use a new job id |
| `needs_inspection` / `turn_correlation_unresolved` (Review 03) | A result arrived before Claude Code acknowledged the review, so it was not taken as the answer. After the acknowledgment, no further result came while Claude showed no progress for `correlationIdleMs` (10 min), or within `correlationTimeoutMs` (4 h). The review stays `delivered` (it was acknowledged) with reason `turn_correlation_unresolved`. Nothing was published; the gate is free | Inspect the repository; a new job id continues the work. If it recurs, run the protocol probe (below) |
| event `handoff_deferred` (Review 03) | A process of the session (or one that cannot be ruled out) was running when a review or acceptance was about to be handed over. The request stays pending until a new verified quiet window. The detail names the code (`session_writers`, `unattributed_processes`, `process_scan_incomplete`), pids and command names | Wait. If it turns into `boundary_unstable`, see below |
| `boundary_unstable` or `snapshot_failed` with `[unattributed_processes]` (Review 03) | A same-user process started during the session whose environment cannot be read. It is not proven to be the session's, but it is not ignored either. The message lists `pid <n> <command>` | Inspect it (`ps -o pid,lstart,comm -p <pid>`). If it is unrelated and can be ended, end it yourself: a pending request is then handed over at the next quiet window. Otherwise stop the supervisor to end the session |
| `[process_scan_incomplete]` (Review 03) | `/proc` could not be listed or read completely (or more than 50,000 processes) | Check the host; nothing is published or handed over until a scan completes |
| acceptance rejected `handoff_session_writers` / `handoff_unattributed_processes` (Review 03) | A process was found right after the acceptance was recorded; it was withdrawn before anything was collected | Wait for the quiet window, then accept again |

**Recovery rules:**
- A claimed job never launches again (SF-006).
- A supervisor restart never relaunches. It waits for a live predecessor session, then collects it (`interrupted`, or `completed` if the acceptance had been recorded) and marks it for inspection.
- An authorization is used once. After a restart or a retried poll, only an SF-007 approval named in `consumed/<id>` that is **already consumed** lets the launch proceed (Review 02); an unconsumed one is never resumed (`approval_interrupted`). A failed step is recorded in `refused/<id>`, in `managed.json` (`approval_failed`) and in the supervisor's memory, and never retried.
- An acceptance is `completed` only if, after the result files were written, no process of the session runs and the tree and diff are still the accepted ones (Review 02); otherwise `acceptance_drift`. This narrows the race but is no atomic guarantee: nothing confines another same-user writer.
- The private state lives in `~/.local/state/software-factory/executor/`: `policy.json`, `consumed/`, `refused/`, `supervisor/execution.lock`. A `consumed/<id>` written before Review 01 (no approval id) fails closed. The audit log is SF-007's `operator/events.jsonl` (`source: mcp_authorization`).
- The session gate, the per-job lock and their recovery are unchanged: see `docs/runbooks/SF-007-local-operator.md`.

### Initial publication recovery and re-quiescence

Two recoveries, for two different states:

| | Initial publication recovery | Re-quiescence |
|---|---|---|
| When | The first capture of an iteration ran out of its wait: no snapshot exists | Activity after a snapshot was published |
| Shown as | `needs_operator` / `snapshot_failed` | `needs_operator` / `boundary_unstable`, event `boundary_requiesced` on success |
| Evidence | Publishes one new snapshot of the same iteration | Publishes nothing: the published snapshot stands and the tree must still be its tree |
| Requests | Stay pending: nothing can bind yet | Stay pending, then are handled |
| A further turn end | Joins the iteration: its refused actions add up and a failed turn stays recorded in the snapshot (event `publication_turn`) | Recorded as a late turn, or opens a continuation if the tree changed |

Initial publication recovery lasts only while the same supervisor drives the same live session. Each poll checks that `managed.json` still shows that session as alive and that iteration as failed with no snapshot, then scans for processes of the session. It publishes through the complete capture: scope, Git and protected checkouts, processes, tasks, output, a full quiet window and the stable tree. It sends Claude nothing and consumes no authorization. A wait that runs out again is not a new failure: the event is `publication_recovery_waiting`, and the message changes only if the reason did.

It ends without publishing when the session exits, the supervisor stops or restarts, a permanent capture failure occurs, or ownership is in doubt (event `publication_recovery_stopped`, with `session_not_owned`, `iteration_changed` or `managed_record_unreadable`). The status then stays honest: an ended session shows how it ended, and otherwise `needs_operator` keeps its diagnostic and the session stays alive until the operator stops the supervisor.

Ownership is checked again on the record the snapshot would be saved to, so a change during the capture also stops it: the unreferenced capture files are removed and nothing is marked ready. After `publication_recovery_stopped` the iteration stays held: requests stay pending, no continuation opens and nothing publishes, whatever Claude does. Later turn ends are still checked for mode and scope, and each shows only as a `publication_turn_unrecorded` event. Only ending the session resolves it.

An open task or Claude output during recovery restarts the normal boundary. A task reported after the failure means Claude is no longer at a turn end, so publication waits for an actual further result; if none ever comes, the job stays `needs_operator`.

## Integration requirement: the real Claude Code replay protocol (Review 03)

Managed sessions pass `--replay-user-messages` and `--include-partial-messages` (static reading: Claude Code holds the echo until the first model output of the turn; the second flag makes that the first non-ping stream event, with no guaranteed time) and attribute every result by the echoed uuid (`stream-session.ts`). The fake Claude in the tests proves only the fake.
- **Recorded:** the installed Claude Code 2.1.312 lists the flag (`review/SF-009/review03/logs/cli-capabilities.log`). That is flag presence only.
- **UNVERIFIED:** the live event shape, the order of the echo and the `result`, and the process lifetime. The probe below has **not** been run.

**Do not install the Review 02/03 candidate into the mediator before the probe passes.**

*Later (2026-10-29):* the operator ran both probes with Claude Code 2.1.312 and supplied the results: sequential and overlap `PASS`, mode `auto`, exit code 0 (`review/SF-009/INTEGRATION-20261029.md`). That satisfies this requirement **for 2.1.312 only**; run both probes again before relying on another Claude Code version. The bullets above are the original Review 03 state.

1. **When.** Only after the current managed session has ended and no other Software Factory session runs. The probe takes the same session gate and is refused while it is busy. Never run it from inside a Claude Code session; it refuses that too.
2. **Where.** Run it from the operator terminal in a new empty directory outside every checkout: `mkdir -m 700 /tmp/sf009-probe-$(date +%s)`.
3. **What.** Run `scripts/sf009-executor.sh probe-protocol --dir <that dir>`, then the same with `--overlap`. Each run starts one Claude Code process with the managed flags in `--permission-mode auto`, using your normal Claude Code login. It sends two messages asking for a one-word reply and no tool use.
4. **Result.** It prints JSON with the event shape only (no text, prompt, transcript, stderr, id or path) and exits 0 on `PASS`, 3 on `FAIL`, 4 on `gate_unresponsive` (Review 04) or on a thrown `launch_unconfirmed` or `gate_unresponsive` (Review 05), 1 on any other error.
   - **Required:** `PASS` in sequential mode.
   - In `--overlap` mode, `acks_in_order` must pass. Record the `order` line: it shows whether a message sent during a turn is acknowledged before or after that turn's `result`. If after, expect `stale_turn` events, and occasionally `turn_correlation_unresolved`, when a review races a late result.
   - Review 04: `shutdown` must be `exited` with `exit` `{ "code": 0, "signal": null }`. A `sigterm` or `sigkill` end, a nonzero code or an unconfirmed exit is a `FAIL`.
   - `failure.code` `first_result_timeout`: no answer to message 1 within 120 s. The second message was **not** sent; the process was shut down. Record it as a `FAIL`; do not re-run it as `--overlap` to get a `PASS`.
   - `failure.code` `gate_unresponsive`: the process did not end after its input closed, then 10 s after SIGTERM, then 5 s after SIGKILL. Or its identity could not be confirmed, so it was not signalled. The gate was **not** released. The command prints the report and a `gate_unresponsive` line on stderr and exits with code 4 by itself, leaving that process (and its gate) running. It neither signals the process further nor releases the gate. Find and end the holder yourself (see "The gate stays busy"), then check `status` before anything else.
   - Exit code 4 **without a JSON report** (Review 05): the probe ended in an error while a process it started may still be alive, for example a hand-over to Claude Code that was not confirmed (`launch_unconfirmed`), or a gate helper that could not be shown to have stopped (`gate_unresponsive`). Stderr shows the coded message and a line saying that the command exits without releasing the gate or signalling anything. Treat it like the case above: the gate may still be held (if the coded message says the helper was stopped and the gate is free again, `status` confirms it). Find and end any holder yourself (see "The gate stays busy"), then check `status`. It is never a `PASS`.
5. **Evidence.** Attach both JSON outputs to the review package. Remove the directory afterwards.

A `FAIL` on `ack*` means reviews would end `turn_correlation_unavailable`. Do not integrate; record the CLI version and the output.

## Boundaries

- **Not a sandbox; disposable pilots, or the explicit self-hosting opt-in, only.** Auto mode's classifier and the Git deny rules act before a tool runs, but the deny rules are command prefixes (`git -C . push`, wrappers, aliases and scripts pass them). The supervisor detects Git and protected-checkout changes at every turn end, after they happened (a push has already reached its remote). Nothing confines the session's filesystem, credential or network access. Design §6 lists exactly what is enforced.
- **Directory modes.** On this host `factory-data` and `factory-data/apps` are `0775` with a private user group; the supervisor requires only that they not be world-writable. `chmod g-w factory-data factory-data/apps` closes that residual gap.
- **The legacy paths are unchanged:** the SF-006 CLI and the SF-007 console keep working. All paths share one session gate.
