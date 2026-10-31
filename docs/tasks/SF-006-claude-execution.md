# SF-006: Controlled Claude Code execution adapter

Source instruction: `factory-data/apps/sf-pilot/jobs/sf006-claude-code-adapter-20261026/instruction.md`. Runbook: `docs/runbooks/claude-execution.md`. Report: `docs/reports/SF-006-report.md`.

## Goal

Connect an OpenClaw-accepted job to a trusted, operator-started host adapter. The adapter:
1. verifies the acceptance;
2. copies the approved Markdown instruction into the configured application repository;
3. starts the native Claude Code `/implement` session there;
4. returns reviewable artifacts to the mediator.

## Decisions

1. **Per-app configuration** is `factory-data/apps/<app-id>/.env` with the single key `APP_REPO`, parsed strictly as data.
   - The repository must be a separate, non-bare Git worktree root.
   - Errors and artifacts never contain the value.
   - Template: `config/apps/.env.example`.
2. **Acceptance is re-verified before every write and before the launch**, using the SF-005 Review 01 validation, now exported as `readDispatchRecord` and `checkAcceptedReceipt`. It also requires:
   - the instruction's SHA-256;
   - the OpenClaw receiver's own `accepted/<request_id>.json`, read with one fixed, read-only `docker compose exec … cat`.

   SF-005 files are only read. Execution has its own `execution.json`.
3. **Transfer:** `.software-factory/jobs/<job-id>/instruction.md` in the app repository.
   - Exclusive create, then a SHA-256 check.
   - No symlinked directories on the way.
   - A different existing file is refused, never overwritten.
4. **Native invocation: an interactive session in the operator's terminal.**

   ```text
   claude --permission-mode manual --session-id <uuid> --name sf-<app>-<job> "/implement <relative path>"
   ```

   Probes on the installed Claude Code 2.1.310, all in throwaway repositories (`review/SF-006/logs/claude-probe.log`), showed:
   - **`-p` runs a skill.** `claude -p "/skill args"` runs a project skill with its arguments; the transcript records it as `<command-name>/skill</command-name><command-args>…</command-args>` followed by the loaded skill body. It is not used: it cannot ask permissions.
   - **The interactive initial prompt runs it too.** The screen showed `❯ /sf-probe beta-7` followed by the skill's reply.
   - **Trust dialog.** A new folder shows the workspace trust dialog first, with "No, exit" as the default.
   - **Auto mode by default.** Without `--permission-mode` the session starts in **auto mode**, which approves tool calls automatically. Hence `--permission-mode manual`.
   - **Exit code 0 on SIGTERM.** So exit 0 alone does not prove a normal end.
   - **No transcript as a child.** A session started from inside another Claude Code session saves no transcript ("inherited CLAUDE_CODE_CHILD_SESSION marker"). Hence preflight refuses there, and the launcher drops the inherited session markers.
5. **`completed` requires evidence and confirmation.** All of these must hold:
   - exit code 0 (or an operator-confirmed end of a manual or resumed session);
   - the operator's confirmation that `/implement` finished;
   - transcript evidence: the first user message is `/implement <exact path>`, it was recorded in the app repository's own project directory, and the operator's personal skill was loaded;
   - unchanged HEAD and index;
   - exportable results.

   Everything else is `failed`, `interrupted` or `needs_inspection`, in a fixed order: `git_changed` before `claude_exit`.
6. **One launch per job.**
   - `launch.claim` is created exclusively before any session (run or handoff) and is never removed: a filesystem guarantee, independent of locks.
   - `run` is allowed only from `prepared`, and writes `running` before spawning.
   - A per-job lock (written completely before it appears, with a stale lock taken over only when it is unchanged) refuses concurrent commands.
   - Session liveness is checked by pid identity and by the session id in `/proc/*/cmdline`.
   - There is no automatic retry. `interrupted` points to `claude --resume <session-id>`, then `collect`.
