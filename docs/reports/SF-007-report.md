# SF-007 report: operator-approved local execution queue and Claude launch

**Current stage (after Review 03):** implemented and verified with fake Claude runners, including a real `gnome-terminal` running the operator console on an isolated display.
- **Not installed:** nothing is installed or running; there is no service or listener.
- **No live execution:** no real job, app, dispatch or Claude `/implement` run.
- **No Git operations.**
- **Real Claude execution through SF-007 remains pending** a supervised pilot. See "Readiness" in the Review 01 section.

The sections up to "Limitations" describe the initial SF-007 delivery as it was reviewed. Review 01 withdrew its web page: see the Review 01 section, the design (§6) and the runbook for the current state.

## What was built

| Part | Files |
|---|---|
| Private operator state: approvals, decisions, launch records, audit log, pairing and UI sessions, session slots | `bridge/src/operator/store.ts` |
| Read-only queue discovery and status derivation | `bridge/src/operator/queue.ts` |
| Approve / Reject / Later / Cancel | `bridge/src/operator/approval.ts` |
| Approve & Run: approval plus terminal | `bridge/src/operator/launch.ts`, `bridge/src/operator/terminal.ts` |
| The process inside the terminal | `bridge/src/operator/attend.ts`, `attend-main.ts` |
| Loopback page and API | `bridge/src/operator/server.ts`, `ui.ts`, `peer.ts` |
| CLI: `serve`, `pair`, `status`, `sign-out-all`, `render-assets` | `bridge/src/operator/main.ts`, `scripts/sf007-operator.sh` |
| Demo (throwaway repositories, fake Claude) | `bridge/src/operator/demo*.ts`, `scripts/sf007-demo.sh` |
| Optional unit and launcher templates | `deploy/operator/*.in` |
| Docs | `docs/tasks/`, `docs/design/` and `docs/runbooks/SF-007-local-operator.md` |

**SF-006 changes, each needed and regression-tested:**
- **`service.ts`:** `prepare(app, job, expected?)` and `run(app, job, confirm, expected?)` compare the approval (request id, instruction SHA-256, SHA-256 of the real `APP_REPO`) with the freshly verified acceptance. The comparison runs inside the per-job lock, before any write to the app repository. A bound `prepare` refuses an existing `execution.json`, and `status()` also returns the artifact hashes. This could not live outside the service without a time-of-check gap.
- **`errors.ts`:** one new code, `approval_mismatch`.
- **`cli.ts` → `local-service.ts`:** `claudeInstallation()` and the production service construction were moved, unchanged. `cli.ts` runs `main()` on import, so it cannot be imported.

Without `expected`, SF-006 behaves exactly as before: `execution.test.ts` passes 30/30, the manual CLI prints the same usage, and `scripts/sf006-execute.sh` is byte-identical.

## Operator experience as built

1. ChatGPT dispatches as in SF-005; OpenClaw accepts.
2. The page at `http://127.0.0.1:8791/` (paired once with a code from `scripts/sf007-operator.sh pair`) lists the job as `awaiting_operator`.
3. **Review** shows the request id, the SHA-256 and the exact instruction text. The buttons appear only after the text has loaded and matches the SHA-256.
4. **Approve & Run** is one click. A `gnome-terminal` window opens, and in it:
   - the preflight and prepare run;
   - Claude Code starts with `/implement` in manual permission mode, and the operator answers its prompts;
   - the operator answers "Did /implement finish?";
   - SF-006 collects the results.
5. The page shows the SF-006 final state and the four artifact hashes. **Reject** is final. **Later** keeps the job waiting.

**No per-job commands.** The manual CLI stays as a fallback, and the page shows its exact command when recovery needs it.

## Demonstrated

