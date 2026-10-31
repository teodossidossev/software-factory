# SF-007: operator-approved local execution queue and Claude launch

**Instructions:**
- SF-007: `review/SF-007/instruction.md`.
- Review 01: `review/SF-007/review01-instruction.md`.

**Documents:**
- design: `docs/design/SF-007-local-operator.md`;
- runbook: `docs/runbooks/SF-007-local-operator.md`;
- report: `docs/reports/SF-007-report.md`.

## Decisions (current, after Review 01)

| Topic | Decision |
|---|---|
| Discovery | A bounded, read-only scan of `factory-data/apps/*/jobs/*` each time the console lists the queue. Every limit that cuts the list (100 apps, 1,000 jobs per app, 5,000 in total, or unreadable directories) is shown. Discovery never prepares, claims or launches |
| Interface | A terminal console (`scripts/sf007-operator.sh`, optional desktop launcher). No network listener, socket, token or browser page. The OpenClaw Dashboard is untouched |
| Why not a web page | A loopback page cannot prove to the browser that it is the operator's own server. Another local account squatting the port could run script in that origin and act through the operator's browser (design §6) |
| Approval | Typed in the console after the exact instruction is shown. One-use and bound to `(app, job, request_id, instruction_sha256, app_repo_sha256)`; expires after 15 minutes if unused. Kept in `${XDG_STATE_HOME:-~/.local/state}/software-factory/operator` (0700/0600) |
| Launch | In the same terminal: `attend` consumes the approval and drives SF-006 `preflight` → `prepare(expected)` → `run(expected)` (session, "finished?" question, collect) |
| Concurrency | One Claude session on the host, enforced by the SF-006 session gate: `flock` on `~/.local/state/software-factory/claude-session.lock`, taken before `launch.claim` and held by the Claude process. Shared by the manual CLI and the console. The handoff command is `flock`-wrapped. Hand-started sessions are also found by their session id. No `max_sessions` setting |
| Per-job lock | SF-006 `acquireLock` takes over a stale lock through an exclusive takeover marker and an atomic rename, never leaving the path empty. Corrupt locks fail closed |
| SF-006 changes | The approval binding, the session gate in `run`/`handoff`/`preflight`, `ClaudeRunner.reserve()`, `acquireLock` hardening, shared `local-service.ts`, and the error codes `approval_mismatch` and `session_busy`. The manual CLI's commands and outputs are unchanged, apart from the gate and the gated handoff command |
| Setup | Optional desktop launcher rendered by `scripts/sf007-operator.sh render-assets <dir>`. Nothing to enable or start; nothing installed by this task |
| Demo | `scripts/sf007-demo.sh`: the console against a throwaway mediator, app repository, fake `claude`, stub receiver and its own gate |

## Review 01 (2026-10-26)

| # | Finding | Correction |
|---|---|---|
| 1 (P1) | A port-squatting local account could impersonate the browser origin, capture the token and act through the operator's browser | The web interface was withdrawn and replaced by a terminal console with no listener. The threat model was split into browser-to-server and server-to-browser authenticity. Tested: a hostile same-port listener plus captured-token replay achieves nothing, and the console holds no listening socket |
| 2 (P1) | Manual SF-006 and SF-007 did not share an atomic session gate | An OS-backed `flock` gate in SF-006 `run`, taken before `launch.claim` and inherited by the Claude process. Handoff commands are `flock`-wrapped; hand-started sessions are detected by session id (fail closed). Concurrency is fixed at 1. Tests count live Claude processes |
| 3 (P2) | The stale-lock takeover renamed the lock aside (a gap) | Exclusive takeover marker plus an atomic rename-over. Never touches a live lock; corrupt locks fail closed. Multi-process tests |
| 4 (P2) | Queue limits hid jobs without reporting it | Per-limit truncation in the result and the console. No safety decision uses the list. Tests with more than 100 apps, more than 1,000 jobs per app and more than 5,000 in total, and a hidden live session |

## Review 02 (2026-10-26)

| # | Finding | Correction |
|---|---|---|
| R2-1 (P2) | A helper death could be mistaken for a successful exec | Launch evidence: confirmed only when the helper's own process (same start time) is seen running another executable after the control channel closed. `EXECFAIL` is a confirmed non-start (`failed`). Anything else is indeterminate (`needs_inspection` / `launch_unconfirmed`): the claim is kept, nothing is retried, and every wait is bounded |
| R2-2 (P2) | Parsed but untrustworthy records could be treated as inactive | `sessionActivity()`: a live-capable state needs a valid session id; an unknown state or schema blocks; terminal and prepared records (also historical formats) never block. Uninspectable directories block; missing ones do not. Fixed path-safe diagnostics |
| R2-3 (P3) | Unavailable directories looked like an empty queue | Missing roots are a clean "not initialized yet". A symlink, non-directory or unreadable `factory-data`, `apps`, app or `jobs` directory is reported under `LIST INCOMPLETE` and never followed |

## Review 03 (2026-10-27)

| # | Finding | Correction |
|---|---|---|
| R3-1 (P2) | Waits on the gate helper (first answer, after BUSY/ERROR, release) could hang | Every wait is bounded (10 s answer, 5 s exit, 30 s hand-over). A helper not successfully told to exec is stopped with SIGKILL; the gate counts as free only after an observed exit and a readable `/proc/locks` without its pid, otherwise `gate_unresponsive` fails closed. After a delivered request nothing is killed |
| R3-2 (P2) | A completed job resumed by hand evaded the session scan | `completed`, `failed` and `needs_inspection` records with a valid session id are liveness candidates: they block while a process carries the id (`--resume <id>`, `--resume=<id>`, `--session-id <id>`, any letter case). Without a usable id they stay inactive |

## User experience

1. ChatGPT writes and dispatches the job (SF-005, unchanged); OpenClaw accepts it.
2. The operator opens the console (launcher click). The job is listed as `awaiting_operator`.
3. The operator types the job's number and reviews:
   - request id;
   - SHA-256;
   - the exact instruction (control characters shown as escapes).
4. `a` (Approve & Run) runs, in the same terminal:
   - the preflight;
   - prepare;
   - Claude Code with `/implement` in manual permission mode; the operator answers its prompts;
   - "Did /implement finish?";
   - collect.

   The result and the artifact hashes are shown; Enter returns to the queue.
5. `l` (Later) keeps the job waiting. `x` plus typing `reject` rejects it for good.

## Scope

**In scope:**
- `bridge/src/operator/*`, plus `bridge/src/execution/session-gate.ts`;
- the SF-006 changes above;
- `bridge/test/operator-*.test.ts`, `bridge/test/locks.test.ts`;
- `scripts/sf007-*.sh`;
- `deploy/operator/sf007-operator-console.desktop.in`;
- the docs and the review packages.

**Out of scope:**
- installing anything;
- a real `/implement` run;
- new dispatches;
- changes to OpenClaw, the Dashboard, SF-005 dispatch or app repositories;
- Git operations;
- ChatGPT notifications.

## Stage

Review 03 is implemented and verified with fake runners, including a real `gnome-terminal` console on an isolated display. **Not installed; real Claude execution through SF-007 is pending.** It awaits independent review and then the operator's decision on a supervised pilot.
