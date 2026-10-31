# SF-006 report: controlled Claude Code execution adapter

Instruction: `factory-data/apps/sf-pilot/jobs/sf006-claude-code-adapter-20261026/instruction.md`. Task and decisions: `docs/tasks/SF-006-claude-execution.md`. Runbook: `docs/runbooks/claude-execution.md`. Review package: `review/SF-006/MANIFEST.md`.

**Status: infrastructure adapter tested, Reviews 02–04 corrected; real Claude execution pending.** No real Claude Code session has edited an application repository. That needs a separate operator decision naming the application and the job.

## Who does what

| Component | What it does in SF-006 | Has run for real |
|---|---|---|
| **OpenClaw** | Unchanged from SF-005: accepts a dispatch; its receiver keeps `accepted/<request_id>.json` in the OpenClaw volume. The adapter reads that record through one fixed, read-only `docker compose exec … cat` | Yes: real records read for `sf-pilot` and two `sf006-demo` jobs |
| **Host adapter** (`scripts/sf006-execute.sh` → `bridge/dist/src/execution/cli.js`) | Reads the app's `.env` as data; re-verifies the acceptance; copies the instruction byte-for-byte; claims and starts one Claude session; collects results into the mediator job directory | Yes: real CLI, real bridge, real OpenClaw, with a **fake** `claude` on `PATH` |
| **Claude Code** | Interactive session in the app repository: `claude --permission-mode manual --session-id <uuid> --name … "/implement <path>"` in the operator's terminal | Only probe skills in throwaway repositories (see below); `/implement` in an application: **not yet** |
| **Operator** | Registers apps, runs `prepare`/`run` (or `handoff`/`collect`), answers trust and permission prompts, confirms the end, reviews, commits, pushes | — |

## Verification of the installed Claude Code (2.1.310)

From probes in throwaway repositories with a probe skill (`review/SF-006/logs/claude-probe.log`):

| Question | Result |
|---|---|
| Version, login | 2.1.310, logged in via claude.ai (`claude auth status`; no account data recorded) |
| Skill availability | The personal skill `~/.claude/skills/implement` is present |
| `claude -p "/skill args"` | Runs the skill with its arguments (exit 0, $0.04). Not used: `-p` cannot ask permissions |
| Interactive `claude "/skill args"` | Runs the skill as the first message (seen on screen) |
| Trust | A new folder shows the workspace trust dialog first; default "No, exit" |
| Permission mode | Without a flag the session starts in **auto mode** (tool calls approved automatically) → the launcher passes `--permission-mode manual` |
| Exit / completion | `/exit` ends the session; **SIGTERM also gives exit code 0**, so the adapter asks the operator to confirm that `/implement` finished |
| Transcripts | `~/.claude/projects/<cwd slug>/<session-id>.jsonl`; format is internal (docs). A session started **inside** another Claude Code session saves none → preflight refuses that, and the launcher drops inherited session markers |

**Probe side effect.** In one probe an onboarding dialog ("Teach auto mode about your environment?") appeared after the reply. The automated `/exit`+Enter selected "Yes" in it. The wizard's next page was not confirmed before the session was stopped:
- `~/.claude/settings.json` is unchanged (no `autoMode` section) and the version is unchanged.
- The probe folders' Claude state was removed with `claude purge`.

## Verification of the adapter

