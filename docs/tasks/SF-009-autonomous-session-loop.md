# SF-009: one authorization in ChatGPT, Claude auto mode, review iterations in one session, context control

**Instruction:** `review/SF-009/instruction.md` (from `factory-data/apps/sf-pilot/jobs/sf009-autonomous-session-loop-20261027/instruction.md`).

**Documents:**
- design: `docs/design/SF-009-autonomous-session-loop.md`;
- runbook: `docs/runbooks/SF-009-autonomous-session-loop.md`;
- report: `docs/reports/SF-009-report.md`.

**Review package:** `review/SF-009/MANIFEST.md`.

**Current status (2026-10-29):** active for the self-hosted app `sf009-self-fix` (transient user units, canonical `bridge/dist`; no unit file installed). The observer is accepted source but not in the canonical `bridge/dist`. Real `compact` was verified once on 2026-10-29; real `reset` was verified once the same day. Operator acceptance is pending. Evidence matrix: `review/SF-009/context-continuity-20261029/EVIDENCE.md`. The decisions below are the original design and unchanged.

## Decisions

| Topic | Decision |
|---|---|
| Session mechanism | One long-lived `claude -p --input-format stream-json --output-format stream-json` process per job, started through the SF-006 gate helper with pipes. The turn end is the stream-json `result` event. `--bg`/`attach`/`logs` and a PTY were rejected (design §7) |
| Permission mode | Exactly `--permission-mode auto` plus `--permission-prompts none` (nothing waits for a person, nothing is auto-answered). A process reporting another mode is stopped at once |
| Authorization | `factory_authorize_execution` binds app, job, accepted request id, instruction sha256, a salted repository identity, `auto`, the policy epoch, a caller nonce, and a 30-minute expiry. It acts only with the operator's one-time local opt-in (`scripts/sf009-executor.sh enable --app`). Not a signed approval; described as an authenticated tool call |
| Executor | `scripts/sf009-executor.sh run`: one supervisor per user, no listener, polling single-writer files in the job directory. A systemd user unit template exists; nothing is installed |
| Reuse | SF-006 `runManaged` shares the job lock, gate, private baseline, `launch.claim`, export filters and `#finish`. SF-007 approvals are created and consumed with the bound tuple; the audit goes to SF-007's `events.jsonl` |
| Iterations | `managed.json`; immutable `iteration-NNN.{diff,report.md,snapshot.json}`. A review is bound to iteration, snapshot sha256 and review id, against an unchanged tree |
| Context | `compact` = `/compact` observed by `compact_boundary`. `reset` = a verified end, then a new process with a new session id under the same claim. A continuation note comes first |
| Closing | Only an acceptance bound to the current snapshot (ChatGPT tool or local `accept`) ends the session; then SF-006 collects. No Git operations anywhere |
| Gap | ChatGPT cannot be woken; the operator asks it to review. Labelled, not hidden (design §8) |

## Changed SF-006/SF-007 code (each regression-tested)

| File | Change | Why |
|---|---|---|
| `execution/runner.ts` | `ManagedClaudeRunner`, `managedArguments`, `DENIED_TOOLS`, optional `ReservedLaunch.launchManaged` | The managed launch through the same gate |
| `execution/session-gate.ts` | `reserve('pipe')`; a confirmed launch returns the pipes | The supervisor talks to Claude over stdin/stdout |
| `execution/service.ts` | Session mode `managed`; optional `session_lineage` (also checked by the hand-started session scan); `runManaged`; shared `#checkLaunchable`, `#launchFailed`, `#recordPid` (also used by `run`) | Iterations inside the SF-006 lock and claim |
| `execution/local-service.ts` | `managedExecutionService` | Production wiring |
| `execution/errors.ts` | `session_ended` | |
| `operator/store.ts` | File helpers exported; event names and optional fields for supervisor events | Reuse of private-file handling and the audit log |
| `server.ts` | Seven tools | MCP boundary |
| `test/smoke.test.ts` | The exact tool list (6 → 13) | The intended new tools |