7. **Handoff path.** `handoff` gives the operator the exact command with a pre-assigned session id (`pending_manual`). `collect` verifies the transcript after the operator confirms the session ended.
8. **Export filter.** Any of these leads to `needs_inspection` with nothing exported:
   - credential-style changed paths (the `factory_read_file` deny list, now exported as `isForbidden`), including new or changed Git-ignored ones;
   - credential-like text;
   - the app's host path in the diff;
   - more than 2 MiB of diff, or a failed collection.

   Exported text has host paths replaced. Git runs without `GIT_*`, with `core.fsmonitor=false`, `--no-ext-diff --no-textconv`.
9. **Git safety.** All inspection uses `git --no-optional-locks`, which never rewrites the index. The adapter has no staging, commit, push, reset or clean code. Index or HEAD changes during the session are reported as `failed` / `git_changed`, never repaired.
10. **No new services.** The CLI is one-shot. There is no polling, scheduler, daemon or remote shell, and no change to OpenClaw, Docker networking or the Dashboard.

## Also fixed (found by the SF-006 full test run)

- **SF-005-UI forwarder truncation.** The in-container pipe exited before stdout was flushed and could drop the end of a response. The forwarder test caught it intermittently: 1 failure in 5 runs with 3 MiB of data.
- **Fix.** The pipe now exits only after stdout ends. After the fix: 0 failures in 25 runs, and the live Dashboard response is byte-identical to the in-container response.

## Code review

Two parallel reviewers (standards and spec). All real defects were fixed:
- lock takeover race (plus `launch.claim`);
- Git running repo-controlled commands;
- a large diff blocking `collect`;
- unbounded reads without `O_NOFOLLOW`;
- host paths in error messages;
- weak transcript evidence;
- unvalidated `execution.json`;
- the inconsistent interrupted/resume path;
- the crash window before the pid is recorded;
- ignored files not reported;
- `git_changed` hidden behind an exit code.

The interactive-mode probe was added because of the spec review.

## Review 02 (2026-10-26)

ChatGPT's code review raised five findings. The internal two-axis review of the corrections found further defects, also fixed.

| # | Finding | Correction |
|---|---|---|
| R1 (P1) | Git clean filters ran despite `core.fsmonitor=false --no-ext-diff --no-textconv`. Reproduced on Git 2.43: `status` (same-size change or touch), `diff`, `diff --name-only` and `hash-object` without `--no-filters` run them | **Inside the repository:** only `rev-parse`, `config --get`, `check-attr`, `ls-files`, `ls-tree` and `cat-file`, with `protocol.allow=never` against lazy-fetch transports. <br>**Working-tree changes:** hashed in Node as Git blobs, streamed, respecting `core.fileMode`, the owner execute bit and raw symlink targets. <br>**Diffs:** `git diff --no-index` outside the repository with no system/global config or attribute files; mode changes and symlinks are noted. <br>**Content conversions** are detected with `check-attr` and refused: `unsupported_conversions` at prepare, `needs_inspection` at collect |
| R2 (P1) | Withheld exports still carried transcript commands, messages and path names | A withheld export carries only categories and counts. The ignored-file baseline (credential file names and content fingerprints) moved out of `execution.json` into a private `.env.sf006-ignored-<job>` next to the app's `.env`, which `factory_read_file` refuses |
| R3 (P2) | `--directory` hid nested credential files in ignored directories | Ignored directories are walked (`lstat`, no symlinks, nested `.git` skipped). Files over 64 MiB are compared by size/mtime/inode. An unreadable tree, more than 200,000 entries or more than 1000 credential-style files gives an incomplete check, so the export is withheld |
| R4 (P2) | Aggregate limits were checked only after processing everything | The file count is checked before reading content; diff bytes are counted per file and processing stops at 2 MiB. Per-file reads are bounded with `fstat` (1 MiB); nothing partial is kept |
| R5 (P2) | Artifact write failures | `#writeArtifacts` failures give `needs_inspection`/`artifacts_failed` with the would-be outcome and a recovery text; files already written in that attempt are removed; `completed` is impossible |