| Spec test | Evidence | Result |
|---|---|---|
| 1. App resolution, portability, unregistered / missing / invalid `.env` | `app-config.test.ts`: 4 tests with 15 invalid `.env` variants, symlinked/directory/writable `.env`, and repositories that are missing, a subdirectory, bare, the mediator, inside it or containing it; integration: `sf-pilot` refused as not executable | PASS |
| 2. Wrong app/job, invalid ids, traversal, symlink escape, config injection, wrong repository | `execution.test.ts` (ids, unregistered and unconfigured apps, symlinked `.software-factory`), `app-config.test.ts` (injection characters, quotes, `export`, unknown keys) | PASS |
| 3. Instruction SHA-256, dispatch, receipt, OpenClaw acceptance absent, stale, malformed or mismatched | 9 cases in `execution.test.ts`, including OpenClaw unreachable and a receiver record for another job or SHA-256; the receiver lookup's fixed argv is tested in `openclaw-channel.test.ts`; real lookups in the integration | PASS |
| 4. Byte-for-byte copy, UTF-8, SHA-256 | Cyrillic instruction, compared byte-for-byte and by SHA-256; integration `cmp` | PASS |
| 5. One launch; duplicates, concurrency, crash/retry, missing completion | 3 concurrent runs → 1 launch; second run, prepare, handoff and rolled-back `execution.json` refused (`launch.claim`); dead adapter → `interrupted`; hung session → `still_running`/`locked`, then `interrupted`; unconfirmed end → `interrupted`, then resume + collect → `completed` (`operator_confirmed`). Real recovery: a harness run that stopped after the exit was finished with `collect` | PASS |
| 6. cwd, relative command, environment | Fake records argv `--permission-mode manual --session-id … --name … "/implement .software-factory/jobs/<job>/instruction.md"`, cwd = app repository, no `SF_`/`FACTORY_`/`OPENCLAW_` or Claude session markers; integration: a real pseudo-terminal, Claude's stdout/stderr reach the operator's terminal and not the artifacts | PASS |
| 7. Failed and interrupted distinct from completed | Exit 1 → `failed/claude_exit`; signal → `interrupted/claude_signal`; no skill, project skill or transcript in another project → `failed`; commit/stage (also with exit 1) → `failed/git_changed` | PASS |
| 8. Reports, diff, new files; no private config | Diff, new files, checks and hashes verified; no `APP_REPO` in any exported file; `.env`, a private key, a diff containing the app path, and a changed ignored `.env` → `needs_inspection`, nothing exported | PASS |
| 9. Git index unchanged; no staging, commit or push | App index fingerprint identical before and after (unit and integration); the adapter has no staging, commit, push, reset or clean code; mediator index unchanged (`git-index-check.txt`) | PASS |
| 10. Bridge, tunnel, Dashboard, SF-005 dispatch/replay | `logs/regression.log`: replay of accepted dispatches, `sf005-dispatch.sh verify`, `sf005-dashboard.sh verify`, tunnel check; bridge restarted with the SF-006 build | PASS |

- **Tests:** 58/58 (`logs/test-suite.log`).
- **Integration** (`review/SF-006/integration-check.sh`): `INTEGRATION OK` on runs `20261026a` and `20261026c`. Real MCP dispatch → real OpenClaw acceptance → real CLI `preflight`/`prepare`/`run`/`status` in a pseudo-terminal → artifacts; fake `claude` only.

## Code review

Two parallel reviewers (standards and spec). Fixed:
- **Exactly once.**
  - A lock takeover race could allow two launches. The lock is now written completely before it appears and moved aside only while unchanged.
  - A new `launch.claim`, never removed, makes a second launch impossible.
- **Git runs commands.** Git could run repository-controlled commands (`core.fsmonitor`, textconv, external diff) and inherited `GIT_*`. Now neutralised.
- **Large diff.** A large diff left `collect` permanently failing. Now `needs_inspection`, and collection failures never leave a job stuck.
- **New-file reads.** Reads of new files were unbounded and without `O_NOFOLLOW`. Fixed.
- **Paths in errors.** Host paths could appear in fs error messages. Now coded `io_failed` without paths, and the CLI prints only coded messages.
- **Transcript evidence.** It was not tied to the right project directory, the first message or the operator's skill. Tightened; project skills that shadow `/implement` are refused.
- **Record validation.** `execution.json` is now validated with a zod schema.
- **Interrupted/resume path.** It was inconsistent, and an orphaned `running` without a pid could look ended. Now session liveness by session id, an explicit `operator_confirmed` completion, and `adapter_interrupted`.
- **More evidence.**
  - Ignored-file changes are reported.
  - `git_changed` takes precedence over the exit code.
  - The app path in the diff is withheld.
  - Acceptance checks, changed paths and Git state are recorded.

Not changed, documented:
- Clean/smudge filters from `.git/info/attributes` can still run during collection. A session the operator approved can change anything the operator can anyway.
- Plugin-provided `/implement` skills are not accepted.
- Session command results come from the transcript as ok/error, not exit codes.

Also fixed, in SF-005-UI code: the Dashboard forwarder's in-container pipe exited before stdout was flushed. The full test run found it intermittently. After the fix:
- 0 failures in 25 runs;
- the live response is byte-identical to the in-container one;
- the forwarder was restarted.

## Review 02

ChatGPT's code review found five problems. All are corrected and covered by regression tests (`review/SF-006/review02.diff`, `review/SF-006/logs/review02/`):

