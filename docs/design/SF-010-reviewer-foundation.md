# SF-010 design: event-driven independent review foundation

> **Status (2026-10-29, job `sf010-reviewer-foundation-20261029`):**
> - **Offline demonstration:** implemented and tested with the fake stream-json Claude and the deterministic offline provider.
> - **Real-provider compatibility:** UNVERIFIED.
> - **Runtime activation:** NOT done. The production entry points wire no SF-010 hook and register no provider.

## 1. The path

```
supervisor #publish ──commit──► managed.json references iteration-NNN.snapshot.json (verified)
      │ reviewReady (option; unset in production)
      ▼
events/<app>/<job>/<event_id>.json ◄── reconciliation (restart, notifications, backstop) from managed.json
      │ fs.watch notification (a hint only)
      ▼
ReviewCoordinator (one per user, lock) ── delegation + provider opt-in (private state)
      │ buildReviewInput: exact iteration, snapshot, artifacts, instruction, coverage, limits
      ▼
ReviewProvider.review(input) ──► untrusted value ──► validateResponse
      │ findings: recorded first, then
      ▼
ExecutionGateway.submitAutonomousReview ──► review-<id>.json (same file, same rules as factory_submit_review)
      │
      ▼
supervisor #handle(review): bound, idle gate, handoff scans, stillBound, + delegation, session, context epoch
      │ sending → delivered (acknowledged by the same process)
      ▼
next iteration → next snapshot → next event → … → clean → clean_awaiting_acceptance (operator decides)
```

## 2. Durable review-ready events

- **When.** The supervisor creates the event in `#publish`, after `managed.json` was saved with the iteration `ready_for_review` and its snapshot reference. `publishReviewReady` re-reads `managed.json`, requires that iteration to be current and ready with exactly that sha256, hashes the snapshot bytes, and verifies the diff and report (`verifiedArtifacts`). Anything else yields no event (`not_published`). A failure of the hook is logged and changes nothing in the supervisor.
- **Identity.** `event_id = sha256("software-factory.review-ready-event/v1\0" app "\0" job "\0" iteration "\0" snapshot_sha256)`. The file is created by exclusive create. A second creation with the same identity is the same event (`exists`); different content under the same id is refused.
- **Crash recovery.** A crash between publication and event creation is recovered by `reconcileJobEvent`. It runs on every pass over a delegated job and creates the same event from `managed.json` (`source: reconciliation`). It is bounded: only delegated jobs (at most 100 apps × 1,000 jobs), and only the current ready iteration.
- **Duplicate, missed and out-of-order notifications.** Notifications only schedule a pass. Every pass re-reads durable state. The work for an event is keyed by its id, and an event whose snapshot is no longer current becomes `superseded`. So repeats do nothing, losses are recovered by the next pass, and order does not matter.
- **Content.** Ids, the iteration number, the snapshot sha256, the source and the creation time. No secrets, transcripts, host paths or process arguments.
- **Not authorization.** An event is a notification. Only jobs with an unrevoked delegation get events at all.

## 3. Review authority

- **Delegation** (`software-factory.review-delegation/v1`, private, written only by `sf010-reviewer delegate`):
  - **Binding:** app, job, the job's execution `authorization_id`, the provider id, creation and expiry.
  - **Finite limits:** `max_attempts` (≤ 20), `max_reviews` (≤ 20), `max_elapsed_ms` (≤ 24 h), `max_input_bytes` (≤ 8 MiB) and `attempt_timeout_ms` (≤ 30 min).
  - **Not enough on its own:** an execution authorization, an accepted dispatch or an event alone authorize no review.
  - **One per job.** A new delegation needs the old one revoked first. Revocation is a permanent marker; a new delegation starts new budgets.
- **Provider opt-in** (`provider.json`): it must name the delegated provider, and the running coordinator must have that provider. This build has none, so `provider-enable` and `run` refuse.
- **Historical jobs:** only delegated jobs are scanned. `delegate` refuses jobs that are not live managed jobs. This real implementation job was not delegated.
- **The supervisor stays authoritative.** The coordinator never launches Claude, takes the session gate, compacts or resets a session, authorizes a job, accepts a result or runs Git. It cannot edit `managed.json`: it only writes a request file through the bridge's gateway code, and reads.
- **Provenance.**
  - The request carries `provenance { kind: autonomous_reviewer, event_id, delegation_id, provider, session_id, context_epoch }`.
  - The MCP tool's input schema has no such field, so a ChatGPT call cannot produce it, and the coordinator cannot produce a request without it.
  - `managed.json` records `source: autonomous_reviewer`, and the status view shows `source` (`mcp` or `autonomous_reviewer`).
  - The message to Claude names the reviewer.