**Real terminal** (`review/SF-007/logs/terminal-proof.log`, `review/SF-007/proof/*.png`). This is what the real `gnome-terminal` 3.52 on Linux Mint 22.3 showed and did:
- **Isolation:** an isolated Xvfb display with a private D-Bus session, so the operator's desktop is not touched.
- **Approval:** an HTTP approval, made the way the page makes it, opened the real terminal. Its argv passed through the distribution wrapper unchanged.
- **Keyboard input:** real X keyboard events (XTEST) answered two prompts. One was the demo Claude's permission question, read from its TTY stdin. The other was the adapter's "finished?" question.
- **The session:** the fake Claude saw TTYs on stdin, stdout and stderr, with `--permission-mode manual` and the `/implement` argument.
- **The results:**
  - the job ended `completed`, with `observed_exit` and full transcript evidence;
  - the four artifact hashes matched;
  - the page's state matched `execution.json`;
  - the second demo job stayed `awaiting_operator`;
  - the window closed after Enter.

**Tests:** `npm run smoke` passed **102/102**: the 77 accepted plus 25 new (`review/SF-007/logs/test-suite.log`). The new files are:
- `operator-binding` (3);
- `operator-flow` (12; real PTY, scripted keystrokes);
- `operator-server` (8);
- `operator-assets` (2).

| Instruction case | Covered by |
|---|---|
| 1 Discovery only lists | flow "1: discovered jobs…", "1: malformed jobs…" (mediator byte-identical, no claim, no app change, no Claude) |
| 2 Reject, Later, one-click | flow "2: Reject and Later…", "2, 6, 7: one Approve & Run…" |
| 3 Binding | binding tests (request id, instruction, repository, `.env` swap, run-time mismatch). Flow "3:" swaps the instruction, receipt, receiver record, a whole consistent re-acceptance, `.env`, the approval data and an approval symlink; each fails before an app-side write, with no claim and no Claude |
| 4 Web attacks | server tests: loopback only (127.0.0.2 and ::1 refused), peer uid, wrong Host (DNS rebinding, `localhost`, other port), missing or wrong token, a cookie-only token, foreign or other-port Origin, missing Origin, cross-site and same-site fetch metadata, cross-origin and same-origin form posts, `text/plain`, GET approve (405), a token in the query (400), XSS payload as JSON text, CSP and no CORS, no `innerHTML`/`style` in the page script, pairing abuse, oversized and malformed bodies, no secrets in responses |
| 5 At most one launch | 6 parallel approvals → 1; 5 parallel HTTP approvals from "tabs" → 1; 3 competing attend processes → 1 session; a stale approval (16 min); a busy slot; a manual SF-006 session blocks; an unreadable approval blocks; a restart relaunches nothing; a crash ends `interrupted` through `collect`, never relaunched |
| 6 TTY, arguments, environment | all three streams are TTYs; exact argv; `SF_*` dropped by the terminal allowlist and by SF-006; no terminal, no desktop, an exiting terminal and no TTY each fail visibly with nothing run |
| 7 Collect and artifacts | the final state equals `execution.json`; the four hashes match; no child output, app path or state path appears in artifacts |
| 8 Never `completed` | No → `interrupted`; SIGTERM and SIGKILL → `interrupted`; no transcript → `failed`; commit and stage → `failed`; secret file → `needs_inspection` |
| 9 No collateral changes | `review/SF-007/logs/final-checks.log`: compose, receiver automation and `sf006-execute.sh` are byte-identical; `factory-data` is identical in content, type and mode; the Git index is identical; the only modified files are listed. `execution.test.ts` 30/30 covers the manual SF-006 operation |
| 10 Setup and removal | assets test: rendered from templates without host paths, `systemd-analyze --user verify` and `desktop-file-validate` pass, nothing overwritten; pairing and sign-out work without a server; the runbook documents idempotent stop, disable and remove; nothing is installed (final checks) |

## Two-axis review and fixes

The internal review's security/standards and spec/UX axes found no critical defect. These were fixed:
- **Another local account could use a stolen token or a squatted port** to approve. Every connection is now accepted only from the operator's own uid (`/proc/net/tcp`).
- **The one-session limit ignored sessions without an SF-007 slot.** It now counts any live SF-006 session as well: manual CLI runs, and a Claude that outlived its terminal.
- **The global pending-approval check failed open** on unreadable records. It now blocks.
- **The state directory's "outside the repo" check was lexical.** It now compares real paths.
- **The audit log followed symlinks** and grew without limit. It now uses `O_NOFOLLOW` and stops at 16 MiB. Lock reads are checked private files.
- **Competing attend processes could cancel each other's approval.** An attend now consumes the approval before taking a session slot. This was found by a test.
- **A concurrent creation race in private directories (`EEXIST`)** was found by a test and fixed.
- **Labels and recovery in the page:**
  - unproven acceptances show `invalid`, never "accepted";
  - an abandoned launch is shown;
  - Approve appears only once the instruction is on screen;
  - recovery commands are shown;
  - `failed` and `cancelled` outcomes are distinct.
