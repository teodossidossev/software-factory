# SF-009 report: one authorization in ChatGPT, auto mode, review iterations in one session

> **Current status (2026-10-29, job `sf009-context-continuity-20261029`).** Evidence matrix:
> `review/SF-009/context-continuity-20261029/EVIDENCE.md`.
> - **Active runtime:** the supervisor and the bridge run from the canonical `bridge/dist`
>   (built 2026-10-29 09:21 UTC) as transient systemd user units; no unit file is installed.
>   Policy epoch 5; `sf009-self-fix` is enabled for self-hosting on the main checkout
>   (`self_hosting_unconfined`, no sandbox). Real Claude Code 2.1.312 sessions run through it in
>   `--permission-mode auto`; since that activation, two self-hosted jobs were reviewed and accepted.
> - **Accepted source, not in the runtime:** the read-only observer (`observe`) is in `bridge/src`
>   but not in the canonical `bridge/dist`. Run it from the validation build (runbook).
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

**Original stage (2026-10-27, historical; superseded by the current status above):** implemented and proven with a fake stream-json Claude in disposable repositories. **Stopped for independent review.**
- **Nothing installed:** no service, unit, opt-in, credential, setting or listener was installed, enabled or started.
- **No real Claude session** ran through the new launcher. A real pilot needs separate operator approval.
- **Not touched:** the running SF-008 job, both Ontology Manager checkouts, the real `factory-data` (hashes identical), the OpenClaw files and `sf006-execute.sh`.
- **No Git operations:** the index is identical to the baseline; there are no commits (the checkout has no HEAD).

## The operator's day, before and after

| Before (SF-007) | After (SF-009, once installed and opted in) |
|---|---|
| Approve in ChatGPT; open a terminal; find the job; type `a` | Approve in ChatGPT. That call is the authorization |
| Answer each Claude permission prompt | None: `--permission-mode auto`; refusals reported as `needs_operator` |
| `/exit`, answer "Did /implement finish?" | Nothing: Claude's turn end publishes a verified snapshot; the session stays alive |
| Tell ChatGPT to read exported files | Tell ChatGPT "review job X". Its findings go to the same session as the next iteration |
| New job for every correction | Same job, same claim; `compact`/`reset` on request |
| — | Say "accept" (or run `accept` locally): the session ends and is collected. Git stays yours |

**Still manual:** telling ChatGPT that a snapshot is ready (no supported trigger exists), and Git.

## Phase 0 findings

Design §2 has the table. In short:
- Claude Code 2.1.311 documents `--permission-mode auto`, `--permission-prompts none` and stream-json input and output for `-p`. Together they give one process with several turns and a protocol-level turn end.
- Background sessions have no documented reply API, and they isolate into worktrees by default (`worktree.bgIsolation`).
- **UNVERIFIED** without a real session: whether auto mode is enabled for this account/model, the `permissionMode` field timing in `system/init`, and `/compact` over stream-json.
- *Later (2026-10-29):* the operator-supplied probes show auto mode available and `permissionMode: auto` in `system/init` with Claude Code 2.1.312. The active runtime has completed managed jobs, which it does only when every process reports `auto`. Later the same day the supervisor recorded one ChatGPT-requested `/compact` in a real managed session `performed` (its condition: `compact_boundary` plus a completed `result`), with session, process and tree unchanged, and the next correction was published normally (job `sf009-context-continuity-20261029`); see "Context continuity" below.

## Requirement status

| # | Requirement | Status | Evidence |
|---|---|---|---|
| P0 | Capability investigation and design note with rejected alternatives | IMPLEMENTED + TESTED (help and binary only; the real-session items are UNVERIFIED as listed) | design §2, §7 |
| P1.1 | Narrow MCP authorization tool binding app, job, request, sha256, repository identity, auto, epoch/nonce, expiry; dispatch never implies authorization | IMPLEMENTED + TESTED | `executor-refusals` "authorize checks…", `executor-mcp` |
| P1.2 | Honest trust boundary; one-time local opt-in and allowlist; no per-job approval; out-of-policy, stale and replayed requests refused | IMPLEMENTED + TESTED | design §3; `executor-refusals` (opt-in, withdrawn app, stale epoch, forged files, replay) |
| P1.3 | Owner-private supervisor; single launch (`launch.claim` + gate + consumption); bounded audit; queue behind a busy gate only while valid | IMPLEMENTED + TESTED | `executor-recovery` racing; `executor-refusals` gate/expiry |
| P1.4 | No forgery via OpenClaw, JSON, instruction text, loopback page, other users' listener or replay; no listener | IMPLEMENTED + TESTED (no listener exists; the same Unix user is out of scope) | forged-file test; design §3 |
| P1.5 | No tool argument selects a command, executable, cwd, env or credentials | IMPLEMENTED + TESTED | `executor-mcp` rejects extra fields; fixed `managedArguments` unit test |
| P1.6 | Honest statuses: `needs_operator`, `blocked`, `queued`; never "started" when only accepted | IMPLEMENTED + TESTED | `executor-refusals` (no supervisor, gate busy, dirty repo) |
| P1.7 | Real MCP → supervisor fake-Claude proof, with no console and no per-job commands | IMPLEMENTED + TESTED | `executor-mcp.test.ts` |
| P2.1 | Exactly `--permission-mode auto`; no bypass or skip | IMPLEMENTED + TESTED | argv assertions in three tests |
| P2.2 | Auto-mode refusal surfaced as `needs_operator`, not overridden | IMPLEMENTED + TESTED (fake denials) | `executor-scope` refused-action test |
| P2.3 | Scope to the registered repository; no isolation claimed | IMPLEMENTED + TESTED by detection. **Prevention outside the repository: not provided** (not a sandbox) | design §6 |
| P2.4 | Operator-owned Git rule enforced where possible, with regression checks | IMPLEMENTED + TESTED: deny rules (unit) and turn-end detection (real commit test) | `executor-scope`, `executor-units` |
| P2.5 | No `.env`, secrets or host settings touched; SF-006 export safeguards reused | IMPLEMENTED + TESTED for exports (secret test); `.env` deny rules UNVERIFIED with real Claude | `executor-scope` secret test |
| P2.6 | Personal Claude settings untouched; auto only per session | IMPLEMENTED (no settings write exists; per-process flag) | code |
| P2.7 | Auto mode unavailable: fail visibly, never `manual` | IMPLEMENTED + TESTED (fake reports `default` → stopped at once, `failed`) | `executor-refusals` |
| P3.1 | Versioned per-job and per-iteration protocol; legacy records untouched | IMPLEMENTED + TESTED | `managed.json`; `execution.json` additions optional; legacy-audit tests pass |
| P3.2 | Turn idle vs process exit vs logical completion vs acceptance kept apart | IMPLEMENTED + TESTED | slice test: `execution.json` `running` while `awaiting_review` |
| P3.3 | Observed turn end → immutable, numbered, sha-verified snapshot; failed capture distinct; writes during capture detected | IMPLEMENTED + TESTED | slice; background-writer test; crash-during-capture test |
| P3.4 | Session alive and addressable across review; same job | IMPLEMENTED + TESTED (same pid across iterations) | slice, `executor-mcp` |
| P3.5 | Typed MCP list, snapshot and review; bound to job, iteration, sha and review id; stale, duplicate and wrong-app refused; idempotent replay | IMPLEMENTED + TESTED | slice |
| P3.6 | Findings reach the same session without terminal mediation | IMPLEMENTED + TESTED | `executor-mcp` |
| P3.7 | A changed tree under a pending review → conflict, never replayed | IMPLEMENTED + TESTED | `executor-scope` revert test |
| P3.8 | Gate kept across working and idle; restart never doubles work | IMPLEMENTED + TESTED | `executor-recovery` |
| P3.9 | Proactive ChatGPT trigger | **BLOCKED**: no documented, operator-authorized trigger found; not invented. On-demand review is fully functional | design §8 |
| P4.1 | `factory_manage_session_context` compact/reset at a safe boundary, bound to iteration and session | IMPLEMENTED + TESTED (fake) | slice |
| P4.2 | Continuation note first; no secrets or raw transcripts | IMPLEMENTED + TESTED | slice asserts content |
| P4.3 | compact observed (`compact_boundary` + result) | IMPLEMENTED + TESTED with the fake; UNVERIFIED with real Claude | |
| P4.4 | reset without a new job or claim; refused if the gate cannot be retaken | IMPLEMENTED + TESTED. **Residual gap:** the hand-over is not atomic (design §5) | slice: one claim, two processes, lineage |
| P4.5 | Idempotent, auditable, `performed` only on acknowledgement; nothing deleted | IMPLEMENTED + TESTED | |
| P4.6 | A review after compact and after reset; scope kept | IMPLEMENTED + TESTED | slice iterations 3 and 4 |
| P5 | Final acceptance is its own transition; idle is never completion | IMPLEMENTED + TESTED | slice, `executor-mcp` |
| L | One-time installation (the user unit) | **NOT INSTALLED** by design; template + dry-run render tested. *2026-10-29: the supervisor runs as a transient user unit; no unit file is installed* | `executor-units` |