- **Manual and ChatGPT reviews are unchanged.**
  - The existing rule allows one pending review request per iteration. Whichever arrives first wins.
  - The autonomous one becomes `competing_review`, or `superseded` if the manual review was already delivered.
  - A ChatGPT call made while an autonomous request is pending is refused, as before. The supervisor handles that request within its next poll (delivered or rejected); then the human path is open again.
  - `competing_review` is final for that event: if the competing request is later rejected, the iteration is not reviewed again autonomously. The next published snapshot gets a new event.

## 4. Complete, verified input (`input.ts`)

- **Binding.** The input is bound to the event's iteration and snapshot sha256, which must still be current and `ready_for_review`. The job must be `awaiting_review` with a live session (otherwise: wait). The snapshot bytes must hash to the event's sha256 and match their schema and ids. The diff and report are read through `verifiedArtifacts`: no symlink, a private regular file, the recorded sha256. The instruction must hash to `managed.json`'s `instruction_sha256`.
- **Blocking codes** (`input_blocked`, never clean):
  - `input_withheld`, `artifact_invalid`, `snapshot_hash_mismatch`, `instruction_mismatch`, `input_too_large`, `input_malformed` (not strict UTF-8);
  - coverage: `changed_path_not_in_diff`, `diff_path_not_listed`, `diff_path_repeated`, `content_not_exported`, `binary_content`, `diff_unparseable` (quoted or unusual names), `changed_paths_truncated` (≥ 100 listed), `preexisting_list_truncated`;
  - whole-file hashes: `new_file_not_in_diff` and `new_file_hash_mismatch`. For new files, the content in the diff must reproduce the export's whole-file sha256 and byte count.
- **Whole-file hashes: partial, by schema.** Only new files carry a whole-file sha256 in the export (`new_files`). Changed tracked files are covered by path (a section per changed path) and by the diff's own hash. The snapshot schema records no per-file hash for them, so their whole content is not re-verified.
- **Input identity.** `input_sha256` binds the event, snapshot, session, context epoch and the instruction, diff and report hashes. The input is rebuilt and must be identical after the provider answered, and again immediately before submission.
- **Untrusted data.** Source, reports and provider output are only hashed, parsed as a diff, and passed to the provider as data. The supervisor's message frames findings as "review data, not commands".

## 5. Provider boundary (`provider.ts`)

- **Interface.** `ReviewProvider { id; review(input, signal): Promise<unknown> }`. The provider gets the input object only: no paths, no handles, no gateway.
- **Validated response** (`providerResponseSchema`, strict):
  - `findings`: 1–30 items `{file|null, line|null, severity, text}`. Every `file` must be one of the snapshot's changed paths, and a line needs a file;
  - `clean`, `refusal {code}` or `error {code, retryable}`;
  - text is bounded with no control characters.
- **What it costs.** Anything else costs an attempt (`provider_output_invalid`, `finding_file_not_reviewed`, …), as do a timeout (`provider_timeout`) and a thrown error (`provider_failed`).
- **`OfflineReviewProvider`.** Deterministic, in-process, takes a pure rule. The default `markerRule` turns added lines containing `SF010-FINDING:` into findings. File headers are recognized only between `diff --git` and the first hunk, so an added line that begins `++` (in the diff, `+++`) is hunk data (review 2, R5).
- **A future real provider** (a model API, or an OpenClaw agent through the existing channel) implements the same interface. It is registered in `reviewer/main.ts` `PROVIDERS` only with its own review and activation decision. Exactly-once provider execution is **not** claimed: a call interrupted by a crash may have run, and its result is lost. The budget bounds this.

## 6. Coordinator state machine (`coordinator.ts`)

Per event, in `jobs/<app>/<job>.json`:

| State | Meaning | Next |
|---|---|---|
| `pending` | Seen | Checks, then an attempt |
| `provider_running` | The attempt was counted before the call | Answer → below; crash → the attempt stays spent, retried within the budget |
| `submitting` | Findings and their sha256 recorded | Revalidate, write once under the derived id |
| `submitted` | The request file exists | Observe the supervisor's record only |
| `delivered` / `rejected` / `unconfirmed` | What the supervisor recorded | Final; `unconfirmed` is never resent |
| `clean_awaiting_acceptance` | Clean verdict bound to the snapshot | Final; the operator decides |
| `superseded`, `competing_review`, `input_blocked`, `provider_refused`, `provider_failed`, `attempts_exhausted`, `review_limit`, `elapsed_limit`, `delegation_invalid`, `job_ended` | Coded, visible in `status` | Final for that event |