## Review 03 (2026-10-26)

| # | Finding | Correction |
|---|---|---|
| R3-F1 (P2) | A deleted ignored credential file was not detected, because the comparison iterated only over the final entries | The union of baseline and final paths is compared: appeared, disappeared and changed entries each withhold the export, reported by counts only |
| R3-F2 (P2) | Credential-named symlinks in ignored directories were skipped | Every non-directory credential-style entry is recorded. Symlinks get the SHA-256 of their own target bytes (never followed), other types their type. Directory symlinks are never walked into, and a top-level `dir/` entry that is a symlink is recorded, not walked. Read failures make the check incomplete, which withholds the export |
| R3-F3 | Pre-Review 02 `execution.json` records still carried `ignored_initial` | The legacy field is never used as a baseline. Only a valid private baseline counts; missing or invalid gives `needs_inspection`. A read-only `audit-legacy` reports exposure as counts only. Remediation alternatives (keep, redact, hide from MCP) are documented in the runbook; none is performed without an operator decision. Real data: 6 records, none exposes names |

The internal two-axis review of Review 03 found no fail-closed defects. Its standards findings were fixed:
- the audit reuses `FactoryJobs`/`readJobFile`, refuses symlinked `factory-data`, reports unreadable records instead of skipping them, checks the record against the strict schema and the baseline for validity, and treats a malformed legacy field as exposing;
- shared constants for the private baseline name and the schema;
- distinct reasons for a missing and an invalid baseline.

## Review 04 (2026-10-26)

| # | Finding | Correction |
|---|---|---|
| R4-1 (P2) | A private baseline without `complete` was accepted | A dedicated strict `privateBaselineSchema` requires a boolean `complete`, and only `true` supports an export. Missing or invalid completeness → "not readable as a baseline"; `complete: false` → "records an incomplete check". The historical `ignored_initial` keeps its own `legacyIgnoredSchema` (optional `complete`), isolated from baseline validation and never a baseline |
| R4-2 (P2) | The legacy audit undercounted malformed fields | `ignored_initial` is validated against the strict legacy shape; anything else is `malformed` and exposing, and makes the exit code 1. The audit prints only ids, statuses, counts and known states |

The internal review found two more defects, both fixed with tests:
- **`__proto__` keys:** zod 4.6.7 silently drops an own `__proto__` key in records and objects, so a credential map carrying names under it parsed as empty. Every parse of a baseline or legacy field now also requires that all raw own keys survived.
- **The record's `state`** was printed verbatim; now it is printed only if it is a known state.

## Review 05 (2026-10-26)

| # | Finding | Correction |
|---|---|---|
| R5-A (P2) | An unreadable or unparseable `execution.json` counted as `exposes_names: false`, so the audit could exit 0 | The audit verifies a record only when it is fully read, strict UTF-8, a JSON object with the schema marker, without duplicate keys, and with only known fields of their current types. Otherwise the record is `UNVERIFIED (<issue>)` with unknown exposure. Only `ENOENT` means "not prepared" |
| R5-B (P2) | Symlinked or uninspectable directories were skipped silently | Every directory is checked with `lstat` and never followed. Gaps are reported by repository-relative path built from ids and by category, and the walk continues. An unverifiable `factory-data`/`apps` fails; `ENOENT` there is "never initialized" (exit 0). Exit 1 on any exposure, unverified record or gap |

Real data: 9 records, 1 unverified (`demo-20261026a`, a pre-package development format), so `audit-legacy` exits 1 until an operator decides about that record.

## Stage

Infrastructure adapter tested; **real Claude execution pending**. No real Claude session has edited an application. That needs a separate operator decision naming the application and the job.