- **Standards:** the duplicated checks and schemas are shared; there is a launch-record factory, a typed HTTP status map and a static import; non-adapter errors print no messages.

## Limitations and what remains operator-controlled

- **Not proven:** a launch from the systemd user unit into the operator's logged-in Cinnamon session.
  - The unit uses `default.target`, because `graphical-session.target` is inactive on Cinnamon here.
  - It depends on the user manager having `DISPLAY` and `DBUS_SESSION_BUS_ADDRESS`; it has them now.
  - Without them, every launch fails visibly ("NO DESKTOP SESSION"). Restarting the service after login, or running `serve` in a terminal, fixes it.
  - This is part of the first supervised pilot.
- **Recovery is shown as a command, not a button:** a crashed `running` session and a `prepared` job left behind by a closed terminal. `collect` must ask the operator in a terminal.
- **The manual SF-006 CLI is not bound by the page's decisions.** Reject is a page-level decision; the CLI is the operator's own recovery tool.
- **Paired browsers stay signed in for 30 days.** `sign-out-all` ends them.
- **gnome-terminal is the only supported terminal backend.**
- **ChatGPT is not notified.** The operator asks it to review a finished job.
- **Remaining standards smells, as judgement calls:** the `(appId, jobId)` pair is passed separately everywhere, and the mediator-root derivation is repeated per entry point.
- **Operator-controlled:**
  - installing, enabling or starting the service, and pairing;
  - every approval, and Claude's trust and permission prompts;
  - the finished question, the review, and Git (staging, commits, pushes).

**State after this task:**
- the bridge `dist/` was rebuilt;
- running processes (bridge, forwarder, OpenClaw) were not restarted;
- nothing is listening on 8791;
- no operator state directory exists in the home directory.

## Review 01

All four findings are corrected and tested.

**Evidence:**
- `review/SF-007/review01.diff`;
- `review/SF-007/logs/review01/`;
- `review/SF-007/review01-proof/`.

### Finding 1 (P1): browser-origin authenticity

**The attack, now in the threat model** (design §6). While the operator page was down, another local account could bind `127.0.0.1:8791` and serve script in the operator's origin. That script could read the stored token and keep acting through the operator's browser after the real server returned. The peer-uid check then sees the operator's own browser, and Host/Origin are correct. The earlier claim that a stolen token was "useless from another uid" was wrong for this path and has been removed.

**Decision:** the interaction mechanism was changed. Approvals now happen only in a terminal console (`scripts/sf007-operator.sh`, optional desktop launcher). It has no listener, socket, token or browser page. Instruction text is made inert against terminal escape injection.

**Tested** (`operator-security.test.ts`):
- **Hostile listener and replay:** a hostile listener on 127.0.0.1:8791 receives the browser's captured-token request. After it leaves and the console runs, the same request gets `ECONNREFUSED`. Nothing was approved, prepared or started.
- **No listening socket:** the console process holds no listening TCP, UDP or UNIX socket (checked through `/proc/<pid>/fd` and `/proc/net/*`).
- **No server code:** the operator code contains no server or listener API.
- **Escapes made inert:** OSC/CSI/C1/bidi sequences in instruction text reach the terminal only as visible escapes.

**What this does and does not prove.** The test runs as one Unix account. The "hostile listener" and the "browser" are processes of the test, not a second user and a real browser. With no listener at all, the result rests on the absence of any endpoint (socket and code checks) rather than on the replay alone. X keystroke injection by another account was not tested: on this host `xhost` allows only `SI:localuser:teo` and `~/.Xauthority` is 0600.

