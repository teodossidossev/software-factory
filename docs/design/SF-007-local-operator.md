# SF-007 design: local operator queue and approved Claude launch

**Status:** Review 01 implemented and tested with a fake Claude runner, including a real `gnome-terminal` on an isolated display.
- **Not installed:** nothing was installed.
- **Not run for real:** no real Claude execution through SF-007.
- **Readiness:** see `docs/reports/SF-007-report.md`.

**Review 01 changed the design in three places:**
1. The loopback web page was withdrawn (§6). Approvals now happen in a terminal console that has no listener.
2. A host-wide Claude session gate, an OS lock, is shared by the manual SF-006 CLI and SF-007 (§5).
3. The SF-006 lock's stale takeover no longer has a rename gap (§8).

## 1. Goal and non-goals

**Goal:** the operator handles accepted jobs without typing per-job commands:
- review an accepted job's exact instruction;
- approve it with one decision;
- the whole SF-006 sequence then runs for that job on the operator's own terminal: preflight, prepare, the interactive native Claude Code `/implement` session, the end-of-session question, and collect.

**Non-goals:**
- **No unattended execution.** Every launch needs an operator decision typed into the console for the exact job.
- **No change to SF-005 dispatch semantics.** `accepted` still means received, not executed.
- **No second execution state machine.** SF-006 `execution.json`, `launch.claim` and its locks stay the source of truth.
- **No ChatGPT notification.** The operator asks ChatGPT to review a finished job.
- **No change to OpenClaw, its Compose isolation, or the administrative Dashboard.**

## 2. Components

```
ChatGPT ──MCP──► bridge (SF-005) ──► factory-data/apps/<app>/jobs/<job>/{instruction.md, dispatch.json, openclaw-receipt.json}
                                          ▲ read only                    OpenClaw (network_mode none) keeps its receiver record
                                          │
desktop launcher ─► gnome-terminal ─► operator console (bridge/src/operator/console.ts)   [no listener; the operator's own terminal]
                                          │  queue (read only), instruction view, a / l / x / c typed by the operator
                                          │  private state: ~/.local/state/software-factory/operator (approvals, decisions, audit log)
                                          ▼
                     attend (same process): consume the approval once → SF-006 preflight / prepare(expected) / run(expected)
                                          │
                     run: session gate (flock, ~/.local/state/software-factory/claude-session.lock) → launch.claim → the gate helper
                          exec()s claude --permission-mode manual --session-id … "/implement <path>" on this terminal (it keeps the gate)
                          → "Did /implement finish?" → SF-006 collect → execution.json + four artifacts
```

| Module | Role |
|---|---|
| `operator/console.ts` | The approval interface: queue, exact instruction, decisions from the keyboard. Job text is made inert (`printable()`) |
| `operator/attend.ts` | Runs one approved job through SF-006 on this terminal |
| `operator/approval.ts` | Approve, Reject, Later, Cancel: bound, one-use approvals |
| `operator/queue.ts` | Bounded, read-only discovery and status derivation, with per-limit truncation reporting |
| `operator/store.ts` | Private operator state: approvals, decisions, launch records, the audit log |
| `operator/main.ts` | CLI: `console`, `status`, `render-assets` |
| `operator/demo*.ts` | The console against throwaway repositories and a fake `claude` |
| `execution/session-gate.ts` | The host-wide Claude session gate: `flock(2)` through a fixed `python3 -I` helper |
| `execution/process-identity.ts` | The per-job execution lock, with stale takeover hardened in Review 01 |

### Changes to SF-006 code (each regression-tested; `execution.test.ts` 30/30)

| Change | Why |
|---|---|
| `prepare`/`run` take an optional `expected` approval binding (initial SF-007) | Bind the approval inside the per-job lock, before any app-side write |
| `run` takes the session gate before `launch.claim`; the launched Claude process holds it (Review 01) | One gate for every launch path. A busy gate claims nothing |
| `handoff` refuses while the gate is held or a hand-started session lives (Review 01) | The handed-off session cannot hold the gate |
| `preflight` reports the gate (Review 01) | The console and the CLI show "busy" before anything is prepared |
| A fail-closed scan for hand-started sessions (Review 01) | Handed-off or resumed sessions started by hand cannot hold the gate |
| `ClaudeRunner.reserve()` replaces `launch()`; `ProcessClaudeRunner` takes the gate (Review 01) | The gate and the launch are one step |
| `acquireLock` stale takeover without a rename gap; corrupt locks fail closed (Review 01) | Finding 3 |
| `local-service.ts`: shared production wiring; `errors.ts`: `approval_mismatch`, `session_busy` | |

