# SF-009 design: one authorization in ChatGPT, auto mode, review iterations in one session

> **Current status (2026-10-29, job `sf009-context-continuity-20261029`).** Evidence matrix:
> `review/SF-009/context-continuity-20261029/EVIDENCE.md`.
> - **Active runtime:** the supervisor and the bridge run from the canonical `bridge/dist`
>   (built 2026-10-29 09:21 UTC) as transient systemd user units; no unit file is installed.
>   Policy epoch 5; `sf009-self-fix` is enabled for self-hosting on the main checkout
>   (`self_hosting_unconfined`, no sandbox). Real Claude Code 2.1.312 sessions run through it in
>   `--permission-mode auto`; since that activation, two self-hosted jobs were reviewed and accepted.
> - **Observer (updated 2026-10-31):** the read-only observer (`observe`) is in the canonical
>   `bridge/dist` and runs through `scripts/sf009-executor.sh observe` (runbook).
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
>   gate hand-over stays non-atomic (§5).
> - **UNVERIFIED:** that a real session reads the continuation note itself after a compact or a
>   reset (no independent evidence).
> - **Open:** OS isolation, the R3-5 approval ambiguity, a proactive ChatGPT trigger.
>
> The integration note of 2026-10-29 recorded host checks and runtime activation as pending;
> the runtime has since been activated as above. Sections below keep their original review
> snapshots and are historical.

**Original status (2026-10-27, historical; superseded by the current status above):** implemented and proven with a fake stream-json Claude only.
- **Not installed:** no service, unit, opt-in or credential was installed, enabled or started.
- **No real Claude:** no real Claude Code session ran through the new launcher.
- **Readiness:** see `docs/reports/SF-009-report.md`.

## 1. The loop

```
ChatGPT ──MCP──► bridge ──writes──► factory-data/apps/<app>/jobs/<job>/
  factory_authorize_execution          authorization.json        (bridge)
  factory_submit_review                review-<id>.json          (bridge)
  factory_manage_session_context       context-<id>.json         (bridge)
  factory_accept_job                   acceptance-<id>.json      (bridge)
  factory_execution_status ◄──reads──  managed.json              (supervisor)
  factory_list_review_ready            iteration-NNN.{snapshot.json,diff,report.md}  (supervisor)
  factory_review_snapshot              continuation-NNN.md       (supervisor)
                                             ▲ polls (no listener)
supervisor (operator's user, one per user, after the one-time opt-in)
  └─ SF-006 runManaged: job lock → session gate (flock) → launch.claim → gate helper exec()s
       claude -p --input-format stream-json --output-format stream-json --verbose
              --permission-mode auto --permission-prompts none --strict-mcp-config
              --session-id <uuid> --name sf-<app>-<job> --disallowedTools <Git operations, sudo, EnterWorktree, .git/**>
     stdin: user messages (JSON lines)   stdout: system/init, compact_boundary, result (turn end)
```

**The central distinction.** Four separate events are recorded separately:

| Event | How it is observed | What it changes |
|---|---|---|
| Claude's turn ends | a stream-json `result` event on stdout (never free text) | the iteration's snapshot is captured; job `awaiting_review` |
| The process exits | the child's exit, observed by the parent | iteration `abandoned` unless accepted; SF-006 collects |
| The task is logically complete | not inferred: Claude saying "done" changes nothing | nothing |
| The operator accepts | an `acceptance-<id>.json` bound to iteration and snapshot sha256 | job `approved`, then the session ends and SF-006 collects → `closed` |

## 2. Phase 0: what the installed Claude Code 2.1.311 can do

Sources: `claude --help`, the subcommand help pages and string constants in the installed binary. Nothing was upgraded. No real session was started, because this instruction does not authorize one.

| Capability | Finding | Used? |
|---|---|---|
| `--permission-mode auto` | Documented choice (`acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`). The binary names four reasons it can be unavailable: "auto mode disabled by settings", "unavailable for your plan" (server circuit breaker), "unavailable while fast mode is on", "unavailable for this model". **Whether it is enabled for this account: UNVERIFIED** (only a real session shows it) | Yes, the only mode |
| How auto mode reports refusals | The print/SDK `result` event carries `permission_denials` (tool name, id, input). The binary also counts `safety_stops` | Yes: summarized as action names only, never inputs |
| `--permission-prompts none` | Documented: with `--print`, anything that would prompt is denied automatically, and the permission mode still decides everything else | Yes: no prompt can deadlock, none is auto-answered |
| `-p --input-format stream-json --output-format stream-json` | Documented realtime streaming input. One process takes several user messages and emits a `result` per turn; it ends when stdin ends | **Yes: the managed session** |
| `system/init` with `permissionMode` | SDK init event (the field is in the binary). Its exact presence and timing in 2.1.311 print mode: **UNVERIFIED with a real run** | Yes: every process must report `auto`, or it is stopped (fails closed) |
| `/compact` in a managed session | `compact_boundary` system events exist in the binary. In streaming input, a user message `/compact …` is the documented slash-command path: **UNVERIFIED with a real run** | Yes: performed only when a `compact_boundary` and a `result` are observed |
| `/clear` in print mode | The string exists. Its effect in a stream-json session is **undocumented** | No: reset is a controlled process replacement (§5) |
| `claude --bg`, `agents --json`, `attach`, `logs`, `stop`, `respawn`, `--resume <id> --bg` | Background sessions exist. `logs` prints *terminal output* (screen scraping). `attach` is an interactive TUI. **No documented reply or message API** for an existing background session | No (rejected, §7) |
| Background worktrees | Setting `worktree.bgIsolation`: `'worktree'` (default) "blocks Edit/Write in the main checkout until EnterWorktree is called"; `'none'` turns that off. It is a *restrictive* setting in the merge rules, so whether a session-scoped `--settings` value of `none` wins over other sources is **UNVERIFIED** | No: the managed session is not a background session; `EnterWorktree` is denied |
| `Stop` hook, `stop_hook_active` | Present. A hook would need settings outside the session (a hook file and a configuration change) | No: the `result` event is the boundary, and no host settings change |
| `--restricted` | Removes Bash and the other code-running tools, and confines the file tools to the working directories | No: `/implement` needs to run tests. Recorded as a stronger option for later |
| Sandbox (`sandbox.*` settings) | Exists in the binary. Not verified on this host | No: **no isolation is claimed** (§6) |