**Not claimed:**
- the end-to-end UX *with* a proactive review trigger;
- a running supervisor (it needs the operator's install or `run` and opt-in);
- any real Claude behaviour.

*Later (2026-10-29):* a supervisor runs and real sessions ran through it; see the current status at the top. Real `compact` and real `reset` were later each verified once (see "Context continuity" below).

## Tests

**Full suite** (`npm run smoke`, clean rebuild): see `review/SF-009/logs/test-suite.log`. Review 03's 134 earlier tests plus 26 new SF-009 tests. The result line is quoted in `review/SF-009/MANIFEST.md`.

**Focused runs:**

```bash
cd bridge && rm -rf dist && npx tsc && node --test dist/test/executor-*.test.js
```

| File | Proves |
|---|---|
| `executor-flow.test.ts` | Vertical slice: one authorization → one auto launch → iterations 1–4 (review, compact, review, reset, review) → acceptance → `completed`; Git untouched; no host paths in readable files |
| `executor-mcp.test.ts` | The same over the real MCP boundary, with the bridge and the supervisor as separate processes |
| `executor-refusals.test.ts` | No opt-in, no supervisor, authorize binding/replay, dirty repository (and a launch once it is clean), changed instruction, withdrawn app/epoch, occupied gate, expiry while queued, forged files, auto mode unavailable, a second authorization |
| `executor-scope.test.ts` | Refused action → `needs_operator`; real commit → `needs_inspection`; protected checkout; secret export withheld; background writer → `snapshot_failed`; revert under review → `conflict` |
| `executor-recovery.test.ts` | Racing supervisors; SIGKILL'd supervisor; crash during capture |
| `executor-units.test.ts` | Fixed argv, lineage scan policy, stream-json parsing, CLI dry run (refuses without opt-in, renders the unit only) |

**The earlier SF-006/SF-007 tests run unchanged,** except `smoke.test.ts`'s exact tool list. This is justified by the shared changes to `service.ts`, `runner.ts` and `session-gate.ts`.

## Security and spec review (before this report)

Two independent reviews ran on the diff: standards and spec. Resolved:
- raw error text with possible host paths in `managed.json` → coded messages only;
- an auto-mode fallback ran a whole turn → stopped at the first `system/init`;
- ignored credential files were outside the fingerprint → included;
- `.env` deny rules added;
- restart recovery trusted `managed.json` alone for acceptance → also requires the bound acceptance request;
- no local acceptance → `accept` command;
- stop-listener build-up, continuation-note failure handling, shared pre-launch checks, constants.

**Documented, not changed:**
- the non-atomic gate hand-over on reset;
- no prevention of writes outside the repository;
- same-user file forgery is out of scope;
- test evidence is the transcript's ok/error per command (Claude Code does not record exit codes there).

## Next actions (operator decisions)

1. Independent review of SF-009.
2. If approved, a supervised real pilot:
   - opt in one disposable app (`enable --app`);
   - run the supervisor in a terminal;
   - authorize one job from ChatGPT;
   - verify the UNVERIFIED items: `system/init.permissionMode`, `/compact` over stream-json, transcript evidence for `/implement` sent as a stream-json message, and auto-mode availability.
3. Optional: install the user unit; `chmod g-w factory-data factory-data/apps`.

*Later (2026-10-29):* steps 1 and 2 have been overtaken by Reviews 01–06, the operator-supplied probes and the self-hosted activation (current status at the top). `/compact` over stream-json and a real reset have since each been verified once ("Context continuity" below).

## Review 01 (2026-10-27): corrections to the first independent review

**How it ran.** This was the first dogfooding run. The SF-009 supervisor (user unit `sf009-supervisor.service`, running the mediator's own build) launched this Claude Code session in `--permission-mode auto` in the operator-designated, isolated pilot checkout `pilots/sf009-self-fix-…/software-factory`. It used the instruction `.software-factory/jobs/sf009-review01-self-fix-20261027/instruction.md`. The process tree and the session environment showed the managed `claude -p … --permission-mode auto … --disallowedTools …` under that unit.
- **Changes:** the session changed only the working tree of that checkout.
- **Untouched:** Git (nothing staged or committed: the supervisor treats any HEAD or index change as `git_operation_detected`), the running mediator and its build, SF-008, the Ontology Manager checkouts, OpenClaw, host settings.
- **Snapshots:** the iteration snapshot of this turn is the supervisor's to capture (`factory_review_snapshot`). Nothing here claims it exists.

| Finding | Correction | Status | Tests |
|---|---|---|---|
| R1-1 P1: consumed marker bypassed a failed approval | `consumed/<id>` is now a typed, tuple-bound use record naming one SF-007 approval id. A launch proceeds only once that approval is proven consumed with the same tuple (create, consume, or recover by id after a restart). Any failure writes `refused/<id>`, which is checked before preflight and never retried, and settles its own pending approval `refused`. Pre-Review-01 markers fail closed | IMPLEMENTED + TESTED | `executor-approval.test.ts` (12) |
| R1-2 P1: acceptance not bound to the final tree | The acceptance carries the accepted snapshot's tree identity, its diff sha256 and the session's live descendants. After the process ends, SF-006 waits for those descendants (bounded), compares the tree, exports, compares again, and compares the diff hash. Drift gives `needs_inspection`/`acceptance_drift` with honest artifacts; the snapshot is never rewritten. Snapshot bytes are re-hashed when a review or acceptance is bound. The restart-recovery collection uses the same check | IMPLEMENTED + TESTED (recovery-path drift: code only) | `executor-acceptance.test.ts` (8) |
| R1-3 P1: auto mode does not isolate | Enforcement documented exactly (design §6 table). No sandbox is implemented or claimed. Production auto execution is refused: `enable` requires `--disposable-pilot`; the supervisor refuses, and the bridge does not authorize, apps without it (`unsupported_isolation`), including policies from before Review 01 | IMPLEMENTED + TESTED | `executor-isolation.test.ts` (7), `executor-units` |
| R1-4 P2: silent truncation | A bounded `ScanSummary` (complete, counts, ≤20 coded issues with app ids, no paths). It appears in the supervisor heartbeat (and a `SCAN INCOMPLETE` log line) and in `factory_list_review_ready`. `scan_incomplete` status instead of `pending_supervisor`. Symlinks are not followed | IMPLEMENTED + TESTED (an enumeration race: code only) | `executor-scan.test.ts` (8) |

**Blocked or not done:**
- no OS sandbox: none exists on this host, and none was built or faked;
- no service, opt-in, setting or checkout change by this session;
- the "disposable pilot" conditions (no real credentials, no other writable checkout) are an operator declaration and are not verified;
- red runs of the new tests against the unchanged code were not executed: the new tests need the new fixture seams.

**Test runs (all reported):**

| Run | Result |
|---|---|
| Focused SF-009 tests, baseline before changes | 26/26 |
| Focused set during development (`executor-*`, `locks`, `execution`, `session-scan`, `operator-*`, `gate-lifecycle`, `launch-evidence`, `legacy-audit`) | 152/153. The one failure is `operator-assets` (missing `deploy/operator`, see below) |
| Full suite, before the review fixes | 187/193 |
| Full suite on an untouched `git archive HEAD` copy of the baseline | 154/160 |
| Full suite, final, clean rebuild | **189/195** |

The same 6 tests fail in the baseline and in the final run. This allowlisted pilot snapshot does not contain `deploy/openclaw/sf-dispatch-receiver.mjs` (5 `dispatch-receiver` tests) or `deploy/operator` (1 `operator-assets` test). These failures are environmental, not regressions. The SF-007 stale-lock contender test passed in every run here.

**The full suite is not green.**

## Review 02 (2026-10-27): stable review boundaries, acceptance integrity, approval fail-closed

**How it ran.** This was a new, distinct SF-009 job (`.software-factory/jobs/sf009-review02-snapshot-reliability-20261027/instruction.md`), not a replay of Review 01. It was one managed Claude Code session in `--permission-mode auto` in the disposable pilot checkout. It started with one `/implement` invocation and used no manual SF-007 console. It used no authorization beyond this job's own.
- **Supervisor:** the session was launched by the installed mediator supervisor, which does **not** contain these fixes.
- **Git:** nothing was staged, committed, stashed or reset. HEAD stays `f92ef57`, the operator's clean Review 02 baseline.
- **Outside the checkout:** nothing outside this checkout was changed: not the mediator, `factory-data`, services, OpenClaw, Docker or host settings. Neither Ontology Manager checkout was read or touched.
- **Background work:** the turn ends only after every test run and review agent had finished. No background timers or second Claude session were used.

| Finding | Correction | Status | Tests |
|---|---|---|---|
| R2-1 P1: snapshot published while background writers ran | **Quiescent boundary** (`executor/quiescence.ts`). Session processes are found by parent link **and** by an inherited environment tag (`SOFTWARE_FACTORY_MANAGED_SESSION`, set by `ManagedClaudeRunner`), by pid plus start time. Open stream-json background tasks also count. Any stdout output or tree change resets a 5 s quiet window. The wait is bounded at 20 min, then `snapshot_failed` with the reason. The scope check and fingerprint run again around the export and before publication. A further `result` during the wait belongs to the same iteration. A late `result` after publication is taken and checked (`late_turn`). The reason is visible while waiting (`snapshot_waiting`). Nothing is killed | IMPLEMENTED + TESTED. The task event names are UNVERIFIED against the installed Claude Code | `executor-quiescence.test.ts` (19), `executor-scope` (updated) |
| R2-2 P1: accepted tree vs final completed result | After the result files are written, and right before the outcome is persisted, `#finish` checks again: no session process, the accepted tree identity, the accepted diff hash. An error counts as drift. On drift: `acceptance_drift`, the files are rewritten to describe that outcome, and the snapshot is untouched. Test seam `afterArtifactsWritten` | IMPLEMENTED + TESTED. Restart recovery uses the same `#finish`; its late-drift case is covered by code only | `executor-acceptance.test.ts` (+7: writer, session process, HEAD, index, control file, withheld export, unchanged; plus the acceptance-time wait for a tagged process, which replaces the Review 01 delayed-writer test) |
| R2-3 P2: double failure could later approve | A later attempt (retry or restart) never resumes an unconsumed approval (`approval_interrupted`; a pending one is withdrawn). Only an already consumed approval proves the launch after a restart. A caught failure is recorded in memory, `refused/<id>`, the SF-007 settlement and `managed.json` (`approval_failed`) | IMPLEMENTED + TESTED. **Behaviour change:** two Review 01 recovery cases now refuse instead of launching | `executor-approval.test.ts` (+2 double-failure tests with real permission faults: retry, restart, restart without the `managed.json` evidence; 3 recovery tests updated) |
| R2-4 P2: artifacts not verified at binding | `verifiedArtifacts` is shared by `#bound`, restart recovery and `factory_review_snapshot`. The check covers: own file names, a regular file of this user, no symlink, ≤ 4 MiB, and the sha256. A failure gives `snapshot_artifact_invalid`, then conflict, then `needs_inspection`. Nothing is delivered or accepted | IMPLEMENTED + TESTED | `executor-integrity.test.ts` (6) |

**What is guaranteed and what is not.**
- **No sandbox.** There is still no OS sandbox. Process attribution is same-user `/proc` inspection. A process that clears its environment **and** leaves the process tree is not found. An unrelated same-user program can write at any time.
- **Fingerprint checks.** They catch writes during the capture and before publication. A later write is caught when a review or acceptance is bound.
- **Post-export checks.** They narrow the race, but there is no atomic write guarantee against unconfined same-user writers. A hard guarantee needs filesystem confinement (design §9).
- **R2-3 residual.** One narrow case remains: the consume step reports an error after it took effect, *and* all three durable failure writes fail, *and* the supervisor restarts.

**Test runs:**

| Run | Result |
|---|---|
| Executor suites, first run after the code change (before the tests were updated) | 55/61. The 6 failures are the intended behaviour changes (`logs/dev-executor-run1-before-test-updates.log`) |
| Executor suites during development | One intermittent failure (`logs/dev-executor-run-transient-indeterminate.log`). Its cause was real: a same-user process exiting or exec-ing refused the environment read for a moment and was counted as unidentifiable. Fixed by re-checking its stat, plus a ≤ 1 s re-scan for instant checks. The test bound for positive writer tests was raised from 4 s to 10–12 s (production bound: 20 min) |
| Executor suites (`executor-*`), 3 consecutive runs, final code (after the code-review fixes) | **95/95, 95/95, 95/95** (`logs/executor-repeat-run{1,2,3}.log`) |
| Focused: SF-009 + SF-006/SF-007 suites (`execution`, `operator-*`, `gate-lifecycle`, `launch-evidence`, `session-scan`, `locks`, `smoke`) | **186/187**. The one failure is `operator-assets` (missing `deploy/operator`) |
| Full suite, final, clean rebuild (`npm run smoke`) | **223/229** (net +34 tests over Review 01's 195; one Review 01 acceptance test was replaced) |

The 6 failures are the same known environmental ones as in the Review 01 baseline and final runs: 5 `dispatch-receiver` tests (no `deploy/openclaw/sf-dispatch-receiver.mjs`) and 1 `operator-assets` test (no `deploy/operator`). There is no new failure. The SF-007 stale-lock contender test passed. **The full suite is not green.**

**Code review (standards and spec, two read-only sub-agents, both finished before this report):** `review/SF-009/review02/findings.md` lists every finding and what was done with it. Main fixes:
- an unreadable `/proc` now fails closed (it read as "no writers");
- the restart-recovery scan starts from the session's recorded start;
- the acceptance-time wait has a test again;
- the late turn after publication is tested.

Main documented choices:
- R2-3 does not resume crash recovery for unconsumed approvals;
- `finalDrift` compares the in-memory export and does not export again;
- the gap between the final check and the `execution.json`/`managed.json` write remains, caught later at binding or not at all.

**Review a0b86c38 (iteration-002).** The iteration-001 export was withheld: the committed test logs held the checkout's absolute host path in Node stack traces. The logs now carry `<app-repo>` and `~` instead (only those substitutions). No changed or new file contains the path, and none matches the export's credential patterns. The export filters are unchanged.

**Review 1ff34ac1 (iteration-003): four fail-open gaps closed** (details: `review/SF-009/review02/findings.md`, design §9).
- **Output after the quiet window:** it now discards the capture.
- **`/proc` scan:** a truncated process list and an unreadable same-user stat are indeterminate.
- **Late-turn refused actions:** they block the acceptance (`late_turn_refused`, `late_refused_actions`).
- **Background tasks:** overflow and long ids fail closed.

There are 4 new regression tests.

| Run (after these fixes) | Result |
|---|---|
| `executor-*`, 3 consecutive runs | **99/99, 99/99, 99/99** |
| Focused SF-009 + SF-006/SF-007 | **190/191** (`operator-assets`) |
| Full suite, clean rebuild | **226/233** |
| Full suite, second run | **226/233** |

In both full runs, 6 failures are the known environmental ones. The seventh was one SF-007 `locks.test.ts` timing test, a different one in each run: "a holder killed while holding is replaced by one contender" (3 wins counted, 2 expected), then "a stale lock is taken over by exactly one of many simultaneous contenders" (2 `won`).
- This is the timing assumption documented since the first SF-009 package: a contender that starts late takes the lock after the winner released it, and it is logged after every refusal.
- `locks` passed 5/5 in isolation (`logs/locks-isolation.log`) and in the focused run.
- The 8×25 mutual-exclusion overlap test passed in every run.
- The lock code and tests are unchanged and were not edited.
- The heavier suite (more process-spawning tests) makes this more likely; that is stated rather than hidden. **The full suite is not green.**

**Review 9a4e25e0 (iteration-004): late results at the commit boundary.**
- **Commit boundary:** reviews and acceptances are committed only when no late outcome is queued (deferred until it is handled), and with no open task and no output since the boundary was last known quiet (else `session_active`). They are checked before and after the record is written; a failing post-commit check withdraws the acceptance.
- **Stale results:** results carry a sequence number, so a result that predates a review message never completes the next iteration.
- **Failed late turns:** these (`is_error`) make the snapshot not acceptable (`late_turn_error`).

There are 4 new regression tests; the two race tests were shown red without the fix.

| Run (after these fixes) | Result |
|---|---|
| `executor-*`, 3 consecutive runs | **103/103** each |
| Focused | **194/195** (`operator-assets`) |
| Full suite, clean rebuild | **231/237** (only the 6 environmental failures) |
| Full suite, second run | **230/237** (the 6 plus the intermittent SF-007 stale-lock contender timing test; lock code and tests unchanged) |

**The full suite is not green.**

**Review 97dbc7ac (iteration-005): causality and the idle fence.**
- **Correlation:** results are attributed by Claude Code's acknowledgment of each message (`--replay-user-messages`, uuid). A result that predates the acknowledgment of a review is recorded on the reviewed iteration and never becomes the new snapshot. Without acknowledgments, reviews are refused, never guessed.
- **Review commit:** a review is rolled back if Claude reports anything while it is being recorded.
- **Publication:** keeps the capture's verified quiet token.
- **Activity after publication:** leads to a bounded re-quiescence (scope, process, task and tree checks) instead of endless rejections; on timeout `boundary_unstable` with requests left pending.

There are 9 new tests, each shown red without its fix (`logs/mutation-checks.log`). **UNVERIFIED:** the exact replay event shape of the real CLI.

| Run (after these fixes) | Result |
|---|---|
| `executor-*`, 3 consecutive runs | **111/111** each |
| Focused | **202/203** (`operator-assets`) |
| Full suite, clean rebuild | **238/245** |
| Full suite, second run | **239/245** (only the 6 environmental failures) |

The seventh failure in the first full run was SF-006 `launch-evidence.test.ts` "an explicit EXECFAIL is a confirmed non-start …": `launch_unconfirmed` instead of `runner_unavailable`, after a fixed 200 ms sleep following SIGINT; that test took 5 s on the loaded host.
- The session gate and this test are unchanged and not edited.
- It passed in the second full run and in the focused run.
- This intermittent failure was first seen in this round.

**The full suite is not green.**

**Review 9bbf622d (iteration-006): bound acknowledgments, revalidation at the commit boundary.**
- **Acknowledgments:** these count only for the uuid of the oldest unacknowledged message, and never for `isReplay` alone, duplicates, foreign uuids or tool results.
- **Revalidation:** reviews and acceptances re-verify the snapshot bytes, both artifacts and the full tree identity right before they are committed and again after they are recorded. A mismatch refuses, withdraws or rolls back the request, then takes the conflict path to `needs_inspection`.

There are 16 new tests, all shown red without the fixes (`logs/mutation-checks.log`).

| Run (after these fixes) | Result |
|---|---|
| `executor-*`, 3 consecutive runs | **127/127** each |
| Focused | **218/219** (`operator-assets`) |
| Full suite, clean rebuild | **254/261**: the 6 environmental failures plus the documented SF-007 stale-lock contender timing test (unchanged code) |
| Full suite, second run | **255/261** (only the 6) |

**The full suite is not green.** The real CLI's replay format is still UNVERIFIED.

**Review 88e39f51 (iteration-007): bounded acknowledgment, honest review audit.**
- **Acknowledgment bound:** a message after a process's first must be acknowledged within 60 s. Otherwise the session ends fail-closed (`turn_correlation_unavailable`); nothing is published and the gate is released.
- **Review audit:** reviews are recorded `sending` before the write and become `delivered` only on Claude Code's echo of that message. A failed write, a missing echo, a session end or a supervisor restart leaves them `unconfirmed`, never re-sent.

There are 5 new tests; the discriminating ones are red without the fixes (`logs/mutation-checks.log`).

| Run (after these fixes) | Result |
|---|---|
| `executor-*`, 3 consecutive runs | **132/132** each |
| Full suite, clean rebuild | **260/266** (only the 6 environmental failures) |
| Full suite, second run | **260/266** (only the 6) |
| Focused | **223/224** (`operator-assets`) |

**The full suite is not green.** The real CLI's replay format is still UNVERIFIED.

**Stop point.** The work stops here for independent ChatGPT code review at a clean iteration boundary. There is no self-acceptance, no Git operation, no integration into the live mediator and no further task.

## Review 03 (2026-10-28): message correlation, writers at the handoff, protocol evidence

**How it ran.**
- **The job:** one new SF-009 job (`.software-factory/jobs/sf009-review03-correlation-boundary-20261028/instruction.md`), one managed Claude Code session in `--permission-mode auto` in the disposable pilot checkout. It started with one `/implement` invocation. It is not a resume or replay of the Review 02 job, which ended `needs_inspection`/`tree_changed` on iteration-007.
- **Baseline:** the operator's clean commit of the unaccepted Review 02 source (HEAD `2370012`).
- **No Git operations:** nothing was staged, committed, stashed, reset or switched.
- **Not changed:** the mediator, its supervisor, services, OpenClaw, the SF-010 job and the global Claude configuration. Neither Ontology Manager checkout was read or touched.
- **No live CLI probe:** the only real-CLI contact was read-only `claude --version` and `--help`, which the instruction allows.
- **Not integrated:** nothing was installed into the mediator.
- **Background work:** every sub-agent and test command finished before this report.

**The installed supervisor is not this code.** The iteration-007 `tree_changed` conflict of the Review 02 job shows a limit of the *installed* supervisor, which has no quiescent bound. It is not evidence that the Review 02 candidate failed.

| Finding | Correction | Status | Tests |
|---|---|---|---|
| R3-1 P1: a result before its acknowledgment could hang forever | `StreamSession` marks the correlation **unresolved** when a result arrives while a later message is unacknowledged. A late acknowledgment never resolves it; only a further result does, and that result is the answer. While unresolved and acknowledged, `#awaitTurn` requires progress within `correlationIdleMs` (default 10 min). Progress is an assistant or stream event, a tool result, an open task or a running process of the session. The whole state is bounded by `correlationTimeoutMs` (default 4 h). Otherwise `needs_inspection`/`turn_correlation_unresolved`: nothing is published, the gate is released, nothing is re-sent or relaunched. The review stays `delivered` (it was acknowledged) with reason `turn_correlation_unresolved`. Normal turns stay unbounded | IMPLEMENTED + TESTED; the deadlock regression is red without the fix | `executor-correlation.test.ts` (9): real `StreamSession` units (late ack, duplicate, foreign and tool-result uuids) and the supervisor with the fake stream-json process (silence, system-only noise, a later valid answer after more than the idle bound, supervisor stop, the absolute bound) |
| R3-2 P1: writers started after the snapshot passed the handoff | The session's process scan (pid plus start time, tags, unidentifiable processes fail closed) now also runs at the handoff. Before commit (settled scan), a running process defers the request (`handoff_deferred`) to a new verified quiet window (`#requiesce`: scope, no process, and the published tree identity, else a conflict), then the request is re-bound. After the record (settled scan), a review is rolled back and an acceptance is withdrawn (`handoff_<code>`). Right before the review write there is one synchronous pass. Nothing is killed or sent twice | IMPLEMENTED + TESTED; red without the fix. **Not atomic:** a process that cleared its environment and left the tree, or an unrelated same-user writer, is not prevented or reliably found | `executor-handoff.test.ts` (8): a silent detached tagged writer started at either seam, which writes after 1.5 s, for both review and acceptance, is never handed over; a tagged process that ends without writing (delivered once, only after it ended); no process (no deferral); an unattributable process (bounded `boundary_unstable`, then delivered once it is gone) |
| R3-3 P1 gate: the real replay protocol was unproven | Flag presence recorded (`logs/cli-capabilities.log`: Claude Code 2.1.312 lists every managed flag). Added the operator-invoked probe `sf009-executor probe-protocol --dir <empty-dir> [--overlap]` (`protocol-probe.ts`): one process with the exact managed flags through the shared gate; refused inside a session or outside an empty directory; event shape only. The runbook makes a sequential `PASS` an integration requirement before installing | Flag presence: RECORDED. Live event shape, order and uuid echo: **UNVERIFIED** (the probe was not run; it needs the operator, after this session) | `executor-probe.test.ts` (7), against the fake Claude only |
| R3-4 P2: unrelated unreadable processes looked like session writers | `WriterScan.unattributed` (pid, start, command name) is kept apart from proven `writers`. Codes: `session_writers`, `unattributed_processes`, `process_scan_incomplete`, in every waiting, timeout and handoff diagnostic, with no command line or environment. Still fail closed. Recovery: a bounded wait plus a diagnostic naming pid and command; once the process is gone, the pending request is handed over | IMPLEMENTED + TESTED; red without the fix | fake-`/proc` test (tagged, detached, foreign tag, untagged, unreadable unrelated, pre-session or recycled, vanished, unreadable list; no secret in the message), the end-to-end unattributable handoff test, updated `executor-quiescence` |
| R3-5 P2/security: approval double-failure residual | **Not fixed.** Documented as a production release-blocking limitation, with a remediation design (design §10): a durable confirmation after a successful consume, required for a restart launch, plus fault-injection tests. It is not claimed fail-closed | DOCUMENTED | none (no code change) |

**Test runs** (logs in `review/SF-009/review03/logs/`, host paths replaced by `<app-repo>` and `~`):

| Run | Result |
|---|---|
| R3-1 regression before the supervisor fix | red: the job stayed `running iteration-002` |
| Mutation checks, final code (`mutation-checks.log`) | M1 (R3-1): 2/2 red. M2 (R3-2): 6/6 red. M3 (R3-4): 2/2 red. Clean mutant builds, source restored |
| `executor-*` during development | **156/156** (132 Review 02 + 24 new) |
| Focused SF-009 + SF-006/SF-007 suites (`focused-tests.log`) | **247/248**; the one failure is `operator-assets` (no `deploy/operator`) |
| Full suite, clean rebuild, `npm run smoke` (`test-suite.log`) | **284/290**: only the 6 known environmental failures (5 `dispatch-receiver`: no `deploy/openclaw/sf-dispatch-receiver.mjs`; 1 `operator-assets`: no `deploy/operator`) |

After these runs, one fake environment string in `executor-handoff.test.ts` was renamed (to stay clear of the export's credential patterns). That file alone was re-run: 8/8 (`handoff-rerun.log`).

**The full suite is not green;** the six failures come from the deliberately partial pilot checkout. The Review 02 test evidence is accepted as given and was not re-run separately; the full suite above includes those tests.

**Code review** (standards and spec, two read-only sub-agents, both finished): see `review/SF-009/review03/findings.md`.
- **Fixed:**
  - a probe `finally` that could leave the gate held;
  - a wrong cause in the unattributed diagnostic;
  - a withdrawn acceptance's diagnostic code;
  - an incomplete scan hidden behind unattributed processes;
  - naming.
- **Left for the operator:** the runnable probe command, which goes beyond "design a probe". It is guarded and was not run.

**Boundaries.**
- **One job, one authorization:** one new managed job under one fresh execution authorization.
- **No Git or integration:** no Git changes, and no source integration into the installed mediator.
- **No live CLI probe** without the operator's separate authorization.
- **Not a sandbox:** this is a source-isolated disposable pilot, not an OS sandbox.
- **No self-acceptance:** the operator keeps the final acceptance. SF-010 was not started.

**Stop point.** The work stops here for independent ChatGPT review at a quiescent iteration boundary.

## Review 04 (2026-10-28): a trustworthy operator protocol probe

**Scope.**
- **Job:** `.software-factory/jobs/sf009-review04-protocol-probe-20261028/instruction.md`.
- **Baseline:** the operator's HEAD `853f541`.
- **Production change:** `bridge/src/executor/protocol-probe.ts` only. Package: `review/SF-009/review04/`.

| Finding | Correction | Status | Tests |
|---|---|---|---|
| R4-1 P1: a non-sequential order passed the sequential probe | Without result 1 within the bound, message 2 is never sent (`first_result_timeout`, `FAIL`, bounded cleanup). The analyzer requires each message sent and acknowledged exactly once and exactly two results. Sequential: `send(1) < ack(1) < result(1) < send(2) < ack(2) < result(2)`. Overlap: acks in order, and each result after its own ack | FIXED + TESTED; the baseline returned PASS on the counterexample | `executor-probe` analyzer cases and a fake-CLI timeout |
| R4-2 P2: any exit passed `exits_after_input_closed` | Requires code 0, no signal, an exit after the input closed with no signal of ours before it, and the process alive at message 2 | FIXED + TESTED; the baseline returned PASS for code 1 and SIGKILL | code 0, 1 and 143, SIGTERM, SIGKILL, unconfirmed, between turns, before close, a fake that exits 0 on SIGTERM |
| R4-3 P2: an unbounded wait after SIGTERM | Close the input, wait 30 s; SIGTERM, wait 10 s; SIGKILL, wait 5 s. Signals go to the identity-verified child pid only, and EPERM fails closed. If no exit is confirmed: `gate_unresponsive`, the gate is not released, no second process. A `launchManaged` throw goes back to the gate helper's release | FIXED + TESTED | a real SIGTERM-ignoring fake; simulated unkillable, reused-pid, EPERM, launch throw and release failure |

**Test runs** (`review/SF-009/review04/logs/`, host paths replaced by `<pilot>`):

| Run | Result |
|---|---|
| `tsc --noEmit -p .` | exit 0 |
| `executor-probe`, new analyzer tests on the baseline (`red-analyzer.tap`) | 8/12: the 4 new analyzer tests red |
| Baseline analyzer on the counterexample (`baseline-counterexample.log`) | PASS (the defect); also PASS with code 1 and with SIGKILL |
| `executor-probe`, final code (`green-executor-probe.tap`) | **20/20** |
| Full suite | Not re-run. The Review 03 result (284/290, the 6 fixture-only failures) is accepted; no shared code changed |

**Code review.** Standards and spec, two read-only sub-agents, both finished before the final run. Four defects were fixed:
- a SIGTERM exit 0 could still PASS;
- the identity was read outside a try block;
- a lost earlier failure cause;
- an `input_failed` detail without its cause.

What stayed open at that point (historical: iteration-002 bounded the returned report, Review 05 the thrown errors): the CLI may stay attached to an unkillable process (would need a change to `main.ts`), and the shutdown ladder duplicates `service.ts` (out of scope). See `review/SF-009/review04/findings.md`.

**Boundaries.**
- **Not a real-CLI proof:** the fake CLI tests are not a real-CLI compatibility proof. The live protocol stays **UNVERIFIED**, and running it needs a separate operator decision after this job.
- **Production blockers stay open:** OS isolation and the approval ambiguity (R3-5).
- **No Git operation,** no install, no live probe, no SF-010.

**Stop point.** The work stops here for independent ChatGPT code review. There is no acceptance.

**Iteration-002 (reviewer d37e2fac).**
- *P1, the attached CLI: fixed.* On `gate_unresponsive`, the operator command now prints the report and a stderr diagnostic and exits with code 4 by itself (`reportProbe`; `main.ts` calls it). Exiting only detaches: there is no further signal and no release, and the child keeps the gate through its own inherited lock descriptor.
  - A subprocess test proves it: code 4 within the bound; the gate is held by the child until the test ends its own fake; then the gate is free.
  - It was red with the earlier behaviour (still attached after 8 s).
- *P2, a throwing identity check: fixed.* An identity check that throws counts as `refused` (never signalled). A failing input `end()` or any unexpected shutdown error still yields a bounded report. Two fault-injection tests were red on iteration-001 and are green now.
- *Runs:* `executor-probe` **23/23**, `executor-units` 4/4, `tsc` exit 0. The full suite was not re-run.

## Review 05 (2026-10-28): the probe command's thrown-error path is bounded

**Scope.**
- **Job:** `.software-factory/jobs/sf009-review05-launch-handover-20261028/instruction.md`.
- **Baseline:** the operator's HEAD `26559f8` (the Review 04 WIP, containing the final Review 04 candidate; its `main.ts`, `protocol-probe.ts` and probe test match the Review 04 manifest hashes).
- **Production change:** `bridge/src/executor/protocol-probe.ts` and the probe branch of `bridge/src/executor/main.ts`. Package: `review/SF-009/review05/`.

| Finding | Correction | Status | Tests |
|---|---|---|---|
| R5-1 P1: a thrown `launch_unconfirmed` or `gate_unresponsive` skipped the explicit exit; the generic handler set only `process.exitCode`, so a live helper kept the command attached | `probeCommand` is the probe branch's boundary. On a thrown `launch_unconfirmed` or `gate_unresponsive` it prints the coded message and an operator-attention line and exits with code 4, detaching only (no release, no signal, nothing started). A `runner_unavailable` non-start whose helper pid is still present becomes `gate_unresponsive`. Reports keep 0/3/4; other errors keep the generic handler (code 1) | FIXED + TESTED; red on the Review 04 behaviour (attached after 8 s, all four routes) | Real subprocess, real gate, test-owned fake helper: unconfirmed hand-over, release failure, silent reservation, lingering EXECFAIL |

**Test runs** (`review/SF-009/review05/logs/`, host paths replaced by `<pilot>`):

| Run | Result |
|---|---|
| `tsc --noEmit` | exit 0 |
| `executor-probe`, final test on the Review 04 behaviour (`red-cli-thrown.tap`: the HEAD `protocol-probe.ts` plus a pass-through `probeCommand`) | 26/30: the 4 subprocess routes stayed attached past 8 s |
| `executor-probe`, final code (`green-executor-probe.tap`) | **30/30** |
| `executor-units` (`executor-units.tap`) | 4/4 |
| Full suite | Not re-run; no shared runner, gate or supervisor code changed |

**Code review.** Standards and spec, two read-only sub-agents, both finished before the final runs. Applied: the test re-checks the fake's marker right before it ends it; a test that `main.ts` routes the probe through `probeCommand`; the code set is typed; the stderr line no longer contradicts a coded "gate is free again" message; a stale `main.ts` comment. Left open (see `review/SF-009/review05/findings.md`): the BUSY/ERROR-linger residual in `SessionGate.reserve()`, and the pid-only liveness check (fails closed on a reused pid).

**Boundaries.**
- **Not a real-CLI proof:** the fake CLI and fake helper tests do not prove compatibility with the installed Claude CLI. The live protocol stays **UNVERIFIED**.
- **Production blockers stay open:** OS isolation and the approval ambiguity (R3-5).
- **No Git operation,** no install, no live probe, no SF-010.

**Stop point.** The work stops here for independent review. There is no acceptance.

## Context continuity (2026-10-29): real compact and reset

**Scope.**
- **Job:** `.software-factory/jobs/sf009-context-continuity-20261029/instruction.md`, app `sf009-self-fix`, self-hosted on the main checkout.
- **Documentation only:** no source, test, `bridge/dist`, policy, registration, service or Git change; historical job records and earlier review packages untouched.
- **Package:** `review/SF-009/context-continuity-20261029/` (`EVIDENCE.md`, checksums, checks).

**Iteration 1.** Stale current-status statements corrected in the task, design, runbook and this report; the original status lines are kept and labelled historical. The evidence matrix separates active runtime, accepted source, operator-supplied probe results, fake-only and unverified behaviour.

| Item | Status |
|---|---|
| Real `compact` | **Verified** (iteration 2 below; criterion 4 confirmed by ChatGPT's review of iteration 2) |
| Real `reset` | **Verified** (iteration 3 below; the last criterion confirmed by ChatGPT's review of iteration 3) |
| Reset gate hand-over | Not atomic (design §5); unchanged |

**Iteration 2 (after the compact).** ChatGPT requested one `compact` through `factory_manage_session_context` at the iteration-001 boundary; the session did not initiate it.

| Criterion | Observed | Source |
|---|---|---|
| Context request `c1d29a78-cf05-4f24-9cd2-f4798065e1f3` `performed` at 2026-10-29T12:07:40.215Z | Yes. The supervisor reports `performed` only after a `compact_boundary` and a completed `result`. ChatGPT did not inspect the raw transcript | `managed.json`, supplied by ChatGPT |
| Same session and process, no new lineage entry | Session `93e94e38-22a8-4517-86c4-c2181d4636d7`, pid 650083 with the same start; lineage and baseline unchanged. The process was still running at 12:09 UTC | `execution.json`, supplied by ChatGPT; `ps`, read by the session |
| Same launch claim | `launch.claim` 103 bytes, sha256 `68cca95c…e005` | supplied by ChatGPT |
| Tree unchanged | The iteration-001 snapshot sha256 `6fcd0101…b060` and tree fingerprint `2c8769a5…e2eb` were the same before and after | `factory_review_snapshot`, supplied by ChatGPT |
| Continuation note | `continuation-001.md` 6824 bytes, sha256 `f95191e6…a5f`; its `.software-factory` mirror matches. The session continued from its compaction summary, whose compact instruction names this note | supplied by ChatGPT; session |
| Next correction published as a normal snapshot | Yes. Iteration-002 snapshot sha256 `f043ca6c…23c2`, captured by the same session, published normally and reviewed in full (review `6c8bfd21-147a-43a2-b5aa-befaa8dbe403`): no background processes, quiet 5000 ms, index unchanged, only the four allowed documents changed | review, supplied by ChatGPT |

The runbook's observer fallback was also corrected (review P2): during a job, run only the already-built observer; build the validation copy only while no job is authorized or active.

That the session read `continuation-001.md` itself after the compact is not evidenced.

**Iteration 3 (after the reset).** ChatGPT requested one `reset` through `factory_manage_session_context` at the iteration-002 boundary; the session did not initiate it. No further context action is planned.

| Criterion | Observed | Source |
|---|---|---|
| Context request `e478c832-c288-499c-9d68-a84c04ee3691` `performed` at 2026-10-29T12:15:14.176Z | Yes. Process replacement, auto mode and the first `result` are the supervisor's verified outcome; ChatGPT did not read host `/proc` or raw transcripts | `managed.json`, supplied by ChatGPT |
| Old process ended, new process started | pid 650083/start 49332656 → pid 666555/start 49433938, same boot. Read-only at 12:17 UTC: pid 650083 absent; pid 666555 runs `claude -p … --permission-mode auto --permission-prompts none`, started 12:14:55 UTC | `execution.json`, supplied by ChatGPT; `ps`, `/proc/<pid>/stat`, read by the session |
| Lineage under the same job | Session `93e94e38-22a8-4517-86c4-c2181d4636d7` ended; `af3a27d7-b83b-4dc0-b05a-ee742e44a968` started 2026-10-29T12:14:56.456Z, reason `reset`, alive. `session_lineage` lists exactly both; `session.id` intentionally stays the originally claimed id. App, job, dispatch, authorization and instruction bindings unchanged | `managed.json`, `execution.json`, supplied by ChatGPT |
| Same launch claim | `launch.claim` 103 bytes, sha256 `68cca95c…e005` | supplied by ChatGPT |
| Tree unchanged | The iteration-002 snapshot sha256 `f043ca6c…23c2` and tree fingerprint `792ce1df…ae5f` were re-verified right after the reset; the snapshot still names its original capture session | `factory_review_snapshot`, supplied by ChatGPT |
| Continuation note | `continuation-002.md` 10462 bytes, sha256 `4bc79d6b…dbed`; its `.software-factory` mirror matches. The new session read it on its first turn, as instructed (session's own report, not independently verified) | supplied by ChatGPT; session |
| Next correction published as a normal snapshot | Yes. Review `6c8bfd21-147a-43a2-b5aa-befaa8dbe403` reached session `af3a27d7…`; its correction was published normally as the iteration-003 snapshot (sha256 `fe42d47d…140e`, tree fingerprint `f9a68b90…b235`), captured by that session at 2026-10-29T12:19:16.000Z, and reviewed in full (review `9578f618-4d92-4dd1-b75d-f22e5f7e992a`): no background processes, quiet 5000 ms, index unchanged, only the four allowed documents changed, the 322 baseline paths untouched, launch claim unchanged | review, supplied by ChatGPT |

The reset gate hand-over remains non-atomic (design §5). This iteration also aligned the observer rollout wording (review finding 3): rebuilding the canonical `bridge/dist` while idle makes the wrapper command available to new invocations; restarting the supervisor and bridge is a separate rollout. Neither was done.

**Closeout (iteration 4).** Reset criterion 5 recorded as met, from ChatGPT's review of iteration 3; documentation only. The snapshot of this closeout is for final review; the reset verification does not depend on it.

**Still open:** a real session's own reading of the continuation note is not independently evidenced; the reset gate hand-over is not atomic; there is no proactive ChatGPT review trigger; OS isolation and the R3-5 approval ambiguity remain.

**Stop point.** The work stops at a stable review boundary. No further context action was initiated. Operator acceptance and final collection are pending.