## 3. Status model

Execution truth stays in SF-006 `execution.json`. Operator decisions live only in the private state directory.

| Displayed | Condition | Decisions in the console |
|---|---|---|
| `accepted` | OpenClaw accepted it, but this app cannot run here (no valid `.env`/`APP_REPO`) | none (the reason is shown) |
| `invalid` | The acceptance is not proven: the receipt, the instruction digest, or a malformed or unreadable record (no details shown) | none |
| `awaiting_operator` | Accepted, valid, no `execution.json`, no decision (or Later). A failed earlier launch is shown with its reason | Approve & Run, Later, Reject |
| `approved` | An approval is recorded and not yet consumed (expires after 15 minutes) | Cancel approval |
| `launching` | An operator console consumed the approval and is preparing | none |
| `running` | `execution.json` state `running`, with the liveness of the session process | none; recovery command if the process is gone |
| `prepared` | Prepared, not started. If an approval prepared it and the gate was busy at launch, it can be approved again ("resume"). Otherwise it came from the manual CLI and the recovery command is shown | Approve & Run (resume), or none |
| `pending_manual` | Handed off with the manual CLI | none; recovery command |
| `completed`, `failed`, `interrupted`, `needs_inspection` | SF-006 final states | none; SF-006 recovery text |
| `rejected` | The operator rejected it (final) | none |

Earlier launch outcomes are shown on the job:
- `refused` (`session_busy`, `not_ready`, `expired`, `no_tty`);
- `failed`;
- `cancelled`;
- `abandoned` (a console took the approval and ended before preparing).

A retry is always a new explicit approval. After `launch.claim` exists, SF-006 never launches the job again.

## 4. Approval semantics

- **Binding.** An approval is bound to `(app_id, job_id, request_id, instruction_sha256, app_repo_sha256)`:
  - `request_id` and `instruction_sha256` must equal what the console displayed and what `dispatch.json` holds;
  - the SF-006 preflight must be ready: receipt, the OpenClaw receiver's own record, the app configuration, a clean repository, the runner, the login, the skill, and the session gate;
  - SF-006 re-checks the binding inside the per-job lock, in `prepare` and `run`, before any app-side write.
- **One use.**
  - **Created:** by an exclusive link of `approval.json`.
  - **Consumed:** by an atomic rename.
  - **Cancel, expire, refuse:** also renames of the same source.
  - **The SF-006 floor:** `launch.claim`.
  - **Tested:** six concurrent approvals give one; three competing attend processes give one session.
- **Who can approve.** Only someone typing into the operator console, or the same Unix user operating its private files directly. Nothing can reach the console: it has no listener, socket or IPC endpoint. The bridge, ChatGPT and OpenClaw cannot write the private state directory. A message in ChatGPT is never an approval.
- **Audit.** `events.jsonl` (0600) records events with the bound tuple: `approved`, `rejected`, `deferred`, `cancelled`, `consumed`, `expired`, `refused`, `failed` and `finished`. It never records paths, tokens or child output.

## 5. The host-wide Claude session gate (Review 01, Findings 2 and 3)

**Invariant:** at most one Claude Code session started by Software Factory runs on this host at a time, whichever way it was started: the manual SF-006 CLI or the SF-007 console. `max_sessions` was removed: concurrency above 1 is not offered, because it cannot be shown safe across all launch modes.