*Later evidence (2026-10-29), Claude Code 2.1.312:* the operator-supplied protocol probes show auto mode available and `permissionMode: auto` in `system/init`; the active runtime has completed managed jobs, which it does only when every process reports `auto`. Later the same day the supervisor recorded one ChatGPT-requested `/compact` in a real managed session `performed` (its condition: `compact_boundary` plus a completed `result`), with session, process and tree unchanged, and the next correction was published normally (job `sf009-context-continuity-20261029`). A real reset was then performed once in the same job (new process and session id, same job and launch claim, tree unchanged); its next correction was published normally from the new session, and the gate hand-over stays non-atomic (§5). The table above is the original 2.1.311 finding.

## 3. Trust boundaries

| Boundary | What is trusted | What is not |
|---|---|---|
| ChatGPT → bridge | An authenticated MCP tool call from the connector. The tool descriptions require an explicit user approval in the conversation | That the person typed the approval: **no signed approval token exists**, and none is claimed |
| Bridge → supervisor | Files in the mediator job directory, written by this user (0600, temp + fsync + link/rename) | Their content: strict schemas; owner and mode checked; no symlinks; the directory chain checked (job, jobs, app: no group or other write; `factory-data` and `factory-data/apps`: no world write); every request re-validated against the supervisor's own state |
| Operator → supervisor | `policy.json` in `${XDG_STATE_HOME:-~/.local/state}/software-factory/executor` (0700/0600, outside the mediator), written only by `enable`/`disable` | Nothing else can enable an app, change its repository binding, the executable or the epoch |
| Supervisor → Claude | The fixed argument list, the executable verified at opt-in (`claude --version`, path), the repository from `.env` | Instruction text and review findings are stdin *messages*: no shell, no argv, no keystrokes into a terminal |
| Claude → repository | Auto mode's classifier and the deny rules | Prompt text. This is **not a sandbox** (§6) |

**What an authorization binds:** `app_id`, `job_id`, the accepted `request_id`, the exact `instruction_sha256`, `repo_identity`, `permission_mode: "auto"`, `policy_epoch`, and a caller-chosen `authorization_id` (the nonce). The bridge adds `issued_at` and `expires_at` (30 minutes).
- **`repo_identity`** is `sha256("sf009-repo\0" + salt + "\0" + realpath(APP_REPO))`. The salt is private, so the identity cannot be reversed or guessed, and no host path reaches ChatGPT.
- **`policy_epoch`** rises with every `enable`/`disable`. An authorization issued under an earlier policy is refused (`stale_policy`).
- **`factory_request_dispatch`** never authorizes anything.

**Forgery and replay:**
- OpenClaw has no access to the host filesystem (unchanged).
- A request, receipt or instruction file cannot authorize: only `authorization.json` with its exact schema can, and only together with the private policy.
- The supervisor has no listener, so a loopback page, another account's listener or a squatted port has nothing to talk to.
- A replay is idempotent (same id, same content) or refused (`conflict`).
- An authorization is consumed once (`consumed/<id>`, exclusive create), then the SF-006 `launch.claim` floor applies. Since Review 01 the marker is only a reservation, never evidence of an approval (below).
- A process of the same Unix user is out of scope, as in SF-007: it could run `claude` itself, or write any of these files. The single-writer rule is enforced by code paths (no MCP tool can name a file), not by the OS. One step is hardened anyway: after a restart, an `approved` record is collected as accepted only when the acceptance request it names still exists and binds the iteration's snapshot.

**Reuse of the SF-007 records.** Every authorization is carried by exactly one SF-007 approval with the same bound tuple (`app, job, request, instruction sha256, sha256(realpath APP_REPO)`). So:
- the job is refused if the operator rejected it in the console, or if a console approval is pending;
- the audit log records `approved`/`consumed` with `source: mcp_authorization` and the `authorization_id`;
- SF-006 re-checks the binding inside the per-job lock (`expected`), exactly as for a console approval.

**The approval transition (Review 01, R1-1).** Nothing is prepared, claimed or launched unless a once-consumed SF-007 approval bound to the same tuple and authorization is proven, on every attempt:

| Durable state found | Action |
|---|---|
| `refused/<authorization_id>` | Refused; never retried. Checked before preflight, so it is never shown as `queued` |
| no `consumed/<authorization_id>` | Write it (exclusive create): `software-factory.authorization-use/v1` with the tuple and a fresh **approval id**. Then create the SF-007 approval **with that id** (same checks under the job lock: no rejection, no pending approval), then consume it |
| use record, no approval with its id | A crash between the two: create it now, under the same checks |
| use record, its approval pending | A crash before consuming: consume it if within the SF-007 TTL, else settle it `expired` and refuse |
| use record, its approval consumed | Proven (a restart after consuming, or a launch retried after a busy gate) |
| anything else | Refused: approval cancelled/expired/refused, another tuple, a use record that is not valid (e.g. a pre-Review-01 marker without an approval id), an unreadable record |

**Residuals, documented:** (1) any unexpected error in the approval step (e.g. an I/O error) refuses the authorization for good, while a crash at the same point is recovered; both fail closed. (2) If an unexpected error occurs after the approval was created *and* writing `refused/<id>` and settling the approval both fail, the next poll would consume that still-pending, correctly checked approval; this needs two failing private writes. Every refusal writes `refused/<authorization_id>` first and settles this authorization's own pending approval as `refused`, so a failed local approval never becomes an approval on a later poll, even if its cause (a rejection, a pending console approval) disappears. ChatGPT can authorize again with a new id once the job is `blocked` (unchanged SF-009 rule). Exactly-once launch still rests on the SF-006 `launch.claim`; the supervisor lock keeps a second supervisor from starting, and the exclusive use record makes competing writers agree on one approval id.

## 4. States

**Job** (`managed.json`; `authorized` is derived when only `authorization.json` exists):