**Operator experience trade-off.** "One click" is now:
- one launcher click to open the console;
- typing the job's number and Enter;
- `a` and Enter after reading the instruction.

The console is occupied while the session runs, and the list refreshes on `r` or after each action, not by itself.

### Finding 2 (P1): one shared, atomic session gate

**The gate:** an OS `flock` on `~/.local/state/software-factory/claude-session.lock`.
- **Shared:** SF-006 `ExecutionService.run`, used by both the manual CLI and the console, takes it before `launch.claim`.
- **Held by Claude:** a fixed `python3 -I` helper `exec()`s Claude, so the Claude process holds the gate until it ends, even if its adapter dies.
- **Busy claims nothing:** the job stays `prepared`, and the console can resume it after a new approval.
- **Handoff:** `handoff` prints a `flock`-wrapped command.
- **Hand-started sessions** are found by their session id (`--session-id`, `--resume <id>`, `--resume=<id>`), and the scan fails closed on unreadable records.
- **Checks take nothing:** `preflight` reads `/proc/locks` and never takes the gate.
- **Concurrency is fixed at 1:** the `max_sessions` setting was removed.

**Tested** (`operator-gate.test.ts`, 9 tests). Every one counts the Claude processes actually alive:
- manual start racing an SF-007 launch (3 rounds);
- a manual session started after approval but before attend;
- four competing manual launches;
- a handed-off session started by hand;
- `flock`-gated handoff commands (refused with 75 while busy; blocking while running);
- resumed sessions in both argument forms;
- a Claude that outlives its adapter;
- a crashed holder before launch;
- unsafe gate file and directory modes;
- an unreadable record blocking every launch until repaired.