**Mechanism:**
- **The gate:** an exclusive `flock(2)` on `~/.local/state/software-factory/claude-session.lock`. The path comes from the account database (`os.userInfo().homedir`), not from `HOME`/`XDG_*`, so every process agrees on it.
- **The helper:** Node has no `flock`, so a fixed helper takes it: `python3 -I -c <fixed source> <path>`, with no shell and no environment influence. The helper:
  - opens the file with `O_NOFOLLOW`;
  - requires a regular 0600 file owned by this user, in a directory owned by this user and not writable by others (otherwise it fails closed);
  - takes `LOCK_EX|LOCK_NB`;
  - checks that the path still names the locked file (so a file replaced between open and lock is not trusted);
  - reports `HELD` or `BUSY` on fd 3. Any failure after `HELD` reports `EXECFAIL`, never a silent "launched".
- **Launch:** on `HELD`, it waits. To launch, it receives the Claude command as JSON and `exec()`s it in place, so the Claude process itself holds the locked descriptor. To give the gate back without launching, the adapter closes fd 3, and the helper exits.
- **Release:** the kernel releases the lock when the last process holding the descriptor ends. No owner check, rename or unlink exists that could race. The file is never removed.
- **Checking without taking:** `preflight` and `handoff` only read `/proc/locks` to see whether, and by which pid, the gate is held. A check never makes a concurrent launch busy.
- **Bounded helper lifecycle (Review 03).** Every wait on a helper has a finite deadline. Defaults:
  - **10 s** from start to the first answer (`HELD`, `BUSY`, `ERROR`);
  - **5 s** for any exit after an answer, a release or a signal;
  - **30 s** for a hand-over.

  **A helper that was not, or not successfully, told to exec Claude is stopped with SIGKILL**, which also ends a stopped process. That covers a helper that is silent or stopped before `HELD`, lingers after `BUSY`, `ERROR` or `EXECFAIL`, or does not end after `release()`. The gate then counts as free only when **both** hold:
  - the helper's exit was observed;
  - `/proc/locks`, read successfully, shows no lock of its pid.

  The outcomes:
  - **Free:** the call reports it ("was stopped; the gate is free again", or the plain `BUSY`/`ERROR`/`EXECFAIL` outcome).
  - **Not free** (e.g. a process stuck in the kernel, signals without effect, an unreadable lock table): the call fails closed with `gate_unresponsive`, "may still hold the session gate", naming the pid. Every other reservation then sees the gate busy, so no second session starts until the operator ends that holder.

  **After a launch request has been delivered, a timeout never kills the helper**, because it may be about to become, or already be, Claude. A hand-over that does not happen within 30 s is reported as `launch_unconfirmed`, naming the pid that was left running; that process keeps the gate. Only the bounded `handoverEvidence` check after the channel closes can confirm a launch.

  In `ExecutionService.run`, a release that fails on an error path never hides the original error: the `gate_unresponsive` diagnostic (pid, recovery) is appended to it. All of this happens before `launch.claim`, so the job stays `prepared`.

  **Tested with injected faults** (`gate-lifecycle.test.ts`, deadlines shortened to 0.5 s):
  - silent and stopped helpers before `HELD`;
  - a silent helper that holds the lock and cannot be ended (fails closed);
  - `BUSY`, `ERROR` and `EXECFAIL` followed by a hang;
  - a helper stopped during `release()`;
  - a stopped helper whose signals have no effect (the fail-closed case);
  - `run` with a silent helper;
  - a stopped helper at the hand-over timeout (`launch-evidence.test.ts`: not killed, keeps the gate).

  Each call returned within 4 s, with the correct category, and the gate was verified free (or verified still held). The test seams are the `python`, `signal` and timeout options of `SessionGate`; production never sets the first two.

  **Not covered:** a helper in an uninterruptible kernel wait cannot be ended by any signal. That case is reported, not recovered.