- **R1, Git filter execution (P1).**
  - **Reproduced on Git 2.43.0.** A repository-configured clean filter runs from `git status` (after a same-size change or a touch), `git diff` (also `--name-only`, `--no-ext-diff --no-textconv`) and `git hash-object` without `--no-filters`. It does not run from `ls-files`, `ls-tree`, `cat-file blob`, `rev-parse` or `diff --no-index` outside the repository.
  - **Fix.** Inspection now uses only filter-free commands in the repository and hashes working-tree files itself. Diffs are built outside the repository with no system/global config or attribute files.
  - **Content conversions** (`filter`, `ident`, `working-tree-encoding`, or `eol`/`text`/`core.autocrlf` on files with CR) are not exported as raw bytes:
    - dirty repositories with them are refused at prepare (`unsupported_conversions`);
    - after a session they give `needs_inspection`.
  - **Regression test:**
    - clean/smudge/process filters, a textconv driver, `diff.external` and `core.fsmonitor` are configured to write a marker;
    - `prepare`, `run` and collection leave the marker empty, with and without a `filter` attribute;
    - a positive control shows that plain `git status` on the same repository does run it.
- **R2, withheld exports (P1).**
  - A withheld export keeps only the reason, as categories and counts: no paths, transcript commands, messages or Claude output.
  - The ignored-file baseline, which names credential files and fingerprints their content, moved out of `execution.json` into `factory-data/apps/<app>/.env.sf006-ignored-<job>`, which `factory_read_file` refuses.
  - Regression test: non-token sensitive text (`PIN-4711-NOT-A-TOKEN`) in the transcript command and the last message, with a withheld export. Neither it nor any path name reaches the artifacts.
- **R3, ignored directories (P2).**
  - Collapsed ignored directories are walked for credential-style files (nested `.git` skipped).
  - An unreadable tree, more than 200,000 entries or more than 1000 credential-style files makes the check incomplete, and the export is withheld.
  - Tests: a changed and a new `hidden/deep/.env`, a nested `.git` (not blocking), an unreadable directory, and 1001 key files.
- **R4, diff limits (P2).** The file count (1000) is checked before any content is read. Diff bytes are counted per file and processing stops at 2 MiB, keeping nothing partial. Per-file reads are bounded. Tests: 1100 files, and a 3 × ~900 KB diff.
- **R5, artifact write failures (P2).** A failed write gives `needs_inspection`/`artifacts_failed`, with the outcome it would have had and a recovery text. Files already written in that attempt are removed, and `completed` is impossible. Test: an unwritable `report.md`.

**Internal review.** The two-axis internal review of these corrections found further issues, also fixed:
- lazy fetch in partial clones (`protocol.allow=never`);
- nested `.git` contents recorded as credentials;
- no cap on recorded credential files;
- unreadable directories failing without a code;
- false changes under conversions, `core.fileMode=false`, group/other execute bits or non-UTF-8 symlink targets;
- mode-only changes and symlinks without a note in the diff;
- unbounded reads after `lstat`;
- quadratic diff size accounting;
- per-file rows bloating `checks.md`.

**Evidence:**
- 65/65 tests: the 58 accepted plus 7 new;
- integration runs `20261026d` and `20261026e` through the real CLI, real bridge and real OpenClaw acceptance, with a fake `claude`: `INTEGRATION OK`;
- no real Claude `/implement` was run.

**Remaining limits, documented:**
- Repositories that rely on content conversions, including Git LFS, are refused, not supported.
- Submodule commits are not inspected.
- Each snapshot reads every tracked file once, streamed.

## Review 03

All three findings are corrected and covered by regression tests (`review/SF-006/review03.diff`, `review/SF-006/logs/review03/`).

- **R3-F1, deleted ignored credential files.**
  - The comparison now covers the union of baseline and final entries, so it counts entries that appeared, disappeared and changed. Any count withholds the export, and the reason carries counts only.
  - Tests:
    - a pre-existing ignored `hidden/deep/.env` deleted → `needs_inspection` (`1 disappeared`);
    - the same file removed together with its whole ignored directory → `needs_inspection`.

    No path, value or sandbox path reaches the artifacts.
- **R3-F2, credential-named symlinks.**
  - The walker records every non-directory credential-style entry, using `lstat`, never following links:
    - symlinks as `symlink:<sha256 of the target bytes>`;
    - other types as `other:<type>`.
  - The fingerprints live only in the private baseline. Read failures make the check incomplete, which withholds the export.
  - Tests:
    - a new link (`1 appeared`);
    - a file replaced by a link, and a retargeted link (`1 changed`);
    - a removed link (`1 disappeared`);
    - a stable link (`completed`; the baseline has the fingerprint but neither the target nor its content);
    - a link to a directory outside the repository (not walked; a change there does not block).
