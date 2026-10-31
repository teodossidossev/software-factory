# SF-010: event-driven independent review foundation

**Instruction:** `.software-factory/jobs/sf010-reviewer-foundation-20261029/instruction.md` (job `sf010-reviewer-foundation-20261029`, app `sf009-self-fix`).

**Documents:**
- design: `docs/design/SF-010-reviewer-foundation.md`;
- runbook: `docs/runbooks/SF-010-reviewer-foundation.md`.

**Review package:** `review/SF-010/reviewer-foundation-20261029/README.md`.

**Status (2026-10-29): offline foundation, implemented and tested; not active.**
- **Offline demonstration (done):** the whole path runs in tests with the fake stream-json Claude and the deterministic offline provider. The path: verified snapshot → durable event → coordinator → findings delivered to the same live session → next verified iteration → clean verdict awaiting operator acceptance.
- **Real-provider compatibility (UNVERIFIED):** no real reviewer exists. No model API, OpenClaw agent or credential was used.
- **Runtime activation (NOT done):** the production supervisor (`scripts/sf009-executor.sh run`) wires neither SF-010 hook, so it creates no events and refuses every autonomous review (`autonomous_review_disabled`). `scripts/sf010-reviewer.sh run` and `provider-enable` refuse, because this build registers no provider. Nothing was delegated, enabled, installed or restarted. The canonical `bridge/dist` was not rebuilt.

## Decisions

| Topic | Decision |
|---|---|
| Trigger | Event-driven. The supervisor creates a durable review-ready event right after a snapshot is committed and referenced by `managed.json`. The coordinator follows file-system notifications (`fs.watch`) of events, delegations and delegated jobs' directories. It reconciles everything at start. A slow backstop pass (15 min) recovers dropped notifications; it is not the trigger. No scheduled checker |
| Event identity | `sha256(schema, app, job, iteration, snapshot sha256)`. It is created by exclusive create, so a repeat of the same identity is the same event. A crash before the event is recovered by reconciliation from `managed.json` |
| Review authority | A private per-job delegation (`delegations/<app>/<job>.json`, 0600, outside the mediator) with finite limits and an expiry. It is bound to the job's execution authorization id, and it is the only source of review authority. An execution authorization, an accepted dispatch or an event alone authorize no review. A provider opt-in is needed as well. Revocation is a permanent marker |
| Historical jobs | Never processed by default: only delegated jobs are scanned, and `delegate` refuses a job that is not a live managed job |
| Delivery path | The existing one. The coordinator writes the same bound `review-<id>.json` the bridge writes for `factory_submit_review` (`ExecutionGateway.submitAutonomousReview`: same validation and pending-request rule), with a `provenance` block. The supervisor applies every existing check. It then re-checks the delegation, the session id and the context epoch immediately before it records and sends |
| Provenance | `provenance.kind = autonomous_reviewer` in the request; `source: autonomous_reviewer` in `managed.json` and in `factory_execution_status` (`mcp` otherwise). The MCP tool cannot set it. The message to Claude names the autonomous reviewer |
| Stable ids | The review id is derived from the event id. Findings are recorded before submission. A restart submits the same content under the same id, or only observes. `sending`/`unconfirmed` reviews are never resent |
| Input | Verified at the exact current iteration and snapshot: snapshot bytes, artifact hashes, the instruction hash, strict UTF-8, complete diff coverage of the changed paths, and whole-file sha256 of new files. Withheld, oversized, malformed or incomplete material is `input_blocked` and never clean |
| Provider boundary | `ReviewProvider.review(input, signal) → unknown`, validated by a strict schema. The outcomes are findings (bounded, with file references checked against the snapshot), `clean`, `refusal` and `error`. The only implementation is `OfflineReviewProvider` (deterministic, in-process) |
| Budgets | Attempts, reviews, elapsed time, input bytes and per-attempt timeout come from the delegation. Usage is counted before the work it pays for and persisted, so a restart never refills it |
| Clean verdict | `clean_awaiting_acceptance`, bound to the snapshot sha256. Nothing is accepted or closed |

## Changed SF-009 code

| File | Change |
|---|---|
| `bridge/src/executor/records.ts` | Optional `provenance` on `software-factory.review-request/v1`; optional `source` on `managed.json` review entries; `contextEpoch()` |
| `bridge/src/executor/gateway.ts` | `submitReview` and the new `submitAutonomousReview` share one implementation; review views add `source` |
| `bridge/src/executor/supervisor.ts` | Two optional options, unset in production: `reviewReady` (post-commit hook) and `autonomousReview` (delegation re-check). It also checks the session and context epoch for autonomous reviews, and the feedback message names the autonomous reviewer |

## New code

`bridge/src/reviewer/{records,store,events,input,provider,coordinator,status,main}.ts`, `scripts/sf010-reviewer.sh`, and the tests `bridge/test/reviewer-{units,flow,recovery,safety}.test.ts` with `bridge/test/support/reviewer-fixture.ts`.

## Inherited limitations (not fixed here)

- **R3-5** (SF-009 design §10): the approval double-failure residual stays a production release blocker. SF-010 does not touch authorization or approval.
- **Non-atomic reset handover** (SF-009 design §5): unchanged. SF-010 refuses findings made for a replaced session or an earlier context epoch, but the gate handover itself is not changed.
- **Same-user writers:** the reviewer state is protected by file modes and ownership only, like the executor state. A process of the same user can write it (SF-009 design §3).