- **Launch evidence (Review 02).** The control channel (fd 3) is close-on-exec. It closes in three situations, so its closing alone proves nothing:
  - the helper exec'd the target;
  - the helper died (killed, crashed);
  - the adapter closed it.

  **What Linux shows:**
  - `execve()` switches the process's executable (`/proc/<pid>/exe`) inside `begin_new_exec()`, before close-on-exec descriptors are closed.
  - The new argument list (`/proc/<pid>/cmdline`) can read as empty for a short moment afterwards. A review found this, so the evidence relies on `exe` first.
  - A dying process loses its image (unreadable `exe`) before its descriptors close.

  **The check.** At `HELD`, the adapter records the helper's start time (field 22 of `/proc/<pid>/stat`, kept across exec, new for a reused pid) and its executable. When the channel closes, it checks that same process:
  - **launched:** it runs another executable, or its argument list no longer contains the helper's marker. The marker is inserted into the helper's source from the same constant.
  - **gone:** it has exited (also as an unreaped zombie), or the pid has another start time.
  - **undetermined:** still alive but neither shown, re-checked for about 2 s. It is never waited on beyond that and never killed, since it may be the session.

  Every wait for an exit is bounded (5 s after a kill).

  | Observation | Outcome | SF-006 record |
  |---|---|---|
  | launched | **Confirmed launch**; its exit is then observed as the session's end | `running`, pid recorded; the session proceeds |
  | An `EXECFAIL`/`ERROR` line from the helper (e.g. the executable is missing; SIGINT before exec) | **Confirmed non-start** | `failed` / `runner_failed` |
  | gone | **Indeterminate**: the helper died before exec, or the target started and ended at once. The two cannot be told apart from outside | `needs_inspection` / `launch_unconfirmed` |
  | undetermined | **Indeterminate** (the process keeps running and holding the gate) | `needs_inspection` / `launch_unconfirmed` |
  | No hand-over within 30 s | The helper is stopped (`SIGKILL`); **indeterminate** | `needs_inspection` / `launch_unconfirmed` |

  **In every case:**
  - `launch.claim` stays, and nothing is retried; the job id never launches again;
  - the gate is free afterwards, because the helper, or the target, is gone;
  - the record is never `completed`.

  The operator inspects the application repository. A genuine fast exit is reported as indeterminate, never as a helper failure.

**Order inside `ExecutionService.run`.** Every launch passes through it. Each step happens inside the per-job lock:
1. Verify the acceptance and the approval binding.
2. Check the destination and that the repository is unchanged since prepare.
3. **Take the gate.** If busy, throw `session_busy`: nothing is claimed, and the job stays `prepared`.
4. With the gate held, scan for live hand-started sessions. If one is found, or if any record is unreadable, give the gate back and throw `session_busy`.
5. Write the private baseline, create `launch.claim`, record `running`.
6. Hand the gate to the Claude process (`exec`).
7. If the launch fails, give the gate back and record `failed`.

**Release.** The gate is held for the whole session:
- **Adapter dies while Claude runs** (terminal closed, SIGKILL): Claude keeps the gate until it ends.
- **Claude ends:** the gate is free again.
- **Adapter dies before the launch:** the helper sees EOF and exits.
- **Claude-spawned background processes:** they inherit the descriptor, so a process Claude left running holds the gate until it ends. This is deliberate and fails closed: releasing at Claude's own exit would need a parent process that holds the lock, and killing that parent alone would free the gate while Claude still runs. The busy message says "or a process it started", and the runbook shows how to find the holder (`fuser`).
- **Deleting the gate file:** deleting it, or its directory, while it is held would let the next launch lock a new file. Only the operator's own account can do that (the directory is 0700 and owned by the operator). The runbook says never to.