**Constraints, documented:**
- A hand-started session that neither uses the gated command nor carries its session id is not counted. Examples: `claude --continue`, the in-app `/resume` picker.
- Processes that Claude started and left running keep the gate (fail closed; `fuser` recovery).
- Deleting the gate file while it is held would split the gate (only the operator's own account can).

### Finding 3 (P2): stale-lock takeover

`acquireLock` (SF-006) now replaces a stale lock only through an exclusive takeover marker per stale token and an atomic `rename` over it. The lock path is never absent, and a live lock is never touched. Corrupt locks and leftover markers fail closed, with a documented manual recovery.

**Tested** (`locks.test.ts`, 5 tests, real processes):
- 8 × 25 acquire/release rounds with no overlap;
- 8 simultaneous contenders for one stale lock give exactly one winner (5 rounds);
- a killed holder is replaced;
- PID reuse and another boot count as stale;
- a live holder, corrupt locks and an existing marker are untouched.

All SF-006 tests still pass (`execution.test.ts` 30/30).

### Finding 4 (P2): queue truncation

`scanQueue` reports omitted apps, jobs per app (by app), total omissions and unreadable directories. The console prints "LIST INCOMPLETE" with each limit. No safety decision uses the list.

**Tested** (`operator-queue.test.ts`, 3 tests):
- 102 apps;
- 1,001 jobs in one app;
- 6,001 job directories;
- a live manual session in an app beyond the app limit, which blocks approval and the manual CLI (one live Claude process).

### Independent two-axis review (Review 01)

**Spec/operator UX:**
- **Fixed:**
  - an untracked handoff window, now covered by the gated command;
  - narrow resume detection;
  - a preflight probe that took the real lock;
  - no test or recovery for a corrupt record.
- **Documented:**
  - the UX trade-off;
  - inherited-descriptor holders;
  - the same-uid nature of the squat test.

**Security/standards:**
- **Fixed:**
  - the gate file is re-checked after locking, and its directory must be private;
  - helper failures are no longer mistaken for a launch, and spawn errors are handled;
  - a bookkeeping error after the exec no longer marks a running session `failed`;
  - all job-derived text in attend is made inert (`text.ts`);
  - the busy messages name the holder, "or a process it started";
  - duplicated `/proc` walk and busy message removed; stale comments and unclear names fixed.
- **Remaining judgement calls:** the directory walk is still duplicated between the SF-006 session scan and the operator queue (different modules and bounds), and `status()` runs one `/proc` scan per running job.

### Evidence

- `npm run smoke` on a clean rebuild: **112/112** (`logs/review01/test-suite.log`).
- Real `gnome-terminal` 3.52 console proof on Xvfb with a private D-Bus session (`logs/review01/console-proof.log`, `review01-proof/*.png`):
  - queue, then review with the exact instruction;
  - `a`, then the fake Claude's permission prompt answered by X key events, then "finished?" `y`;
  - `completed`, with four artifact hashes OK and one Claude process with TTY stdio and manual permissions;
  - back to the queue, then `q`.
- `logs/review01/final-checks.log`:
  - OpenClaw Compose and receiver, `sf006-execute.sh` and `factory-data` are unchanged;
  - the Git index is identical to the SF-007 baseline;
  - no launcher, unit or state directory is installed, nothing listens on 8791, and no test processes remain.

### Readiness

**Ready for a one-time installation:** the optional desktop launcher (nothing else needs installing). The browser-origin attack no longer applies, because there is no browser endpoint. Every Software Factory launch through `run`, and every handed-off command started as printed, shares one OS-enforced gate.

**Before real use, the operator should accept these constraints:**
- the hand-started-session constraint above;
- the keystroke-based console in place of a web button;
- the first real run through SF-007 is still unproven.

That first real run remains a separate, supervised pilot.

## Review 02

Three narrow corrections from the independent review of Review 01. The console-only interface, the shared `flock` gate, `launch.claim` and the approval model are unchanged.

**Evidence:**
- `review/SF-007/review02.diff`;
- `review/SF-007/logs/review02/`;
- `review/SF-007/review02-proof/`.

### R2-1: launch evidence

**Before:** a closed control channel without `EXECFAIL` counted as a launch. A killed or crashed helper looked the same.

**Now:** at `HELD`, the adapter records the helper's start time and executable. When the channel closes, it checks that same process:
- **Confirmed launch:** it runs another executable, or its arguments are no longer the helper's.
- **Confirmed non-start:** an explicit `EXECFAIL`/`ERROR`. SF-006 records `failed` / `runner_failed`.
- **Indeterminate:** everything else. The helper is gone (killed, crashed, or the target ended at once), the process is alive but not shown to have exec'd within about 2 s, or there was no hand-over within 30 s (then the helper is stopped with SIGKILL). SF-006 records `needs_inspection` / `launch_unconfirmed`, with a recovery text that sends the operator to inspect the repository.

**In every case:** `launch.claim` stays and nothing is retried. Every wait for an exit is bounded, and the gate is free afterwards (no leaked holder).

**What remains ambiguous:**
- A genuine Claude that ends within microseconds of starting is indistinguishable from a helper that died, so it is reported as unconfirmed, never as a helper failure.
- A process that stays alive without visibly switching program is reported as unconfirmed, and is neither waited on nor killed.

The independent review corrected the first draft of this check. Its draft relied on `/proc/<pid>/cmdline`, which can read as empty right after exec. It also had no defence against pid reuse, and two unbounded waits.

**Tests** (`launch-evidence.test.ts`, 8):
- SIGKILL and SIGTERM after `HELD`;
- stopped, then killed after the request was written;
- adapter-side release;
- `EXECFAIL` and SIGINT before exec;
- the timeout path;
- the evidence check (alive but not exec'd, pid reuse, exited);
- normal, brief and immediate exits;
- SF-006 `run` with a fault-injected helper (needs_inspection, claimed, never retried, no Claude process);
- `EXECFAIL` after the claim;
- a confirmed session whose adapter dies (stays `running` with the Claude pid, the gate held by it, no relaunch, `collect` gives `interrupted`).

### R2-2: record validation in the hand-started-session scan

**Policy** (`sessionActivity()`, using SF-006's `STATES` and a UUID session id):
- **Never block:** `prepared`, `completed`, `failed`, `needs_inspection`, whatever else the record holds.
- **Count only with a valid session id:** `running`, `pending_manual`, `interrupted`.
- **Block, with a fixed diagnostic** of the form `Running sessions cannot be verified: <verified path or id> (<category>)`:
  - an unknown state or schema;
  - an unreadable or non-JSON record;
  - an app or jobs directory that is a symlink, not a directory, or unreadable.
- **Not blocking:** a missing `factory-data`/`apps`/`jobs` directory (never initialized, no jobs yet).

Session ids are matched in any letter case.

**Real data, read-only** (`logs/review02/real-records-classification.log`): all 10 existing `execution.json` files are inactive. They include `sf006-demo/demo-20261026a` and the completed `sf006-demo/real-claude-pilot-20261026`. Nothing real is blocked.

**Tests** (`session-scan.test.ts`, 4):
- a missing, null, numeric, malformed or invalid UUID session id, and a non-object session;
- an unknown state, a missing state, an unknown schema, an array, non-JSON;
- malformed terminal records and a synthesized earliest-format record;
- live `--session-id` (an upper-case recorded id), live `--resume`, and an idle handed-off record;
- symlinked app and jobs directories, an unreadable jobs directory, an app without jobs, a never-initialized mediator.

Each blocked case checks that there is no `launch.claim`, no Claude start, and the same refusal from `preflight`.

One SF-006 test fixture (`launch.claim prevents a second launch…`) deliberately left a malformed record in the shared fixture. Under the new policy it now (correctly) blocked all later launches in that file: 13 failures in the first full run. The test now restores the record after its assertion.

**Not changed:** directory entries whose names are not valid ids are not adapter jobs and are skipped, as before.

### R2-3: queue coverage

`scanQueue` classifies `factory-data`, `factory-data/apps`, each app directory and each `jobs` directory with `lstat`, never following links:
- **Missing roots:** "not initialized yet: nothing has been dispatched", a clean empty state.
- **A missing `jobs` directory:** an app without jobs.
- **A symlink or non-directory, cannot be inspected, cannot be listed:** `LIST INCOMPLETE`, with the path built from verified ids.

The listing remains display-only.

**Tests:** in `operator-queue.test.ts`, three new tests cover:
- missing versus symlinked, file and unreadable roots;
- symlinked, file, unreadable and unsearchable app and jobs directories;
- a clean listing after repair;
- the target of a link is never listed, and nothing is written.

### Evidence and status

- **Full suite** (`npm run smoke`, clean rebuild; the shared gate and runner changed): **127/127** on the second run, after the fixture fix above. The first run's 13 failures are kept in `logs/review02/test-suite.log`.
- **Focused excerpt:** `logs/review02/focused-tests.log`.
- **Real-terminal proof:** the `gnome-terminal` console proof on Xvfb was rerun (`logs/review02/console-proof.log`, `review02-proof/`). A genuine fake-Claude launch is still confirmed and reaches `completed`.
- **Final checks** (`logs/review02/final-checks.log`):
  - OpenClaw Compose and receiver, `sf006-execute.sh` and `factory-data` (including `demo-20261026a`) are unchanged;
  - the Git index is identical to the SF-007 baseline;
  - the earlier evidence is unchanged;
  - nothing is installed or listening, and no test processes or temp directories remain.

**Readiness** is unchanged from Review 01: the optional launcher could be installed, but a real Claude run through SF-007 remains unproven and is a separate supervised pilot.

## Review 03

Two focused P2 corrections from the independent review of Review 02. The console, the shared `flock` gate, the launch evidence, `launch.claim` and the approval model are unchanged.

**Evidence:**
- `review/SF-007/review03.diff`;
- `review/SF-007/logs/review03/`;
- `review/SF-007/review03-proof/`.

### R3-1: bounded gate-helper lifecycle

Every wait on a helper now has a finite deadline. Defaults: 10 s for the first answer, 5 s for any exit, 30 s for a hand-over. Tests inject 0.5 s.

**A helper that was not, or not successfully, told to exec Claude is stopped with SIGKILL.** That covers a helper that is silent or stopped before `HELD`, lingers after `BUSY`, `ERROR` or `EXECFAIL`, or does not end on `release()`. The gate counts as free only when the helper's exit was observed and `/proc/locks` (read successfully) shows no lock of its pid. Otherwise the call fails closed with `gate_unresponsive`, naming the pid with a runbook pointer, and every later reservation sees the gate busy.

**After the launch request was delivered, nothing is killed.** A missing hand-over after 30 s is `launch_unconfirmed`, naming the process left running, which keeps the gate. The first draft killed in this case after one `/proc` check; both reviewers objected, and it was removed.

In `ExecutionService.run`, a release failure on an error path no longer hides the original error; its diagnostic is appended. All of this happens before `launch.claim`, so the job stays `prepared` and nothing is claimed or started.

**Tests:**
- **`gate-lifecycle.test.ts` (6):**
  - silent and SIGSTOPped helpers before `HELD`;
  - a lock-holding helper that cannot be ended (fails closed; the next reservation is busy);
  - `BUSY` and `ERROR` followed by a hang;
  - `EXECFAIL` followed by a hang;
  - SIGSTOP during `release()` (stopped, the gate verified free, no target started);
  - an unkillable stopped helper during `release()` (`gate_unresponsive`; the gate stays busy; SF-006 `run` refuses before the claim);
  - `run` with a silent helper (refused before the claim; the job stays prepared);
  - positive controls: free and busy reservations, a successful exec, an immediate exit.
- **`launch-evidence.test.ts`:** a stopped helper at the hand-over timeout is reported within 5 s, not killed, and keeps the gate.

Every call returned within its bound (under 4 s with the test deadlines). The old unbounded waits were restored in the compiled code as a mutation check: the handshake, release and `run` tests then hung until the test timeout.

**Limits:**
- A helper in an uninterruptible kernel wait cannot be ended by any signal. That case is reported as `gate_unresponsive` and left to the operator, not recovered.
- A helper that is left running after a missed hand-over keeps the gate until it ends or the operator ends it.

### R3-2: resumed terminal sessions

`sessionActivity()` now treats a `completed`, `failed` or `needs_inspection` record with a valid session id as a candidate for the liveness check. The record blocks only while a process carries that id, in the forms `--resume <id>`, `--resume=<id>` and `--session-id <id>`, in any letter case. The same policy applies to `failed` and `needs_inspection`, because their sessions can be resumed in the same way.
- **Without a usable id:** a terminal record stays inactive, so historical records never block for being old.
- **Unchanged:** `prepared` is inactive; unknown states and schemas, and live states without an id, still fail closed.

**Real data** (`logs/review03/real-records-classification.log`): all 10 completed records are candidates with no live process. That includes `sf006-demo/demo-20261026a`, which does carry a valid session id, so the instruction's expectation that it lacks one does not hold. Nothing real is blocked.

**Tests** (`session-scan.test.ts`): a completed record resumed with `--resume <id>`, `--resume=<id>` and mixed case, plus `failed` and `needs_inspection` records. Each case checks:
- the manual CLI is refused before `launch.claim`;
- preflight reports `session_busy`;
- the console approval is refused;
- exactly one live process;
- the same record stops blocking after the process exits.

Not-running completed records, a completed record without an id, and an earliest-format record without an id are non-blocking controls, and the final launch succeeds.

**Limit (fail closed):** any process whose command line contains a recorded id counts, including a transcript viewer such as `tail -f …/<id>.jsonl` (runbook). Sessions started without an observable id (`claude --continue`, the resume picker) are still not detected.

### Evidence and status

- **Full suite** (`npm run smoke`, clean rebuild; the shared gate code changed): **134/134** on the first run (`logs/review03/test-suite.log`).
- **Focused excerpt:** `logs/review03/focused-tests.log`.
- **Real-terminal proof:** the `gnome-terminal` console proof was rerun and reached `completed` (`logs/review03/console-proof.log`).
- **Final checks** (`logs/review03/final-checks.log`):
  - OpenClaw, `sf006-execute.sh` and `factory-data` are unchanged;
  - the Git index is identical to the SF-007 baseline;
  - the earlier diffs and evidence are unchanged;
  - nothing is installed or listening, and no test processes remain.

**Readiness** is unchanged: the optional launcher could be installed, but a real Claude run through SF-007 remains a separate, supervised pilot.