- **R3-F3, legacy records.**
  - **Exposure boundary:** `factory_read_file` reads every `execution.json`, and records from before Review 02 keep `ignored_initial` there.
  - **Fix:** the legacy field is never used as a baseline; only a valid private baseline counts.
  - **Missing or invalid private baseline** (missing, a symlink, unparsable) → `needs_inspection`, even when the legacy record claims a complete check. No record is rewritten.
  - **Audit:** a read-only `scripts/sf006-execute.sh audit-legacy` reports exposure by counts. On the real mediator: 6 records, **0 expose names** (`demo-20261026b/c/d` have an empty legacy field; `demo-20261026a` is an earliest-format record that the adapter refuses as `invalid_record`, unchanged).
  - **Alternatives:** keep (current), redact, or hide from MCP, each with its compatibility impact and verification. They are documented in the runbook and need an operator decision; none was performed.
  - **Tests:** a removed private baseline; a symlinked one; a legacy record claiming `complete: true`; the audit's counts-only output, no-change guarantee and `legacy-format` detection.

**Internal review:** the two-axis review found no fail-closed defects. Its standards findings in the audit and a symlink guard for top-level ignored entries were fixed.

**Evidence:**
- 68/68 tests: the 65 accepted plus 3 new Review 03 tests, which also extend coverage of the earlier R3 cases;
- integration runs `20261026f` and `20261026g` through the real CLI, bridge and OpenClaw acceptance, with a fake `claude`: `INTEGRATION OK`;
- no real Claude `/implement` was run.

**Remaining limits:**
- A symlink whose own name is not credential-style is not fingerprinted.
- Changes behind directory symlinks, outside the repository, are not seen.
- A `readlink` failure is handled (incomplete check, export withheld) but not exercised by a test.

## Review 04

Both findings are corrected and covered by regression tests (`review/SF-006/review04.diff`, `review/SF-006/logs/review04/`).