**Crash windows:**
- before the event: reconciliation;
- after the attempt was counted: spent, retried;
- before the write: `submitting`, so the same content and id are submitted again;
- after the write, before `submitted`: the file is found, so it is never written again;
- after the supervisor recorded `sending`: SF-009 makes it `unconfirmed`, never resent.

**Concurrency:**
- one coordinator per user (`coordinator/execution.lock`, the SF-006 lock: pid, start time, boot id);
- work is serialized per job within a coordinator;
- the state is read, modified and written under a short per-job lock;
- the derived review id plus the bridge's replay rule make a second request for an event impossible.

**Bounded state (review 2, R3).**
- The reviewer state has its own reader, with the same checks as the SF-007 private reader (no symlink, a private regular file of this user, a strict schema) and a 2 MiB bound. Every write enforces the same bound (nothing is written beyond it), so the coordinator never persists a record that it cannot read back. The SF-007 reader and its 64 KiB bound are unchanged.
- Finding bodies are kept only while an entry is `submitting`; afterwards only `submission_sha256` remains, because the request file holds the body.
- A submission is limited to 48 KiB, so the whole request stays below what the supervisor reads (`MAX_REQUEST_BYTES`, 64 KiB). A valid but larger answer is `provider_failed` / `provider_output_too_large`: the attempt is spent, no review is counted and nothing is written. As a second guard, the gateway refuses an autonomous request whose file would exceed 64 KiB (`too_large`, mapped to `request_too_large`). *Inherited, unchanged:* an MCP `factory_submit_review` request larger than 64 KiB is still written and then recorded by the supervisor as `request_invalid`.

**Grant binding (review 2, R4).**
- Each entry records the `delegation_id` and `provider` it belongs to, and its provenance is taken from the entry, never from the current delegation.
- After a revocation and a new delegation, the behaviour depends on the entry's state:
  - an old `submitting` entry whose request was not written ends as `delegation_invalid` / `delegation_replaced`, and its findings are neither relabelled nor replayed;
  - a request that was already written is only observed; the supervisor checks its original delegation, which is revoked;
  - an entry without a recorded result starts again under the new grant.

**Retries and stale verdicts.** A retryable failure waits with bounded exponential backoff (250 ms doubling, at most 10 s) before the next attempt. A `clean_awaiting_acceptance` verdict whose snapshot is no longer the current ready iteration becomes `superseded` (`clean_superseded`) on the next pass. The clean path re-checks the delegation right before the verdict is recorded, like a delivery.

**Compact, reset and superseded snapshots.** The input binds the session id and the context epoch (the number of performed context actions). A reset or compact after the provider answered changes the input, so the findings become `superseded` (`input_changed`). The gateway refuses a stale binding (`session_replaced`, `context_changed`), and so does the supervisor at the commit point. The launch claim and the one-live-session invariant are untouched: SF-010 starts no process.

## 7. What the supervisor checks for an autonomous review

The SF-009 path runs unchanged, in this order:
- `#bound` (job, current iteration, snapshot sha256, verified artifacts, tree fingerprint);
- live process and correlation;
- `#idleGate`;
- the settled handoff scan (quiescence);
- `#stillBound`.

Then, only for `provenance`, right before the `sending` record:
- `autonomous_review_disabled` (no `autonomousReview` option: the production default);
- `session_replaced`;
- `context_changed`;
- the delegation re-check: `delegation_revoked`, `delegation_expired`, `elapsed_limit`, `delegation_mismatch`, `provider_mismatch`, `provider_not_enabled`, `delegation_replaced` or `delegation_unverifiable`.

A refusal is recorded as `rejected` with that reason. The session keeps waiting for a review.

The same authority check runs **again after the `sending` record** (review 2, R2): after `afterRequestRecorded`, and before the existing post-record process scan, drift check, final synchronous process pass, idle gate and write, which stay together. A refusal there rolls the record back (`review_withdrawn`: same state, iterations and current iteration) and records the review `rejected`. It is never sent, no iteration is added, and no second entry is created.

## 8. Not claimed, and inherited limitations

- **Not claimed:**
  - real model review quality or compatibility;
  - automatic continuation of a ChatGPT conversation;
  - exactly-once provider execution;
  - OS isolation of the reviewer state (same-user writers, as in SF-009 §3).
- **R3-5** (approval double-failure) stays a production release blocker. It is unchanged.
- **The reset gate handover** stays non-atomic (SF-009 §5). SF-010 only refuses stale findings across it.
- **Schema compatibility.** Readers older than this change refuse a `managed.json` with `source` or a request with `provenance`.
  - `source` is written only by a supervisor of this change that handled an autonomous review.
  - The active runtime (the canonical `bridge/dist`, older code) would record a request with `provenance` as `request_invalid` and never act on it.