| State | Meaning |
|---|---|
| `queued` | Checks passed and the session gate is busy. Nothing consumed or claimed. Retried every 15 s while the authorization is valid |
| `blocked` | A check refused it (diagnostic code: `repo_dirty` and other preflight codes, `app_not_allowed`, `stale_policy`, `repo_mismatch`, `authorization_expired`, …). Nothing claimed. Non-final reasons are retried while the authorization is valid |
| `launching` | Consumed; preparing and starting |
| `running` | Claude is working on the current iteration |
| `awaiting_review` | Turn ended; a verified snapshot is published; the session lives and holds the gate |
| `needs_operator` | The session lives, but a person should look: auto mode refused actions, a capture failed, a context action failed, or a predecessor's session is still running |
| `approved` | Acceptance received; ending the session and collecting |
| `closed` | Collected after acceptance (`execution.json` `completed`) |
| `failed`, `needs_inspection` | Ended without acceptance; the diagnostic and `execution.json` say why |

**Iteration:** `working` → `ready_for_review` → `changes_requested` (and the next iteration starts `working`), or `accepted`. Also `snapshot_failed`, `conflict` and `abandoned`. A `reviewing` state is **not** tracked: reading a snapshot is passive.

**Legacy records.** `execution.json` stays `software-factory.execution/v1`. Two additions are optional: the session mode `managed`, and `session_lineage` (all session ids under the one claim). No historical record is rewritten. Earlier readers would refuse a new managed record, which is intended.

## 5. Iterations, snapshots, reviews, context

**Turn boundary checks** (all must pass, or the session ends):
- every process reported `permissionMode: "auto"` in a `system/init`, and never anything else. A `system/init` with another mode stops the process **at once** (SIGTERM, before its turn ends): `auto_mode_unavailable` → `failed`, and no other mode is substituted. No read-only pre-launch check of auto-mode availability exists in 2.1.311, so this costs the authorization and the claim. With `--permission-prompts none`, a session in another mode could not get an edit approved before it is stopped;
- the init session id is the launched one;
- HEAD and index equal the baseline, and the Git control files (HEAD file, config, packed-refs, refs, MERGE_HEAD, rebase state) are unchanged (`git_operation_detected` → `needs_inspection`);
- the protected checkouts named at opt-in are unchanged (`protected_checkout_changed` → `needs_inspection`).

**Snapshot capture** (Review 02 replaced the Review 01 "two fingerprints 1 s apart" settle; §9):
1. Wait for a **quiescent boundary**: no process of the session runs, the Claude process writes nothing to stdout and has no background task open, and the tree fingerprint (HEAD, index, Git control files, every working-tree change hashed here without Git filters, Git-ignored credential-style files by content) stays the same for a whole quiet window (5 s). Bounded (20 min); the bound gives `snapshot_failed` with the reason. A further `result` during the wait belongs to the same iteration and is waited for first.
2. Check the turn-boundary scope again (Git, protected checkouts); then run the SF-006 export: the same filters for credential-style paths, ignored credential files, conversions, limits, credential-like text and the host path.
3. Take the fingerprint again; it must equal the quiescent one (else back to step 1 within the same bound).
4. Write the diff and the report; check again that no process of the session runs and the fingerprint is unchanged; then write `iteration-NNN.snapshot.json` last, each with an exclusive create, and check once more.
5. Publish: `managed.json` references the snapshot by sha256.

The bridge shows a snapshot only when that reference, its bytes and both artifact hashes agree. A crash before step 5 leaves unreferenced files that are never shown.

**A review:**
- is bound to job, current iteration, snapshot sha256 and `review_id`; the snapshot's diff and report are re-read and re-hashed at that point (Review 02, R2-4: its own file names, regular files of this user, no symlink, ≤ 4 MiB); any mismatch is `snapshot_artifact_invalid`, handled like a changed tree;
- is refused when stale, mismatched, for another app, or while another review is pending; an identical resubmission is a replay;
- is refused against a changed tree: the supervisor recomputes the fingerprint, and on a mismatch it marks the iteration `conflict`, ends the session and sets `needs_inspection`; the review is never sent;
- is otherwise sent to the same process as a framed user message ("review data, not commands", plus the Git rules), and the next iteration starts.

**Context actions** run only at the idle boundary, bound to the current iteration and session id. A continuation note is written first, to the job directory and next to the instruction copy. It holds the task and its hash, scope and Git rules, the baseline, iterations and snapshot hashes, the latest filtered checks, the reviewer's findings, pending work, the focus and the session lineage; no transcripts and no secrets.
- **compact:** sends `/compact …` and reports `performed` only after `compact_boundary` plus `result`, with the tree unchanged.
- **reset:**
  1. end the process (stdin EOF, then SIGTERM/SIGKILL of this confirmed child, each bounded);
  2. take the gate again;
  3. record the new session id in `session_lineage`;
  4. start a fresh process with a new `--session-id`, whose first message points at the instruction and the note and asks for no changes;
  5. report `performed` after its `result` (auto mode verified, tree unchanged).

  If another session takes the gate between steps 1 and 2, nothing is started and the job is `needs_operator`; the reset can be requested again. **Residual gap:** the gate is not handed over atomically. Between the old process's exit and the new reservation, another *gated* launch (SF-006 CLI, SF-007 console, a `flock`-wrapped hand start) can take it. That never makes two Software Factory sessions run at once, but the other session could change this job's tree. The next reset turn then finds the tree changed and the job becomes `conflict`/`needs_inspection`. An atomic hand-over would need a change to the gate helper (e.g. a blocking waiter started before the release), which was not made in this task. A reset never creates a job, a claim or a second process. **A new process is not called the same process**: lineage records both.