- **R4-1, completeness evidence in the private baseline.**
  - The private baseline has its own strict schema with a required boolean `complete`, and only `complete: true` supports an export.
  - Test (each variant is placed into a real handoff job's private file, followed by a real `collect`):

    | `complete` in the file | Result |
    |---|---|
    | missing | `needs_inspection`, "not readable as a baseline" |
    | `false` | `needs_inspection`, "records an incomplete check" |
    | `"yes"` | `needs_inspection`, "not readable as a baseline" |
    | `1` | `needs_inspection`, "not readable as a baseline" |
    | `true` | `completed` |

    A credential map with a hidden `__proto__` key → invalid.
  - The historical `ignored_initial` is validated by a separate legacy schema and is never a baseline.
  - Existing private files without `complete` now fail closed. No file is rewritten.
- **R4-2, legacy audit.**
  - `ignored_initial` must match the strict legacy shape exactly. Otherwise it is `malformed`, counts as exposing names, and makes the exit code 1.
  - Output: ids, statuses, counts and known states only.
  - Test:
    - unexpected keys with sensitive-looking names;
    - a non-string entry and a non-string fingerprint;
    - an array as the credential map;
    - a non-boolean `complete`;
    - `__proto__` keys in the map and at the top level;
    - a free-text `state`;
    - a valid empty field as the positive control (exit 0).

    Inputs stay byte-identical, and no value appears in the output.
- **Internal review.** It found the `__proto__` case: zod 4.6.7 silently drops such own keys, which the earlier check had caught. It also found the verbatim `state`. Both are fixed.

**Evidence:**
- 70/70 tests: the 68 accepted plus 2 new;
- integration runs `20261026h` and `20261026i` (real CLI, bridge and OpenClaw acceptance, fake `claude`): `INTEGRATION OK`;
- `audit-legacy` on the real mediator: 9 records, 0 may expose names, exit 0;
- no real Claude `/implement` was run.

**Remaining limits:** as after Review 03. In addition, the CLI exit code is tested through the shared formatter, not by running the CLI against a test mediator.

## Review 05

**Finding (P2):** the read-only `audit-legacy` could exit 0 while some ChatGPT-readable `execution.json` files or job directories had not been inspected. Corrected with regression tests (`review/SF-006/review05.diff`, `review/SF-006/logs/review05/`).

- **Two separate results.** The audit reports possible exposure and coverage separately. The exit code is 0 only when every record and directory was inspected and none exposes names. Any exposing field, unverified record or coverage gap gives 1.
- **Records (Finding A).**
  - A record is verified only when all of the following hold:
    - a regular file of at most 1 MiB, read in full through `FactoryJobs`/`readJobFile`;
    - strict UTF-8;
    - a JSON object with the schema marker;
    - no duplicate keys;
    - only known fields of their current types.
  - Otherwise it is `UNVERIFIED (<issue>)`, with exposure unknown, never `false`. The issues are `symlink`, `not_regular`, `too_large`, `unreadable`, `invalid_utf8`, `invalid_json`, `not_record`, `duplicate_key` and `unknown_shape`.
  - Only `ENOENT` counts as "not prepared"; any other error is unverified.
- **Directories (Finding B).**
  - `factory-data`, `apps`, app, `jobs` and job directories are checked with `lstat` and never followed.
  - A symlink, a non-directory, an unlistable directory or an entry with a name outside the id pattern is a coverage gap. A gap reports the repository-relative path built from verified ids, the kind and the category; a name outside the pattern is counted, never printed.
  - The walk continues after a gap.
  - An unverifiable `factory-data` or `apps` fails the audit. Only `ENOENT` there means "never initialized" (exit 0, stated explicitly).
- **Internal review, before packaging.** It found that structurally invalid `legacy-format` records and records with duplicate keys still counted as clean. Both are now unverified (`unknown_shape`, `duplicate_key`), and a nested `__proto__` key gives `unknown_shape`. One Review 04 assertion was widened for the new `UNVERIFIED` marker: its fixture's free-text `state` now makes that record unverified as well.
- **Tests:** 7 new tests in `bridge/test/legacy-audit.test.ts`. Each runs against its own temporary mediator:
  - malformed, truncated and invalid-UTF-8 records containing secret-looking names;
  - non-records and oversized records;
  - duplicate keys, unknown fields and `__proto__`;
  - symlinked (also dangling), directory-typed and permission-denied `execution.json`;
  - in-root app, `jobs` and job symlinks that `factory_read_file` resolves, but the audit does not follow;
  - plain files in place of directories, unlistable directories and names outside the id pattern;
  - an unverifiable `factory-data` or `apps`;
  - an absent record versus an absent data directory;
  - a positive control (exit 0).

  Every run asserts that the mediator is byte-identical (contents, types, modes, link targets) and that no fixture secret or host path appears in the output or result. The permission cases run without root (uid 1000 here).

**Evidence:**
- `npm run smoke`: **77/77** (the 70 accepted plus 7 new);
- mutation checks: disabling any of the new checks makes a regression test fail;
- `audit-legacy` on the real mediator: 9 records, 8 verified, 1 unverified, 0 known to expose names, 0 gaps, 13 unprepared jobs, **exit 1**. `factory-data` is unchanged.

**Real data needs a decision.** `sf006-demo/demo-20261026a` is unverified (`unknown_shape`). A development build older than the first packaged SF-006 version wrote it, storing `changed_paths` as a count instead of a list. It has no `ignored_initial`. Its exposure is unknown, so the audit no longer exits 0. Nothing was changed; redacting, removing or accepting it is an operator decision (runbook, "Remediation alternatives").

**Remaining limits:**
- Only `execution.json` is opened. Other files in a job directory, such as a crash-left `.execution.json.<uuid>.tmp`, are not audited.
- Only the `ignored_initial` content is judged. Other string fields are checked by type only.
- With `factory-data` present and `apps` missing, the audit reports "never initialized" and exits 0.
- The CLI exit code is still tested through the shared formatter.
- No integration run was repeated: the change is limited to the diagnostic audit.
- No real Claude `/implement` was run; **real Claude execution in an application remains pending**.

## What is still manual

- App registration and `.env`.
- Starting each step.
- Trust and permission prompts.
- Confirming that `/implement` finished.
- Review, commit and push.
- Removing `.software-factory/jobs/<job>/` from app repositories.

**Next seam.**
- An event from the accepted receipt that prompts the operator, or an approved local launcher, to run `preflight`/`prepare` for a job id.
- No polling service was built.

## State at the end of SF-006

- **Bridge.** Restarted with the SF-006 build (`logs/bridge-run.log`); tunnel unchanged.
- **Dashboard forwarder.** Restarted with the flush fix (`logs/forwarder-run.log`).
- **OpenClaw.** Container, configuration and receiver unchanged.
- **`factory-data/apps/sf006-demo/`.** Contains the integration jobs and no `.env`, so it is not executable. Its throwaway repositories are deleted.
- **`sf-pilot`.** Still has no `.env`.
- **Mediator Git index.** Unchanged. No staging, commit or push; the operator handles Git.