**What the gate cannot cover, and the constraint:**
- **Untracked starts:**
  - a session the operator starts by hand from SF-006 `handoff`;
  - a resumed interrupted session (`claude --resume <id>`).

  They run outside `ExecutionService.run`. Three rules cover them:
  - **The gated command.** `handoff` returns, and the CLI prints, the command wrapped in `flock --nonblock --conflict-exit-code 75 <gate file> claude …` (util-linux `flock(1)`). Started that way, the hand-started session holds the same gate and refuses at once while another session runs. The runbook gives the same form for `--resume <id>`.
  - **The scan.** `run`, `handoff` and the preflight refuse while any recorded `running`, `pending_manual` or `interrupted` job has a live process whose command line contains its session id (`--session-id <id>`, `--resume <id>` or `--resume=<id>`). The scan is one `/proc` pass. Its record policy (Review 02, `sessionActivity()`) is:
    - **No schema marker** (not an object with `schema: software-factory.execution/v1`): blocks, "unknown schema".
    - **A state outside SF-006's `STATES`**: blocks, "unknown state".
    - **`prepared`**: inactive (no session yet).
    - **`running`, `pending_manual`, `interrupted`**: counted with a valid UUID `session.id`. Without one (missing, null, non-string, not a UUID), it blocks: "no valid session id".
    - **`completed`, `failed`, `needs_inspection`** (Review 03): the session ended, but anyone can resume it by hand with `claude --resume <id>`, outside the gate. A valid session id is therefore a candidate, and blocks while a process carries it. Without a usable id, the record is inactive, so historical records never block for being old. On the real mediator, all 10 completed records are candidates with no live process (`logs/review03/real-records-classification.log`).
    - **Unreadable, non-JSON or more than 1,000 apps / 100,000 jobs**: blocks.
    - **Directories:** a missing `factory-data`, `factory-data/apps` or app `jobs` directory is benign (never initialized, or no jobs yet). One that is a symlink, not a directory, or cannot be inspected or listed blocks.

    Blocking means `session_busy` with the fixed diagnostic `Running sessions cannot be verified: <app>[/<job>] (<category>)`, using verified ids only (tested).
  - **No handoff while busy.** `handoff` itself is refused while the gate is held or a hand-started session lives.