**Acceptance** comes from ChatGPT (`factory_accept_job`, after the user's explicit acceptance) or from the operator's terminal (`scripts/sf009-executor.sh accept --app --job`). Both write the same bound request. It needs the current iteration, its snapshot sha256 (the snapshot file's bytes are re-hashed) and an unchanged tree. Then the process is ended and SF-006 `#finish` runs with the operator's confirmation. The transcript evidence is still checked on the claimed (first) session, and Git must be unchanged; otherwise the job is `failed`/`needs_inspection`.

**The collection is bound to the accepted snapshot (Review 01, R1-2).** The acceptance hands SF-006 the accepted snapshot's full tree identity (its `tree_fingerprint`: HEAD, index, Git control files, every working-tree change by content, ignored credential-style files by content) and the sha256 of the diff the reviewer saw. The acceptance also records the session's live descendant processes. After the Claude process has ended (stdin EOF, then SIGTERM/SIGKILL, bounded), `#finish`:
0. waits up to 10 s for those descendants to end (one still running is drift: it could still write); nothing is killed beyond the SF-006 handling of the Claude process itself;
1. compares the tree with the accepted identity;
2. exports as before;
3. compares the tree again, and the exported diff's sha256 with the accepted diff's.

Any difference is `acceptance_drift` → `needs_inspection`, never `completed`. The artifacts (`implementation.diff` and the rest) still describe what was collected; the accepted snapshot is never rewritten, and the new diff is never presented as the accepted one. A write in either window is caught: by the process while it ends, by a background descendant after it ended (it is waited for), or a changed index or HEAD. **Residual:** a process that is not a descendant at the acceptance (e.g. one that double-forked away earlier, or another program of the same user) and writes after the second check is not seen; the collected artifacts are then still exactly the accepted ones, but the repository is not. A recovery collection after a supervisor restart uses the same check (the accepted snapshot is re-read and re-hashed). A child that ended by signal without changing anything is collected as `completed`; one that changed something is `acceptance_drift`.

## 6. Scope and what is not claimed

**What is enforced before a tool runs, and what is not (Review 01, R1-3):**

| Mechanism | Before execution? | Covers | Does not cover |
|---|---|---|---|
| Claude Code `--permission-mode auto` (classifier) | Yes, Claude Code decides | What its classifier refuses (reported as `auto_mode_refused`) | Anything it allows; it is not a policy this project controls |
| `--disallowedTools` deny rules | Yes, Claude Code enforces them | Exactly the listed tool patterns: `Bash(git <op>:*)` prefixes, `Bash(sudo:*)`, `EnterWorktree`, `Edit/Write(.git/**)`, `Read/Edit/Write(**/.env*)` | `git -C . push`, `git -c … commit`, `git --git-dir=…`, `sh -c`/`bash -lc` wrappers, `env git`, `/usr/bin/git`, Git aliases, scripts, a shell writing `.git/` or reading `.env`, any other executable (tested in `executor-isolation.test.ts`) |
| Turn-end checks (HEAD, index, Git control files, protected checkouts) | **No:** after the fact | Detects commits, staging, ref and config changes (also a push's remote-tracking ref), changes in `--protect` checkouts; ends the session as `needs_inspection` | Prevention: a push has reached its remote, a file outside was written, a credential was read |
| Nothing | — | — | Reads or writes of other files, credentials (`~/.ssh`, `~/.netrc`, tokens), unlisted checkouts, network |

- **Not a sandbox, and production automatic execution is refused.** The session runs as the operator. No OS sandbox (namespaces, seccomp, a separate user, a container) confines its filesystem, credential, Git or network access, and none is claimed. Therefore `enable` refuses every app unless the operator passes `--disposable-pilot`, the explicit declaration that the repository is a disposable checkout and the host session exposes no real credentials and no other writable checkout. The supervisor refuses (`unsupported_isolation`) any app without that declaration, including policies written before Review 01; the bridge refuses to authorize it. The policy view says `isolation: "disposable_pilot"` or `"none"`: an operator declaration, never a sandbox claim. A verified sandbox would be a new isolation value; none is implemented.
- **Enforced by detection, not prevention.** Git operations and protected-checkout changes are detected at every turn end and stop the session; nothing is repaired.
- **Defense in depth, as Claude Code deny rules:** `Bash(git <op>:*)` for `add commit push reset clean stash checkout switch restore rebase merge cherry-pick revert rm mv tag branch config update-ref update-index worktree am pull fetch`, `Bash(sudo:*)`, `EnterWorktree`, `Edit(.git/**)`, `Write(.git/**)`. Prefix rules can be evaded by other command shapes (table above).
- **Auto mode refusals** are reported as `needs_operator` with action names (e.g. `Bash(git commit)`), never inputs. Nothing is approved on Claude's behalf.
- **The user's personal Claude settings** are not touched. Auto mode is passed per process. `--strict-mcp-config` loads no MCP servers. The environment is filtered as in SF-006.
- **The user's own configuration still loads.** Hooks, CLAUDE.md and skills from `~/.claude` load in the session; the personal skill is needed for `/implement`.
- **`.env` deny rules:** `Read`, `Edit` and `Write` of `**/.env` and `**/.env.*`. A shell command can still read them; a changed ignored credential file changes the tree fingerprint and withholds the export.
- **Out-of-scope writes elsewhere** (outside the repository and the protected checkouts) are neither prevented nor detected. Name every checkout that must stay untouched with `--protect`. The other frontend checkout is not added by this task, because it must not be read now.
- **Bounded discovery is reported (Review 01, R1-4).** The supervisor scans at most 100 apps and 5,000 jobs; the bridge lists at most 1,000 jobs per app and 200 ready entries. Each scan or listing reports `complete` and bounded issues (`app_limit`, `job_limit`, `ready_limit`, `apps_/jobs_unreadable`, `apps_/jobs_/app_not_directory` for a substituted symlink, never followed, `job_unreadable`, `enumeration_race`; at most 20, with app ids and counts, never paths). The supervisor publishes its last scan in the heartbeat and logs `SCAN INCOMPLETE` on a change. While it is incomplete (or not yet reported, e.g. by a pre-Review-01 supervisor), an authorized job without a managed record is `scan_incomplete`, never `pending_supervisor`: it is not shown as processed or blocked. A missing apps or jobs directory is a clean empty listing. A job directory that cannot be read keeps the scan incomplete until it is fixed: it could hold an authorization. The host-wide session gate and its own bounds are unchanged.

## 7. Rejected alternatives

| Alternative | Why not |
|---|---|
| `claude --bg` + `attach`/`logs` | No documented way to send a message to a running background session. `logs` is screen output, so state would be scraped. Background sessions fork worktrees by default (`bgIsolation`) |
| A managed PTY typing into interactive Claude | Keystrokes into a TUI, with turn end inferred from screen content. The instruction forbids blind typing, and stream-json gives a protocol boundary |
| `claude -p` one process per turn with `--resume <id>` | Works natively, but every turn would be a new process and a new gate acquisition (a window for another session). Kept as the documented fallback; not needed while streaming input works |
| A `Stop` hook signalling turn end | Needs hook configuration outside the session, i.e. a host settings change |
| A loopback HTTP or Unix-socket API for the supervisor | Same-user IPC adds a listener to defend (SF-007 §6). Single-writer files with strict validation need none |
| Releasing the gate while Claude is idle | The idle session can still write. The gate is held by the Claude process for its whole life (SF-007 §5) |
| Proactive ChatGPT review trigger | No documented, operator-authorized ChatGPT API to wake a conversation was found. Not invented (§8) |

## 8. The remaining gap: ChatGPT is not woken

The bridge is request/response. When a snapshot is ready, nothing tells ChatGPT. The operator says "review the job" (or ChatGPT polls `factory_list_review_ready` when asked). **Fully automatic review is not claimed.**

Everything after that is in ChatGPT and the supervisor: reading, reviewing, sending findings, compact/reset and acceptance. No terminal step is involved.

**Next-action contract** for a future trigger: when one exists, it only has to call `factory_list_review_ready` and `factory_review_snapshot`; no new state is needed.

## 9. Review 02 (2026-10-27): stable boundaries, final-result integrity, approval fail-closed

**Why.** In the Review 01 pilot, iteration-001 was published with `background_processes: 22` while two code-review agents and a full test suite still ran; they wrote 11 more paths afterwards, and ChatGPT's review was correctly refused with `tree_changed`. A stream-json `result` proves only that the foreground turn ended.

**R2-1: the quiescent review boundary** (`bridge/src/executor/quiescence.ts`).
- *Who belongs to the session.* (a) The Claude process's descendants by parent link, and (b) every process of this user that carries `SOFTWARE_FACTORY_MANAGED_SESSION=<session id>` in its environment. `ManagedClaudeRunner` sets that variable; every child inherits it, also one that double-forked or `setsid`-ed away from the tree. Only processes started after the session's first process are read (the tag cannot be older), and only this user's (`/proc/<pid>` owner). Each is known by pid **and** start time, so a recycled pid is never the process that was waited for. Unrelated processes are never counted, signalled or killed.
- *Unidentifiable processes.* A same-user process started during the session whose environment cannot be read is *indeterminate*: a reason to wait, never to publish. A process that refuses the read only while it exits or execs (re-read: gone, zombie, other start time) is not counted; instant checks re-scan for up to 1 s before they count a lasting one.
- *In-process work.* A subagent has no process of its own. Claude Code's stream-json `system/task_started` without its `system/task_notification` (by task id) counts as open work; any stdout line resets the quiet window. **UNVERIFIED** against the installed Claude Code: these event names come from the documented SDK message types; the fake Claude in the tests emits them.
- *Visibility.* While waiting, `managed.json` shows `snapshot_waiting` with the reason (counts and 15-character command names only; no arguments, paths or environment values), at most every 2 s. A timeout gives `needs_operator`/`snapshot_failed` with the last reason. The snapshot records `quiescence: { waited_ms, writers_waited_for, quiet_ms }`.
- *Limits (no OS sandbox).* This is same-user inspection of `/proc`. A process that clears its environment **and** leaves the tree (`env -i setsid …`) is not found; an unrelated same-user program can write at any time. Reading other same-user processes' environments looks only for the one tag string and keeps nothing. The fingerprint checks in steps 3–4 catch a write that lands during the capture; a write after publication is caught when a review or acceptance is bound (`tree_changed`), not prevented.

**R2-2: the final result is checked after its files are written** (`service.ts` `#finish`, `finalDrift`). After `#writeArtifacts` and immediately before a successful state is persisted, `#finish` checks again that no process of the session runs (`ApprovedTree.busy()`, tag-based since the Claude process has ended), that the tree has the accepted identity (HEAD, index, control files, every change, ignored credential files) and that the exported diff is the accepted one. An error is drift too. Drift there gives `needs_inspection`/`acceptance_drift`; the result files are written again to describe that outcome (the exported diff remains the tree as collected, before the change, and says so), and the accepted snapshot is never rewritten. Restart recovery (`collect` with an approved tree) runs the same `#finish`. **Guarantee, stated plainly:** these comparisons narrow the race; they cannot make the final write atomic against an unconfined same-user writer. A hard guarantee needs filesystem confinement of the session (an OS sandbox or a read-only bind of the repository during collection), which this host does not have.

**R2-3: a caught approval failure never approves later** (`supervisor.ts` `#launch`, `#approve`). Two changes:
1. *Protocol.* The approval step (reserve `consumed/<id>`, create, consume) completes only within the attempt that reserved the authorization. A later attempt (a retried poll or a restart) cannot tell a crash from a caught error whose refusal could not be written, so it resumes nothing: a use with no approval, or with a pending approval, is refused as `approval_interrupted` (the pending approval is settled `refused`). Only an approval that is **already consumed** with the same tuple proves the launch after a restart; `launch.claim` keeps it to one launch. This changes two Review 01 recovery cases (crash after the use record, crash after the approval was created) from "resumed and launched" to "refused; authorize again".
2. *Evidence.* A caught failure is recorded in four independent places: the supervisor's memory (never retried by that process), `refused/<id>`, the SF-007 approval settled `refused`, and `managed.json` (`approval_failed: true`, never considered again). Losing any of them to the same fault does not approve; the protocol alone already refuses the pending case.
**Residual:** if the consume step itself reports an error *after* it took effect, and all three durable writes also fail, and the supervisor then restarts, the consumed approval is indistinguishable from a crash after consuming it and launches once.

**R2-4: artifacts verified when a review or acceptance is bound** (`records.ts` `verifiedArtifacts`, used by `#bound`, restart recovery and `factory_review_snapshot`). The snapshot must name its own `iteration-NNN.diff`/`.report.md`; both are read without following symlinks as regular files of this user that nobody else can write, ≤ 4 MiB, and must hash to the recorded sha256. Otherwise the request is rejected (`snapshot_artifact_invalid`), the iteration is `conflict` and the session ends for inspection; nothing reaches Claude and nothing is accepted. `factory_review_snapshot` stays read-only.

**ChatGPT review 1ff34ac1 (fail-open gaps closed):**
- **Output after the quiet window:** the capture keeps the quiet window's output token, and any stdout line before publication discards the capture.
- **`/proc` scan:** a truncated process list, or a same-user (or owner-unknown) process whose stat cannot be read, is indeterminate.
- **Late turns:** refused actions reported by a turn end after publication are added to the iteration (`needs_operator`/`late_turn_refused`). An acceptance of that snapshot is rejected (`late_refused_actions`), while reviews still work.
- **Background tasks:** they are tracked by sha256 of the whole id. Over 1,000 open tasks sets a sticky busy flag for that process.

**ChatGPT review 9a4e25e0 (late results at the commit boundary):**
- **The gate:** a review or acceptance is committed only through `#idleGate`, checked right before and right after its `managed.json` record. A queued late outcome defers it until `#lateTurn` has handled that outcome. An open task, or output since the idle boundary was last known quiet (publication, a handled late turn, a finished context action), rejects it (`session_active`). An acceptance that fails the post-commit check is withdrawn before the process is ended (`late_result_during_acceptance`).
- **Sequence numbers:** every `result` carries a sequence number, and a result received before the last message was sent is never its answer (`stale_turn`; its refused actions stay with the current iteration).
- **Failed late turns:** a late `is_error` result is recorded on the iteration (`late_error`, subtype only), and the snapshot is not acceptable (`late_turn_error`).

**ChatGPT review 97dbc7ac (causality, fence, re-quiescence):**
- **Acknowledged messages:** the managed argument list adds `--replay-user-messages`, a documented 2.1.311 flag. Every user message carries a uuid, and Claude Code echoes it. **Correction (2026-10-30):** the echo is not "once read". Static reading of the installed 2.1.312 and 2.1.314 shows it held until the first assistant message, or with `--include-partial-messages` the first non-ping stream event, so the managed list passes that flag. Stream events are never an acknowledgment. Behavior on a real slow turn is unverified, and no echo time is guaranteed. `session.process` adds `ending` (shutdown in progress, no exit observed) and `unconfirmed` (shutdown finished with no observed exit; the lineage entry stays open). While a session is closing, the gateway reports `session_ending`, lists nothing ready and refuses requests.
- **Attribution rule:** a result answers the latest message only if all sent messages were acknowledged before it. Other results are recorded on their own iteration (`#attributeTurn`) and never complete a new one. With no acknowledgment of the first message, reviews and compactions are refused (`turn_correlation_unavailable`).
- **Review commit:** reviews are gated before and after their record, rolled back on a late outcome (`review_withdrawn`), and sent in the same tick as the check.
- **Publication fence:** the ready record uses the capture's verified quiet token. Output before the record re-captures; output during it is caught because the token, not a later sample, becomes the fence.
- **Re-quiescence:** activity since the last verified window defers requests until `#requiesce` observes a new bounded window (no process, task or output; unchanged fingerprint; scope; the published tree identity). On timeout: `needs_operator`/`boundary_unstable`, with requests pending.
- **UNVERIFIED:** the replay event shape of the real CLI.

**ChatGPT review 9bbf622d:**
- **Acknowledgments:** an acknowledgment is the echo of the oldest unacknowledged message's own uuid, without a tool result. Nothing else counts.
- **Revalidation:** at the commit boundary a request is re-bound (`#stillBound`: snapshot bytes, diff and report, full tree fingerprint) before its record and again after it, before it is sent or the session is ended for collection. A mismatch takes the conflict path.

**ChatGPT review 88e39f51:**
- **Acknowledgment bound:** every message after a process's first must be acknowledged within `ackTimeoutMs` (60 s); otherwise the review is `unconfirmed` and the session ends fail-closed (`turn_correlation_unavailable`).
- **Review outcomes:** `sending`, then `delivered` (echo of that message) or `unconfirmed` (write failed, no echo, session ended, supervisor restarted). A review is never sent twice.

**Future instrumentation (SF-010, not built here):** the `snapshot_waiting` reasons, the per-iteration `quiescence` record and the `late_turn` event are the signals a live console would show; a console would also want the open background task count and a per-process start time list (still without arguments or environments).

## 10. Review 03 (2026-10-28): message correlation, writers at the handoff, protocol evidence

**Baseline.** The operator committed the unaccepted Review 02 source as a disposable pilot baseline (`2370012`). The installed mediator supervisor still runs the older source. The Review 02 job's iteration-007 `tree_changed` conflict is therefore evidence about the installed supervisor, which has no quiescent bound. It is not evidence that the Review 02 candidate failed.

**R3-1: a result before its acknowledgment never hangs** (`stream-session.ts` `unresolvedSince`, `progressAt`; `supervisor.ts` `#awaitTurn`).
- *The state.* A `result` that arrives while a later message (a review) is still unacknowledged is not that message's answer (`stale_turn`, as before). It now also opens an **unresolved correlation**: that result may have been the answer, but nothing proves it. A later acknowledgment does not resolve it and never makes that result the answer retroactively. Only a further `result` after the acknowledgment resolves it: that result answers the review, as on the normal path.
- *The bound.* While unresolved and acknowledged, Claude Code must show **progress** within `correlationIdleMs` (default 10 min). Progress means an `assistant` or `stream_event` event, a tool result, an open background task, or a running process of the session (scanned at most once a second). System events, unparsable lines and unrelated output are not progress. The whole state is bounded by `correlationTimeoutMs` (default 4 h), whatever the progress. Exceeding either ends the session fail-closed: `needs_inspection` / `turn_correlation_unresolved`. Nothing is published from the unattributed result, the gate is released, and nothing is re-sent or relaunched.
- *What is not bounded.* A normal turn, acknowledged before any result, keeps its unbounded wait as before: long implementation work is never cut by a generic turn timeout. The unacknowledged state keeps its own 60 s `ackTimeoutMs` bound (`turn_correlation_unavailable`).
- *Audit.* A review is `delivered` only on its acknowledgment, as before. When its correlation then ends unresolved, its entry keeps `delivered` (it *was* acknowledged) with reason `turn_correlation_unresolved`, and the event `review_unanswered` is recorded. It never claims an answer.

**R3-2: the session's processes are scanned again at the handoff** (`supervisor.ts` `#handoffBlocker`, `#deferHandoff`).
- *The gap.* `#idleGate` sees only Claude's output, queued outcomes and open tasks, and `#stillBound` sees only writes already made. A process of the session started after the snapshot that is silent and has not written yet passed both.
- *Where the scan runs.* The process scan of quiescence.ts (descendants and tagged processes, pid plus start time, unidentifiable ones fail closed) now also runs at the handoff:
  1. before a review or acceptance is committed (settled scan): a running or unidentifiable process **defers** it (`handoff_deferred`). The request stays pending, and none is acted on until `#requiesce` has observed a new verified quiet window. That window requires no process of the session and an unchanged fingerprint, and it revalidates the scope and the published tree identity (a changed tree is a conflict). The request is then bound again (`#bound`, `#stillBound`) to the same iteration and exact snapshot sha256.
  2. after it was recorded (settled scan): a review is rolled back (`review_withdrawn`, still pending, never sent). An acceptance is withdrawn (`rejected`, `handoff_session_writers` or the other code), the same as a late result during an acceptance; recorded evidence is never overwritten.
  3. right before the review message is written: one synchronous pass over the process table, in the same tick as the idle gate and the write.
- *Not killed, not sent twice.* Nothing is signalled. A review is delivered at most once. An acceptance whose session process has already ended (`no_process`) goes to collection, which waits for the session's processes as in Review 02 (R2-2).
- *Limit, stated plainly.* Same-user `/proc` inspection only: a process that cleared its environment **and** left the process tree, or an unrelated same-user writer, is neither prevented nor reliably found. The scan narrows the window to the instant between the last pass and the write; it is **not** an atomic boundary. A hard boundary needs OS confinement of the session.
- *Restart.* A supervisor restart never hands over a pending request: the predecessor's session is collected as interrupted (Review 01/02 recovery, unchanged). A review recorded as `sending` becomes `unconfirmed`.

**R3-3: the real CLI's replay protocol is an integration requirement** (`protocol-probe.ts`, `sf009-executor probe-protocol`).
- *Recorded.* The installed CLI (Claude Code 2.1.312) lists every managed flag, including `--replay-user-messages` (`review/SF-009/review03/logs/cli-capabilities.log`, read-only `--version` and `--help`). That is **flag presence only**.
- *UNVERIFIED.* The live event shape (does the replayed `user` event carry our uuid?), its order relative to the previous and to its own `result`, and the permission mode and process lifetime under the managed flags.
- *The probe.* An operator-invoked command runs one real process with exactly `managedArguments`, through the shared session gate (refused while busy) and only in an empty directory. It refuses inside a Claude Code or managed session. It sends two messages (the second review-style) and prints the event shape only: no text, prompt, transcript, stderr, id or path. It checks the following, each pass or fail with the observed order:
  - `init_mode_auto`;
  - `ack1_exact_uuid` and `ack1_before_first_result`;
  - `ack2_exact_uuid` and `ack2_before_its_result` (sequential mode), or `acks_in_order` (`--overlap`: the second message sent while the first turn may run);
  - `two_results`, `no_foreign_acknowledgments`, `alive_between_turns` and `exits_after_input_closed`.
- *Tests.* They run it against the fake Claude only. **It was not run against the real CLI in this job.**
- *Review 04 (R4-1 to R4-3): a trustworthy verdict and a bounded end.*
  - *Strict order (R4-1).* In sequential mode, message 2 is sent only after result 1 arrived within `turnTimeoutMs`. Otherwise it is never sent: the report fails with `failure.code` `first_result_timeout`, and the process is shut down as below. The analyzer checks every required event on its own: each message sent once, acknowledged once by its uuid, and **exactly two** results. Sequential mode requires `send(1) < ack(1) < result(1) < send(2) < ack(2) < result(2)` (`ack1_before_first_result`, `result1_before_send2`, `ack2_before_its_result`). A duplicate, missing or extra event fails, so a later result cannot stand in for a missing answer. `--overlap` keeps message 2 being sent during turn 1. It requires `ack(1) < ack(2)` with `send(2) < ack(2)` (`acks_in_order`), and each result after its own acknowledgment (`results_after_their_acks`).
  - *A clean exit (R4-2).* `exits_after_input_closed` passes only for exit code 0 with no signal, recorded after the input was closed (`closed` and `exit` events), with no `signal` event before it (a process that exits 0 only on SIGTERM fails), and only if the process was still alive when message 2 was sent. A nonzero code, a signal or an unconfirmed exit is a `FAIL`, even if every uuid check passed.
  - *Bounded shutdown (R4-3).* The steps: close the input and wait `exitTimeoutMs` (30 s); send SIGTERM and wait `termWaitMs` (10 s); send SIGKILL and wait `killWaitMs` (5 s). Every wait is bounded.
    - Signals go to the launched child's pid only, never to a process group. Before each signal, the probe re-checks the identity recorded at launch (pid, start time and boot id, `process-identity.ts`). A pid that no longer matches is not signalled. EPERM, or any other error but ESRCH, stops the escalation (fail closed), and so does an identity check that throws. A failing input `end()` or an unexpected error in the shutdown steps still yields a report: an exit that was not seen is `unconfirmed`.
    - `report.shutdown` records how the process ended: `exited`, `sigterm`, `sigkill` or `unconfirmed`. A signalled end is never a `PASS`.
    - If no exit is confirmed by the final deadline, the probe returns `FAIL` with `failure.code` `gate_unresponsive`. It does **not** release the reservation: the gate stays with the process until it ends. It closes its own ends of the pipes and never starts a second process. The operator command then exits with code 4 by itself (`reportProbe`, iteration-002): Node would otherwise stay attached to the child handle. Exiting detaches only. The gate lock is the child's own inherited descriptor, so the child keeps the gate until it really ends. Every coded failure is also a failed check; `failure` names `gate_unresponsive` first if present (for example, after a `first_result_timeout`).
    - If `launchManaged` throws, the probe calls the reservation's `release()` (a no-op for a used reservation, whose gate stays with what it launched; otherwise the gate's bounded helper stop). It then rethrows the launch error, or `gate_unresponsive` if that release failed. Review 05 (R5-1): a `runner_unavailable` non-start whose gate helper pid is still present (for example, a helper that lingered after EXECFAIL and could not be stopped) is rethrown as `gate_unresponsive`; an unreadable pid counts as present.
  - *The command's thrown-error boundary (Review 05, R5-1).* The operator command runs the probe through `probeCommand` (`protocol-probe.ts`; `main.ts` calls it). A thrown `launch_unconfirmed` or `gate_unresponsive` (from the launch, the release after it, or the reservation itself) means a helper or launched process may still be alive and referenced by Node. The command then prints the coded message and an operator-attention line on stderr and exits with code 4 by itself, like a report with `shutdown` `unconfirmed`. It prints no report and never a `PASS`. Exiting only detaches: nothing is released, signalled or started, and the holder keeps the gate through its own lock descriptor. Every other thrown error still goes to the generic handler (code 1). The other supervisor commands are unchanged. A `gate_unresponsive` from the reservation whose message says the helper was stopped and the gate is free again also exits 4 (fail closed; the extra line defers to that message). *Residual:* `SessionGate.reserve()` stops a helper that lingers after BUSY or ERROR but ignores an `uncertain` stop, so the probe then throws `session_busy` or `io_failed` (generic handler, code 1) and could stay attached to that helper. That route needs a helper that cannot be killed and is left to a gate change outside this correction; `service.ts` treats the lingering-EXECFAIL `runner_unavailable` as before.

**R3-4: proven writers and unattributed unknowns are told apart** (`quiescence.ts` `WriterScan.unattributed`, `scanBlocker`).
- *Three reason codes,* each in the waiting, timeout and handoff diagnostics:
  - `session_writers`: proven processes of the session (descendant or tagged);
  - `unattributed_processes`: same-user processes started during the session, known by pid plus start time, whose environment (or owner) cannot be read; listed by pid and 15-character command name;
  - `process_scan_incomplete`: the process list is unreadable or truncated, or a stat is unreadable.
- *Still fail closed.* An unattributed process still blocks: it is never silently taken as unrelated.
- *The bounded recovery path.* The wait is bounded (`snapshot_failed` at a capture, `boundary_unstable` after publication, with requests left pending). The diagnostic names the pid and command so the operator can inspect it and end it if appropriate. Once it is gone, the next re-quiescence hands the pending request over without a new request. No command line or environment content is read into a diagnostic.

**R3-5: the approval double-failure residual is a production release blocker (not fixed).**
- *The case.* The SF-007 `consume` takes effect but reports an error, *and* every durable failure write (`refused/<id>`, the SF-007 settlement, `managed.json`) fails, *and* the supervisor restarts.
- *Why it is open.* Then a consumed approval is indistinguishable from a crash after a successful consume, and it launches once. This is **not** proven fail-closed; it stays a release-blocking limitation for any production use. Disposable pilots accept it explicitly.
- *Remediation design (not implemented):*
  1. A durable confirmation record (`confirmed/<id>`, written with fsync and a directory fsync) **only after** `consume` returned success.
  2. A restart launches only with a consumed approval **and** its confirmation record. A consumed approval without one is refused (`approval_unconfirmed`, authorize again).
  3. The residual then moves to the confirmation write itself (it takes effect but reports an error, and every refusal write fails). After a restart, that case launches only on an approval whose `consume` **did** return success: never an unproven approval.
  4. Required tests: deterministic fault injection at each write (`consume` effect-then-error, confirmation effect-then-error, every refusal write failing), with exactly one launch or none per case, across restarts.
- *Why not here.* It changes the SF-007/SF-009 recovery contract, and Review 03 is scoped to R3-1 to R3-3.

## 11. Self-hosting: an operator-controlled mode on the Software Factory checkout (2026-10-29)

**Why.** Software Factory work on Software Factory itself happened in pilot checkouts. The operator wants it on the main checkout, where their own uncommitted work lives, with the execution visible.

**The opt-in.** A separate private record, `executor/self-hosting.json` (0600, written only by `enable --app <id> --self-hosting`, removed by `disable`): the app id, the sha256 of the mediator's real path and the declaration `operator_controlled_unconfined`. The policy entry gets `isolation: "self_hosting_unconfined"`, never `disposable_pilot`; neither is a sandbox claim. One app at a time. `loadAppConfig` accepts the mediator as `APP_REPO` only with a grant for exactly that app and checkout; repositories inside or containing the mediator stay refused. The supervisor re-verifies the record, the policy sha and the repository at every launch (`self_hosting_not_enabled`, `repo_mismatch`); the bridge accepts the view value for authorization and the supervisor decides.

**Existing work, not `repo_dirty`.** For this app only, `prepare` records a private, hash-only baseline (`.env.sf006-preexisting-<job>`, bound by sha256 in `execution.json`) of every path that differs from HEAD. The launch requires the tree to equal it. Exports leave unchanged baseline paths out and name changed and reverted/removed ones; a removal makes the iteration `needs_operator` / `existing_work_removed`. No content is copied, so a removed path's earlier content is not recoverable by Software Factory, and a changed path's diff includes the earlier work (against HEAD).

**The mediator's own state.** `factory-data/` is excluded from the self-hosted job's tree identity, ignored-credential checks and exports (the supervisor and the bridge write it while the session runs). Deny rules `Read/Edit/Write(factory-data/**)` are added for that session. A forged request file by the session would still have to pass the existing handoff process scans and snapshot binding; a writer that escaped them is the documented same-user residual, more reachable here because the session's working directory contains the mediator data.

**Visibility.** `status`/`watch` (`executor/status.ts`) read the policy, the opt-in, `managed.json`, `execution.json`, the supervisor lock and heartbeat and the transcript's modification time, and show per job the real repository, app/job, the supervisor and Claude processes by pid and start time, the iteration, the last activity and the waiting reason. Read-only.

**Not changed:** authorization binding and epochs, `consumed/<id>` and the SF-007 approval, `launch.claim`, the session gate, quiescence and snapshot integrity, final acceptance and drift checks. Nothing reloads the supervisor or bridge after a job changes their source or build.

**Review corrections (SH-R1 to SH-R5).**
- A path HEAD has is always compared with HEAD, never listed as a new untracked file as well (a staged deletion that the session recreates is one change, or a reverted one when it has the HEAD content again).
- The baseline file (`software-factory.preexisting-work/v2`) stores `[path, fingerprint]` pairs, never an object keyed by path; it is written only when it reads back completely, and a repeated path makes it invalid.
- Withdrawing the self-hosting opt-in also withdraws its policy entry; every public view is computed before anything is written.
- `status` shows a job's repository only when verified against its authorization binding, and reports discovery issues and unreadable records with their codes.

**Inherited protection of the main checkout (04).** The global `protected_paths` stays unchanged. A verified self-hosted session excludes only the entry exactly equal to its verified `config.repo`, its session repository and the resolved mediator root (all three one path); the remaining list is frozen at the session start and rechecked, exactly, at every scope boundary (`supervisor.ts`, `sessionProtection`). Every other app keeps the full list, so the main checkout stays protected while another app runs.
