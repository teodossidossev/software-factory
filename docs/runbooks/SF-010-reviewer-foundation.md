# SF-010 runbook: the independent review coordinator (offline foundation)

**Status:** autonomous review is not active and cannot be activated with this build:
- no real review provider exists;
- the production supervisor does not wire the SF-010 hooks.

Use this runbook to inspect the state, to dry-run, and to understand what an activation would need. Design: `docs/design/SF-010-reviewer-foundation.md`.

## Commands

`scripts/sf010-reviewer.sh` runs `bridge/<dist>/src/reviewer/main.js`. Select the build with `SF010_BRIDGE_DIST`:

```bash
SF010_BRIDGE_DIST=sf010-reviewer-validation-dist scripts/sf010-reviewer.sh status
```

| Command | Effect |
|---|---|
| `status [--app <id>] [--job <id>]` | **Read-only.** Shows the provider opt-in, whether a coordinator runs (lock holder), and per delegated job: delegation state (`active`, `revoked`, `expired`, `elapsed`), limits, usage, event count, and review states with codes. With no state it prints `present: false` and creates nothing |
| `dry-run --app <id> --job <id>` | **Read-only.** What a coordinator would do now: `not_delegated`, `delegation_invalid`, `provider_unavailable`, `no_ready_iteration`, `already_handled`, `reviewer_state_unreadable`, `review_limit`, `attempts_exhausted`, `wait`, `superseded`, `job_ended`, `input_blocked` (with the code) or `would_review` (input bytes and hash). Creates no event or state, calls no provider |
| `provider-enable --provider <id> [--yes]` | The provider opt-in. **Refused** (`provider_unavailable`) for every id: this build has no provider |
| `delegate --app <id> --job <id> --provider <id> --max-attempts <n> --max-reviews <n> --max-minutes <n> --max-input-kib <n> --attempt-timeout-s <n> --expires-minutes <n> [--yes]` | The per-job review delegation. Every limit is required and bounded. Refused for a job that is not a live managed job (never a historical one). It authorizes review only |
| `revoke --app <id> --job <id>` | Permanent. A queued or later autonomous review of that job is refused, also by the supervisor right before delivery |
| `run` | The coordinator in the foreground. **Refused** (`provider_unavailable`) unless an enabled provider is in this build, and none is. A refused start creates no state |

The state lives in `${XDG_STATE_HOME:-~/.local/state}/software-factory/reviewer/` (0700/0600, outside the repository).

## Reading a review state

| State (code) | What it means | What to do |
|---|---|---|
| `clean_awaiting_acceptance` | The provider found nothing in exactly this snapshot | Decide yourself: accept with `scripts/sf009-executor.sh accept` or through ChatGPT, or send a review. Nothing was accepted |
| `delivered` | The supervisor sent the findings to the same live session | Wait for the next iteration |
| `rejected (reason)` | The supervisor refused it (`tree_changed`, `delegation_revoked`, `session_replaced`, `autonomous_review_disabled`, …) | Read the SF-009 status; nothing reached Claude |
| `unconfirmed (reason)` | Delivery could not be confirmed | Inspect the job; it is never resent |
| `input_blocked (code)` | Withheld, oversized, malformed, tampered or incomplete material | Inspect the snapshot; never a clean verdict |
| `attempts_exhausted`, `review_limit`, `elapsed_limit` | A budget is used up | A new delegation (after `revoke`) is your decision |
| `provider_refused`, `provider_failed` | The provider declined or failed for good (`provider_output_too_large`, `request_too_large`: the findings would exceed the 64 KiB request bound) | Review manually |
| `superseded`, `competing_review` | A newer snapshot, a reset or compact, or a manual review came first (`clean_superseded`: a clean verdict whose snapshot is no longer current) | Nothing to do |
| `delegation_invalid (code)` | Revoked, expired, mismatched or no provider opt-in; `delegation_replaced`: findings recorded under an earlier grant, never delivered under the new one | Nothing to do, or delegate again |

While an autonomous review request is pending for an iteration, a ChatGPT `factory_submit_review` for the same iteration is refused ("still pending"). The supervisor settles the pending request at its next poll, after which ChatGPT can review again.

## What an activation would need (open decisions)

1. **A real provider.** An adapter (a model API, or an OpenClaw agent through the existing channel) implementing `ReviewProvider`, with its own credential handling, data-egress review and tests. It is registered in `bridge/src/reviewer/main.ts` `PROVIDERS`. Its compatibility is **UNVERIFIED**.
2. **Supervisor wiring.** The production supervisor (`bridge/src/executor/main.ts` `run`) must pass `reviewReady` (`publishReviewReady`) and `autonomousReview` (`autonomousReviewCheck`). Until then it creates no events and refuses autonomous reviews.
3. **A build and a restart** of the supervisor from that build. Both are operator decisions; this job made neither.
4. **Per job:** `provider-enable`, then `delegate`, with limits you accept.
5. **R3-5** remains a production release blocker (SF-009 design §10), independent of SF-010.

## Tests

```bash
cd bridge
npx tsc -p . --outDir sf010-reviewer-validation-dist
node --experimental-test-module-mocks --test --test-concurrency=1 sf010-reviewer-validation-dist/test/reviewer-*.test.js
```

The build output (about 2.9 MB) is ignored since 2026-10-31, so it no longer counts toward a managed session's 2 MiB export bound. Delete `bridge/sf010-reviewer-validation-dist/` once the tests are done.

The tests use the SF-009 fixtures only: a throwaway mediator, a disposable repository, the fake stream-json Claude and the offline provider. No real Claude, model or network is used.