- **Remaining constraint (documented, not tested away):** a hand-started session counts only if it is started with the gated command, or carries its recorded session id. One that does neither, such as `claude --continue` or the in-app `/resume` picker run without the gate, is not counted. This holds whatever the job's recorded state is: since Review 03, sessions of `completed`, `failed` and `needs_inspection` jobs are checked too. A handed-off job that has not been started yet holds nothing either: the gate is taken only when its gated command is run.
- **Not counted:** Claude Code sessions outside Software Factory (the operator's own work) are not gated.

**SF-007 order.**
- **Before approving:** the console's approve step requires a ready preflight, so a busy gate refuses the approval.
- **Inside attend:**
  1. consume the approval;
  2. run the preflight; if the gate is busy, record `refused`/`session_busy`. Nothing is prepared, and the job is approvable again later;
  3. prepare;
  4. run. If a manual session wins the race in between, `run` throws `session_busy`. The job stays `prepared`, and the console offers "Approve & Run (resume)", which skips prepare.

  Nothing is consumed irrecoverably.

## 6. Why the web page was withdrawn (Review 01, Finding 1)

**Threat.** The initial SF-007 served a page at `http://127.0.0.1:8791/` with a token in the page's `localStorage`.
- **Browser-to-server authentication** (proving to the server that a request comes from the operator) was in place: a bearer token, a peer-uid check via `/proc/net/tcp`, and Host/Origin/fetch-metadata checks.
- **Server-to-browser authenticity** (proving to the browser that the page comes from the operator's server) was not. Browsers bind origin state to `scheme://host:port`, and anyone who can listen on that port is that origin.

**The attack:**
1. **Squat the port.** While the operator service is down (not yet started, stopped, crashed, before login), another local account binds `127.0.0.1:8791`.
2. **Serve a script.** The operator opens the bookmark or launcher; the attacker's page loads in the operator's origin, reads the stored token, and stays open.
3. **Send requests through the browser.** When the real server returns, the page's requests come from the operator's own browser process: the peer-uid check sees the operator, and Host/Origin are correct. The page can approve jobs and read instruction text.

**Not sufficient:**
- the peer-uid check, longer or hashed tokens, Host/Origin checks, or rotating tokens on restart (the page can re-capture on the next pairing);
- `sessionStorage`;
- a `*.localhost` name with a secret (the squatter receives it in the `Host` header).

TLS with a pinned certificate would require browser exceptions an operator could click through. A permanently reserved port (systemd socket activation) leaves gaps: before the user manager starts, when the socket unit is stopped, and with another account's linger.

**Decision.** The interaction mechanism was changed, as the instruction allows. Approvals happen in a terminal console with no network listener, socket or IPC endpoint.
- **Trust anchor:** the operator's own terminal. Only someone who can type into it can approve. Another local account cannot inject keystrokes into the operator's X session without its X authority. Checked on this host: `xhost` reports "access control enabled" with only `SI:localuser:teo`, and `~/.Xauthority` is 0600.
- **One click:** the desktop launcher (one click) opens the console in `gnome-terminal`. Choosing a job and typing `a` is the approval.
- **Tested:** a hostile listener on 8791 and a replayed captured-token request achieve nothing (the request goes to the attacker, later `ECONNREFUSED`). The console process holds no listening socket. The operator code contains no server or listener API.

**Terminal injection replaces XSS** as the presentation risk. Everything printed from job data goes through `printable()`:
- C0/C1 controls (except newline and tab), DEL and bidirectional format characters become visible escapes;
- the instruction cannot set the title, move the cursor, clear the screen or reorder text.

## 7. Threat model

| Threat | Mitigation |
|---|---|
| ChatGPT or the MCP bridge forges an approval | The state directory is outside the mediator. The bridge has no write path there. Approvals need console input |
| OpenClaw (compromised) accepts a job | Acceptance only lists it. It is re-verified against the receiver's own record and needs an operator decision |
| Another local account impersonates the approval interface (port squat, stolen token, script in the operator's browser) | No web page, listener or token exists. The console is the operator's own terminal |
| Terminal escape injection through instruction text, ids or messages | `printable()` on all job-derived output |
| Two Claude sessions at once (manual CLI, console, competing launches, an orphaned Claude) | The `flock` session gate, held by the Claude process itself, taken before `launch.claim`. The fail-closed hand-started session scan |
| A hand-started session without its session id in argv | Documented constraint (§5) |
| A swapped instruction, dispatch, receipt, `.env` or approval file | The bound tuple, re-verified inside the SF-006 per-job lock. A strict approval schema, private regular files, no symlinks |
| A stale-lock takeover race (two owners) | Exclusive takeover marker plus an atomic rename over the stale lock (§8) |
| A display list cut by limits hiding a live session | Truncation reported per limit; no safety decision uses the list (the gate does) |
| A headless or automatic Claude run | The console and attend refuse a non-TTY. No `-p`, auto or skip-permissions flags. No autostart, no listener |
| A local process of the same Unix user | Out of scope: it could already run `claude` or the SF-006 CLI itself |

## 8. Per-job lock (SF-006 `acquireLock`, Review 01 Finding 3)

The per-job `execution.lock` (and the operator store's short-lived job locks) is a complete file published with `link()`.

**Stale takeover:** before Review 01, a contender renamed a stale lock aside, leaving a moment without a lock file. Now:
1. Read the holder.
2. Only if that holder is provably dead (pid, start time, boot id), create the exclusive marker `.execution.lock.takeover-<holder token>`. Exactly one contender can create it for that stale lock.
3. Re-read: the path must still hold the same token.
4. `rename()` the contender's own complete lock file over it (atomic replace).
5. Remove the marker.

The lock path is never absent during a takeover. A live lock is never touched.

**Failing closed:**
- **Corrupt lock:** a lock that cannot be parsed fails closed. Locks appear complete, so unparsable means corrupt. It is left untouched.
- **Existing marker:** a takeover marker that already exists fails closed as well. If a contender crashed between creating the marker and the rename, the operator removes the marker by hand after checking that no adapter runs (runbook).

**Release** unlinks only while the file holds the releaser's own token, which only the live owner can replace.

**Tested:** 8 processes × 25 rounds of acquire and release with no overlap; 8 contenders for one stale lock give one winner (5 rounds); a killed holder is replaced; PID reuse and another boot count as stale; a live holder, corrupt locks and an existing marker are untouched.

## 9. Queue coverage (Review 02)

The display scan distinguishes, for `factory-data`, `factory-data/apps`, each app directory and each `jobs` directory:
- **missing:** a clean state. Missing roots show "The mediator is not initialized yet (no factory-data/apps): nothing has been dispatched". A missing `jobs` directory means an app without jobs yet.
- **A symlink or not a directory**, or **cannot be inspected / cannot be listed**: reported under `LIST INCOMPLETE` with the repository-relative path built from verified ids and the category. The scan does not descend into it. Symlinks are never followed.

The Review 01 limits (100 apps, 1,000 jobs per app, 5,000 in total) are reported the same way. The listing is display only. Safety comes from the session gate and the hand-started-session scan (§5), which treat the same directory cases fail-closed.

